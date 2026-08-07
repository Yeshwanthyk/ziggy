import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

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
const ConnectionsOpenSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  url: Schema.String,
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
const decodeConnectionsOpenResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ConnectionsOpenSuccess, SlackFailure])),
);

export type SlackApiOperation = "authTest" | "postMessage" | "connectionsOpen" | "socket";
export type SlackApiErrorReason =
  | "network"
  | "server"
  | "rate-limited"
  | "authentication"
  | "api"
  | "decode"
  | "socket";

export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()("SlackApiError", {
  operation: Schema.Literals(["authTest", "postMessage", "connectionsOpen", "socket"]),
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
  "forbidden_team",
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
  if (response.status === 401 || response.status === 403) {
    return apiError(
      operation,
      "authentication",
      false,
      new Error(`HTTP ${response.status}`),
      token,
      {
        status: response.status,
      },
    );
  }
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
  client: HttpClient.HttpClient,
  token: string,
  operation: SlackApiOperation,
  method: string,
  options: {
    readonly body: string;
    readonly contentType: string;
  },
): Effect.Effect<RawResponse, SlackApiError> => {
  const outgoing = HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyText(options.body, options.contentType),
  );

  return client.execute(outgoing).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({
          status: response.status,
          body,
          retryAfterHeader: response.headers["retry-after"],
        })),
      ),
    ),
    Effect.mapError((cause) => apiError(operation, "network", true, cause, token)),
  );
};

const jsonRequest = (
  client: HttpClient.HttpClient,
  token: string,
  operation: SlackApiOperation,
  method: string,
  body: object,
): Effect.Effect<RawResponse, SlackApiError> =>
  request(client, token, operation, method, {
    body: JSON.stringify(body),
    contentType: "application/json; charset=utf-8",
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

export const makeSlackApi = (client: HttpClient.HttpClient) => ({
  authTest: (token: string) =>
    jsonRequest(client, token, "authTest", "auth.test", {}).pipe(
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
    ),
  postMessage: (token: string, channel: string, text: string, threadTs?: string) =>
    jsonRequest(client, token, "postMessage", "chat.postMessage", {
      channel,
      text,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "postMessage", response)),
      Effect.flatMap((response) =>
        decodePostMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("postMessage", "decode", false, cause, token, {
              status: response.status,
            }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "postMessage", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  connectionsOpen: (token: string) =>
    request(client, token, "connectionsOpen", "apps.connections.open", {
      body: "",
      contentType: "application/x-www-form-urlencoded",
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "connectionsOpen", response)),
      Effect.flatMap((response) =>
        decodeConnectionsOpenResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("connectionsOpen", "decode", false, cause, token, {
              status: response.status,
            }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.succeed({ url: envelope.url })
              : Effect.fail(
                  slackFailure(token, "connectionsOpen", envelope.error, response.status),
                ),
          ),
        ),
      ),
    ),
});

export type SlackApi = ReturnType<typeof makeSlackApi>;

const withLiveClient = <A, E>(use: (api: SlackApi) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* use(makeSlackApi(client));
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const authTest = (
  token: string,
): Effect.Effect<{ readonly userId: string }, SlackApiError> =>
  withLiveClient((api) => api.authTest(token));

export const postMessage = (
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.postMessage(token, channel, text, threadTs));

export const connectionsOpen = (
  token: string,
): Effect.Effect<{ readonly url: string }, SlackApiError> =>
  withLiveClient((api) => api.connectionsOpen(token));
