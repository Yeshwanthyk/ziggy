import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { SlackIngressFileReference } from "../../../domain/slack-ingress";

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

export interface SlackDownloadAccumulator {
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

const StreamMessageSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  ts: Schema.String,
});

const ReactionSuccess = Schema.Struct({
  ok: Schema.Literal(true),
});

const ConnectionsOpenSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  url: Schema.String,
});

const BoundedThreadFileText = Schema.String.check(Schema.isMaxLength(4_096));

const BoundedThreadFileName = Schema.String.check(Schema.isMaxLength(512));

export const ThreadReplyFile = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  name: Schema.optional(BoundedThreadFileName),
  title: Schema.optional(BoundedThreadFileName),
  mimetype: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  url_private: Schema.optional(BoundedThreadFileText),
  url_private_download: Schema.optional(BoundedThreadFileText),
});

const ThreadReply = Schema.Struct({
  ts: Schema.String,
  text: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.Unknown)),
});

const ThreadRepliesSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  messages: Schema.Array(ThreadReply),
  has_more: Schema.optional(Schema.Boolean),
  response_metadata: Schema.optional(
    Schema.Struct({
      next_cursor: Schema.optional(Schema.String),
    }),
  ),
});

const ConversationInfoSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  channel: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
  }),
});

const SlackFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
});

export const decodeAuthTestResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([AuthTestSuccess, SlackFailure])),
);

export const decodePostMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([PostMessageSuccess, SlackFailure])),
);

export const decodeUpdateMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([UpdateMessageSuccess, SlackFailure])),
);

export const decodeSetStatusResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([SetStatusSuccess, SlackFailure])),
);

export const decodeStreamMessageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([StreamMessageSuccess, SlackFailure])),
);

export const decodeReactionResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ReactionSuccess, SlackFailure])),
);

export const decodeConnectionsOpenResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ConnectionsOpenSuccess, SlackFailure])),
);

export const decodeThreadRepliesResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ThreadRepliesSuccess, SlackFailure])),
);

export const decodeConversationInfoResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ConversationInfoSuccess, SlackFailure])),
);

export const decodeThreadReplyFile = Schema.decodeUnknownEffect(ThreadReplyFile);

export const MAX_SLACK_THREAD_MESSAGES = 200;

export const SLACK_THREAD_PAGE_SIZE = 100;

export const MAX_SLACK_THREAD_FILES_PER_MESSAGE = 4;

export const MAX_SLACK_THREAD_FILES_TO_DECODE = 20;

export interface SlackThreadMessage {
  readonly ts: string;
  readonly text: string;
  readonly userId?: string;
  readonly botId?: string;
  readonly files?: ReadonlyArray<SlackIngressFileReference>;
  readonly omittedFileCount?: number;
}

export interface SlackThreadHistory {
  readonly messages: ReadonlyArray<SlackThreadMessage>;
  readonly truncated: boolean;
}

export type SlackTaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface SlackTaskUpdateChunk {
  readonly type: "task_update";
  readonly id: string;
  readonly title: string;
  readonly status: SlackTaskStatus;
  readonly details?: string;
}

export interface SlackPlanUpdateChunk {
  readonly type: "plan_update";
  readonly title: string;
}

export type SlackStreamChunk = SlackTaskUpdateChunk | SlackPlanUpdateChunk;

export interface SlackStartStreamOptions {
  readonly chunks?: ReadonlyArray<SlackStreamChunk>;
  readonly recipientUserId?: string;
  readonly recipientTeamId?: string;
}

const SLACK_STREAM_ID_LIMIT = 32;

const SLACK_STREAM_TITLE_LIMIT = 80;

const SLACK_STREAM_DETAILS_LIMIT = 120;

const boundedStreamText = (value: string, maximum: number): string =>
  [...value].slice(0, maximum).join("");

export const encodeStreamChunk = (chunk: SlackStreamChunk) =>
  chunk.type === "plan_update"
    ? {
        type: "plan_update" as const,
        title: boundedStreamText(chunk.title, SLACK_STREAM_TITLE_LIMIT),
      }
    : {
        type: "task_update" as const,
        id: boundedStreamText(chunk.id, SLACK_STREAM_ID_LIMIT),
        title: boundedStreamText(chunk.title, SLACK_STREAM_TITLE_LIMIT),
        status: chunk.status,
        ...(chunk.details !== undefined
          ? { details: boundedStreamText(chunk.details, SLACK_STREAM_DETAILS_LIMIT) }
          : undefined),
      };

export type SlackApiOperation =
  | "authTest"
  | "getConversation"
  | "getThreadReplies"
  | "postMessage"
  | "updateMessage"
  | "setStatus"
  | "startStream"
  | "appendStream"
  | "stopStream"
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
    "getConversation",
    "getThreadReplies",
    "postMessage",
    "updateMessage",
    "setStatus",
    "startStream",
    "appendStream",
    "stopStream",
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

interface SlackApiErrorOptions {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly message?: string;
}

export const apiError = (
  operation: SlackApiOperation,
  reason: SlackApiErrorReason,
  retriable: boolean,
  cause: unknown,
  token: string,
  options?: SlackApiErrorOptions,
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
    ...(options?.status !== undefined ? { status: options.status } : undefined),
    ...(options?.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: options.retryAfterSeconds }
      : undefined),
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
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined),
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

/** Bounds a stalled transport so turn delivery and shutdown cannot wait on it forever. */
const slackRequestTimeout = "30 seconds";

export const request = (
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
    Effect.timeout(slackRequestTimeout),
    Effect.mapError((cause) => apiError(operation, "network", true, cause, token)),
  );
};

type SlackPostMessageBody = { channel: string; markdown_text: string; thread_ts?: string };

type SlackEncodedStreamChunk =
  | ReturnType<typeof encodeStreamChunk>
  | { readonly type: "markdown_text"; readonly text: string };

/**
 * Slack rejects `markdown_text` beside `chunks` (`cannot_provide_both_markdown_text_and_chunks`),
 * so text rides as a trailing `markdown_text` chunk whenever there are other chunks.
 */
export const encodeStreamContent = (
  chunks: ReadonlyArray<SlackStreamChunk> | undefined,
  markdownText: string | undefined,
): { chunks: ReadonlyArray<SlackEncodedStreamChunk> } | { markdown_text: string } | undefined => {
  const encoded: Array<SlackEncodedStreamChunk> = (chunks ?? []).map(encodeStreamChunk);

  if (encoded.length === 0)
    return markdownText === undefined ? undefined : { markdown_text: markdownText };

  if (markdownText !== undefined) encoded.push({ type: "markdown_text", text: markdownText });

  return { chunks: encoded };
};

type SlackStartStreamBody = {
  channel: string;
  thread_ts: string;
  task_display_mode: "plan";
  chunks?: ReadonlyArray<SlackEncodedStreamChunk>;
  recipient_user_id?: string;
  recipient_team_id?: string;
};

type SlackAppendStreamBody = {
  channel: string;
  ts: string;
  chunks?: ReadonlyArray<SlackEncodedStreamChunk>;
  markdown_text?: string;
};

type SlackStopStreamBody = {
  channel: string;
  ts: string;
  markdown_text?: string;
  chunks?: ReadonlyArray<SlackEncodedStreamChunk>;
};

type SlackJsonRequestBody =
  | Record<string, never>
  | SlackPostMessageBody
  | SlackStartStreamBody
  | SlackAppendStreamBody
  | SlackStopStreamBody
  | { channel: string; ts: string; markdown_text: string }
  | { channel_id: string; thread_ts: string; status: string }
  | { channel: string; timestamp: string; name: string };

export const jsonRequest = (
  client: HttpClient.HttpClient,
  token: string,
  operation: SlackApiOperation,
  method: string,
  body: SlackJsonRequestBody,
): Effect.Effect<RawResponse, SlackApiError> =>
  request(client, token, operation, method, {
    body: JSON.stringify(body),
    contentType: "application/json; charset=utf-8",
  });

export const queryRequest = (
  client: HttpClient.HttpClient,
  token: string,
  operation: SlackApiOperation,
  method: string,
  parameters: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<RawResponse, SlackApiError> => {
  const url = new URL(`https://slack.com/api/${method}`);

  for (const [key, value] of parameters) url.searchParams.set(key, value);
  const outgoing = HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.bearerToken(token));

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
    Effect.timeout(slackRequestTimeout),
    Effect.mapError((cause) => apiError(operation, "network", true, cause, token)),
  );
};

export const ensureHttpSuccess = (
  token: string,
  operation: SlackApiOperation,
  response: RawResponse,
): Effect.Effect<RawResponse, SlackApiError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(classifyHttpFailure(operation, response, token));

export const slackFailure = (
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
        : undefined),
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

export const slackImageMimeType = (value: string | undefined): SlackImageMimeType | undefined =>
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
