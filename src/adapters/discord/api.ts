import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";

const HttpStatus = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(100),
  Schema.isLessThanOrEqualTo(599),
);
const RetryAfterSeconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const GatewayBotSuccess = Schema.Struct({ url: Schema.String });
const CreateMessageSuccess = Schema.Struct({ id: Schema.String });
const RateLimitFailure = Schema.Struct({
  retry_after: Schema.optional(RetryAfterSeconds),
});

const decodeGatewayBotResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GatewayBotSuccess),
);
const decodeCreateMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CreateMessageSuccess),
);
const decodeRateLimitResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RateLimitFailure));

export type DiscordApiOperation = "getGatewayBot" | "createMessage" | "gateway";
export type DiscordApiErrorReason =
  | "network"
  | "server"
  | "rate-limited"
  | "authentication"
  | "rejected"
  | "invalid-response"
  | "gateway";

export class DiscordApiError extends Schema.TaggedErrorClass<DiscordApiError>()("DiscordApiError", {
  operation: Schema.Literals(["getGatewayBot", "createMessage", "gateway"]),
  reason: Schema.Literals([
    "network",
    "server",
    "rate-limited",
    "authentication",
    "rejected",
    "invalid-response",
    "gateway",
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

const redact = (value: string, token: string): string =>
  value.replaceAll(token, "[REDACTED]").replaceAll(encodeURIComponent(token), "[REDACTED]");

const safeCause = (cause: unknown, token: string): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(redact(message, token));
};

const apiError = (
  operation: DiscordApiOperation,
  reason: DiscordApiErrorReason,
  retriable: boolean,
  cause: unknown,
  token: string,
  options?: {
    readonly status?: number;
    readonly retryAfterSeconds?: number;
  },
): DiscordApiError =>
  new DiscordApiError({
    operation,
    reason,
    retriable,
    message:
      reason === "authentication"
        ? `Discord ${operation} authentication failed`
        : `Discord ${operation} failed`,
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
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

const classifyFailure = (
  operation: DiscordApiOperation,
  status: number,
  token: string,
  retryAfterSeconds?: number,
): DiscordApiError => {
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
  client: HttpClient.HttpClient,
  token: string,
  operation: DiscordApiOperation,
  url: string,
  options?: {
    readonly method?: "GET" | "POST";
    readonly body?: string;
  },
): Effect.Effect<RawResponse, DiscordApiError> => {
  let outgoing = HttpClientRequest.make(options?.method ?? "GET")(url).pipe(
    HttpClientRequest.setHeader("Authorization", `Bot ${token}`),
  );
  if (options?.body !== undefined) {
    outgoing = outgoing.pipe(
      HttpClientRequest.bodyText(options.body, "application/json"),
    );
  }

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

const retryAfter = (response: RawResponse): Effect.Effect<number | undefined, never> =>
  decodeRateLimitResponse(response.body).pipe(
    Effect.map((body) => body.retry_after ?? retryAfterHeader(response.retryAfterHeader)),
    Effect.orElseSucceed(() => retryAfterHeader(response.retryAfterHeader)),
  );

const ensureSuccess = (
  token: string,
  operation: DiscordApiOperation,
  response: RawResponse,
): Effect.Effect<RawResponse, DiscordApiError> => {
  if (response.status >= 200 && response.status < 300) {
    return Effect.succeed(response);
  }
  if (response.status === 429) {
    return retryAfter(response).pipe(
      Effect.flatMap((seconds) =>
        Effect.fail(classifyFailure(operation, response.status, token, seconds)),
      ),
    );
  }
  return Effect.fail(classifyFailure(operation, response.status, token));
};

export const makeDiscordApi = (client: HttpClient.HttpClient) => ({
  getGatewayBot: (token: string) =>
    request(client, token, "getGatewayBot", "https://discord.com/api/v10/gateway/bot").pipe(
      Effect.flatMap((response) => ensureSuccess(token, "getGatewayBot", response)),
      Effect.flatMap((response) =>
        decodeGatewayBotResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("getGatewayBot", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
    ),
  createMessage: (token: string, channelId: string, text: string) =>
    request(
      client,
      token,
      "createMessage",
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      { method: "POST", body: JSON.stringify({ content: text }) },
    ).pipe(
      Effect.flatMap((response) => ensureSuccess(token, "createMessage", response)),
      Effect.flatMap((response) =>
        decodeCreateMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("createMessage", "invalid-response", false, cause, token, {
              status: response.status,
            }),
          ),
        ),
      ),
      Effect.asVoid,
    ),
});

export type DiscordApi = ReturnType<typeof makeDiscordApi>;

const withLiveClient = <A, E>(
  use: (api: DiscordApi) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* use(makeDiscordApi(client));
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const getGatewayBot = (
  token: string,
): Effect.Effect<{ readonly url: string }, DiscordApiError> =>
  withLiveClient((api) => api.getGatewayBot(token));

export const createMessage = (
  token: string,
  channelId: string,
  text: string,
): Effect.Effect<void, DiscordApiError> =>
  withLiveClient((api) => api.createMessage(token, channelId, text));
