import { Buffer } from "node:buffer";
import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { SlackIngressFileReference } from "../../domain/slack-ingress";

export const MAX_SLACK_IMAGE_BYTES = 5 * 1024 * 1024;
export const SLACK_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type SlackImageMimeType = (typeof SLACK_IMAGE_MIME_TYPES)[number];
export interface SlackImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: SlackImageMimeType;
}
interface SlackDownloadAccumulator {
  readonly chunks: Array<Uint8Array>;
  readonly size: number;
}

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
const UpdateMessageSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  ts: Schema.String,
});
const SetStatusSuccess = Schema.Struct({
  ok: Schema.Literal(true),
});
const ReactionSuccess = Schema.Struct({
  ok: Schema.Literal(true),
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
const decodeUpdateMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([UpdateMessageSuccess, SlackFailure])),
);
const decodeSetStatusResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([SetStatusSuccess, SlackFailure])),
);
const decodeReactionResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ReactionSuccess, SlackFailure])),
);
const decodeConnectionsOpenResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ConnectionsOpenSuccess, SlackFailure])),
);

export type SlackApiOperation =
  | "authTest"
  | "postMessage"
  | "updateMessage"
  | "setStatus"
  | "addReaction"
  | "removeReaction"
  | "downloadFile"
  | "connectionsOpen"
  | "socket";
export type SlackApiErrorReason =
  | "network"
  | "server"
  | "rate-limited"
  | "authentication"
  | "api"
  | "decode"
  | "socket";

export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()("SlackApiError", {
  operation: Schema.Literals([
    "authTest",
    "postMessage",
    "updateMessage",
    "setStatus",
    "addReaction",
    "removeReaction",
    "downloadFile",
    "connectionsOpen",
    "socket",
  ]),
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
    return apiError(operation, "authentication", false, new Error(error), token, {
      status,
      ...(error === "missing_scope"
        ? { message: `Slack ${operation} is missing a required scope` }
        : {}),
    });
  }
  if (error === "ratelimited") {
    return apiError(operation, "rate-limited", true, new Error(error), token, { status });
  }
  return apiError(operation, "api", false, new Error(error), token, {
    status,
    message: `Slack ${operation} failed: ${error}`,
  });
};

const slackImageMimeType = (value: string | undefined): SlackImageMimeType | undefined =>
  SLACK_IMAGE_MIME_TYPES.find((mimeType) => mimeType === value);

export const isSlackPrivateFileUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "files.slack.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
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
      markdown_text: text,
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
              ? Effect.succeed({ ts: envelope.ts })
              : Effect.fail(slackFailure(token, "postMessage", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  updateMessage: (token: string, channel: string, ts: string, text: string) =>
    jsonRequest(client, token, "updateMessage", "chat.update", {
      channel,
      ts,
      markdown_text: text,
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "updateMessage", response)),
      Effect.flatMap((response) =>
        decodeUpdateMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("updateMessage", "decode", false, cause, token, {
              status: response.status,
            }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "updateMessage", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  setStatus: (token: string, channel: string, threadTs: string, status: string) =>
    jsonRequest(client, token, "setStatus", "assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "setStatus", response)),
      Effect.flatMap((response) =>
        decodeSetStatusResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("setStatus", "decode", false, cause, token, { status: response.status }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "setStatus", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  addReaction: (token: string, channel: string, ts: string, name: string) =>
    jsonRequest(client, token, "addReaction", "reactions.add", {
      channel,
      timestamp: ts,
      name,
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "addReaction", response)),
      Effect.flatMap((response) =>
        decodeReactionResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("addReaction", "decode", false, cause, token, { status: response.status }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "addReaction", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  removeReaction: (token: string, channel: string, ts: string, name: string) =>
    jsonRequest(client, token, "removeReaction", "reactions.remove", {
      channel,
      timestamp: ts,
      name,
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "removeReaction", response)),
      Effect.flatMap((response) =>
        decodeReactionResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("removeReaction", "decode", false, cause, token, {
              status: response.status,
            }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "removeReaction", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  downloadFile: (token: string, file: SlackIngressFileReference) => {
    const mimeType = slackImageMimeType(file.mimeType);
    if (mimeType === undefined) {
      return Effect.fail(
        apiError("downloadFile", "api", false, new Error("unsupported image type"), token, {
          message: "Slack attachment uses an unsupported image type",
        }),
      );
    }
    if (file.size === undefined) {
      return Effect.fail(
        apiError("downloadFile", "api", false, new Error("missing file size"), token, {
          message: "Slack attachment size is unavailable",
        }),
      );
    }
    if (file.size > MAX_SLACK_IMAGE_BYTES) {
      return Effect.fail(
        apiError("downloadFile", "api", false, new Error("file too large"), token, {
          message: "Slack attachment exceeds the 5 MiB limit",
        }),
      );
    }
    if (file.urlPrivate === undefined || !isSlackPrivateFileUrl(file.urlPrivate)) {
      return Effect.fail(
        apiError("downloadFile", "api", false, new Error("invalid private file URL"), token, {
          message: "Slack attachment URL is unavailable",
        }),
      );
    }

    const outgoing = HttpClientRequest.get(file.urlPrivate).pipe(
      HttpClientRequest.bearerToken(token),
    );
    return client.execute(outgoing).pipe(
      Effect.mapError(() =>
        apiError("downloadFile", "network", true, new Error("private file request failed"), token),
      ),
      Effect.flatMap((response) =>
        ensureHttpSuccess(token, "downloadFile", {
          status: response.status,
          body: "",
          retryAfterHeader: response.headers["retry-after"],
        }).pipe(Effect.as(response)),
      ),
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const contentLength = Number(response.headers["content-length"]);
          if (Number.isFinite(contentLength) && contentLength > MAX_SLACK_IMAGE_BYTES) {
            return yield* apiError(
              "downloadFile",
              "api",
              false,
              new Error("content length too large"),
              token,
              { message: "Slack attachment download exceeds the 5 MiB limit" },
            );
          }
          const responseMimeType = response.headers["content-type"]
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (responseMimeType !== mimeType) {
            return yield* apiError(
              "downloadFile",
              "api",
              false,
              new Error("content type mismatch"),
              token,
              { message: "Slack attachment response type does not match its metadata" },
            );
          }
          return yield* response.stream.pipe(
            Stream.runFoldEffect(
              (): SlackDownloadAccumulator => ({ chunks: [], size: 0 }),
              (accumulator, chunk) => {
                const size = accumulator.size + chunk.byteLength;
                if (size > MAX_SLACK_IMAGE_BYTES) {
                  return Effect.fail(
                    apiError("downloadFile", "api", false, new Error("download too large"), token, {
                      message: "Slack attachment download exceeds the 5 MiB limit",
                    }),
                  );
                }
                accumulator.chunks.push(chunk);
                return Effect.succeed({ chunks: accumulator.chunks, size });
              },
            ),
            Effect.mapError((failure) =>
              failure instanceof SlackApiError
                ? failure
                : apiError(
                    "downloadFile",
                    "network",
                    true,
                    new Error("private file body failed"),
                    token,
                  ),
            ),
          );
        }),
      ),
      Effect.map(
        (body): SlackImageContent => ({
          type: "image",
          data: Buffer.concat(
            body.chunks.map((chunk) => Buffer.from(chunk)),
            body.size,
          ).toString("base64"),
          mimeType,
        }),
      ),
    );
  },
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
): Effect.Effect<{ readonly ts: string }, SlackApiError> =>
  withLiveClient((api) => api.postMessage(token, channel, text, threadTs));

export const updateMessage = (
  token: string,
  channel: string,
  ts: string,
  text: string,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.updateMessage(token, channel, ts, text));

export const setStatus = (
  token: string,
  channel: string,
  threadTs: string,
  status: string,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.setStatus(token, channel, threadTs, status));

export const addReaction = (
  token: string,
  channel: string,
  ts: string,
  name: string,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.addReaction(token, channel, ts, name));

export const removeReaction = (
  token: string,
  channel: string,
  ts: string,
  name: string,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.removeReaction(token, channel, ts, name));

export const downloadFile = (
  token: string,
  file: SlackIngressFileReference,
): Effect.Effect<SlackImageContent, SlackApiError> =>
  withLiveClient((api) => api.downloadFile(token, file));

export const connectionsOpen = (
  token: string,
): Effect.Effect<{ readonly url: string }, SlackApiError> =>
  withLiveClient((api) => api.connectionsOpen(token));
