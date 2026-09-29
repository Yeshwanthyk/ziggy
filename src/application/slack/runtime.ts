import { makeSlackTurnProcessor } from "./turn";
import {
  classifySlackCommand,
  resolveSlackChannelMode,
  isSlackStopCommand,
  slackReplyThreadTs,
} from "./intake";
import { uniqueSlackStatusTargets } from "./delivery";
import { randomUUID } from "node:crypto";
import { Context, Deferred, Duration, Effect, Layer, Result, Semaphore } from "effect";
import type * as Scope from "effect/Scope";
import {
  addReaction,
  appendStream,
  authTest,
  downloadFile,
  getConversation,
  getThreadReplies,
  postMessage,
  removeReaction,
  setStatus,
  SlackApiError,
  type SlackImageContent,
  type SlackStartStreamOptions,
  type SlackTaskUpdateChunk,
  type SlackThreadHistory,
  startStream,
  stopStream,
  updateMessage,
} from "../../adapters/slack/api";
import {
  admitSlackIngress,
  finishSlackIngress,
  initializeSlackIngressDatabase,
  readReplayableSlackIngress,
  recoverSlackIngress,
  startSlackIngress,
} from "../../adapters/bun/slack-ingress-sqlite";
import {
  type SlackSocket,
  SlackSocketError,
  type SlackSocketInboundAdmit,
  openSlackSocket,
} from "../../adapters/slack/socket";
import { writeSlackHealth } from "../../adapters/fs/slack-health";
import { type SlackGatewayConfig } from "../../domain/slack";
import {
  type SlackIngressDatabaseError,
  type SlackIngressFileReference,
  type SlackIngressPayload,
  type SlackIngressRecord,
  type SlackIngressTerminalState,
} from "../../domain/slack-ingress";
import {
  evolveSlackHealth,
  initialSlackHealth,
  type SlackHealthEvent,
  type SlackHealthProjectionError,
  type SlackHealthSnapshot,
} from "../../domain/slack-health";
import type { ProfileTarget } from "../../domain/profile";
import { ZiggyAgent, type ChatHandle, type ZiggyAgentApi } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";
import { automationTargetFromString } from "../../domain/automation";

const MAX_PENDING_TURNS_PER_CHAT = 8;

const BUSY_MESSAGE = "This conversation is busy. Please try again later.";

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
    chunks: ReadonlyArray<SlackTaskUpdateChunk>,
  ) => Effect.Effect<void, SlackApiError>;
  readonly stopStream?: (
    token: string,
    channel: string,
    ts: string,
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

export class SlackGateway extends Context.Service<SlackGateway, SlackGatewayApi>()(
  "ziggy/SlackGateway",
) {}

type InboundMessage = SlackIngressPayload;

export interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  readonly statusSemaphore: Semaphore.Semaphore;
  readonly turns: Set<ScheduledSlackTurn>;
  generation: number;
  handle?: ChatHandle;
  activeMessage?: InboundMessage;
  pending: number;
  busyNoticePending: boolean;
}

export interface ScheduledSlackTurn {
  readonly cancellation: Deferred.Deferred<void>;
  readonly generation: number;
  readonly message: InboundMessage;
  cancelled: boolean;
  terminalAttempted: boolean;
}

const disposeChats = (
  chats: Map<string, ChatState>,
  registry?: ChatRegistryApi,
): Effect.Effect<void> =>
  Effect.forEach(
    [...chats.entries()],
    ([chatKey, state]) =>
      state.handle === undefined
        ? Effect.void
        : (registry === undefined
            ? state.handle.dispose
            : registry.closeAlias(`slack/${chatKey}`, state.handle)
          ).pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                console.error(`[slack] ${chatKey} dispose failed: ${failure.message}`);
              }),
            ),
          ),
    { concurrency: "unbounded", discard: true },
  );

const socketFailure = (socketError: SlackSocketError): SlackApiError =>
  new SlackApiError({
    operation: "socket",
    reason: "socket",
    retriable: false,
    message: socketError.message,
    cause: socketError,
  });

const ingressSocketFailure = (failure: SlackIngressDatabaseError): SlackSocketError =>
  new SlackSocketError({
    operation: "receive",
    reason: "connection",
    retriable: false,
    message: "Slack inbound durability failed",
    cause: failure,
  });

const liveSlackTransport: SlackTransport = {
  addReaction,
  authTest,
  downloadFile,
  getConversation,
  getThreadReplies,
  openSocket: (appToken, admitInbound) => openSlackSocket(appToken, undefined, admitInbound),
  postMessage,
  removeReaction,
  setStatus,
  startStream,
  appendStream,
  stopStream,
  updateMessage,
};

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

const liveSlackIngressRuntime: SlackIngressRuntime = {
  initialize: initializeSlackIngressDatabase,
  recover: recoverSlackIngress,
  replayable: readReplayableSlackIngress,
  admit: admitSlackIngress,
  start: startSlackIngress,
  finish: finishSlackIngress,
};

const volatileSlackIngressRuntime: SlackIngressRuntime = {
  initialize: () => Effect.void,
  recover: () => Effect.void,
  replayable: () => Effect.succeed([]),
  admit: () => Effect.succeed("accepted"),
  start: () => Effect.succeed(true),
  finish: () => Effect.void,
};

export interface SlackHealthRuntime {
  readonly now: () => number;
  readonly waitForHeartbeat: Effect.Effect<void>;
  readonly write: (
    profilePath: string,
    snapshot: SlackHealthSnapshot,
  ) => Effect.Effect<void, SlackHealthProjectionError>;
}

const liveSlackHealthRuntime: SlackHealthRuntime = {
  now: Date.now,
  waitForHeartbeat: Effect.sleep(Duration.seconds(30)),
  write: writeSlackHealth,
};

const silentSlackHealthRuntime: SlackHealthRuntime = {
  now: Date.now,
  waitForHeartbeat: Effect.never,
  write: () => Effect.void,
};

export const makeSlackGateway = (
  agent: ZiggyAgentApi,
  transport: SlackTransport = liveSlackTransport,
  healthRuntime: SlackHealthRuntime = silentSlackHealthRuntime,
  ingressRuntime: SlackIngressRuntime = volatileSlackIngressRuntime,
): SlackGatewayApi => ({
  runLoop: (target, config, registry) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingressOwnerId = randomUUID();
        yield* ingressRuntime.initialize(target.path);
        yield* ingressRuntime.recover(target.path, ingressOwnerId);
        const replayable = yield* ingressRuntime.replayable(target.path);
        let health = initialSlackHealth(healthRuntime.now());
        const healthPermit = Semaphore.makeUnsafe(1);

        const observe = (event: SlackHealthEvent): Effect.Effect<void> =>
          healthPermit.withPermit(
            Effect.sync(() => {
              health = evolveSlackHealth(health, event);

              return health;
            }).pipe(
              Effect.flatMap((snapshot) => healthRuntime.write(target.path, snapshot)),
              Effect.catch((failure) =>
                Effect.sync(() => {
                  console.error(`[slack] health observation failed: ${failure.message}`);
                }),
              ),
            ),
          );

        yield* healthRuntime.write(target.path, health).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              console.error(`[slack] health observation failed: ${failure.message}`);
            }),
          ),
        );

        const bot = yield* transport.authTest(config.botToken).pipe(
          Effect.tapError((failure) =>
            observe({
              _tag: "failed",
              atMs: healthRuntime.now(),
              failure: failure.reason === "authentication" ? "authentication" : "connection",
            }),
          ),
        );

        const chats = new Map<string, ChatState>();
        const channelLabels = new Map<string, string>();
        const channelLookups = new Set<string>();
        let reactionsAvailable = true;

        const rememberChannel = (channel: string): Effect.Effect<void> =>
          registry === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const target = automationTargetFromString(`slack:channel:${channel}`);

                if (target === undefined) return;

                const knownLabel = channelLabels.get(channel);

                const destination =
                  knownLabel === undefined ? { target } : { target, label: knownLabel };

                yield* registry.rememberDestination(destination);

                if (transport.getConversation === undefined || channelLookups.has(channel)) return;

                channelLookups.add(channel);

                const result = yield* transport
                  .getConversation(config.botToken, channel)
                  .pipe(Effect.timeout("2 seconds"), Effect.result);

                if (result._tag === "Failure" || result.success.name === undefined) return;

                const label = result.success.name.trim();

                if (label.length === 0) return;

                channelLabels.set(channel, label);
                yield* registry.rememberDestination({
                  target,
                  label,
                });
              });

        yield* Effect.forEach(Object.keys(config.channels ?? {}), rememberChannel, {
          concurrency: 4,
          discard: true,
        });

        const admitInbound: SlackSocketInboundAdmit = (inbound, eventId) => {
          const channelMode = resolveSlackChannelMode(config, inbound.channel);

          const admission = classifySlackCommand(
            inbound,
            bot.userId,
            config.ownerUserId,
            channelMode,
          );

          if (admission.kind === "ignored") {
            if (admission.reason === "mention-required") {
              console.log(
                `[slack] ignored owner channel message reason:${admission.reason} channel:${inbound.channel}`,
              );
            }

            return Effect.succeed("acknowledge");
          }

          return ingressRuntime
            .admit(
              target.path,
              (() => {
                const record = {
                  payload: admission.message,
                  ...Object.fromEntries(
                    eventId === undefined ? [] : ([["eventId", eventId]] as const),
                  ),
                };

                return record;
              })(),
              healthRuntime.now(),
            )
            .pipe(
              Effect.map((result) => (result === "accepted" ? "deliver" : "acknowledge")),
              Effect.mapError(ingressSocketFailure),
            );
        };

        const socket = yield* transport.openSocket(config.appToken, admitInbound).pipe(
          Effect.tapError((failure) =>
            observe({
              _tag: "failed",
              atMs: healthRuntime.now(),
              failure: failure.reason === "authentication" ? "authentication" : "socket",
            }),
          ),
          Effect.mapError(socketFailure),
        );

        const channelPolicySummary = `default:mention overrides:${Object.keys(config.channels ?? {}).length}`;
        console.log(
          `[slack] authenticated; socket supervisor started; channel-policy:${channelPolicySummary}`,
        );
        yield* Effect.addFinalizer(() =>
          Effect.all(
            [
              socket.close.pipe(
                Effect.catch((failure) =>
                  Effect.logWarning("Slack socket close failed", { failure }),
                ),
              ),
              disposeChats(chats, registry),
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.andThen(observe({ _tag: "stopped", atMs: healthRuntime.now() }))),
        );
        yield* socket.nextConnectionState.pipe(
          Effect.flatMap((state) =>
            observe(
              state.state === "connected"
                ? { _tag: "connected", atMs: healthRuntime.now() }
                : {
                    _tag: "reconnecting",
                    atMs: healthRuntime.now(),
                    failure: state.failure,
                  },
            ),
          ),
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
            statusSemaphore: Semaphore.makeUnsafe(1),
            turns: new Set(),
            generation: 0,
            pending: 0,
            busyNoticePending: false,
          };

          chats.set(chatKey, created);

          return created;
        };

        const processMessage = makeSlackTurnProcessor({
          agent,
          transport,
          healthRuntime,
          ingressRuntime,
          target,
          config,
          registry,
          ingressOwnerId,
          botUserId: bot.userId,
          channelLabels,
          observe,
          reactionsAvailable: () => reactionsAvailable,
          disableReactions: () => {
            reactionsAvailable = false;
          },
        });

        // Slack may steer a new text turn into the active handle; cancelled ingress is
        // settled as cancelled. Discord instead queues turns and requeues interrupted ingress.

        const registerMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            yield* rememberChannel(message.channel);

            if (registry !== undefined && message.context.kind === "group") {
              const threadTs = message.statusThreadTs;
              const channelLabel = channelLabels.get(message.channel);

              const target = automationTargetFromString(
                `slack:channel:${message.channel}:thread:${threadTs}`,
              );

              if (target !== undefined) {
                const destination =
                  channelLabel === undefined
                    ? { target }
                    : { target, label: `${channelLabel} · thread` };

                yield* registry.rememberDestination(destination);
              }
            }

            const started = yield* ingressRuntime.start(
              target.path,
              message,
              ingressOwnerId,
              healthRuntime.now(),
            );

            if (!started) return;
            const chatState = chatStateFor(message.chatKey);
            const queued = chatState.pending > 0;
            const active = chatState.activeMessage;
            const handle = chatState.handle;

            if (
              (config.busyMessageMode ?? "steer") === "steer" &&
              queued &&
              active !== undefined &&
              handle !== undefined &&
              !handle.isIdle &&
              active.channel === message.channel &&
              active.statusThreadTs === message.statusThreadTs &&
              (message.files?.length ?? 0) === 0 &&
              (message.omittedFileCount ?? 0) === 0
            ) {
              const steered = yield* handle.steer(message.text).pipe(Effect.result);

              if (Result.isSuccess(steered)) {
                yield* ingressRuntime.finish(
                  target.path,
                  message,
                  ingressOwnerId,
                  "completed",
                  healthRuntime.now(),
                );

                return;
              }

              yield* Effect.logWarning("Slack steering failed; queueing message", {
                chatKey: message.chatKey,
                failure: steered.failure,
              });
            }

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
                  .postMessage(
                    config.botToken,
                    message.channel,
                    BUSY_MESSAGE,
                    slackReplyThreadTs(message),
                  )
                  .pipe(
                    Effect.catch((failure) =>
                      Effect.logWarning("Slack busy response failed", { failure }),
                    ),
                    Effect.forkScoped,
                  );
              }

              return;
            }

            const cancellation = yield* Deferred.make<void>();

            const turn: ScheduledSlackTurn = {
              cancellation,
              generation: chatState.generation,
              message,
              cancelled: false,
              terminalAttempted: false,
            };

            chatState.turns.add(turn);
            chatState.pending += 1;
            const cancelled = Deferred.await(cancellation).pipe(Effect.as("cancelled" as const));

            const cleanup = Effect.gen(function* () {
              if (turn.cancelled && !turn.terminalAttempted) {
                turn.terminalAttempted = true;
                yield* ingressRuntime
                  .finish(target.path, message, ingressOwnerId, "cancelled", healthRuntime.now())
                  .pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        console.error(
                          `[slack] ${message.chatKey} cancelled ingress settlement failed: ${failure.message}`,
                        );
                      }),
                    ),
                  );
              }

              chatState.turns.delete(turn);
              chatState.pending = Math.max(0, chatState.pending - 1);

              if (chatState.pending < MAX_PENDING_TURNS_PER_CHAT)
                chatState.busyNoticePending = false;
            });

            return Effect.suspend(() =>
              turn.cancelled
                ? Effect.void
                : Effect.raceFirst(
                    processMessage(turn, chatState, queued).pipe(Effect.as("settled" as const)),
                    cancelled,
                  ).pipe(Effect.asVoid),
            ).pipe(Effect.ensuring(cleanup));
          });

        const scheduleMessage = (message: InboundMessage) =>
          Effect.gen(function* () {
            const work = yield* registerMessage(message);

            if (work !== undefined) yield* work.pipe(Effect.forkScoped);
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
            const chatState = chatStateFor(message.chatKey);
            chatState.generation += 1;

            const cancelled = [...chatState.turns].filter(
              (turn) => turn.generation < chatState.generation && !turn.terminalAttempted,
            );

            for (const turn of cancelled) turn.cancelled = true;
            yield* Effect.forEach(
              cancelled,
              (turn) => Deferred.succeed(turn.cancellation, undefined),
              { discard: true },
            );

            if (chatState.handle !== undefined) {
              yield* chatState.handle.abort.pipe(
                Effect.catch((failure) =>
                  Effect.sync(() => {
                    console.error(`[slack] ${message.chatKey} abort failed: ${failure.message}`);
                  }),
                ),
              );
            }

            const cancelledStatusTargets = uniqueSlackStatusTargets(
              cancelled.map((turn) => turn.message),
            );

            yield* chatState.statusSemaphore.withPermit(
              Effect.forEach(
                cancelledStatusTargets,
                (target) =>
                  transport.setStatus(config.botToken, target.channel, target.threadTs, "").pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        console.error(
                          `[slack] ${message.chatKey} stop status clear failed: ${failure.message}`,
                        );
                      }),
                    ),
                  ),
                { discard: true },
              ),
            );
            yield* ingressRuntime.finish(
              target.path,
              message,
              ingressOwnerId,
              "completed",
              healthRuntime.now(),
            );

            const acknowledgement =
              cancelled.length === 0
                ? "Nothing was running."
                : `Stopped ${cancelled.length} ${cancelled.length === 1 ? "request" : "requests"}.`;

            yield* Effect.all(
              [
                transport
                  .postMessage(
                    config.botToken,
                    message.channel,
                    acknowledgement,
                    slackReplyThreadTs(message),
                  )
                  .pipe(
                    Effect.catch((failure) =>
                      Effect.sync(() => {
                        console.error(
                          `[slack] ${message.chatKey} stop acknowledgement failed: ${failure.message}`,
                        );
                      }),
                    ),
                  ),
                reactionsAvailable
                  ? transport
                      .addReaction(
                        config.botToken,
                        message.channel,
                        message.sourceTs,
                        "white_check_mark",
                      )
                      .pipe(
                        Effect.catch((failure) =>
                          Effect.sync(() => {
                            if (failure.reason === "authentication") reactionsAvailable = false;
                            console.error(
                              `[slack] ${message.chatKey} stop reaction failed: ${failure.message}`,
                            );
                          }),
                        ),
                      )
                  : Effect.void,
              ],
              { concurrency: "unbounded", discard: true },
            ).pipe(Effect.forkScoped);
          });

        const dispatchMessage = (message: InboundMessage) =>
          isSlackStopCommand(message.text) ? stopMessage(message) : scheduleMessage(message);

        const replayWork: Array<Effect.Effect<void>> = [];

        for (const recovered of replayable) {
          console.log(`[slack] replaying durable ingress ${recovered.payload.chatKey}`);

          if (isSlackStopCommand(recovered.payload.text)) {
            yield* stopMessage(recovered.payload);
          } else {
            const work = yield* registerMessage(recovered.payload);

            if (work !== undefined) replayWork.push(work);
          }
        }

        yield* Effect.forEach(replayWork, (work) => work, {
          concurrency: 4,
          discard: true,
        }).pipe(Effect.forkScoped);

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
          const channelMode = resolveSlackChannelMode(config, inbound.channel);

          const admission = classifySlackCommand(
            inbound,
            bot.userId,
            config.ownerUserId,
            channelMode,
          );

          if (admission.kind !== "ignored") {
            const activation = inbound.channelType === "im" ? "direct" : channelMode;
            console.log(`[slack] admitted ${admission.message.chatKey} activation:${activation}`);
            yield* dispatchMessage(admission.message);
          } else if (admission.reason === "mention-required") {
            console.log(
              `[slack] ignored owner channel message reason:${admission.reason} channel:${inbound.channel}`,
            );
          }
        }
      }),
    ),
});

export const SlackGatewayLive = Layer.effect(
  SlackGateway,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;

    return makeSlackGateway(
      agent,
      liveSlackTransport,
      liveSlackHealthRuntime,
      liveSlackIngressRuntime,
    );
  }),
);
