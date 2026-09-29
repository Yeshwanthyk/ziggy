import type * as Scope from "effect/Scope";
import type { Effect, Deferred, Semaphore } from "effect";
import type {
  SlackApiError,
  SlackImageContent,
  SlackStartStreamOptions,
  SlackStreamChunk,
  SlackThreadHistory,
} from "../../adapters/slack/api";
import type {
  SlackSocket,
  SlackSocketError,
  SlackSocketInboundAdmit,
} from "../../adapters/slack/socket";
import type { SlackGatewayConfig } from "../../domain/slack";
import type {
  SlackIngressDatabaseError,
  SlackIngressFileReference,
  SlackIngressPayload,
  SlackIngressRecord,
  SlackIngressTerminalState,
} from "../../domain/slack-ingress";
import type { SlackHealthProjectionError, SlackHealthSnapshot } from "../../domain/slack-health";
import type { ProfileTarget } from "../../domain/profile";
import type { ChatHandle } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";

export type SlackGatewayError = SlackApiError | SlackIngressDatabaseError;

export interface SlackTransport {
  readonly authTest: (token: string) => Effect.Effect<{ readonly userId: string }, SlackApiError>;
  readonly getConversation?: (
    token: string,
    channel: string,
  ) => Effect.Effect<{ readonly id: string; readonly name?: string | undefined }, SlackApiError>;
  readonly openSocket: (
    appToken: string,
    admitInbound?: SlackSocketInboundAdmit,
  ) => Effect.Effect<SlackSocket, SlackSocketError, Scope.Scope>;
  readonly postMessage: (
    token: string,
    channel: string,
    text: string,
    threadTs?: string,
  ) => Effect.Effect<{ readonly ts: string }, SlackApiError>;
  readonly getThreadReplies: (
    token: string,
    channel: string,
    threadTs: string,
    latestTs: string,
  ) => Effect.Effect<SlackThreadHistory, SlackApiError>;
  readonly updateMessage: (
    token: string,
    channel: string,
    ts: string,
    text: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly setStatus: (
    token: string,
    channel: string,
    threadTs: string,
    status: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly startStream?: (
    token: string,
    channel: string,
    threadTs: string,
    options?: SlackStartStreamOptions,
  ) => Effect.Effect<{ readonly ts: string }, SlackApiError>;
  readonly appendStream?: (
    token: string,
    channel: string,
    ts: string,
    chunks: ReadonlyArray<SlackStreamChunk>,
    markdownText?: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly stopStream?: (
    token: string,
    channel: string,
    ts: string,
    markdownText?: string,
    chunks?: ReadonlyArray<SlackStreamChunk>,
  ) => Effect.Effect<void, SlackApiError>;
  readonly addReaction: (
    token: string,
    channel: string,
    ts: string,
    name: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly removeReaction: (
    token: string,
    channel: string,
    ts: string,
    name: string,
  ) => Effect.Effect<void, SlackApiError>;
  readonly downloadFile?: (
    token: string,
    file: SlackIngressFileReference,
  ) => Effect.Effect<SlackImageContent, SlackApiError>;
}

export interface SlackGatewayApi {
  readonly runLoop: (
    target: ProfileTarget,
    config: SlackGatewayConfig,
    registry?: ChatRegistryApi,
  ) => Effect.Effect<never, SlackGatewayError>;
}

export interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  readonly statusSemaphore: Semaphore.Semaphore;
  readonly turns: Set<ScheduledSlackTurn>;
  generation: number;
  handle?: ChatHandle;
  activeMessage?: SlackIngressPayload;
  progressSink?: (excerpt: string) => void;
  pending: number;
  busyNoticePending: boolean;
}

export interface ScheduledSlackTurn {
  readonly cancellation: Deferred.Deferred<void>;
  readonly generation: number;
  readonly message: SlackIngressPayload;
  cancelled: boolean;
  terminalAttempted: boolean;
}

export interface SlackIngressRuntime {
  readonly initialize: (profilePath: string) => Effect.Effect<void, SlackIngressDatabaseError>;
  readonly recover: (
    profilePath: string,
    ownerId: string,
  ) => Effect.Effect<void, SlackIngressDatabaseError>;
  readonly replayable: (
    profilePath: string,
  ) => Effect.Effect<ReadonlyArray<SlackIngressRecord>, SlackIngressDatabaseError>;
  readonly admit: (
    profilePath: string,
    record: SlackIngressRecord,
    atMs: number,
  ) => Effect.Effect<"accepted" | "duplicate", SlackIngressDatabaseError>;
  readonly start: (
    profilePath: string,
    payload: SlackIngressPayload,
    ownerId: string,
    atMs: number,
  ) => Effect.Effect<boolean, SlackIngressDatabaseError>;
  readonly finish: (
    profilePath: string,
    payload: SlackIngressPayload,
    ownerId: string,
    state: SlackIngressTerminalState,
    atMs: number,
  ) => Effect.Effect<void, SlackIngressDatabaseError>;
}

export interface SlackHealthRuntime {
  readonly now: () => number;
  readonly waitForHeartbeat: Effect.Effect<void>;
  readonly write: (
    profilePath: string,
    snapshot: SlackHealthSnapshot,
  ) => Effect.Effect<void, SlackHealthProjectionError>;
}
