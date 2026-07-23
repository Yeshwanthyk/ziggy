import type { GatewayInboundMessage } from "@ziggy/protocol";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { TelegramCredentials, TelegramGatewayConfig } from "./config.ts";

const Id = Schema.Number.check(
  Schema.makeFilter(Number.isSafeInteger, { expected: "a safe integer Telegram ID" }),
);
const UnixTimestampSeconds = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_640_000_000_000),
);
const User = Schema.Struct({ id: Id });
const Chat = Schema.Struct({ id: Id, type: Schema.String });
const Reply = Schema.Struct({ message_id: Id, text: Schema.optional(Schema.String) });
const Message = Schema.Struct({
  message_id: Id,
  date: UnixTimestampSeconds,
  chat: Chat,
  from: Schema.optional(User),
  text: Schema.optional(Schema.String),
  message_thread_id: Schema.optional(Id),
  reply_to_message: Schema.optional(Reply),
});
const Update = Schema.Struct({ update_id: Id, message: Schema.optional(Message) });
const UpdatesResponse = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Array(Update) });
const SendResponse = Schema.Struct({ ok: Schema.Literal(true), result: Message });
const decodeUpdatesResponse = HttpClientResponse.schemaBodyJson(UpdatesResponse, {
  onExcessProperty: "ignore",
});
const decodeSendResponse = HttpClientResponse.schemaBodyJson(SendResponse, {
  onExcessProperty: "ignore",
});
const CanonicalIntegerString = Schema.String.check(
  Schema.makeFilter((value) => /^[1-9]\d*$/.test(value), {
    expected: "a canonical positive integer string",
  }),
);
const decodeCanonicalIntegerString = Schema.decodeUnknownEffect(CanonicalIntegerString);
const decodeSafeInteger = Schema.decodeUnknownEffect(Id);

type TelegramUpdate = typeof Update.Type;
export interface TelegramPollRequest {
  readonly offset: number;
  readonly timeoutSeconds: number;
}
export interface TelegramPollResult {
  readonly nextOffset: number;
  readonly messages: ReadonlyArray<GatewayInboundMessage>;
}
export interface TelegramSendRequest {
  readonly chatId: string;
  readonly text: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
}
export interface TelegramBotApi {
  readonly getUpdates: (
    request: TelegramPollRequest,
  ) => Effect.Effect<TelegramPollResult, TelegramApiError>;
  readonly sendMessage: (request: TelegramSendRequest) => Effect.Effect<void, TelegramApiError>;
}

export class TelegramApiError extends Schema.TaggedErrorClass<TelegramApiError>()(
  "TelegramApiError",
  { operation: Schema.Literals(["getUpdates", "sendMessage"]), message: Schema.String },
) {}

export function makeTelegramBotApi(
  config: TelegramGatewayConfig,
  credentials: TelegramCredentials,
): Effect.Effect<TelegramBotApi, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken)}/`;
    const request = <A>(
      operation: "getUpdates" | "sendMessage",
      body: unknown,
      decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
    ) =>
      HttpClientRequest.post(`${base}${operation}`).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((httpRequest) => client.execute(httpRequest)),
        Effect.flatMap(decode),
        Effect.mapError(
          () => new TelegramApiError({ operation, message: `Telegram ${operation} failed` }),
        ),
      );
    const numericId = (value: string) =>
      decodeCanonicalIntegerString(value).pipe(
        Effect.map(Number),
        Effect.flatMap(decodeSafeInteger),
        Effect.mapError(
          () =>
            new TelegramApiError({
              operation: "sendMessage",
              message: "Telegram sendMessage ID is invalid",
            }),
        ),
      );
    return {
      getUpdates: (value) =>
        request(
          "getUpdates",
          { offset: value.offset, timeout: value.timeoutSeconds, allowed_updates: ["message"] },
          decodeUpdatesResponse,
        ).pipe(
          Effect.map((response) => ({
            nextOffset: response.result.reduce(
              (offset, update) => Math.max(offset, update.update_id + 1),
              value.offset,
            ),
            messages: response.result.flatMap((update) => {
              const normalized = normalizeUpdate(config.gatewayId, update);
              return normalized === undefined ? [] : [normalized];
            }),
          })),
        ),
      sendMessage: (value) =>
        Effect.gen(function* () {
          const threadId =
            value.threadId === undefined ? undefined : yield* numericId(value.threadId);
          const replyToMessageId =
            value.replyToMessageId === undefined
              ? undefined
              : yield* numericId(value.replyToMessageId);
          yield* request(
            "sendMessage",
            {
              chat_id: value.chatId,
              text: value.text,
              ...(threadId === undefined ? {} : { message_thread_id: threadId }),
              ...(replyToMessageId === undefined
                ? {}
                : { reply_parameters: { message_id: replyToMessageId } }),
            },
            decodeSendResponse,
          );
        }),
    };
  });
}

function normalizeUpdate(
  gatewayId: string,
  update: TelegramUpdate,
): GatewayInboundMessage | undefined {
  const message = update.message;
  if (message?.text === undefined || message.from === undefined) return undefined;
  const kind =
    message.chat.type === "private"
      ? "direct"
      : message.chat.type === "group" || message.chat.type === "supergroup"
        ? "group"
        : undefined;
  if (kind === undefined) return undefined;
  const threadId = message.message_thread_id?.toString();
  const reply = message.reply_to_message;
  return {
    gatewayId,
    messageId: message.message_id.toString(),
    conversation: {
      chatId: message.chat.id.toString(),
      ...(threadId === undefined ? {} : { threadId }),
      kind,
    },
    senderId: message.from.id.toString(),
    sentAt: new Date(message.date * 1_000).toISOString(),
    text: message.text,
    ...(reply?.text === undefined
      ? {}
      : { replyTo: { messageId: reply.message_id.toString(), text: reply.text } }),
  };
}
