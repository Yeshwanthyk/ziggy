import { join } from "node:path";
import { Deferred, Duration, Effect, Exit, Option, Queue, Result, Semaphore } from "effect";
import { SlackApiError } from "../../adapters/slack/api";
import { codePointLength } from "../../domain/memory";
import type { SlackGatewayConfig } from "../../domain/slack";
import type { SlackHealthEvent } from "../../domain/slack-health";
import type { ProfileTarget } from "../../domain/profile";
import type { ZiggyAgentError } from "../../domain/agent";
import type { UiGatewayError } from "../../domain/ui-gateway";
import type { SlackIngressDatabaseError } from "../../domain/slack-ingress";
import { formatSpecialistVoice, type ZiggyAgentApi } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";
import { slackToolStatus } from "../slack-tool-progress";
import { slackReplyThreadTs } from "./intake";
import {
  prepareSlackAttachmentPrompt,
  renderSlackThreadContext,
  slackMessageChunks,
  retrySlackDelivery,
  slackIngressTerminalState,
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
import type {
  ChatState,
  ScheduledSlackTurn,
  SlackHealthRuntime,
  SlackIngressRuntime,
  SlackTransport,
} from "./runtime";

const HEARTBEAT_SECONDS = 30;

interface SlackTurnContext {
  readonly agent: ZiggyAgentApi;
  readonly transport: SlackTransport;
  readonly healthRuntime: SlackHealthRuntime;
  readonly ingressRuntime: SlackIngressRuntime;
  readonly target: ProfileTarget;
  readonly config: SlackGatewayConfig;
  readonly registry: ChatRegistryApi | undefined;
  readonly ingressOwnerId: string;
  readonly botUserId: string;
  readonly channelLabels: Map<string, string>;
  readonly observe: (event: SlackHealthEvent) => Effect.Effect<void>;
  readonly reactionsAvailable: () => boolean;
  readonly disableReactions: () => void;
}

export const makeSlackTurnProcessor =
  ({
    agent,
    transport,
    healthRuntime,
    ingressRuntime,
    target,
    config,
    registry,
    ingressOwnerId,
    botUserId,
    channelLabels,
    observe,
    reactionsAvailable,
    disableReactions,
  }: SlackTurnContext) =>
  (turn: ScheduledSlackTurn, chatState: ChatState, queued: boolean) =>
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

            const options = slackProgressStreamStartOptions(message, config.ownerUserId, chunk);

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
                Effect.catch((failure) => logFeedbackFailure("progress stream stop", failure)),
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
                  Effect.catch((failure) => logFeedbackFailure("progress message update", failure)),
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
        if (!reactionsAvailable()) return Effect.void;

        const effect =
          operation === "add"
            ? transport.addReaction(config.botToken, message.channel, message.sourceTs, name)
            : transport.removeReaction(config.botToken, message.channel, message.sourceTs, name);

        return effect.pipe(
          Effect.catch((failure) =>
            Effect.gen(function* () {
              if (failure.reason === "authentication") disableReactions();
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
              logMessageDeliveryFailure("working message", failure).pipe(Effect.as(undefined)),
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
                      : renderSlackThreadContext(threadHistory, botUserId, config.ownerUserId);

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
                  transport.postMessage(config.botToken, message.channel, chunk, replyThreadTs),
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
          (failure: ZiggyAgentError | SlackApiError | SlackIngressDatabaseError | UiGatewayError) =>
            Effect.sync(() => {
              console.error(`[slack] ${message.chatKey} failed: ${failure.message}`);
            }),
        ),
      );
    });
