import { join } from "node:path";
import { Cause, Deferred, Duration, Effect, Exit, Queue } from "effect";
import type { DiscordApiError } from "../../adapters/discord/api";
import type { DiscordGatewayConfig } from "../../domain/discord";
import type {
  DiscordIngressPayload as InboundMessage,
  DiscordIngressTerminalState,
} from "../../domain/discord-ingress";
import type { DiscordHealthEvent } from "../../domain/discord-health";
import { codePointLength } from "../../platform/text";
import { automationTargetFromString } from "../../domain/automation";
import { formatSpecialistVoice, type ZiggyAgentApi } from "../agent";
import type { DestinationBook } from "../../resident/destinations";
import type { ChatRegistryApi } from "../chat-registry";
import {
  prepareDiscordAttachmentPrompt,
  discordMessageChunks,
  retryDiscordDelivery,
  retryDiscordFeedback,
  discordIngressTerminalState,
  shouldUpdateDiscordProgress,
  discordDeliveryOutcomeUnknown,
  WORKING_MESSAGE,
  QUEUED_MESSAGE,
  FAILED_MESSAGE,
  STOPPED_MESSAGE,
} from "./delivery";
import type {
  ChatState,
  ScheduledDiscordTurn,
  DiscordTransport,
  DiscordHealthRuntime,
  DiscordIngressRuntime,
} from "./model";
import type { DiscordProgressUpdateState } from "./delivery";
import { type ProfileTarget } from "../../profile";

const TYPING_REFRESH_SECONDS = 8;

interface DiscordTurnContext {
  readonly agent: ZiggyAgentApi;
  readonly transport: DiscordTransport;
  readonly healthRuntime: DiscordHealthRuntime;
  readonly ingressRuntime: DiscordIngressRuntime;
  readonly target: ProfileTarget;
  readonly config: DiscordGatewayConfig;
  readonly registry: ChatRegistryApi | undefined;
  readonly destinations: DestinationBook | undefined;
  readonly ingressOwnerId: string;
  readonly observe: (event: DiscordHealthEvent) => Effect.Effect<void>;
}

export const makeDiscordTurnProcessor = ({
  agent,
  transport,
  healthRuntime,
  ingressRuntime,
  target,
  config,
  registry,
  destinations,
  ingressOwnerId,
  observe,
}: DiscordTurnContext) => {
  const reactionUnavailableChannels = new Set<string>();
  const typingUnavailableChannels = new Set<string>();

  const updateFeedback = (message: InboundMessage, placeholderId: string, text: string) =>
    retryDiscordDelivery("idempotent", () =>
      transport.updateMessage(config.botToken, message.channelId, placeholderId, text),
    ).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          console.error(`[discord] ${message.chatKey} feedback update failed: ${failure.message}`);
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

  const maintainTyping = (message: InboundMessage, isFresh: () => boolean): Effect.Effect<never> =>
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

  const processMessage = (turn: ScheduledDiscordTurn, chatState: ChatState, queued: boolean) => {
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
            if (destinations !== undefined) {
              const target = automationTargetFromString(`discord:channel:${message.channelId}`);

              if (target !== undefined) {
                const destination =
                  message.label === undefined ? { target } : { target, label: message.label };

                yield* destinations.remember(destination);
              }
            }

            const open = agent.open({
              target,
              context: message.context,
              directory: join(target.path, "sessions", "discord", message.chatKey),
              session: "continue",
              name: message.label === undefined ? undefined : `Discord · ${message.label}`,
            });

            chatState.handle =
              registry === undefined
                ? yield* open
                : yield* registry.openAlias(`discord/${message.chatKey}`, "discord", open);
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

                    if (!isFresh() || !shouldUpdateDiscordProgress(previous, snapshot, atMs)) {
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
              transport.updateMessage(config.botToken, message.channelId, firstMessageId, first),
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

  return { processMessage, reaction };
};
