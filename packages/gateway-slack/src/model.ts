import type { BroadcastTarget, GatewayInboundMessage, GatewayResumeHandle } from "@ziggy/protocol";
import { Effect, Redacted, Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const SlackId = NonEmptyString.check(Schema.isMaxLength(512));
const SlackText = NonEmptyString.check(Schema.isMaxLength(65_536));
const SlackOutboundText = NonEmptyString.check(Schema.isMaxLength(40_000));
const SlackTimestamp = Schema.String.check(Schema.isPattern(/^\d{10}\.\d{1,6}$/));

export const SlackGatewayConfigSchema = Schema.Struct({
  gatewayId: SlackId,
  resumeGranularity: Schema.Literals(["conversation", "peer"]),
});
export type SlackGatewayConfig = typeof SlackGatewayConfigSchema.Type;

export const SlackCredentialsSchema = Schema.Struct({
  botToken: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^xoxb-[A-Za-z0-9-]+$/)),
    { label: "Slack bot token" },
  ),
});
export type SlackCredentials = typeof SlackCredentialsSchema.Type;

const SlackMessageEventSchema = Schema.Struct({
  type: Schema.Literal("message"),
  channel: SlackId,
  channel_type: Schema.String,
  user: SlackId,
  ts: SlackTimestamp,
  text: SlackText,
  thread_ts: Schema.optional(SlackTimestamp),
  event_ts: Schema.optional(SlackTimestamp),
  client_msg_id: Schema.optional(SlackId),
  team: Schema.optional(SlackId),
});

const SlackQuotedMessageSchema = Schema.Struct({
  messageId: SlackTimestamp,
  text: SlackText,
});

export const SlackInboundPayloadSchema = Schema.Struct({
  event: SlackMessageEventSchema,
  quotedMessage: Schema.optional(SlackQuotedMessageSchema),
});
export type SlackInboundPayload = typeof SlackInboundPayloadSchema.Type;

export const SlackPostMessageRequestSchema = Schema.Struct({
  channel: SlackId,
  text: SlackOutboundText,
  thread_ts: Schema.optional(SlackTimestamp),
});
export type SlackPostMessageRequest = typeof SlackPostMessageRequestSchema.Type;

export const SlackPostMessageReceiptSchema = Schema.Struct({
  channel: SlackId,
  ts: SlackTimestamp,
});
export type SlackPostMessageReceipt = typeof SlackPostMessageReceiptSchema.Type;

export interface SlackOutboundDelivery {
  readonly target: Extract<BroadcastTarget, { readonly type: "gateway" }>;
  readonly text: string;
}

export class SlackConfigurationError extends Schema.TaggedErrorClass<SlackConfigurationError>()(
  "SlackConfigurationError",
  {
    subject: Schema.Literals(["config", "credentials"]),
    cause: Schema.Defect(),
  },
) {}

export class SlackInboundError extends Schema.TaggedErrorClass<SlackInboundError>()(
  "SlackInboundError",
  {
    code: Schema.Literals([
      "invalid-payload",
      "unsupported-conversation",
      "unsupported-message",
      "missing-quoted-text",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class SlackDeliveryError extends Schema.TaggedErrorClass<SlackDeliveryError>()(
  "SlackDeliveryError",
  {
    code: Schema.Literals(["wrong-gateway", "invalid-delivery", "transport", "rejected"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeConfig = Schema.decodeUnknownEffect(SlackGatewayConfigSchema, {
  onExcessProperty: "error",
});
const decodeCredentials = Schema.decodeUnknownEffect(SlackCredentialsSchema, {
  onExcessProperty: "error",
});
const decodeInbound = Schema.decodeUnknownEffect(SlackInboundPayloadSchema, {
  onExcessProperty: "error",
});
const decodePostMessageRequest = Schema.decodeUnknownEffect(SlackPostMessageRequestSchema, {
  onExcessProperty: "error",
});

export function decodeSlackGatewayConfig(
  value: unknown,
): Effect.Effect<SlackGatewayConfig, SlackConfigurationError> {
  return decodeConfig(value).pipe(
    Effect.mapError((cause) => new SlackConfigurationError({ subject: "config", cause })),
  );
}

export function decodeSlackCredentials(
  value: unknown,
): Effect.Effect<SlackCredentials, SlackConfigurationError> {
  return decodeCredentials(value).pipe(
    Effect.mapError((cause) => new SlackConfigurationError({ subject: "credentials", cause })),
  );
}

export function normalizeSlackInbound(
  config: SlackGatewayConfig,
  value: unknown,
): Effect.Effect<GatewayInboundMessage, SlackInboundError> {
  return Effect.gen(function* () {
    const payload = yield* decodeInbound(value).pipe(
      Effect.mapError((cause) => new SlackInboundError({ code: "invalid-payload", cause })),
    );
    const event = payload.event;
    if (event.channel_type !== "im") {
      return yield* new SlackInboundError({ code: "unsupported-conversation" });
    }

    const threadId =
      event.thread_ts === undefined || event.thread_ts === event.ts ? undefined : event.thread_ts;
    if (threadId !== undefined && payload.quotedMessage === undefined) {
      return yield* new SlackInboundError({ code: "missing-quoted-text" });
    }
    if (
      payload.quotedMessage !== undefined &&
      (threadId === undefined || payload.quotedMessage.messageId !== threadId)
    ) {
      return yield* new SlackInboundError({ code: "unsupported-message" });
    }

    return {
      gatewayId: config.gatewayId,
      messageId: event.ts,
      conversation: {
        chatId: event.channel,
        kind: "direct",
        ...(threadId === undefined ? {} : { threadId }),
      },
      senderId: event.user,
      sentAt: slackTimestampToIso(event.ts),
      text: event.text,
      ...(payload.quotedMessage === undefined
        ? {}
        : {
            replyTo: {
              messageId: payload.quotedMessage.messageId,
              text: payload.quotedMessage.text,
            },
          }),
    };
  });
}

export function slackResumeHandle(
  config: SlackGatewayConfig,
  message: GatewayInboundMessage,
): GatewayResumeHandle {
  const conversation = {
    chatId: message.conversation.chatId,
    ...(message.conversation.threadId === undefined
      ? {}
      : { threadId: message.conversation.threadId }),
  };
  return {
    type: "gateway-resume",
    gatewayId: config.gatewayId,
    route:
      config.resumeGranularity === "conversation"
        ? { type: "conversation", conversation }
        : { type: "peer", conversation, senderId: message.senderId },
  };
}

export function mapSlackDelivery(
  config: SlackGatewayConfig,
  delivery: SlackOutboundDelivery,
): Effect.Effect<SlackPostMessageRequest, SlackDeliveryError> {
  if (delivery.target.gatewayId !== config.gatewayId) {
    return Effect.fail(new SlackDeliveryError({ code: "wrong-gateway" }));
  }
  return decodePostMessageRequest({
    channel: delivery.target.conversation.chatId,
    text: delivery.text,
    ...(delivery.target.conversation.threadId === undefined
      ? {}
      : { thread_ts: delivery.target.conversation.threadId }),
  }).pipe(Effect.mapError((cause) => new SlackDeliveryError({ code: "invalid-delivery", cause })));
}

export function slackBotToken(credentials: SlackCredentials): string {
  return Redacted.value(credentials.botToken);
}

function slackTimestampToIso(value: string): string {
  const [seconds, fraction] = value.split(".");
  const milliseconds =
    Number(seconds) * 1_000 + Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
  return new Date(milliseconds).toISOString();
}
