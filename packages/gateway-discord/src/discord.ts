import type {
  BroadcastTarget,
  BroadcastTargetOutcome,
  GatewayInboundMessage,
  GatewayResumeHandle,
} from "@ziggy/protocol";
import { decodeGatewayInboundMessage, gatewayInboundMessageKey } from "@ziggy/protocol";
import { Context, Effect, Layer, Match, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 2_000;
const DISCORD_USER_AGENT = "DiscordBot (https://github.com/yeshwanthyk/ziggy, 0.0.0)";
const MAX_ACCEPTED_INBOUND = 4_096;

const DiscordGatewayConfigSchema = Schema.Struct({
  gatewayId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  resumeBy: Schema.Literals(["conversation", "peer"]),
});

const DiscordCredentialsSchema = Schema.Struct({
  botToken: Schema.RedactedFromValue(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  ),
});

const DiscordAuthorSchema = Schema.Struct({
  id: Schema.String,
  bot: Schema.optional(Schema.Boolean),
});

const DiscordReferencedMessageSchema = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
});

const DiscordMessageReferenceSchema = Schema.Struct({
  message_id: Schema.optional(Schema.String),
});

const DiscordMessageSchema = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  guild_id: Schema.optional(Schema.String),
  author: DiscordAuthorSchema,
  content: Schema.String,
  timestamp: Schema.String,
  type: Schema.Number,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  embeds: Schema.optional(Schema.Array(Schema.Unknown)),
  message_reference: Schema.optional(DiscordMessageReferenceSchema),
  referenced_message: Schema.optional(Schema.NullOr(DiscordReferencedMessageSchema)),
});

const DiscordDispatchSchema = Schema.Struct({
  op: Schema.Number,
  t: Schema.NullOr(Schema.String),
  d: Schema.Unknown,
});

const decodeConfigUnknown = Schema.decodeUnknownEffect(DiscordGatewayConfigSchema, {
  onExcessProperty: "error",
});
const decodeCredentialsUnknown = Schema.decodeUnknownEffect(DiscordCredentialsSchema, {
  onExcessProperty: "error",
});
const decodeDispatchUnknown = Schema.decodeUnknownEffect(DiscordDispatchSchema);
const decodeMessageUnknown = Schema.decodeUnknownEffect(DiscordMessageSchema);

export type DiscordGatewayConfig = typeof DiscordGatewayConfigSchema.Type;
export type DiscordCredentials = typeof DiscordCredentialsSchema.Type;

export class DiscordConfigurationError extends Schema.TaggedErrorClass<DiscordConfigurationError>()(
  "DiscordConfigurationError",
  { source: Schema.Literals(["config", "credentials"]), message: Schema.String },
) {}

export class DiscordInboundError extends Schema.TaggedErrorClass<DiscordInboundError>()(
  "DiscordInboundError",
  { message: Schema.String },
) {}

export class DiscordApiError extends Schema.TaggedErrorClass<DiscordApiError>()("DiscordApiError", {
  operation: Schema.Literal("send-message"),
  code: Schema.Literals([
    "target-not-found",
    "target-unavailable",
    "delivery-rejected",
    "outcome-unknown",
    "internal",
  ]),
  message: Schema.String,
}) {}

export interface DiscordServiceShape {
  sendMessage(channelId: string, content: string): Effect.Effect<void, DiscordApiError>;
}

export class DiscordService extends Context.Service<DiscordService, DiscordServiceShape>()(
  "@ziggy/gateway-discord/DiscordService",
) {
  static layer(
    credentials: DiscordCredentials,
  ): Layer.Layer<DiscordService, never, HttpClient.HttpClient> {
    return Layer.effect(this, makeDiscordHttpService(credentials));
  }
}

export function decodeDiscordGatewayConfig(
  value: unknown,
): Effect.Effect<DiscordGatewayConfig, DiscordConfigurationError> {
  return decodeConfigUnknown(value).pipe(
    Effect.mapError(
      () =>
        new DiscordConfigurationError({
          source: "config",
          message: "Invalid Discord Gateway config",
        }),
    ),
  );
}

export function decodeDiscordCredentials(
  value: unknown,
): Effect.Effect<DiscordCredentials, DiscordConfigurationError> {
  return decodeCredentialsUnknown(value).pipe(
    Effect.mapError(
      () =>
        new DiscordConfigurationError({
          source: "credentials",
          message: "Invalid Discord credentials",
        }),
    ),
  );
}

/**
 * Accepts only text DM MESSAGE_CREATE dispatches. Guild channels, edits, bot messages, and rich
 * media remain outside the text-first Discord leaf.
 */
export function normalizeDiscordDispatch(
  config: DiscordGatewayConfig,
  payload: unknown,
): Effect.Effect<GatewayInboundMessage | undefined, DiscordInboundError> {
  return Effect.gen(function* () {
    const dispatch = yield* decodeDispatchUnknown(payload).pipe(
      Effect.mapError(
        () => new DiscordInboundError({ message: "Invalid Discord Gateway dispatch" }),
      ),
    );
    if (dispatch.op !== 0 || dispatch.t !== "MESSAGE_CREATE") return undefined;
    const message = yield* decodeMessageUnknown(dispatch.d).pipe(
      Effect.mapError(() => new DiscordInboundError({ message: "Invalid Discord message" })),
    );
    if (
      message.guild_id !== undefined ||
      message.author.bot === true ||
      message.content.length === 0 ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.embeds?.length ?? 0) > 0 ||
      (message.type !== 0 && message.type !== 19)
    ) {
      return undefined;
    }

    const replyMessageId = message.message_reference?.message_id;
    const normalized: GatewayInboundMessage = {
      gatewayId: config.gatewayId,
      messageId: message.id,
      conversation: { chatId: message.channel_id, kind: "direct" },
      senderId: message.author.id,
      sentAt: message.timestamp,
      text: message.content,
      ...(replyMessageId === undefined ||
      message.referenced_message === undefined ||
      message.referenced_message === null
        ? {}
        : {
            replyTo: {
              messageId: replyMessageId,
              text: message.referenced_message.content,
            },
          }),
    };
    return yield* Effect.try({
      try: () => decodeGatewayInboundMessage(normalized),
      catch: () => new DiscordInboundError({ message: "Discord message cannot be normalized" }),
    });
  });
}

/** Resume identity is reconstructable solely from the configured instance and accepted route. */
export function discordResumeHandle(
  config: DiscordGatewayConfig,
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
      config.resumeBy === "peer"
        ? { type: "peer", conversation, senderId: message.senderId }
        : { type: "conversation", conversation },
  };
}

/** Maps one normalized Broadcast target to Discord without resolving daemon routes. */
export function deliverDiscordBroadcast(
  gatewayId: string,
  ruleIndex: number,
  target: BroadcastTarget,
  content: string,
): Effect.Effect<BroadcastTargetOutcome, never, DiscordService> {
  return Effect.gen(function* () {
    if (target.type !== "gateway" || target.gatewayId !== gatewayId) {
      return { ruleIndex, status: "failed", code: "target-not-found" };
    }
    if (content.length === 0) return { ruleIndex, status: "skipped", code: "no-content" };
    if (content.length > DISCORD_MESSAGE_LIMIT) {
      return { ruleIndex, status: "failed", code: "delivery-rejected" };
    }
    const service = yield* DiscordService;
    const channelId = target.conversation.threadId ?? target.conversation.chatId;
    return yield* service.sendMessage(channelId, content).pipe(
      Effect.as(deliveredOutcome(ruleIndex)),
      Effect.catchTag("DiscordApiError", (error) =>
        Effect.succeed(failedOutcome(ruleIndex, error.code)),
      ),
    );
  });
}

export const makeDiscordGateway = (config: DiscordGatewayConfig) =>
  Effect.gen(function* () {
    const accepted = yield* Ref.make<ReadonlyMap<string, GatewayInboundMessage>>(new Map());
    return {
      acceptDispatch: (payload: unknown) =>
        normalizeDiscordDispatch(config, payload).pipe(
          Effect.flatMap((message) => {
            if (message === undefined) return Effect.succeed(undefined);
            const key = gatewayInboundMessageKey(message);
            return Ref.modify(accepted, (current) => {
              const first = current.get(key);
              if (first !== undefined) return [first, current];
              const next = new Map(current).set(key, message);
              if (next.size > MAX_ACCEPTED_INBOUND) {
                const oldest = next.keys().next().value;
                if (oldest !== undefined) next.delete(oldest);
              }
              return [message, next];
            });
          }),
        ),
    };
  });

export type DiscordGateway = Effect.Success<ReturnType<typeof makeDiscordGateway>>;

function makeDiscordHttpService(
  credentials: DiscordCredentials,
): Effect.Effect<DiscordServiceShape, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    return DiscordService.of({
      sendMessage: (channelId, content) =>
        HttpClientRequest.post(
          `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages`,
        ).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `Bot ${Redacted.value(credentials.botToken)}`,
          ),
          HttpClientRequest.setHeader("user-agent", DISCORD_USER_AGENT),
          HttpClientRequest.bodyJsonUnsafe({
            content,
            allowed_mentions: { parse: [] },
          }),
          client.execute,
          Effect.asVoid,
          Effect.mapError(classifyDiscordApiError),
        ),
    });
  });
}

const classifyHttpFailure = Match.type<HttpClientError.HttpClientErrorReason>().pipe(
  Match.tagsExhaustive({
    TransportError: () => discordFailureCode("outcome-unknown"),
    EncodeError: () => discordFailureCode("internal"),
    InvalidUrlError: () => discordFailureCode("internal"),
    StatusCodeError: ({ response }) => classifyDiscordStatus(response.status),
    DecodeError: () => discordFailureCode("internal"),
    EmptyBodyError: () => discordFailureCode("internal"),
  }),
);

function deliveredOutcome(ruleIndex: number): BroadcastTargetOutcome {
  return { ruleIndex, status: "delivered" };
}

function failedOutcome(ruleIndex: number, code: DiscordApiError["code"]): BroadcastTargetOutcome {
  return { ruleIndex, status: "failed", code };
}

function discordFailureCode(code: DiscordApiError["code"]): DiscordApiError["code"] {
  return code;
}

function classifyDiscordApiError(cause: HttpClientError.HttpClientError): DiscordApiError {
  return new DiscordApiError({
    operation: "send-message",
    code: classifyHttpFailure(cause.reason),
    message: "Discord message delivery failed",
  });
}

function classifyDiscordStatus(
  status: number,
): "delivery-rejected" | "target-not-found" | "target-unavailable" {
  switch (status) {
    case 400:
      return "delivery-rejected";
    case 404:
      return "target-not-found";
    default:
      return "target-unavailable";
  }
}
