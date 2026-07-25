import { Effect, Schema } from "effect";

const TelegramId = Schema.Number.check(
  Schema.makeFilter(Number.isSafeInteger, { expected: "a safe integer Telegram ID" }),
);
const HttpStatus = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(100),
  Schema.isLessThanOrEqualTo(599),
);
const RetryAfterSeconds = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const TelegramUser = Schema.Struct({
  id: TelegramId,
  username: Schema.optional(Schema.String),
});
const TelegramChat = Schema.Struct({
  id: TelegramId,
  type: Schema.String,
});
const TelegramMessage = Schema.Struct({
  message_id: TelegramId,
  from: Schema.optional(TelegramUser),
  chat: TelegramChat,
  text: Schema.optional(Schema.String),
});
const TelegramUpdate = Schema.Struct({
  update_id: TelegramId,
  message: Schema.optional(TelegramMessage),
});
const GetUpdatesSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Array(TelegramUpdate),
});
const SendMessageSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ message_id: TelegramId }),
});
const TelegramFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error_code: HttpStatus,
  description: Schema.String,
  parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(RetryAfterSeconds) })),
});

const decodeGetUpdatesResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([GetUpdatesSuccess, TelegramFailure])),
);
const decodeSendMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([SendMessageSuccess, TelegramFailure])),
);

export type TelegramUpdate = typeof TelegramUpdate.Type;
export type TelegramApiOperation = "getUpdates" | "sendMessage";
export type TelegramApiErrorReason =
  | "network"
  | "server"
  | "rate-limited"
  | "authentication"
  | "rejected"
  | "invalid-response";

export class TelegramApiError extends Schema.TaggedErrorClass<TelegramApiError>()(
  "TelegramApiError",
  {
    operation: Schema.Literals(["getUpdates", "sendMessage"]),
    reason: Schema.Literals([
      "network",
      "server",
      "rate-limited",
      "authentication",
      "rejected",
      "invalid-response",
    ]),
    retriable: Schema.Boolean,
    status: Schema.optional(Schema.Number),
    retryAfterSeconds: Schema.optional(Schema.Number),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

const redact = (value: string, token: string): string =>
  value.replaceAll(token, "[REDACTED]").replaceAll(encodeURIComponent(token), "[REDACTED]");

const safeCause = (cause: unknown, token: string): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(redact(message, token));
};

const apiError = (
  operation: TelegramApiOperation,
  reason: TelegramApiErrorReason,
  retriable: boolean,
  cause: unknown,
  token: string,
  options?: {
    readonly status?: number;
    readonly retryAfterSeconds?: number;
  },
): TelegramApiError =>
  new TelegramApiError({
    operation,
    reason,
    retriable,
    message:
      reason === "authentication"
        ? `Telegram ${operation} authentication failed`
        : `Telegram ${operation} failed`,
    cause: safeCause(cause, token),
    ...(options?.status === undefined ? {} : { status: options.status }),
    ...(options?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
  });

const classifyFailure = (
  operation: TelegramApiOperation,
  status: number,
  token: string,
  retryAfterSeconds?: number,
): TelegramApiError => {
  if (status === 401 || status === 403) {
    return apiError(operation, "authentication", false, new Error(`HTTP ${status}`), token, {
      status,
    });
  }
  if (status === 429) {
    return apiError(operation, "rate-limited", true, new Error("HTTP 429"), token, {
      status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status >= 500) {
    return apiError(operation, "server", true, new Error(`HTTP ${status}`), token, { status });
  }
  return apiError(operation, "rejected", false, new Error(`HTTP ${status}`), token, { status });
};

const request = (
  token: string,
  operation: TelegramApiOperation,
  body: object,
): Effect.Effect<RawResponse, TelegramApiError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
      );
      return { status: response.status, body: await response.text() };
    },
    catch: (cause) => apiError(operation, "network", true, cause, token),
  });

const invalidResponse = (
  operation: TelegramApiOperation,
  response: RawResponse,
  cause: unknown,
  token: string,
): TelegramApiError =>
  response.status < 200 || response.status >= 300
    ? classifyFailure(operation, response.status, token)
    : apiError(operation, "invalid-response", false, cause, token, { status: response.status });

export const getUpdates = (
  token: string,
  offset: number,
  timeoutSeconds: number,
): Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramApiError> =>
  request(token, "getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  }).pipe(
    Effect.flatMap((response) =>
      decodeGetUpdatesResponse(response.body).pipe(
        Effect.mapError((cause) => invalidResponse("getUpdates", response, cause, token)),
        Effect.flatMap((envelope) =>
          envelope.ok
            ? Effect.succeed(envelope.result)
            : Effect.fail(
                classifyFailure(
                  "getUpdates",
                  envelope.error_code,
                  token,
                  envelope.parameters?.retry_after,
                ),
              ),
        ),
      ),
    ),
  );

export const sendMessage = (
  token: string,
  chatId: number,
  text: string,
): Effect.Effect<void, TelegramApiError> =>
  request(token, "sendMessage", { chat_id: chatId, text }).pipe(
    Effect.flatMap((response) =>
      decodeSendMessageResponse(response.body).pipe(
        Effect.mapError((cause) => invalidResponse("sendMessage", response, cause, token)),
        Effect.flatMap((envelope) =>
          envelope.ok
            ? Effect.void
            : Effect.fail(
                classifyFailure(
                  "sendMessage",
                  envelope.error_code,
                  token,
                  envelope.parameters?.retry_after,
                ),
              ),
        ),
      ),
    ),
  );
