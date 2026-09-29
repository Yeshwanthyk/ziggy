import { join } from "node:path";
import { Deferred, Duration, Effect, Exit, Queue, Result } from "effect";
import type { SlackApiError } from "../../adapters/slack/api";
import { codePointLength } from "../../domain/memory";
import type { SlackGatewayConfig } from "../../domain/slack";
import type { SlackHealthEvent } from "../../domain/slack-health";
import type { ProfileTarget } from "../../domain/profile";
import type { ZiggyAgentError } from "../../domain/agent";
import type { UiGatewayError } from "../../domain/ui-gateway";
import type { SlackIngressDatabaseError } from "../../domain/slack-ingress";
import { formatSpecialistVoice, type ZiggyAgentApi } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";
import { slackTaskTitle } from "../slack-tool-progress";
import { makeTurnProgress } from "./progress";
import { slackReplyThreadTs } from "./intake";
import {
  prepareSlackAttachmentPrompt,
  renderSlackThreadContext,
  slackMessageChunks,
  retrySlackDelivery,
  slackIngressTerminalState,
  shouldUpdateSlackProgress,
  deliveryOutcomeUnknown,
  WORKING_MESSAGE,
  QUEUED_MESSAGE,
  FAILED_MESSAGE,
  STOPPED_MESSAGE,
  type SlackProgressSignal,
  type SlackProgressUpdateState,
} from "./delivery";
import type {
  ChatState,
  ScheduledSlackTurn,
  SlackHealthRuntime,
  SlackIngressRuntime,
  SlackTransport,
} from "./model";

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

      const progress = makeTurnProgress(
        transport,
        config.botToken,
        message.channel,
        message.statusThreadTs,
        message.context.kind === "user"
          ? undefined
          : message.teamId === undefined
            ? undefined
            : {
                userId: config.ownerUserId,
                teamId: message.teamId,
              },
        healthRuntime.now,
        (kind, failure) =>
          Effect.sync(() => {
            console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
          }),
      );

      const canStream = message.context.kind === "user" || message.teamId !== undefined;

      const logMessageDeliveryFailure = (kind: string, failure: SlackApiError) =>
        Effect.sync(() => {
          if (deliveryOutcomeUnknown(failure)) deliveryUnknown = true;
          console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
        });

      const runProgress = (
        workingMessage: { readonly ts: string } | undefined,
        initialAtMs: number,
        signals: Queue.Dequeue<SlackProgressSignal>,
      ): Effect.Effect<never> =>
        Effect.gen(function* () {
          let lastPlaceholder: SlackProgressUpdateState = { atMs: initialAtMs, text: "" };
          let lastStreamTextAt = initialAtMs;
          let latestText = "";
          let lastStatus = "";
          let lastStatusAt = initialAtMs;

          while (true) {
            const signal = yield* Queue.take(signals);

            if (!isFresh()) continue;

            if (signal.kind === "flush") {
              if (progress.started) yield* progress.text(latestText);
              yield* Deferred.succeed(signal.done, undefined);
              continue;
            }

            if (signal.kind === "text") {
              latestText = signal.snapshot;

              if (progress.started) {
                if (healthRuntime.now() - lastStreamTextAt >= 1_500) {
                  lastStreamTextAt = healthRuntime.now();
                  yield* progress.text(latestText);
                }
              } else if (
                workingMessage !== undefined &&
                shouldUpdateSlackProgress(lastPlaceholder, latestText, healthRuntime.now())
              ) {
                const text = slackMessageChunks(latestText)[0];

                if (text !== undefined) {
                  lastPlaceholder = { atMs: healthRuntime.now(), text: latestText };
                  yield* transport
                    .updateMessage(config.botToken, message.channel, workingMessage.ts, text)
                    .pipe(
                      Effect.catch((failure) =>
                        Effect.logWarning("Slack progress message update failed", { failure }),
                      ),
                    );
                }
              }

              continue;
            }

            if (signal.kind === "tool") {
              yield* progress.change({
                kind: "tool",
                atMs: healthRuntime.now(),
                phase: signal.phase,
                toolCallId: signal.toolCallId,
                category: slackTaskTitle(signal.toolName, signal.detail),
                failed: signal.failed,
                ...(signal.phase === "start" && signal.detail !== undefined
                  ? { detail: signal.detail }
                  : undefined),
              });
            } else if (signal.kind === "steer") {
              yield* progress.change({
                kind: "steer",
                atMs: healthRuntime.now(),
                excerpt: signal.excerpt,
              });
            } else if (signal.kind === "specialist") {
              yield* progress.change({
                kind: "specialist",
                atMs: healthRuntime.now(),
                agentId: signal.agentId,
              });
            } else if (signal.kind === "heartbeat") {
              yield* progress.change({ kind: "tick", atMs: healthRuntime.now() });
            } else if (signal.kind === "active") {
              yield* progress.change({ kind: "active", atMs: healthRuntime.now() });
            }

            const headline = progress.headline;
            const status = `is ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`;

            if (
              status !== lastStatus &&
              (signal.kind !== "heartbeat" || healthRuntime.now() - lastStatusAt >= 10_000) &&
              (signal.kind !== "tool" ||
                signal.phase !== "update" ||
                healthRuntime.now() - lastStatusAt >= 10_000)
            ) {
              lastStatus = status;
              lastStatusAt = healthRuntime.now();
              yield* updateStatus(status);
            }
          }
        });

      const offerProgressHeartbeats = (signals: Queue.Enqueue<SlackProgressSignal>) =>
        Effect.forever(
          Effect.sleep(Duration.seconds(HEARTBEAT_SECONDS)).pipe(
            Effect.andThen(Queue.offer(signals, { kind: "heartbeat" })),
          ),
        );

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
              yield* Effect.logWarning(`Slack ${operation} ${name} reaction failed`, { failure });
            }),
          ),
        );
      };

      const acquireFeedback = Effect.gen(function* () {
        // Acquisition is uninterruptible: every accepted observation has a release observation,
        // even when stop wins the race while the health projection is being written.

        yield* observe({ _tag: "accepted", atMs: healthRuntime.now(), queued });

        if (!isFresh()) return undefined;
        yield* reaction("add", "eyes");
        const streaming = yield* progress.start(queued, canStream);
        yield* updateStatus(`is ${progress.headline.toLowerCase()}`);

        if (streaming) return undefined;

        return yield* transport
          .postMessage(
            config.botToken,
            message.channel,
            queued ? QUEUED_MESSAGE : WORKING_MESSAGE,
            replyThreadTs,
          )
          .pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Slack working message failed", { failure }).pipe(
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
                yield* progress.change({ kind: "active", atMs: healthRuntime.now() });
                yield* updateStatus(`is ${progress.headline.toLowerCase()}`);

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
                        Effect.logWarning("Slack queued-message update failed", { failure }),
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
                  const progressSignals = yield* Queue.unbounded<SlackProgressSignal>();
                  chatState.progressSink = (excerpt) =>
                    Queue.offerUnsafe(progressSignals, { kind: "steer", excerpt });

                  const voiceSignals = yield* Queue.unbounded<
                    | {
                        readonly kind: "voice";
                        readonly agentId: string;
                        readonly text: string;
                      }
                    | { readonly kind: "done" }
                  >();

                  const voicesDrained = yield* Deferred.make<void>();
                  yield* offerProgressHeartbeats(progressSignals).pipe(Effect.forkScoped);
                  yield* runProgress(workingMessage, progressStartedAtMs, progressSignals).pipe(
                    Effect.forkScoped,
                  );
                  yield* Effect.gen(function* () {
                    while (true) {
                      const signal = yield* Queue.take(voiceSignals);

                      if (signal.kind === "done") break;

                      if (!isFresh()) continue;
                      Queue.offerUnsafe(progressSignals, {
                        kind: "specialist",
                        agentId: signal.agentId,
                      });
                      yield* retrySlackDelivery("post", () =>
                        transport.postMessage(
                          config.botToken,
                          message.channel,
                          formatSpecialistVoice(signal.agentId, signal.text),
                          replyThreadTs,
                        ),
                      ).pipe(
                        Effect.catch((failure) =>
                          Effect.logWarning("Slack specialist voice failed", { failure }),
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
                          Queue.offerUnsafe(progressSignals, {
                            kind: "text",
                            snapshot: event.snapshot,
                          });

                          return;
                        }

                        if (event.kind !== "tool") return;

                        Queue.offerUnsafe(progressSignals, {
                          kind: "tool",
                          phase: event.phase,
                          toolCallId: event.toolCallId,
                          toolName: event.toolName,
                          failed: event.failed,
                          ...Object.fromEntries(
                            event.detail === undefined ? [] : ([["detail", event.detail]] as const),
                          ),
                        });
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

                  if (progress.started) {
                    const flushed = yield* Deferred.make<void>();
                    yield* Queue.offer(progressSignals, { kind: "flush", done: flushed });
                    // A stalled progress append must not hold the final answer hostage.
                    yield* Deferred.await(flushed).pipe(Effect.timeoutOption(Duration.seconds(2)));
                  }

                  return reply;
                }),
              );

              if (!isFresh()) return yield* Effect.interrupt;
              const streamDelivered = yield* progress.finish("done", reply);
              const replyChunks = slackMessageChunks(reply);
              const chunks = replyChunks.length === 0 ? ["Done."] : replyChunks;
              const firstChunk = chunks[0];
              let firstUnsentChunk = 0;

              if (streamDelivered) firstUnsentChunk = 1;

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
                  yield* logMessageDeliveryFailure(
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
            if (chatState.progressSink !== undefined) delete chatState.progressSink;
            yield* progress.finish(
              turn.cancelled ? "stopped" : Exit.isSuccess(exit) ? "done" : "failed",
            );
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
                          Effect.logWarning("Slack terminal feedback update failed", { failure }),
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

      yield* work.pipe(
        Effect.catch(
          (failure: ZiggyAgentError | SlackApiError | SlackIngressDatabaseError | UiGatewayError) =>
            Effect.sync(() => {
              console.error(`[slack] ${message.chatKey} failed: ${failure.message}`);
            }),
        ),
      );
    });
