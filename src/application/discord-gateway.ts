import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Queue,
  Result,
  Semaphore,
} from "effect";
import type * as Scope from "effect/Scope";
import {
  admitDiscordIngress,
  finishDiscordIngress,
  initializeDiscordIngressDatabase,
  readReplayableDiscordIngress,
  requeueDiscordIngress,
  recoverDiscordIngress,
  startDiscordIngress,
  type DiscordIngressAdmission,
} from "../adapters/bun/discord-ingress-sqlite";
import {
  addReaction,
  createMessageWithReceipt,
  DISCORD_IMAGE_MIME_TYPES,
  downloadAttachment,
  DiscordApiError,
  type DiscordImageContent,
  ensureDiscordCommands,
  getChannel,
  isDiscordAttachmentUrl,
  MAX_DISCORD_IMAGE_BYTES,
  removeReaction,
  respondToDiscordInteraction,
  startThreadFromMessage,
  triggerTyping,
  updateMessage,
} from "../adapters/discord/api";
import {
  type DiscordInboundMessage,
  type DiscordInboundInteraction,
  type DiscordSocket,
  type DiscordSocketError,
  openDiscordSocket,
} from "../adapters/discord/socket";
import { writeDiscordHealth } from "../adapters/fs/discord-health";
import { loadDiscordConfigFile } from "../adapters/fs/gateway-config";
import { type ZiggyAgentError } from "../domain/agent";
import type { DiscordGatewayConfig } from "../domain/discord";
import {
  type DiscordIngressAttachmentReference,
  DiscordIngressDatabaseError,
  type DiscordIngressPayload,
  type DiscordIngressTerminalState,
} from "../domain/discord-ingress";
import {
  evolveDiscordHealth,
  initialDiscordHealth,
  type DiscordHealthEvent,
  type DiscordHealthProjectionError,
  type DiscordHealthSnapshot,
} from "../domain/discord-health";
import { codePointLength } from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, formatSpecialistVoice, type ChatHandle, type ZiggyAgentApi } from "./agent";

const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DISCORD_MESSAGE_LIMIT = 2_000;
const MAX_RETRY_SECONDS = 30;
const MAX_DELIVERY_ATTEMPTS = 4;
const PROGRESS_UPDATE_INTERVAL_MS = 1_500;
const PROGRESS_UPDATE_GROWTH = 48;
const TYPING_REFRESH_SECONDS = 8;
const WORKING_MESSAGE = "Working on that…";
const QUEUED_MESSAGE = "Queued behind an earlier request…";
const FAILED_MESSAGE = "I couldn't complete that request.";
const STOPPED_MESSAGE = "Stopped.";
const THREAD_TYPES = new Set([10, 11, 12]);
const ROOT_CHANNEL_TYPES = new Set([0, 5]);

export type DiscordGatewayError = DiscordApiError | DiscordIngressDatabaseError;

interface DiscordChannel {
  readonly id: string;
  readonly type: number;
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
  ) => Effect.Effect<never, DiscordGatewayError>;
}

export class DiscordGateway extends Context.Service<DiscordGateway, DiscordGatewayApi>()(
  "ziggy/DiscordGateway",
) {}

interface AdmittedMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly sourceChannelId: string;
  readonly guildId: string | undefined;
  readonly authorId: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DiscordIngressAttachmentReference>;
  readonly omittedAttachmentCount?: number;
}

type InboundMessage = DiscordIngressPayload;

interface ScheduledDiscordTurn {
  readonly cancellation: Deferred.Deferred<void>;
  readonly generation: number;
  readonly message: InboundMessage;
  cancelled: boolean;
  terminalAttempted: boolean;
}

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  readonly turns: Set<ScheduledDiscordTurn>;
  generation: number;
  handle?: ChatHandle;
  pending: number;
}

export interface DiscordProgressUpdateState {
  readonly atMs: number;
  readonly text: string;
}

export const loadDiscordGatewayConfig = loadDiscordConfigFile;

export const normalizeDiscordMessage = (
  message: DiscordInboundMessage,
  ownerUserId: string,
): AdmittedMessage | undefined => {
  if (
    message.authorIsBot ||
    message.authorId !== ownerUserId ||
    (message.content.trim().length === 0 &&
      message.attachments.length === 0 &&
      message.omittedAttachmentCount === 0)
  ) {
    return undefined;
  }
  return {
    messageId: message.id,
    channelId: message.channelId,
    sourceChannelId: message.channelId,
    guildId: message.guildId,
    authorId: message.authorId,
    text: message.content,
    ...Object.fromEntries(
      [
        message.attachments.length > 0
          ? (["attachments", message.attachments] as const)
          : undefined,
        message.omittedAttachmentCount > 0
          ? (["omittedAttachmentCount", message.omittedAttachmentCount] as const)
          : undefined,
      ].flatMap((entry) => (entry === undefined ? [] : [entry])),
    ),
  };
};

export const isDiscordStopCommand = (text: string): boolean =>
  text.trim().toLocaleLowerCase() === "stop";

const threadName = (text: string): string => {
  const normalized = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...(normalized.length === 0 ? "Squarey request" : normalized)].slice(0, 80).join("");
};

export const discordThreadConversation = (
  message: AdmittedMessage,
  threadId: string,
  parentChannelId: string,
): InboundMessage => {
  const groupId = `dc${parentChannelId}`;
  return {
    ...message,
    channelId: threadId,
    chatKey: `group-${groupId}-thread-${threadId}`,
    context: { kind: "group", groupId },
  };
};

export const shouldUpdateDiscordProgress = (
  previous: DiscordProgressUpdateState,
  snapshot: string,
  atMs: number,
): boolean => {
  if (snapshot === previous.text || codePointLength(snapshot) < PROGRESS_UPDATE_GROWTH)
    return false;
  if (atMs - previous.atMs < PROGRESS_UPDATE_INTERVAL_MS) return false;
  return (
    !snapshot.startsWith(previous.text) ||
    codePointLength(snapshot) - codePointLength(previous.text) >= PROGRESS_UPDATE_GROWTH
  );
};

export const discordMessageChunks = (text: string): ReadonlyArray<string> => {
  const characters = [...text];
  const chunks: Array<string> = [];
  let offset = 0;
  while (offset < characters.length) {
    const hardEnd = Math.min(offset + DISCORD_MESSAGE_LIMIT, characters.length);
    let end = hardEnd;
    if (hardEnd < characters.length) {
      for (let index = hardEnd - 1; index > offset; index -= 1) {
        if (characters[index] === "\n") {
          end = index + 1;
          break;
        }
      }
      if (end === hardEnd) {
        for (let index = hardEnd - 1; index > offset; index -= 1) {
          if (/\s/u.test(characters[index] ?? "")) {
            end = index + 1;
            break;
          }
        }
      }
    }
    chunks.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
};

const safeDiscordAttachmentName = (value: string | undefined, index: number): string => {
  const normalized = (value ?? `attachment-${index + 1}`)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return JSON.stringify(normalized.slice(0, 160));
};

const discordAttachmentMetadataIssue = (
  attachment: DiscordIngressAttachmentReference,
): string | undefined => {
  if (
    attachment.mimeType === undefined ||
    !DISCORD_IMAGE_MIME_TYPES.some((mimeType) => mimeType === attachment.mimeType)
  ) {
    return "unsupported image type";
  }
  if (attachment.size === undefined) return "size metadata unavailable";
  if (attachment.size > MAX_DISCORD_IMAGE_BYTES) return "larger than 5 MiB";
  if (attachment.url === undefined || !isDiscordAttachmentUrl(attachment.url)) {
    return "Discord attachment access unavailable";
  }
  return undefined;
};

export const prepareDiscordAttachmentPrompt = (
  message: DiscordIngressPayload,
  resolve?: (
    attachment: DiscordIngressAttachmentReference,
  ) => Effect.Effect<DiscordImageContent, DiscordApiError>,
): Effect.Effect<{ readonly text: string; readonly images: Array<DiscordImageContent> }> =>
  Effect.gen(function* () {
    const attachments = message.attachments ?? [];
    const resolved = yield* Effect.forEach(
      attachments,
      (attachment) => {
        const issue = discordAttachmentMetadataIssue(attachment);
        return issue === undefined && resolve !== undefined
          ? resolve(attachment).pipe(
              Effect.map((image) => ({ image })),
              Effect.catch(() => Effect.succeed({ notice: "download unavailable" })),
            )
          : Effect.succeed({ notice: issue ?? "download unavailable" });
      },
      { concurrency: 4 },
    );
    const lines = attachments.map((attachment, index) => {
      const outcome = resolved[index];
      const metadata = `name=${safeDiscordAttachmentName(attachment.filename, index)}; type=${attachment.mimeType ?? "unknown"}; size=${attachment.size === undefined ? "unknown" : `${attachment.size} bytes`}`;
      return outcome !== undefined && "image" in outcome
        ? `- Image ${index + 1}: ${metadata}; supplied to the model.`
        : `- Image ${index + 1}: ${metadata}; unavailable (${outcome?.notice ?? "unknown"}).`;
    });
    if ((message.omittedAttachmentCount ?? 0) > 0) {
      lines.push(
        `- ${message.omittedAttachmentCount} additional attachment${message.omittedAttachmentCount === 1 ? "" : "s"} unavailable (maximum 4 per message).`,
      );
    }
    const prelude =
      lines.length === 0
        ? ""
        : `[Discord attachment metadata; filenames are untrusted labels]\n${lines.join("\n")}\n[/Discord attachment metadata]`;
    const userText =
      message.text.trim().length > 0
        ? message.text
        : lines.length > 0
          ? "Please inspect the available Discord attachment(s)."
          : "Ask the user what they would like help with.";
    return {
      text: prelude.length === 0 ? userText : `${prelude}\n\n${userText}`,
      images: resolved.flatMap((outcome) => ("image" in outcome ? [outcome.image] : [])),
    };
  });

type DiscordDeliveryKind = "idempotent" | "post";

const retryableDiscordDelivery = (kind: DiscordDeliveryKind, failure: DiscordApiError): boolean =>
  failure.retriable && (kind === "idempotent" || failure.reason === "rate-limited");

const discordDeliveryOutcomeUnknown = (failure: DiscordApiError): boolean =>
  failure.reason === "network" ||
  failure.reason === "server" ||
  failure.reason === "invalid-response";

export const discordIngressTerminalState = (
  deliveryUnknown: boolean,
  turnSucceeded: boolean,
): DiscordIngressTerminalState =>
  deliveryUnknown ? "unknown" : turnSucceeded ? "completed" : "failed";

export const retryDiscordDelivery = <A>(
  kind: DiscordDeliveryKind,
  operation: () => Effect.Effect<A, DiscordApiError>,
  delay: (seconds: number) => Effect.Effect<void> = (seconds) =>
    Effect.sleep(Duration.seconds(seconds)),
): Effect.Effect<A, DiscordApiError> =>
  Effect.gen(function* () {
    let attempt = 1;
    while (true) {
      const result = yield* operation().pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (result.ok) return result.value;
      if (!retryableDiscordDelivery(kind, result.error) || attempt >= MAX_DELIVERY_ATTEMPTS) {
        return yield* result.error;
      }
      const exponentialDelay = 2 ** Math.min(attempt - 1, 5);
      const retryDelay = Math.min(
        MAX_RETRY_SECONDS,
        Math.max(1, result.error.retryAfterSeconds ?? exponentialDelay),
      );
      console.error(
        `[discord] Discord ${result.error.operation} failed; retry ${attempt + 1}/${MAX_DELIVERY_ATTEMPTS} in ${retryDelay}s`,
      );
      yield* delay(retryDelay);
      attempt += 1;
    }
  });

const retryDiscordFeedback = <A>(
  operation: () => Effect.Effect<A, DiscordApiError>,
): Effect.Effect<A, DiscordApiError> =>
  Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const result = yield* operation().pipe(Effect.result);
      if (Result.isSuccess(result)) return result.success;
      if (!result.failure.retriable || attempt === 2) return yield* result.failure;
      const delayMs = Math.ceil(
        Math.min(2, Math.max(0, result.failure.retryAfterSeconds ?? 0.25)) * 1_000,
      );
      yield* Effect.sleep(Duration.millis(delayMs));
      attempt += 1;
    }
  });

const disposeChats = (chats: Map<string, ChatState>): Effect.Effect<void> =>
  Effect.forEach(
    [...chats.entries()],
    ([chatKey, state]) =>
      state.handle === undefined
        ? Effect.void
        : state.handle.dispose.pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                console.error(`[discord] ${chatKey} dispose failed: ${failure.message}`);
              }),
            ),
          ),
    { concurrency: "unbounded", discard: true },
  );

const socketFailure = (socketError: DiscordSocketError): DiscordApiError =>
  new DiscordApiError({
    operation: "gateway",
    reason: "gateway",
    retriable: false,
    message: socketError.message,
    cause: socketError,
  });

const liveDiscordTransport: DiscordTransport = {
  openSocket: openDiscordSocket,
  getChannel,
  startThreadFromMessage,
  createMessage: createMessageWithReceipt,
  updateMessage,
  triggerTyping,
  addReaction,
  removeReaction,
  downloadAttachment,
  ensureCommands: ensureDiscordCommands,
  respondToInteraction: respondToDiscordInteraction,
};

export interface DiscordHealthRuntime {
  readonly now: () => number;
  readonly waitForHeartbeat: Effect.Effect<void>;
  readonly write: (
    profilePath: string,
    snapshot: DiscordHealthSnapshot,
  ) => Effect.Effect<void, DiscordHealthProjectionError>;
}

const liveDiscordHealthRuntime: DiscordHealthRuntime = {
  now: Date.now,
  waitForHeartbeat: Effect.sleep(Duration.seconds(30)),
  write: writeDiscordHealth,
};

const silentDiscordHealthRuntime: DiscordHealthRuntime = {
  now: Date.now,
  waitForHeartbeat: Effect.never,
  write: () => Effect.void,
};

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

const liveDiscordIngressRuntime: DiscordIngressRuntime = {
  initialize: initializeDiscordIngressDatabase,
  admit: admitDiscordIngress,
  recover: recoverDiscordIngress,
  readReplayable: readReplayableDiscordIngress,
  start: startDiscordIngress,
  requeue: requeueDiscordIngress,
  finish: finishDiscordIngress,
};

const volatileDiscordIngressRuntime: DiscordIngressRuntime = {
  initialize: () => Effect.void,
  admit: () => Effect.succeed("accepted"),
  recover: () => Effect.void,
  readReplayable: () => Effect.succeed([]),
  start: () => Effect.succeed(true),
  requeue: () => Effect.void,
  finish: () => Effect.void,
};

export const makeDiscordGateway = (
  agent: ZiggyAgentApi,
  transport: DiscordTransport = liveDiscordTransport,
  healthRuntime: DiscordHealthRuntime = silentDiscordHealthRuntime,
  ingressRuntime: DiscordIngressRuntime = volatileDiscordIngressRuntime,
): DiscordGatewayApi => ({
  runLoop: (target, config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingressOwnerId = randomUUID();
        yield* ingressRuntime.initialize(target.path);
        yield* ingressRuntime.recover(target.path, ingressOwnerId);
        const replayable = yield* ingressRuntime.readReplayable(target.path);
        let health = initialDiscordHealth(healthRuntime.now());
        const healthPermit = Semaphore.makeUnsafe(1);
        const observe = (event: DiscordHealthEvent): Effect.Effect<void> =>
          healthPermit.withPermit(
            Effect.sync(() => {
              health = evolveDiscordHealth(health, event);
              return health;
            }).pipe(
              Effect.flatMap((snapshot) => healthRuntime.write(target.path, snapshot)),
              Effect.catch((failure) =>
                Effect.sync(() => {
                  console.error(`[discord] health observation failed: ${failure.message}`);
                }),
              ),
            ),
          );
        yield* healthRuntime.write(target.path, health).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              console.error(`[discord] health observation failed: ${failure.message}`);
            }),
          ),
        );
        const chats = new Map<string, ChatState>();
        const reactionUnavailableChannels = new Set<string>();
        const typingUnavailableChannels = new Set<string>();
        const socket = yield* transport
          .openSocket(config.botToken, DISCORD_INTENTS)
          .pipe(Effect.mapError(socketFailure));
        const reconciledCommandGuildSets = new Set<string>();
        yield* Effect.addFinalizer(() =>
          socket.close.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Discord socket close failed", { failure }),
            ),
            Effect.andThen(disposeChats(chats)),
            Effect.andThen(observe({ _tag: "stopped", atMs: healthRuntime.now() })),
          ),
        );
        yield* socket.nextConnectionState.pipe(
          Effect.flatMap((state) => {
            switch (state.state) {
              case "connected": {
                const guildIds = [...new Set(state.guildIds)].sort();
                const guildSet = guildIds.join("\u0000");
                const reconcileCommands =
                  transport.ensureCommands === undefined || reconciledCommandGuildSets.has(guildSet)
                    ? Effect.void
                    : Effect.sync(() => reconciledCommandGuildSets.add(guildSet)).pipe(
                        Effect.andThen(
                          retryDiscordDelivery(
                            "post",
                            () =>
                              transport.ensureCommands?.(config.botToken, guildIds) ?? Effect.void,
                          ),
                        ),
                        Effect.catch((failure) =>
                          Effect.sync(() => {
                            reconciledCommandGuildSets.delete(guildSet);
                            console.error(
                              `[discord] slash command reconciliation failed: ${failure.message}`,
                            );
                          }),
                        ),
                        Effect.forkScoped,
                        Effect.asVoid,
                      );
                return observe({ _tag: "connected", atMs: healthRuntime.now() }).pipe(
                  Effect.andThen(reconcileCommands),
                );
              }
              case "reconnecting":
                return observe({
                  _tag: "reconnecting",
                  atMs: healthRuntime.now(),
                  failure: state.reason,
                });
              case "failed":
                return observe({
                  _tag: "failed",
                  atMs: healthRuntime.now(),
                  failure: state.reason,
                });
              case "stopped":
                return observe({ _tag: "stopped", atMs: healthRuntime.now() });
            }
          }),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* healthRuntime.waitForHeartbeat.pipe(
          Effect.andThen(
            Effect.suspend(() => observe({ _tag: "heartbeat", atMs: healthRuntime.now() })),
          ),
          Effect.forever,
          Effect.forkScoped,
        );

        const chatStateFor = (chatKey: string): ChatState => {
          const existing = chats.get(chatKey);
          if (existing !== undefined) return existing;
          const created: ChatState = {
            semaphore: Semaphore.makeUnsafe(1),
            turns: new Set(),
            generation: 0,
            pending: 0,
          };
          chats.set(chatKey, created);
          return created;
        };

        const cancelChat = (chatKey: string): Effect.Effect<number> =>
          Effect.gen(function* () {
            const chatState = chatStateFor(chatKey);
            chatState.generation += 1;
            const turns = [...chatState.turns].filter(
              (turn) => turn.generation < chatState.generation && !turn.cancelled,
            );
            for (const turn of turns) turn.cancelled = true;
            yield* Effect.forEach(turns, (turn) => Deferred.succeed(turn.cancellation, undefined), {
              discard: true,
            });
            if (chatState.handle !== undefined) {
              yield* chatState.handle.abort.pipe(
                Effect.catch((failure) =>
                  Effect.sync(() => {
                    console.error(`[discord] ${chatKey} abort failed: ${failure.message}`);
                  }),
                ),
              );
            }
            return turns.length;
          });

        const resolveConversation = (
          message: AdmittedMessage,
        ): Effect.Effect<InboundMessage, DiscordApiError> => {
          if (message.guildId === undefined) {
            return Effect.succeed({
              ...message,
              chatKey: `user-${message.authorId}`,
              context: { kind: "user", userId: "owner" },
            });
          }
          return Effect.gen(function* () {
            const channel = yield* retryDiscordDelivery("idempotent", () =>
              transport.getChannel(config.botToken, message.channelId),
            );
            if (THREAD_TYPES.has(channel.type) && channel.parent_id != null) {
              return discordThreadConversation(message, channel.id, channel.parent_id);
            }
            if (!ROOT_CHANNEL_TYPES.has(channel.type)) {
              return yield* new DiscordApiError({
                operation: "getChannel",
                reason: "rejected",
                retriable: false,
                message: `Discord channel type ${channel.type} does not support message threads`,
                cause: { channelType: channel.type },
              });
            }
            const thread = yield* retryDiscordDelivery("post", () =>
              transport.startThreadFromMessage(
                config.botToken,
                channel.id,
                message.messageId,
                threadName(message.text),
              ),
            );
            return discordThreadConversation(message, thread.id, channel.id);
          });
        };

        const updateFeedback = (message: InboundMessage, placeholderId: string, text: string) =>
          retryDiscordDelivery("idempotent", () =>
            transport.updateMessage(config.botToken, message.channelId, placeholderId, text),
          ).pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                console.error(
                  `[discord] ${message.chatKey} feedback update failed: ${failure.message}`,
                );
              }),
            ),
          );

        const reaction = (
          message: InboundMessage,
          operation: "add" | "remove",
          emoji: string,
        ): Effect.Effect<void> => {
          if (reactionUnavailableChannels.has(message.sourceChannelId)) return Effect.void;
          const effect =
            operation === "add"
              ? () =>
                  transport.addReaction(
                    config.botToken,
                    message.sourceChannelId,
                    message.messageId,
                    emoji,
                  )
              : () =>
                  transport.removeReaction(
                    config.botToken,
                    message.sourceChannelId,
                    message.messageId,
                    emoji,
                  );
          return retryDiscordFeedback(effect).pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                if (!failure.retriable && operation === "add") {
                  reactionUnavailableChannels.add(message.sourceChannelId);
                }
                console.error(
                  `[discord] ${message.chatKey} ${operation} reaction failed: ${failure.message}`,
                );
              }),
            ),
          );
        };

        const maintainTyping = (
          message: InboundMessage,
          isFresh: () => boolean,
        ): Effect.Effect<never> =>
          Effect.gen(function* () {
            while (true) {
              if (!isFresh() || typingUnavailableChannels.has(message.channelId)) {
                return yield* Effect.interrupt;
              }
              yield* transport.triggerTyping(config.botToken, message.channelId).pipe(
                Effect.catch((failure) =>
                  Effect.sync(() => {
                    if (!failure.retriable) {
                      typingUnavailableChannels.add(message.channelId);
                    }
                    console.error(`[discord] ${message.chatKey} typing failed: ${failure.message}`);
                  }),
                ),
              );
              yield* Effect.sleep(Duration.seconds(TYPING_REFRESH_SECONDS));
            }
          });

        const processMessage = (
          turn: ScheduledDiscordTurn,
          chatState: ChatState,
          queued: boolean,
        ) => {
          const message = turn.message;
          const isFresh = () => !turn.cancelled && chatState.generation === turn.generation;
          let placeholderId: string | undefined;
          let deliveryUnknown = false;
          let started = false;
          const observeDeliveryFailure = (failure: DiscordApiError) =>
            Effect.sync(() => {
              if (discordDeliveryOutcomeUnknown(failure)) deliveryUnknown = true;
            });
          return Effect.gen(function* () {
            yield* observe({ _tag: "accepted", atMs: healthRuntime.now(), queued });
            yield* reaction(message, "add", "👀");
            placeholderId = (yield* retryDiscordDelivery("post", () =>
              transport.createMessage(
                config.botToken,
                message.channelId,
                queued ? QUEUED_MESSAGE : WORKING_MESSAGE,
              ),
            ).pipe(Effect.tapError(observeDeliveryFailure))).id;
            yield* chatState.semaphore.withPermit(
              Effect.gen(function* () {
                if (!isFresh()) return yield* Effect.interrupt;
                started = true;
                yield* observe({ _tag: "started", atMs: healthRuntime.now(), wasQueued: queued });
                if (queued && placeholderId !== undefined) {
                  yield* updateFeedback(message, placeholderId, WORKING_MESSAGE);
                }
                if (chatState.handle === undefined) {
                  chatState.handle = yield* agent.openChat(
                    target,
                    message.context,
                    join(target.path, "sessions", "discord", message.chatKey),
                  );
                }
                const handle = chatState.handle;

                const reply = yield* Effect.scoped(
                  Effect.gen(function* () {
                    yield* maintainTyping(message, isFresh).pipe(Effect.forkScoped);
                    const progress = yield* Queue.sliding<string>(1);
                    if (placeholderId !== undefined) {
                      const progressMessageId = placeholderId;
                      yield* Effect.gen(function* () {
                        let previous: DiscordProgressUpdateState = {
                          atMs: Date.now(),
                          text: "",
                        };
                        while (true) {
                          const snapshot = yield* Queue.take(progress);
                          const atMs = Date.now();
                          if (
                            !isFresh() ||
                            !shouldUpdateDiscordProgress(previous, snapshot, atMs)
                          ) {
                            continue;
                          }
                          previous = { atMs, text: snapshot };
                          const chunk = discordMessageChunks(snapshot)[0];
                          if (chunk !== undefined) {
                            yield* updateFeedback(message, progressMessageId, chunk);
                          }
                        }
                      }).pipe(Effect.forkScoped);
                    }
                    const prompt = yield* prepareDiscordAttachmentPrompt(
                      message,
                      transport.downloadAttachment,
                    );
                    const voiceSignals = yield* Queue.unbounded<
                      | { readonly kind: "voice"; readonly agentId: string; readonly text: string }
                      | { readonly kind: "done" }
                    >();
                    const voicesDrained = yield* Deferred.make<void>();
                    yield* Effect.gen(function* () {
                      while (true) {
                        const signal = yield* Queue.take(voiceSignals);
                        if (signal.kind === "done") break;
                        if (!isFresh()) continue;
                        yield* retryDiscordDelivery("post", () =>
                          transport.createMessage(
                            config.botToken,
                            message.channelId,
                            formatSpecialistVoice(signal.agentId, signal.text),
                          ),
                        ).pipe(
                          Effect.catch((failure) =>
                            Effect.sync(() => {
                              console.error(
                                `[discord] ${message.chatKey} specialist voice failed: ${failure.message}`,
                              );
                            }),
                          ),
                        );
                      }
                      yield* Deferred.succeed(voicesDrained, undefined);
                    }).pipe(Effect.forkScoped);
                    const reply = yield* handle.prompt(prompt.text, {
                      onProgress: (event) => {
                        if (!isFresh()) return;
                        if (event.kind === "voice") {
                          Queue.offerUnsafe(voiceSignals, event);
                          return;
                        }
                        if (event.kind === "assistant-text") {
                          Queue.offerUnsafe(progress, event.snapshot);
                        }
                      },
                      ...Object.fromEntries(
                        prompt.images.length > 0 ? ([["images", prompt.images]] as const) : [],
                      ),
                    });
                    yield* Queue.offer(voiceSignals, { kind: "done" });
                    yield* Deferred.await(voicesDrained);
                    return reply;
                  }),
                );
                if (!isFresh()) return yield* Effect.interrupt;
                const replyChunks = discordMessageChunks(reply);
                const chunks = replyChunks.length === 0 ? ["Done."] : replyChunks;
                const first = chunks[0];
                if (placeholderId !== undefined && first !== undefined) {
                  const firstMessageId = placeholderId;
                  yield* retryDiscordDelivery("idempotent", () =>
                    transport.updateMessage(
                      config.botToken,
                      message.channelId,
                      firstMessageId,
                      first,
                    ),
                  ).pipe(Effect.tapError(observeDeliveryFailure));
                }
                for (const chunk of chunks.slice(1)) {
                  if (!isFresh()) return yield* Effect.interrupt;
                  yield* retryDiscordDelivery("post", () =>
                    transport.createMessage(config.botToken, message.channelId, chunk),
                  ).pipe(Effect.tapError(observeDeliveryFailure));
                }
                console.log(
                  `[discord] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
                );
              }),
            );
          }).pipe(
            Effect.onExit((exit) => {
              const shutdownInterrupted =
                !turn.cancelled && Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
              if (shutdownInterrupted) {
                turn.terminalAttempted = true;
                return Effect.all(
                  [
                    reaction(message, "remove", "👀"),
                    ingressRuntime.requeue(target.path, message, ingressOwnerId),
                  ],
                  { concurrency: "unbounded", discard: true },
                );
              }
              const terminalState: DiscordIngressTerminalState = turn.cancelled
                ? "cancelled"
                : discordIngressTerminalState(deliveryUnknown, Exit.isSuccess(exit));
              turn.terminalAttempted = true;
              return Effect.all(
                [
                  reaction(message, "remove", "👀").pipe(
                    Effect.andThen(
                      reaction(
                        message,
                        "add",
                        turn.cancelled ? "🛑" : terminalState === "completed" ? "✅" : "❌",
                      ),
                    ),
                  ),
                  placeholderId === undefined ||
                  terminalState === "completed" ||
                  terminalState === "unknown"
                    ? Effect.void
                    : updateFeedback(
                        message,
                        placeholderId,
                        turn.cancelled ? STOPPED_MESSAGE : FAILED_MESSAGE,
                      ),
                  observe(
                    turn.cancelled
                      ? {
                          _tag: "cancelled",
                          atMs: healthRuntime.now(),
                          wasQueued: queued && !started,
                        }
                      : {
                          _tag: "completed",
                          atMs: healthRuntime.now(),
                          succeeded: terminalState === "completed",
                        },
                  ),
                  ingressRuntime.finish(
                    target.path,
                    message,
                    ingressOwnerId,
                    terminalState,
                    healthRuntime.now(),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              );
            }),
          );
        };

        const scheduleMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            const started = yield* ingressRuntime.start(
              target.path,
              message,
              ingressOwnerId,
              healthRuntime.now(),
            );
            if (!started) return;
            const chatState = chatStateFor(message.chatKey);
            const queued = chatState.pending > 0;
            const cancellation = yield* Deferred.make<void>();
            const turn: ScheduledDiscordTurn = {
              cancellation,
              generation: chatState.generation,
              message,
              cancelled: false,
              terminalAttempted: false,
            };
            chatState.turns.add(turn);
            chatState.pending += 1;
            yield* Effect.raceFirst(
              processMessage(turn, chatState, queued),
              Deferred.await(cancellation),
            ).pipe(
              Effect.catch(
                (failure: ZiggyAgentError | DiscordApiError | DiscordIngressDatabaseError) =>
                  Effect.sync(() => {
                    console.error(`[discord] ${message.chatKey} failed: ${failure.message}`);
                  }),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  if (!turn.terminalAttempted) {
                    turn.terminalAttempted = true;
                    const settlement = turn.cancelled
                      ? ingressRuntime.finish(
                          target.path,
                          message,
                          ingressOwnerId,
                          "cancelled",
                          healthRuntime.now(),
                        )
                      : ingressRuntime.requeue(target.path, message, ingressOwnerId);
                    yield* settlement.pipe(
                      Effect.catch((failure) =>
                        Effect.sync(() => {
                          console.error(
                            `[discord] ${message.chatKey} interrupted ingress settlement failed: ${failure.message}`,
                          );
                        }),
                      ),
                    );
                  }
                  chatState.turns.delete(turn);
                  chatState.pending = Math.max(0, chatState.pending - 1);
                }),
              ),
              Effect.forkScoped,
            );
          });

        const stopMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            const started = yield* ingressRuntime.start(
              target.path,
              message,
              ingressOwnerId,
              healthRuntime.now(),
            );
            if (!started) return;
            let deliveryUnknown = false;
            yield* Effect.gen(function* () {
              const stopped = yield* cancelChat(message.chatKey);
              const acknowledgement =
                stopped === 0
                  ? "Nothing was running."
                  : `Stopped ${stopped} ${stopped === 1 ? "request" : "requests"}.`;
              yield* retryDiscordDelivery("post", () =>
                transport.createMessage(config.botToken, message.channelId, acknowledgement),
              ).pipe(
                Effect.tapError((failure) =>
                  Effect.sync(() => {
                    if (discordDeliveryOutcomeUnknown(failure)) deliveryUnknown = true;
                  }),
                ),
              );
              yield* reaction(message, "add", "✅");
            }).pipe(
              Effect.onExit((exit) =>
                ingressRuntime.finish(
                  target.path,
                  message,
                  ingressOwnerId,
                  discordIngressTerminalState(deliveryUnknown, Exit.isSuccess(exit)),
                  healthRuntime.now(),
                ),
              ),
            );
          });

        const resolveInteractionChat = (
          interaction: DiscordInboundInteraction,
        ): Effect.Effect<
          { readonly chatKey: string; readonly label: "direct message" | "thread" } | undefined,
          DiscordApiError
        > => {
          if (interaction.guildId === undefined) {
            return Effect.succeed({
              chatKey: `user-${interaction.authorId}`,
              label: "direct message",
            });
          }
          if (interaction.channelId === undefined) return Effect.succeed(undefined);
          const resolveChannel: Effect.Effect<DiscordChannel, DiscordApiError> =
            interaction.channelType === undefined
              ? retryDiscordDelivery("idempotent", () =>
                  transport.getChannel(config.botToken, interaction.channelId ?? ""),
                )
              : Effect.succeed<DiscordChannel>({
                  id: interaction.channelId,
                  type: interaction.channelType,
                  parent_id: interaction.parentChannelId,
                });
          return resolveChannel.pipe(
            Effect.map((channel) => {
              if (!THREAD_TYPES.has(channel.type) || channel.parent_id == null) return undefined;
              return {
                chatKey: `group-dc${channel.parent_id}-thread-${channel.id}`,
                label: "thread" as const,
              };
            }),
          );
        };

        const respondToInteraction = (interaction: DiscordInboundInteraction, text: string) =>
          transport.respondToInteraction === undefined
            ? Effect.void
            : transport.respondToInteraction(interaction.id, interaction.token, text).pipe(
                Effect.catch((failure) =>
                  Effect.sync(() => {
                    console.error(`[discord] interaction response failed: ${failure.message}`);
                  }),
                ),
              );

        const handleInteraction = (interaction: DiscordInboundInteraction): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (interaction.authorId !== config.ownerUserId) {
              yield* respondToInteraction(interaction, "This Ziggy Profile is owner-only.");
              return;
            }
            if (interaction.commandName !== "status" && interaction.commandName !== "stop") {
              yield* respondToInteraction(interaction, "That Ziggy command is not supported.");
              return;
            }
            const resolved = yield* resolveInteractionChat(interaction).pipe(Effect.result);
            if (Result.isFailure(resolved)) {
              yield* respondToInteraction(
                interaction,
                "I couldn't resolve this Discord conversation.",
              );
              return;
            }
            const conversation = resolved.success;
            if (conversation === undefined) {
              yield* respondToInteraction(
                interaction,
                `Use /${interaction.commandName} inside a Ziggy work thread. Top-level messages create one session per thread.`,
              );
              return;
            }
            if (interaction.commandName === "stop") {
              const stopped = yield* cancelChat(conversation.chatKey);
              yield* respondToInteraction(
                interaction,
                stopped === 0
                  ? "Nothing was running in this conversation."
                  : `Stopped ${stopped} ${stopped === 1 ? "request" : "requests"} in this conversation.`,
              );
              return;
            }
            const chat = chats.get(conversation.chatKey);
            const pending = chat?.pending ?? 0;
            const active = pending > 0 ? 1 : 0;
            const queued = Math.max(0, pending - active);
            yield* respondToInteraction(
              interaction,
              `Ziggy is ready in this ${conversation.label}. Active: ${active} · queued: ${queued}.`,
            );
          });

        if (socket.nextInteraction !== undefined && transport.respondToInteraction !== undefined) {
          yield* socket.nextInteraction.pipe(
            Effect.flatMap(handleInteraction),
            Effect.forever,
            Effect.forkScoped,
          );
        }

        if (replayable.length > 0) {
          console.log(`[discord] replaying ${replayable.length} accepted messages`);
        }
        for (const message of replayable) {
          if (isDiscordStopCommand(message.text)) {
            yield* stopMessage(message);
          } else {
            yield* scheduleMessage(message);
          }
        }

        while (true) {
          const inbound = yield* socket.next.pipe(
            Effect.tapError((failure) =>
              observe({
                _tag: "failed",
                atMs: healthRuntime.now(),
                failure:
                  failure.reason === "authentication"
                    ? "authentication"
                    : failure.reason === "queue-overflow"
                      ? "queue-overflow"
                      : "socket",
              }),
            ),
            Effect.mapError(socketFailure),
          );
          yield* observe({ _tag: "inbound", atMs: healthRuntime.now() });
          const admitted = normalizeDiscordMessage(inbound, config.ownerUserId);
          if (admitted === undefined) continue;
          const resolved = yield* resolveConversation(admitted).pipe(Effect.result);
          if (Result.isFailure(resolved)) {
            yield* observe({
              _tag: "boundary-failed",
              atMs: healthRuntime.now(),
              failure: "thread",
            });
            console.error(`[discord] conversation setup failed: ${resolved.failure.message}`);
            yield* transport
              .createMessage(
                config.botToken,
                admitted.channelId,
                "I couldn't open a work thread here. Check Create Public Threads, Send Messages in Threads, and Read Message History permissions.",
              )
              .pipe(Effect.catch(() => Effect.void));
            continue;
          }
          const message = resolved.success;
          const admission = yield* ingressRuntime.admit(target.path, message, healthRuntime.now());
          if (admission === "duplicate") continue;
          console.log(`[discord] admitted ${message.chatKey}`);
          if (isDiscordStopCommand(message.text)) {
            yield* stopMessage(message);
          } else {
            yield* scheduleMessage(message);
          }
        }
      }),
    ),
});

export const DiscordGatewayLive = Layer.effect(
  DiscordGateway,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeDiscordGateway(
      agent,
      liveDiscordTransport,
      liveDiscordHealthRuntime,
      liveDiscordIngressRuntime,
    );
  }),
);
