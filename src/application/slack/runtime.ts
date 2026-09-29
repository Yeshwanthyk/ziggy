import {
  classifySlackCommand,
  resolveSlackChannelMode,
  isSlackStopCommand,
  slackReplyThreadTs,
} from "./intake";
import {
  prepareSlackAttachmentPrompt,
  renderSlackThreadContext,
  slackMessageChunks,
  retrySlackDelivery,
  slackIngressTerminalState,
  uniqueSlackStatusTargets,
  shouldUpdateSlackProgress,
  slackTaskChunk,
  slackProgressStreamStartOptions,
  deliveryOutcomeUnknown,
  WORKING_MESSAGE,
  QUEUED_MESSAGE,
  FAILED_MESSAGE,
  STOPPED_MESSAGE,
  type SlackProgressSignal,
  type SlackProgressStreamState,
  type SlackProgressUpdateState,
} from "./delivery";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Result,
  Semaphore,
} from "effect";
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
import { type ZiggyAgentError } from "../../domain/agent";
import { codePointLength } from "../../domain/memory";
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
import { ZiggyAgent, formatSpecialistVoice, type ChatHandle, type ZiggyAgentApi } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";
import type { UiGatewayError } from "../../domain/ui-gateway";
import { automationTargetFromString } from "../../domain/automation";
import { slackToolStatus } from "../slack-tool-progress";

const MAX_PENDING_TURNS_PER_CHAT = 8;

const BUSY_MESSAGE = "This conversation is busy. Please try again later.";

const HEARTBEAT_SECONDS = 30;

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

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  readonly statusSemaphore: Semaphore.Semaphore;
  readonly turns: Set<ScheduledSlackTurn>;
  generation: number;
  handle?: ChatHandle;
  activeMessage?: InboundMessage;
  pending: number;
  busyNoticePending: boolean;
}

interface ScheduledSlackTurn {
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

        const processMessage = (turn: ScheduledSlackTurn, chatState: ChatState, queued: boolean) =>
          Effect.gen(function* () {
            const message = turn.message;
            const replyThreadTs = slackReplyThreadTs(message);
            const isFresh = () => !turn.cancelled && chatState.generation === turn.generation;
            let deliveryUnknown = false;
            let started = false;

            const accepted = observe({
              _tag: "accepted",
              atMs: healthRuntime.now(),
              queued,
            });

            const updateStatus = (status: string) =>
              chatState.statusSemaphore.withPermit(
                Effect.suspend(() =>
                  isFresh()
                    ? transport
                        .setStatus(config.botToken, message.channel, message.statusThreadTs, status)
                        .pipe(
                          Effect.catch((failure) =>
                            Effect.sync(() => {
                              console.error(
                                `[slack] ${message.chatKey} status update failed: ${failure.message}`,
                              );
                            }),
                          ),
                        )
                    : Effect.void,
                ),
              );

            const progressStream: SlackProgressStreamState = {
              ts: undefined,
              failed: false,
              closed: false,
            };

            const streamPermit = Semaphore.makeUnsafe(1);

            const canUseProgressStream =
              transport.startStream !== undefined &&
              transport.appendStream !== undefined &&
              transport.stopStream !== undefined &&
              (message.context.kind === "user" || message.teamId !== undefined);

            const logFeedbackFailure = (kind: string, failure: SlackApiError) =>
              Effect.sync(() => {
                console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
              });

            const applyToolCard = (event: Extract<SlackProgressSignal, { kind: "tool" }>) =>
              Effect.gen(function* () {
                const start = transport.startStream;
                const append = transport.appendStream;

                if (
                  !canUseProgressStream ||
                  progressStream.failed ||
                  progressStream.closed ||
                  start === undefined ||
                  append === undefined
                ) {
                  return;
                }

                const chunk = slackTaskChunk(event);

                if (progressStream.ts === undefined) {
                  if (!isFresh()) return;

                  const options = slackProgressStreamStartOptions(
                    message,
                    config.ownerUserId,
                    chunk,
                  );

                  if (options === undefined) {
                    progressStream.failed = true;

                    return;
                  }

                  const started = yield* Effect.uninterruptible(
                    start(config.botToken, message.channel, message.statusThreadTs, options).pipe(
                      Effect.result,
                      Effect.tap((result) =>
                        Effect.sync(() => {
                          if (Result.isFailure(result)) {
                            progressStream.failed = true;

                            return;
                          }

                          progressStream.ts = result.success.ts;
                        }),
                      ),
                    ),
                  );

                  if (Result.isFailure(started)) {
                    yield* logFeedbackFailure("progress stream start", started.failure);
                  }

                  return;
                }

                if (!isFresh()) return;
                yield* append(config.botToken, message.channel, progressStream.ts, [chunk]).pipe(
                  Effect.catch((failure) => logFeedbackFailure("progress stream append", failure)),
                );
              });

            const publishToolCard = (event: Extract<SlackProgressSignal, { kind: "tool" }>) =>
              Effect.uninterruptible(streamPermit.withPermit(applyToolCard(event)));

            const closeProgressStream = (toolSignals?: Queue.Dequeue<SlackProgressSignal>) =>
              Effect.uninterruptible(
                streamPermit.withPermit(
                  Effect.gen(function* () {
                    if (toolSignals !== undefined) {
                      while (true) {
                        const pending = yield* Queue.poll(toolSignals);

                        if (Option.isNone(pending)) break;

                        if (pending.value.kind === "tool") yield* applyToolCard(pending.value);
                      }
                    }

                    progressStream.closed = true;
                    const ts = progressStream.ts;
                    const stop = transport.stopStream;

                    if (ts === undefined || stop === undefined) return;
                    progressStream.ts = undefined;
                    yield* stop(config.botToken, message.channel, ts).pipe(
                      Effect.catch((failure) =>
                        logFeedbackFailure("progress stream stop", failure),
                      ),
                    );
                  }),
                ),
              );

            const logMessageDeliveryFailure = (kind: string, failure: SlackApiError) =>
              Effect.sync(() => {
                if (deliveryOutcomeUnknown(failure)) deliveryUnknown = true;
                console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
              });

            const runProgress = (
              workingMessage: { readonly ts: string } | undefined,
              initialAtMs: number,
              statusSignals: Queue.Dequeue<SlackProgressSignal>,
              textSignals: Queue.Dequeue<SlackProgressSignal>,
              toolSignals: Queue.Dequeue<SlackProgressSignal>,
            ): Effect.Effect<never> =>
              Effect.gen(function* () {
                let latestText = "";
                let lastStatus = "is thinking...";

                let lastPlaceholder: SlackProgressUpdateState = {
                  atMs: initialAtMs,
                  text: "",
                };

                const publishStatus = (status: string) =>
                  Effect.suspend(() => {
                    if (!isFresh() || status === lastStatus) return Effect.void;
                    lastStatus = status;

                    return updateStatus(status);
                  });

                const publishText = () =>
                  Effect.suspend(() => {
                    if (
                      !isFresh() ||
                      workingMessage === undefined ||
                      !shouldUpdateSlackProgress(lastPlaceholder, latestText, healthRuntime.now())
                    ) {
                      return Effect.void;
                    }

                    const text = slackMessageChunks(latestText)[0];

                    if (text === undefined) return Effect.void;
                    lastPlaceholder = { atMs: healthRuntime.now(), text: latestText };

                    return transport
                      .updateMessage(config.botToken, message.channel, workingMessage.ts, text)
                      .pipe(
                        Effect.catch((failure) =>
                          logFeedbackFailure("progress message update", failure),
                        ),
                      );
                  });

                while (true) {
                  const signal = yield* Effect.raceFirst(
                    Queue.take(statusSignals),
                    Effect.raceFirst(Queue.take(textSignals), Queue.take(toolSignals)),
                  );

                  if (!isFresh()) continue;

                  if (signal.kind === "text") {
                    latestText = signal.snapshot;
                    yield* publishText();
                    continue;
                  }

                  if (signal.kind === "tool") {
                    yield* publishToolCard(signal);
                    continue;
                  }

                  yield* publishText();
                  yield* publishStatus(signal.status);
                }
              });

            const offerProgressHeartbeats = (
              signals: Queue.Enqueue<SlackProgressSignal>,
              activeToolStatus: () => string | undefined,
            ) =>
              Effect.gen(function* () {
                let elapsedSeconds = HEARTBEAT_SECONDS;

                while (true) {
                  yield* Effect.sleep(Duration.seconds(HEARTBEAT_SECONDS));
                  yield* Queue.offer(signals, {
                    kind: "status",
                    status: activeToolStatus() ?? `is still working... (${elapsedSeconds}s)`,
                  });
                  elapsedSeconds += HEARTBEAT_SECONDS;
                }
              });

            const reaction = (operation: "add" | "remove", name: string) => {
              if (!reactionsAvailable) return Effect.void;

              const effect =
                operation === "add"
                  ? transport.addReaction(config.botToken, message.channel, message.sourceTs, name)
                  : transport.removeReaction(
                      config.botToken,
                      message.channel,
                      message.sourceTs,
                      name,
                    );

              return effect.pipe(
                Effect.catch((failure) =>
                  Effect.gen(function* () {
                    if (failure.reason === "authentication") reactionsAvailable = false;
                    yield* logFeedbackFailure(`${operation} ${name} reaction`, failure);
                  }),
                ),
              );
            };

            const acquireFeedback = Effect.gen(function* () {
              if (!isFresh()) return undefined;
              yield* reaction("add", "eyes");
              yield* updateStatus(queued ? "is queued..." : "is thinking...");

              return yield* transport
                .postMessage(
                  config.botToken,
                  message.channel,
                  queued ? QUEUED_MESSAGE : WORKING_MESSAGE,
                  replyThreadTs,
                )
                .pipe(
                  Effect.catch((failure) =>
                    logMessageDeliveryFailure("working message", failure).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
            });

            const work = Effect.acquireUseRelease(
              acquireFeedback,
              (workingMessage) =>
                chatState.semaphore.withPermit(
                  Effect.gen(function* () {
                    if (!isFresh()) return yield* Effect.interrupt;
                    started = true;
                    yield* observe({
                      _tag: "started",
                      atMs: healthRuntime.now(),
                      wasQueued: queued,
                    });

                    if (queued) {
                      yield* updateStatus("is thinking...");

                      if (workingMessage !== undefined) {
                        yield* transport
                          .updateMessage(
                            config.botToken,
                            message.channel,
                            workingMessage.ts,
                            WORKING_MESSAGE,
                          )
                          .pipe(
                            Effect.catch((failure) =>
                              logMessageDeliveryFailure("queued-message update", failure),
                            ),
                          );
                      }
                    }

                    let handle = chatState.handle;

                    if (handle === undefined) {
                      const open = agent.openChat(
                        target,
                        message.context,
                        join(target.path, "sessions", "slack", message.chatKey),
                        "continue",
                        undefined,
                        channelLabels.get(message.channel) === undefined
                          ? undefined
                          : `Slack · ${channelLabels.get(message.channel)}`,
                      );

                      handle =
                        registry === undefined
                          ? yield* open
                          : yield* registry.openAlias(`slack/${message.chatKey}`, "slack", open);
                      chatState.handle = handle;
                    }

                    const reply = yield* Effect.scoped(
                      Effect.gen(function* () {
                        const progressStartedAtMs = healthRuntime.now();
                        const statusSignals = yield* Queue.sliding<SlackProgressSignal>(1);
                        const textSignals = yield* Queue.sliding<SlackProgressSignal>(1);
                        const toolSignals = yield* Queue.unbounded<SlackProgressSignal>();

                        const voiceSignals = yield* Queue.unbounded<
                          | {
                              readonly kind: "voice";
                              readonly agentId: string;
                              readonly text: string;
                            }
                          | { readonly kind: "done" }
                        >();

                        const voicesDrained = yield* Deferred.make<void>();
                        const activeTools = new Map<string, string>();

                        const activeToolStatus = (): string | undefined => {
                          const names = [...activeTools.values()];
                          const name = names[names.length - 1];

                          return name;
                        };

                        yield* offerProgressHeartbeats(statusSignals, activeToolStatus).pipe(
                          Effect.forkScoped,
                        );
                        yield* runProgress(
                          workingMessage,
                          progressStartedAtMs,
                          statusSignals,
                          textSignals,
                          toolSignals,
                        ).pipe(Effect.forkScoped);
                        yield* Effect.gen(function* () {
                          while (true) {
                            const signal = yield* Queue.take(voiceSignals);

                            if (signal.kind === "done") break;

                            if (!isFresh()) continue;
                            yield* retrySlackDelivery("post", () =>
                              transport.postMessage(
                                config.botToken,
                                message.channel,
                                formatSpecialistVoice(signal.agentId, signal.text),
                                replyThreadTs,
                              ),
                            ).pipe(
                              Effect.catch((failure) =>
                                logMessageDeliveryFailure("specialist voice", failure),
                              ),
                            );
                          }

                          yield* Deferred.succeed(voicesDrained, undefined);
                        }).pipe(Effect.forkScoped);

                        const threadHistory =
                          message.context.kind === "group" && message.threadTs !== undefined
                            ? yield* transport.getThreadReplies(
                                config.botToken,
                                message.channel,
                                message.threadTs,
                                message.sourceTs,
                              )
                            : undefined;

                        const resolveFile = transport.downloadFile;

                        const prompt = yield* prepareSlackAttachmentPrompt(
                          message,
                          resolveFile === undefined
                            ? undefined
                            : (file) => resolveFile(config.botToken, file),
                          threadHistory,
                        );

                        const ephemeralContext =
                          threadHistory === undefined
                            ? undefined
                            : renderSlackThreadContext(
                                threadHistory,
                                bot.userId,
                                config.ownerUserId,
                              );

                        chatState.activeMessage = message;

                        const reply = yield* handle
                          .prompt(prompt.text, {
                            onProgress: (event) => {
                              if (!isFresh()) return;

                              if (event.kind === "voice") {
                                Queue.offerUnsafe(voiceSignals, event);

                                return;
                              }

                              if (event.kind === "assistant-text") {
                                Queue.offerUnsafe(textSignals, {
                                  kind: "text",
                                  snapshot: event.snapshot,
                                });

                                return;
                              }

                              if (event.kind !== "tool") return;

                              if (event.phase === "end") {
                                activeTools.delete(event.toolCallId);
                              } else {
                                activeTools.delete(event.toolCallId);

                                if (activeTools.size >= 16) {
                                  const oldest = activeTools.keys().next().value;

                                  if (oldest !== undefined) activeTools.delete(oldest);
                                }

                                activeTools.set(event.toolCallId, slackToolStatus(event));
                              }

                              Queue.offerUnsafe(statusSignals, {
                                kind: "status",
                                status: activeToolStatus() ?? "is thinking...",
                              });

                              if (canUseProgressStream) {
                                Queue.offerUnsafe(toolSignals, {
                                  kind: "tool",
                                  phase: event.phase,
                                  toolCallId: event.toolCallId,
                                  toolName: event.toolName,
                                  failed: event.failed,
                                  ...Object.fromEntries(
                                    event.detail === undefined
                                      ? []
                                      : ([["detail", event.detail]] as const),
                                  ),
                                });
                              }
                            },
                            ...Object.fromEntries(
                              [
                                prompt.images.length > 0
                                  ? (["images", prompt.images] as const)
                                  : undefined,
                                ephemeralContext !== undefined
                                  ? (["ephemeralContext", ephemeralContext] as const)
                                  : undefined,
                              ].flatMap((entry) => (entry === undefined ? [] : [entry])),
                            ),
                          })
                          .pipe(
                            Effect.ensuring(
                              Effect.sync(() => {
                                delete chatState.activeMessage;
                              }),
                            ),
                          );

                        yield* Queue.offer(voiceSignals, { kind: "done" });
                        yield* Deferred.await(voicesDrained);
                        yield* closeProgressStream(toolSignals);

                        return reply;
                      }),
                    );

                    if (!isFresh()) return yield* Effect.interrupt;
                    yield* closeProgressStream();
                    const replyChunks = slackMessageChunks(reply);
                    const chunks = replyChunks.length === 0 ? ["Done."] : replyChunks;
                    const firstChunk = chunks[0];
                    let firstUnsentChunk = 0;

                    if (workingMessage !== undefined && firstChunk !== undefined) {
                      if (!isFresh()) return yield* Effect.interrupt;

                      const updateResult = yield* retrySlackDelivery("update", () =>
                        transport.updateMessage(
                          config.botToken,
                          message.channel,
                          workingMessage.ts,
                          firstChunk,
                        ),
                      ).pipe(Effect.result);

                      if (Result.isSuccess(updateResult)) {
                        firstUnsentChunk = 1;
                      } else {
                        yield* logFeedbackFailure(
                          deliveryOutcomeUnknown(updateResult.failure)
                            ? "final working-message update outcome unknown"
                            : "final working-message update",
                          updateResult.failure,
                        );

                        if (deliveryOutcomeUnknown(updateResult.failure)) {
                          deliveryUnknown = true;
                          firstUnsentChunk = 1;
                        }
                      }
                    }

                    for (const chunk of chunks.slice(firstUnsentChunk)) {
                      if (!isFresh()) return yield* Effect.interrupt;
                      yield* retrySlackDelivery("post", () =>
                        transport.postMessage(
                          config.botToken,
                          message.channel,
                          chunk,
                          replyThreadTs,
                        ),
                      ).pipe(
                        Effect.tapError((failure) =>
                          logMessageDeliveryFailure("final message post", failure),
                        ),
                      );
                    }

                    console.log(
                      `[slack] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
                    );
                  }),
                ),
              (workingMessage, exit) =>
                Effect.gen(function* () {
                  yield* closeProgressStream();
                  const cancelled = turn.cancelled;

                  const terminalState = cancelled
                    ? ("cancelled" as const)
                    : slackIngressTerminalState(deliveryUnknown, Exit.isSuccess(exit));

                  yield* Effect.all(
                    [
                      reaction("remove", "eyes"),
                      reaction(
                        "add",
                        terminalState === "completed"
                          ? "white_check_mark"
                          : terminalState === "cancelled"
                            ? "octagonal_sign"
                            : "x",
                      ),
                    ],
                    { concurrency: "unbounded", discard: true },
                  );
                  yield* Effect.all(
                    [
                      isFresh() ? updateStatus("") : Effect.void,
                      workingMessage !== undefined && (cancelled || Exit.isFailure(exit))
                        ? transport
                            .updateMessage(
                              config.botToken,
                              message.channel,
                              workingMessage.ts,
                              cancelled ? STOPPED_MESSAGE : FAILED_MESSAGE,
                            )
                            .pipe(
                              Effect.catch((failure) =>
                                logMessageDeliveryFailure(
                                  cancelled ? "stopped-message update" : "failure-message update",
                                  failure,
                                ),
                              ),
                            )
                        : Effect.void,
                    ],
                    { concurrency: "unbounded", discard: true },
                  );
                  yield* observe(
                    terminalState === "cancelled"
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
                  );
                  turn.terminalAttempted = true;
                  yield* ingressRuntime.finish(
                    target.path,
                    message,
                    ingressOwnerId,
                    terminalState,
                    healthRuntime.now(),
                  );
                }),
            );

            yield* accepted.pipe(
              Effect.andThen(work),
              Effect.catch(
                (
                  failure:
                    | ZiggyAgentError
                    | SlackApiError
                    | SlackIngressDatabaseError
                    | UiGatewayError,
                ) =>
                  Effect.sync(() => {
                    console.error(`[slack] ${message.chatKey} failed: ${failure.message}`);
                  }),
              ),
            );
          });

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
