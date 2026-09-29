import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { Effect } from "effect";
import { makeSlackApi, type SlackApi } from "./api/client";
import {
  SlackApiError,
  type SlackImageContent,
  type SlackStartStreamOptions,
  type SlackTaskUpdateChunk,
  type SlackThreadHistory,
} from "./api/protocol";
import type { SlackIngressFileReference } from "../../domain/slack-ingress";

export {
  MAX_SLACK_IMAGE_BYTES,
  SLACK_IMAGE_MIME_TYPES,
  SlackApiError,
  isSlackPrivateFileUrl,
} from "./api/protocol";

export type {
  SlackImageMimeType,
  SlackImageContent,
  SlackThreadMessage,
  SlackThreadHistory,
  SlackTaskStatus,
  SlackTaskUpdateChunk,
  SlackPlanUpdateChunk,
  SlackStreamChunk,
  SlackStartStreamOptions,
  SlackApiOperation,
  SlackApiErrorReason,
} from "./api/protocol";

export { makeSlackApi };

export type { SlackApi };

const withLiveClient = <A, E>(use: (api: SlackApi) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return yield* use(makeSlackApi(client));
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const authTest = (
  token: string,
): Effect.Effect<{ readonly userId: string }, SlackApiError> =>
  withLiveClient((api) => api.authTest(token));

export const getConversation = (
  token: string,
  channel: string,
): Effect.Effect<{ readonly id: string; readonly name?: string | undefined }, SlackApiError> =>
  withLiveClient((api) => api.getConversation(token, channel));

export const postMessage = (
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Effect.Effect<{ readonly ts: string }, SlackApiError> =>
  withLiveClient((api) => api.postMessage(token, channel, text, threadTs));

export const getThreadReplies = (
  token: string,
  channel: string,
  threadTs: string,
  latestTs: string,
): Effect.Effect<SlackThreadHistory, SlackApiError> =>
  withLiveClient((api) => api.getThreadReplies(token, channel, threadTs, latestTs));

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

export const startStream = (
  token: string,
  channel: string,
  threadTs: string,
  options?: SlackStartStreamOptions,
): Effect.Effect<{ readonly ts: string }, SlackApiError> =>
  withLiveClient((api) => api.startStream(token, channel, threadTs, options));

export const appendStream = (
  token: string,
  channel: string,
  ts: string,
  chunks: ReadonlyArray<SlackTaskUpdateChunk>,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.appendStream(token, channel, ts, chunks));

export const stopStream = (
  token: string,
  channel: string,
  ts: string,
): Effect.Effect<void, SlackApiError> =>
  withLiveClient((api) => api.stopStream(token, channel, ts));

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
