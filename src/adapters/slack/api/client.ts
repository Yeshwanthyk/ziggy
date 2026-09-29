import { Effect, Option, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { SlackIngressFileReference } from "../../../domain/slack-ingress";
import {
  MAX_SLACK_IMAGE_BYTES,
  MAX_SLACK_THREAD_FILES_PER_MESSAGE,
  MAX_SLACK_THREAD_FILES_TO_DECODE,
  MAX_SLACK_THREAD_MESSAGES,
  SLACK_THREAD_PAGE_SIZE,
  SlackApiError,
  type SlackDownloadAccumulator,
  type SlackImageContent,
  type SlackStartStreamOptions,
  type SlackTaskUpdateChunk,
  type SlackThreadHistory,
  type SlackThreadMessage,
  ThreadReplyFile,
  apiError,
  decodeAuthTestResponse,
  decodeConnectionsOpenResponse,
  decodeConversationInfoResponse,
  decodePostMessageResponse,
  decodeReactionResponse,
  decodeSetStatusResponse,
  decodeStreamMessageResponse,
  decodeThreadRepliesResponse,
  decodeThreadReplyFile,
  decodeUpdateMessageResponse,
  encodeStreamChunk,
  ensureHttpSuccess,
  isSlackPrivateFileUrl,
  jsonRequest,
  queryRequest,
  request,
  slackFailure,
  slackImageMimeType,
} from "./protocol";

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
  getConversation: (token: string, channel: string) =>
    queryRequest(client, token, "getConversation", "conversations.info", [
      ["channel", channel],
    ]).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "getConversation", response)),
      Effect.flatMap((response) =>
        decodeConversationInfoResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("getConversation", "decode", false, cause, token, {
              status: response.status,
            }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.succeed(envelope.channel)
              : Effect.fail(
                  slackFailure(token, "getConversation", envelope.error, response.status),
                ),
          ),
        ),
      ),
    ),
  getThreadReplies: (token: string, channel: string, threadTs: string, latestTs: string) =>
    Effect.gen(function* () {
      const messages: Array<SlackThreadMessage> = [];
      const seenMessageTimestamps = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let truncated = false;

      while (messages.length < MAX_SLACK_THREAD_MESSAGES) {
        const response = yield* queryRequest(
          client,
          token,
          "getThreadReplies",
          "conversations.replies",
          [
            ["channel", channel],
            ["ts", threadTs],
            ["latest", latestTs],
            ["inclusive", "false"],
            ["limit", String(SLACK_THREAD_PAGE_SIZE)],
            ...(cursor === undefined ? [] : [["cursor", cursor] as const]),
          ],
        ).pipe(Effect.flatMap((raw) => ensureHttpSuccess(token, "getThreadReplies", raw)));

        const envelope = yield* decodeThreadRepliesResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("getThreadReplies", "decode", false, cause, token, {
              status: response.status,
            }),
          ),
        );

        if (!envelope.ok) {
          return yield* slackFailure(token, "getThreadReplies", envelope.error, response.status);
        }

        for (const message of envelope.messages) {
          if (seenMessageTimestamps.has(message.ts)) continue;

          if (messages.length >= MAX_SLACK_THREAD_MESSAGES) {
            truncated = true;
            break;
          }

          seenMessageTimestamps.add(message.ts);
          const rawFiles = message.files ?? [];
          const decodedFiles: Array<typeof ThreadReplyFile.Type> = [];

          for (const rawFile of rawFiles.slice(0, MAX_SLACK_THREAD_FILES_TO_DECODE)) {
            const decodedFile = yield* decodeThreadReplyFile(rawFile).pipe(Effect.option);

            if (Option.isSome(decodedFile)) decodedFiles.push(decodedFile.value);
          }

          const files = decodedFiles
            .slice(0, MAX_SLACK_THREAD_FILES_PER_MESSAGE)
            .map((file): SlackIngressFileReference => {
              const name = file.name ?? file.title;
              const urlPrivate = file.url_private_download ?? file.url_private;

              return {
                id: file.id,
                ...(name !== undefined ? { name } : undefined),
                ...(file.mimetype !== undefined ? { mimeType: file.mimetype } : undefined),
                ...(file.size !== undefined ? { size: file.size } : undefined),
                ...(urlPrivate !== undefined ? { urlPrivate } : undefined),
              };
            });

          messages.push({
            ts: message.ts,
            text: message.text ?? "",
            ...(message.user !== undefined ? { userId: message.user } : undefined),
            ...(message.bot_id !== undefined ? { botId: message.bot_id } : undefined),
            ...(files.length > 0 ? { files } : undefined),
            ...(rawFiles.length > files.length
              ? { omittedFileCount: rawFiles.length - files.length }
              : undefined),
          });
        }

        const nextCursor = envelope.response_metadata?.next_cursor?.trim();

        if (nextCursor === undefined || nextCursor.length === 0) {
          truncated ||= envelope.has_more === true;
          break;
        }

        if (seenCursors.has(nextCursor)) {
          truncated = true;
          break;
        }

        if (messages.length >= MAX_SLACK_THREAD_MESSAGES) {
          truncated = true;
          break;
        }

        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      return { messages, truncated } satisfies SlackThreadHistory;
    }),
  postMessage: (token: string, channel: string, text: string, threadTs?: string) =>
    jsonRequest(client, token, "postMessage", "chat.postMessage", {
      channel,
      markdown_text: text,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : undefined),
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
  startStream: (
    token: string,
    channel: string,
    threadTs: string,
    options?: SlackStartStreamOptions,
  ) =>
    jsonRequest(client, token, "startStream", "chat.startStream", {
      channel,
      thread_ts: threadTs,
      task_display_mode: "plan",
      ...(options?.chunks !== undefined
        ? { chunks: options.chunks.map(encodeStreamChunk) }
        : undefined),
      ...(options?.recipientUserId !== undefined
        ? { recipient_user_id: options.recipientUserId }
        : undefined),
      ...(options?.recipientTeamId !== undefined
        ? { recipient_team_id: options.recipientTeamId }
        : undefined),
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "startStream", response)),
      Effect.flatMap((response) =>
        decodeStreamMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("startStream", "decode", false, cause, token, { status: response.status }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.succeed({ ts: envelope.ts })
              : Effect.fail(slackFailure(token, "startStream", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  appendStream: (
    token: string,
    channel: string,
    ts: string,
    chunks: ReadonlyArray<SlackTaskUpdateChunk>,
  ) =>
    jsonRequest(client, token, "appendStream", "chat.appendStream", {
      channel,
      ts,
      chunks: chunks.map(encodeStreamChunk),
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "appendStream", response)),
      Effect.flatMap((response) =>
        decodeStreamMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("appendStream", "decode", false, cause, token, { status: response.status }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "appendStream", envelope.error, response.status)),
          ),
        ),
      ),
    ),
  stopStream: (token: string, channel: string, ts: string) =>
    jsonRequest(client, token, "stopStream", "chat.stopStream", {
      channel,
      ts,
    }).pipe(
      Effect.flatMap((response) => ensureHttpSuccess(token, "stopStream", response)),
      Effect.flatMap((response) =>
        decodeStreamMessageResponse(response.body).pipe(
          Effect.mapError((cause) =>
            apiError("stopStream", "decode", false, cause, token, { status: response.status }),
          ),
          Effect.flatMap((envelope) =>
            envelope.ok
              ? Effect.void
              : Effect.fail(slackFailure(token, "stopStream", envelope.error, response.status)),
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
