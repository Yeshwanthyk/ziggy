import { gatewayInboundMessageKey, type GatewayInboundMessage } from "@ziggy/protocol";
import { Effect, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  decodeSlackCredentials,
  decodeSlackGatewayConfig,
  mapSlackDelivery,
  normalizeSlackInbound,
  SlackDeliveryError,
  type SlackConfigurationError,
  type SlackGatewayConfig,
  type SlackInboundError,
  type SlackOutboundDelivery,
  type SlackPostMessageReceipt,
  type SlackPostMessageRequest,
  SlackPostMessageReceiptSchema,
  slackBotToken,
} from "./model.ts";

export interface SlackService {
  postMessage(
    request: SlackPostMessageRequest,
  ): Effect.Effect<SlackPostMessageReceipt, SlackDeliveryError>;
}

export type SlackInboundAcceptance =
  | { readonly status: "accepted"; readonly message: GatewayInboundMessage }
  | { readonly status: "duplicate"; readonly message: GatewayInboundMessage };

export interface SlackGateway {
  readonly config: SlackGatewayConfig;
  acceptInbound(value: unknown): Effect.Effect<SlackInboundAcceptance, SlackInboundError>;
  deliver(
    delivery: SlackOutboundDelivery,
  ): Effect.Effect<SlackPostMessageReceipt, SlackDeliveryError>;
}

const SlackApiSuccessSchema = Schema.Struct({
  ok: Schema.Literal(true),
  channel: Schema.String.check(Schema.isNonEmpty()),
  ts: Schema.String.check(Schema.isPattern(/^\d{10}\.\d{1,6}$/)),
});
const SlackApiFailureSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String.check(Schema.isNonEmpty()),
});
const SlackApiResponseSchema = Schema.Union([SlackApiSuccessSchema, SlackApiFailureSchema]);
const decodeSlackApiResponse = HttpClientResponse.schemaBodyJson(SlackApiResponseSchema);
const decodeSlackPostMessageReceipt = Schema.decodeUnknownEffect(SlackPostMessageReceiptSchema, {
  onExcessProperty: "error",
});

export function makeSlackGateway(
  configValue: unknown,
  service: SlackService,
): Effect.Effect<SlackGateway, SlackConfigurationError> {
  return Effect.gen(function* () {
    const config = yield* decodeSlackGatewayConfig(configValue);
    const accepted = yield* Ref.make(new Map<string, GatewayInboundMessage>());
    return {
      config,
      acceptInbound: (value) =>
        normalizeSlackInbound(config, value).pipe(
          Effect.flatMap((message) =>
            Ref.modify(
              accepted,
              (messages): readonly [SlackInboundAcceptance, Map<string, GatewayInboundMessage>] => {
                const key = gatewayInboundMessageKey(message);
                const first = messages.get(key);
                if (first !== undefined) return [{ status: "duplicate", message: first }, messages];
                const next = new Map(messages);
                next.set(key, message);
                return [{ status: "accepted", message }, next];
              },
            ),
          ),
        ),
      deliver: (delivery) =>
        mapSlackDelivery(config, delivery).pipe(
          Effect.flatMap((request) => service.postMessage(request)),
        ),
    };
  });
}

export function makeSlackWebApi(
  credentialsValue: unknown,
  client: HttpClient.HttpClient,
): Effect.Effect<SlackService, SlackConfigurationError> {
  return decodeSlackCredentials(credentialsValue).pipe(
    Effect.map(
      (credentials): SlackService => ({
        postMessage: (request) =>
          HttpClientRequest.post("https://slack.com/api/chat.postMessage").pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(slackBotToken(credentials)),
            HttpClientRequest.bodyJsonUnsafe(request),
            client.execute,
            Effect.flatMap(decodeSlackApiResponse),
            Effect.mapError((cause) => new SlackDeliveryError({ code: "transport", cause })),
            Effect.flatMap((response) =>
              response.ok
                ? decodeSlackPostMessageReceipt({
                    channel: response.channel,
                    ts: response.ts,
                  }).pipe(
                    Effect.mapError(
                      (cause) => new SlackDeliveryError({ code: "transport", cause }),
                    ),
                  )
                : Effect.fail(new SlackDeliveryError({ code: "rejected", detail: response.error })),
            ),
          ),
      }),
    ),
  );
}
