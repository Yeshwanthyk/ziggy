import type * as Scope from "effect/Scope";
import type { Effect, Deferred, Semaphore } from "effect";
import type { DiscordApiError, DiscordImageContent } from "../../adapters/discord/api";
import type { DiscordSocket, DiscordSocketError } from "../../adapters/discord/socket";
import type { DiscordIngressAdmission } from "../../adapters/bun/discord-ingress-sqlite";
import type { DiscordGatewayConfig } from "../../domain/discord";
import type {
  DiscordIngressAttachmentReference,
  DiscordIngressDatabaseError,
  DiscordIngressPayload,
  DiscordIngressTerminalState,
} from "../../domain/discord-ingress";
import type {
  DiscordHealthProjectionError,
  DiscordHealthSnapshot,
} from "../../domain/discord-health";
import type { ProfileTarget } from "../../domain/profile";
import type { ChatHandle } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";

export type DiscordGatewayError = DiscordApiError | DiscordIngressDatabaseError;

export interface DiscordChannel {
  readonly id: string;
  readonly type: number;
  readonly name?: string | undefined;
  readonly guild_id?: string | undefined;
  readonly parent_id?: string | null | undefined;
}

export interface DiscordTransport {
  readonly openSocket: (
    token: string,
    intents: number,
  ) => Effect.Effect<DiscordSocket, DiscordSocketError, Scope.Scope>;
  readonly getChannel: (
    token: string,
    channelId: string,
  ) => Effect.Effect<DiscordChannel, DiscordApiError>;
  readonly startThreadFromMessage: (
    token: string,
    channelId: string,
    messageId: string,
    name: string,
  ) => Effect.Effect<DiscordChannel, DiscordApiError>;
  readonly createMessage: (
    token: string,
    channelId: string,
    text: string,
  ) => Effect.Effect<{ readonly id: string }, DiscordApiError>;
  readonly updateMessage: (
    token: string,
    channelId: string,
    messageId: string,
    text: string,
  ) => Effect.Effect<void, DiscordApiError>;
  readonly triggerTyping: (
    token: string,
    channelId: string,
  ) => Effect.Effect<void, DiscordApiError>;
  readonly addReaction: (
    token: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) => Effect.Effect<void, DiscordApiError>;
  readonly removeReaction: (
    token: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) => Effect.Effect<void, DiscordApiError>;
  readonly downloadAttachment?: (
    attachment: DiscordIngressAttachmentReference,
  ) => Effect.Effect<DiscordImageContent, DiscordApiError>;
  readonly ensureCommands?: (
    token: string,
    guildIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, DiscordApiError>;
  readonly respondToInteraction?: (
    interactionId: string,
    interactionToken: string,
    text: string,
  ) => Effect.Effect<void, DiscordApiError>;
}

export interface DiscordGatewayApi {
  readonly runLoop: (
    target: ProfileTarget,
    config: DiscordGatewayConfig,
    registry?: ChatRegistryApi,
  ) => Effect.Effect<never, DiscordGatewayError>;
}

export interface ScheduledDiscordTurn {
  readonly cancellation: Deferred.Deferred<void>;
  readonly generation: number;
  readonly message: DiscordIngressPayload;
  cancelled: boolean;
  terminalAttempted: boolean;
}

export interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  readonly turns: Set<ScheduledDiscordTurn>;
  generation: number;
  handle?: ChatHandle;
  pending: number;
  busyNoticePending: boolean;
}

export interface DiscordHealthRuntime {
  readonly now: () => number;
  readonly waitForHeartbeat: Effect.Effect<void>;
  readonly write: (
    profilePath: string,
    snapshot: DiscordHealthSnapshot,
  ) => Effect.Effect<void, DiscordHealthProjectionError>;
}

export interface DiscordIngressRuntime {
  readonly initialize: (profilePath: string) => Effect.Effect<void, DiscordIngressDatabaseError>;
  readonly admit: (
    profilePath: string,
    payload: DiscordIngressPayload,
    atMs: number,
  ) => Effect.Effect<DiscordIngressAdmission, DiscordIngressDatabaseError>;
  readonly recover: (
    profilePath: string,
    ownerId: string,
  ) => Effect.Effect<void, DiscordIngressDatabaseError>;
  readonly readReplayable: (
    profilePath: string,
  ) => Effect.Effect<ReadonlyArray<DiscordIngressPayload>, DiscordIngressDatabaseError>;
  readonly start: (
    profilePath: string,
    payload: DiscordIngressPayload,
    ownerId: string,
    atMs: number,
  ) => Effect.Effect<boolean, DiscordIngressDatabaseError>;
  readonly requeue: (
    profilePath: string,
    payload: DiscordIngressPayload,
    ownerId: string,
  ) => Effect.Effect<void, DiscordIngressDatabaseError>;
  readonly finish: (
    profilePath: string,
    payload: DiscordIngressPayload,
    ownerId: string,
    state: DiscordIngressTerminalState,
    atMs: number,
  ) => Effect.Effect<void, DiscordIngressDatabaseError>;
}
