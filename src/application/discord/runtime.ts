import { randomUUID } from "node:crypto";
import { Context, Deferred, Duration, Effect, Exit, Layer, Result, Semaphore } from "effect";
import {
  admitDiscordIngress,
  finishDiscordIngress,
  initializeDiscordIngressDatabase,
  readReplayableDiscordIngress,
  requeueDiscordIngress,
  recoverDiscordIngress,
  startDiscordIngress,
} from "../../adapters/bun/discord-ingress-sqlite";
import {
  addReaction,
  createMessageWithReceipt,
  downloadAttachment,
  DiscordApiError,
  ensureDiscordCommands,
  getChannel,
  removeReaction,
  respondToDiscordInteraction,
  startThreadFromMessage,
  triggerTyping,
  updateMessage,
} from "../../adapters/discord/api";
import {
  openDiscordSocket,
  type DiscordInboundInteraction,
  type DiscordSocketError,
} from "../../adapters/discord/socket";
import { writeDiscordHealth } from "../../adapters/fs/discord-health";
import type { ProfileSpecialistError } from "../../domain/agent";
import {
  DiscordIngressDatabaseError,
  type DiscordIngressPayload as InboundMessage,
} from "../../domain/discord-ingress";
import {
  evolveDiscordHealth,
  initialDiscordHealth,
  type DiscordHealthEvent,
} from "../../domain/discord-health";
import { ZiggyAgent, type ZiggyAgentApi } from "../../session";
import type { LiveSessionRefused, LiveSessionsApi } from "../../resident/live-sessions";
import {
  retryDiscordDelivery,
  discordIngressTerminalState,
  discordDeliveryOutcomeUnknown,
} from "./delivery";
import {
  normalizeDiscordMessage,
  discordThreadConversation,
  threadName,
  isDiscordStopCommand,
  THREAD_TYPES,
  ROOT_CHANNEL_TYPES,
  type AdmittedMessage,
} from "./intake";
import type {
  ChatState,
  ScheduledDiscordTurn,
  DiscordTransport,
  DiscordGatewayApi,
  DiscordHealthRuntime,
  DiscordIngressRuntime,
  DiscordChannel,
} from "./model";
import { makeDiscordTurnProcessor } from "./turn";

export class DiscordGateway extends Context.Service<DiscordGateway, DiscordGatewayApi>()(
  "ziggy/DiscordGateway",
) {}

const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const MAX_PENDING_TURNS_PER_CHAT = 8;

const BUSY_MESSAGE = "This conversation is busy. Please try again later.";

const disposeChats = (chats: Map<string, ChatState>, live?: LiveSessionsApi): Effect.Effect<void> =>
  Effect.forEach(
    [...chats.entries()],
    ([chatKey, state]) =>
      state.handle === undefined
        ? Effect.void
        : (live === undefined
            ? state.handle.dispose
            : live.release(`discord/${chatKey}`, state.handle)
          ).pipe(
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
  runLoop: (target, config, live, destinations) =>
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

        const socket = yield* transport
          .openSocket(config.botToken, DISCORD_INTENTS)
          .pipe(Effect.mapError(socketFailure));

        const reconciledCommandGuildSets = new Set<string>();
        yield* Effect.addFinalizer(() =>
          socket.close.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Discord socket close failed", { failure }),
            ),
            Effect.andThen(disposeChats(chats, live)),
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
                  failure: state.reason === "malformed-frame" ? "socket" : state.reason,
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
            busyNoticePending: false,
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
              return discordThreadConversation(
                message,
                channel.id,
                channel.parent_id,
                channel.name,
              );
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

            return discordThreadConversation(
              message,
              thread.id,
              channel.id,
              thread.name ?? channel.name,
            );
          });
        };

        const { processMessage, reaction } = makeDiscordTurnProcessor({
          agent,
          transport,
          healthRuntime,
          ingressRuntime,
          target,
          config,
          live,
          destinations,
          ingressOwnerId,
          observe,
        });

        // Unlike Slack's steer path, every accepted Discord turn takes a queue slot;
        // an interrupted non-cancelled turn is requeued for durable replay.

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

            if (chatState.pending >= MAX_PENDING_TURNS_PER_CHAT) {
              yield* ingressRuntime.finish(
                target.path,
                message,
                ingressOwnerId,
                "failed",
                healthRuntime.now(),
              );

              if (!chatState.busyNoticePending) {
                chatState.busyNoticePending = true;
                yield* transport
                  .createMessage(config.botToken, message.channelId, BUSY_MESSAGE)
                  .pipe(
                    Effect.catch((failure) =>
                      Effect.logWarning("Discord busy response failed", { failure }),
                    ),
                    Effect.forkScoped,
                  );
              }

              return;
            }

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
                (
                  failure:
                    | ProfileSpecialistError
                    | DiscordApiError
                    | DiscordIngressDatabaseError
                    | LiveSessionRefused,
                ) =>
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

                  if (chatState.pending < MAX_PENDING_TURNS_PER_CHAT)
                    chatState.busyNoticePending = false;
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
