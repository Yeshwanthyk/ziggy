import { Effect, Schema } from "effect";

const HttpStatus = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(100),
  Schema.isLessThanOrEqualTo(599),
);
const RetryAfterSeconds = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const AuthTestSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  user_id: Schema.String,
});
const PostMessageSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  ts: Schema.String,
});
const SlackFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
});

const decodeAuthTestResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([AuthTestSuccess, SlackFailure])),
);
const decodePostMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([PostMessageSuccess, SlackFailure])),
);

export type SlackApiOperation = "authTest" | "postMessage" | "socket";
export type SlackApiErrorReason =
  | "network"
  | "server"
  | "rate-limited"
  | "authentication"
  | "api"
  | "decode"
  | "socket";

export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()("SlackApiError", {
  operation: Schema.Literals(["authTest", "postMessage", "socket"]),
  reason: Schema.Literals([
    "network",
    "server",
    "rate-limited",
    "authentication",
    "api",
    "decode",
    "socket",
  ]),
  retriable: Schema.Boolean,
  status: Schema.optional(HttpStatus),
  retryAfterSeconds: Schema.optional(RetryAfterSeconds),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

interface RawResponse {
  readonly status: number;
  readonly body: string;
  readonly retryAfterHeader: string | undefined;
}

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_authed",
  "missing_scope",
]);

const redact = (value: string, token: string): string =>
  value.replaceAll(token, "[REDACTED]").replaceAll(encodeURIComponent(token), "[REDACTED]");

const safeCause = (cause: unknown, token: string): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(redact(message, token));
};

const apiError = (
  operation: SlackApiOperation,
  reason: SlackApiErrorReason,
  retriable: boolean,
  cause: unknown,
  token: string,
  options?: {
    readonly status?: number;
    readonly retryAfterSeconds?: number;
    readonly message?: string;
  },
): SlackApiError =>
  new SlackApiError({
    operation,
    reason,
    retriable,
    message: redact(
      options?.message ??
        (reason === "authentication"
          ? `Slack ${operation} authentication failed`
          : `Slack ${operation} failed`),
      token,
    ),
    cause: safeCause(cause, token),
    ...(options?.status === undefined ? {} : { status: options.status }),
    ...(options?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
  });

const retryAfterHeader = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
};

const classifyHttpFailure = (
  operation: SlackApiOperation,
  response: RawResponse,
  token: string,
): SlackApiError => {
  if (response.status === 429) {
    const retryAfterSeconds = retryAfterHeader(response.retryAfterHeader);
    return apiError(operation, "rate-limited", true, new Error("HTTP 429"), token, {
      status: response.status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (response.status >= 500) {
    return apiError(operation, "server", true, new Error(`HTTP ${response.status}`), token, {
      status: response.status,
    });
  }
  return apiError(operation, "api", false, new Error(`HTTP ${response.status}`), token, {
    status: response.status,
  });
};

const request = (
  token: string,
  operation: SlackApiOperation,
  method: string,
  body: object,
): Effect.Effect<RawResponse, SlackApiError> =>
  Effect.tryPromise({
    try: async (signal) => {
      // oxlint-disable-next-line ziggy-effect/no-raw-fetch -- Slack's required adapter boundary uses global fetch.
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal,
      });
      return {
        status: response.status,
        body: await response.text(),
        retryAfterHeader: response.headers.get("Retry-After") ?? undefined,
      };
    },
    catch: (cause) => apiError(operation, "network", true, cause, token),
  });

const ensureHttpSuccess = (
  token: string,
  operation: SlackApiOperation,
  response: RawResponse,
): Effect.Effect<RawResponse, SlackApiError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(classifyHttpFailure(operation, response, token));

const slackFailure = (
  token: string,
  operation: SlackApiOperation,
  error: string,
  status: number,
): SlackApiError => {
  if (AUTH_ERRORS.has(error)) {
    return apiError(operation, "authentication", false, new Error(error), token, { status });
  }
  if (error === "ratelimited") {
    return apiError(operation, "rate-limited", true, new Error(error), token, { status });
  }
  return apiError(operation, "api", false, new Error(error), token, {
    status,
    message: `Slack ${operation} failed: ${error}`,
  });
};

export const authTest = (
  token: string,
): Effect.Effect<{ readonly userId: string }, SlackApiError> =>
  request(token, "authTest", "auth.test", {}).pipe(
    Effect.flatMap((response) => ensureHttpSuccess(token, "authTest", response)),
    Effect.flatMap((response) =>
      decodeAuthTestResponse(response.body).pipe(
        Effect.mapError((cause) =>
          apiError("authTest", "decode", false, cause, token, { status: response.status }),
        ),
        Effect.flatMap((envelope) =>
          envelope.ok
            ? Effect.succeed({ userId: envelope.user_id })
            : Effect.fail(slackFailure(token, "authTest", envelope.error, response.status)),
        ),
      ),
    ),
  );

export const postMessage = (
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Effect.Effect<void, SlackApiError> =>
  request(token, "postMessage", "chat.postMessage", {
    channel,
    text,
    ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
  }).pipe(
    Effect.flatMap((response) => ensureHttpSuccess(token, "postMessage", response)),
    Effect.flatMap((response) =>
      decodePostMessageResponse(response.body).pipe(
        Effect.mapError((cause) =>
          apiError("postMessage", "decode", false, cause, token, { status: response.status }),
        ),
        Effect.flatMap((envelope) =>
          envelope.ok
            ? Effect.void
            : Effect.fail(slackFailure(token, "postMessage", envelope.error, response.status)),
        ),
      ),
    ),
  );
