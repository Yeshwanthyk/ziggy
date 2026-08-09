import { join } from "node:path";
import { Context, Duration, Effect, Exit, Layer, Result, Semaphore } from "effect";
import type * as Scope from "effect/Scope";
import {
  addReaction,
  authTest,
  postMessage,
  removeReaction,
  setStatus,
  SlackApiError,
  updateMessage,
} from "../adapters/slack/api";
import {
  type SlackInboundMessage,
  type SlackSocket,
  type SlackSocketError,
  openSlackSocket,
} from "../adapters/slack/socket";
import { loadSlackConfigFile } from "../adapters/fs/gateway-config";
import { type ZiggyAgentError } from "../domain/agent";
import { codePointLength, type ChatContext } from "../domain/memory";
import { SlackChannelMode, type SlackGatewayConfig } from "../domain/slack";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ChatHandle, type ZiggyAgentShape } from "./agent";

const SLACK_MESSAGE_LIMIT = 4_000;
const MAX_RETRY_SECONDS = 30;
const MAX_DELIVERY_ATTEMPTS = 4;
const HEARTBEAT_SECONDS = 30;
const WORKING_MESSAGE = "Working on that…";
const QUEUED_MESSAGE = "Queued behind an earlier request…";
const FAILED_MESSAGE = "I couldn't complete that request.";
const SLACK_BROADCAST_MENTION = /<!(?:everyone|channel|here)(?:\|[^>\n]*)?>/gi;

export type SlackGatewayError = SlackApiError;

export interface SlackTransport {
  readonly authTest: (token: string) => Effect.Effect<{ readonly userId: string }, SlackApiError>;
  readonly openSocket: (
    appToken: string,
  ) => Effect.Effect<SlackSocket, SlackSocketError, Scope.Scope>;
  readonly postMessage: (
    token: string,
    channel: string,
    text: string,
    threadTs?: string,
  ) => Effect.Effect<{ readonly ts: string }, SlackApiError>;
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
}

export interface SlackGatewayShape {
  readonly runLoop: (
    target: ProfileTarget,
    config: SlackGatewayConfig,
  ) => Effect.Effect<never, SlackGatewayError>;
}

export class SlackGateway extends Context.Service<SlackGateway, SlackGatewayShape>()(
  "ziggy/SlackGateway",
) {}

interface InboundMessage {
  readonly chatKey: string;
  readonly channel: string;
  readonly context: ChatContext;
  readonly statusThreadTs: string;
  readonly sourceTs: string;
  readonly text: string;
  readonly threadTs: string | undefined;
}

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  handle?: ChatHandle;
  pending: number;
}

export type SlackAdmissionReason =
  | "bot-message"
  | "empty-message"
  | "mention-required"
  | "not-owner";

export type SlackAdmission =
  | { readonly kind: "accepted"; readonly message: InboundMessage }
  | { readonly kind: "ignored"; readonly reason: SlackAdmissionReason };

export const loadSlackGatewayConfig = loadSlackConfigFile;

export const classifySlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "always",
): SlackAdmission => {
  if (message.text.trim().length === 0) {
    return { kind: "ignored", reason: "empty-message" };
  }
  if (message.userId === botUserId) {
    return { kind: "ignored", reason: "bot-message" };
  }
  if (message.userId !== ownerUserId) {
    return { kind: "ignored", reason: "not-owner" };
  }

  if (message.channelType === "im") {
    return {
      kind: "accepted",
      message: {
        chatKey: `user-${message.userId}`,
        channel: message.channel,
        context: { kind: "user", userId: "owner" },
        statusThreadTs: message.threadTs ?? message.ts,
        sourceTs: message.ts,
        text: message.text,
        threadTs: message.threadTs,
      },
    };
  }

  const botMention = `<@${botUserId}>`;
  if (channelMode === "mention" && !message.text.includes(botMention)) {
    return { kind: "ignored", reason: "mention-required" };
  }
  const channelText = message.text.replaceAll(botMention, "").trim();
  if (channelText.length === 0) {
    return { kind: "ignored", reason: "empty-message" };
  }

  // Slack channel IDs are alphanumeric; the "sl" prefix keeps group memory channel-scoped.
  const groupId = `sl${message.channel}`;
  const chatKey =
    message.threadTs === undefined
      ? `group-${groupId}`
      : `group-${groupId}-thread-${encodeURIComponent(message.threadTs)}`;
  return {
    kind: "accepted",
    message: {
      chatKey,
      channel: message.channel,
      context: { kind: "group", groupId },
      statusThreadTs: message.threadTs ?? message.ts,
      sourceTs: message.ts,
      text: channelText,
      threadTs: message.threadTs,
    },
  };
};

export const normalizeSlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
  channelMode: typeof SlackChannelMode.Type = "always",
): InboundMessage | undefined => {
  const admission = classifySlackMessage(message, botUserId, ownerUserId, channelMode);
  return admission.kind === "accepted" ? admission.message : undefined;
};

export const escapeSlackBroadcastMentions = (text: string): string =>
  text.replace(SLACK_BROADCAST_MENTION, (mention) => mention.replace("<", "&lt;"));

export const slackMessageChunks = (text: string): ReadonlyArray<string> => {
  const characters = [...escapeSlackBroadcastMentions(text)];
  const chunks: Array<string> = [];
  let offset = 0;
  while (offset < characters.length) {
    const hardEnd = Math.min(offset + SLACK_MESSAGE_LIMIT, characters.length);
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

type SlackDeliveryKind = "post" | "update";

const retryableDelivery = (kind: SlackDeliveryKind, failure: SlackApiError): boolean =>
  failure.retriable && (kind === "update" || failure.reason === "rate-limited");

const deliveryOutcomeUnknown = (failure: SlackApiError): boolean =>
  failure.reason === "network" || failure.reason === "server" || failure.reason === "decode";

export const slackHeartbeat = (
  updateStatus: (status: string) => Effect.Effect<void>,
  wait: () => Effect.Effect<void> = () => Effect.sleep(Duration.seconds(HEARTBEAT_SECONDS)),
): Effect.Effect<never> =>
  Effect.gen(function* () {
    let elapsedSeconds = HEARTBEAT_SECONDS;
    while (true) {
      yield* wait();
      yield* updateStatus(`is still working... (${elapsedSeconds}s)`);
      elapsedSeconds += HEARTBEAT_SECONDS;
    }
  });

export const retrySlackDelivery = <A>(
  kind: SlackDeliveryKind,
  operation: () => Effect.Effect<A, SlackApiError>,
  delay: (seconds: number) => Effect.Effect<void> = (seconds) =>
    Effect.sleep(Duration.seconds(seconds)),
): Effect.Effect<A, SlackApiError> =>
  Effect.gen(function* () {
    let attempt = 1;
    while (true) {
      const result = yield* operation().pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (result.ok) {
        return result.value;
      }
      if (!retryableDelivery(kind, result.error) || attempt >= MAX_DELIVERY_ATTEMPTS) {
        return yield* result.error;
      }

      const exponentialDelay = 2 ** Math.min(attempt - 1, 5);
      const retryDelay = Math.min(
        MAX_RETRY_SECONDS,
        Math.max(1, result.error.retryAfterSeconds ?? exponentialDelay),
      );
      console.error(
        `[slack] Slack ${result.error.operation} failed; retry ${attempt + 1}/${MAX_DELIVERY_ATTEMPTS} in ${retryDelay}s`,
      );
      yield* delay(retryDelay);
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

const liveSlackTransport: SlackTransport = {
  addReaction,
  authTest,
  openSocket: openSlackSocket,
  postMessage,
  removeReaction,
  setStatus,
  updateMessage,
};

export const makeSlackGateway = (
  agent: ZiggyAgentShape,
  transport: SlackTransport = liveSlackTransport,
): SlackGatewayShape => ({
  runLoop: (target, config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const bot = yield* transport.authTest(config.botToken);
        const chats = new Map<string, ChatState>();
        let reactionsAvailable = true;
        const socket = yield* transport
          .openSocket(config.appToken)
          .pipe(Effect.mapError(socketFailure));
        console.log(
          `[slack] authenticated; socket supervisor started; channel-mode:${config.channelMode ?? "always"}`,
        );
        yield* Effect.addFinalizer(() =>
          socket.close.pipe(
            Effect.catch((failure) => Effect.logWarning("Slack socket close failed", { failure })),
            Effect.andThen(disposeChats(chats)),
          ),
        );

        const processMessage = (message: InboundMessage) => {
          let state = chats.get(message.chatKey);
          if (state === undefined) {
            state = { semaphore: Semaphore.makeUnsafe(1), pending: 0 };
            chats.set(message.chatKey, state);
          }
          const chatState = state;
          const queued = chatState.pending > 0;
          chatState.pending += 1;

          const updateStatus = (status: string) =>
            transport
              .setStatus(config.botToken, message.channel, message.statusThreadTs, status)
              .pipe(
                Effect.catch((failure) =>
                  Effect.sync(() => {
                    console.error(
                      `[slack] ${message.chatKey} status update failed: ${failure.message}`,
                    );
                  }),
                ),
              );

          const logFeedbackFailure = (kind: string, failure: SlackApiError) =>
            Effect.sync(() => {
              console.error(`[slack] ${message.chatKey} ${kind} failed: ${failure.message}`);
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
            yield* reaction("add", "eyes");
            yield* updateStatus(queued ? "is queued..." : "is thinking...");
            return yield* transport
              .postMessage(
                config.botToken,
                message.channel,
                queued ? QUEUED_MESSAGE : WORKING_MESSAGE,
                message.threadTs,
              )
              .pipe(
                Effect.catch((failure) =>
                  logFeedbackFailure("working message", failure).pipe(Effect.as(undefined)),
                ),
              );
          });

          return Effect.acquireUseRelease(
            acquireFeedback,
            (workingMessage) =>
              chatState.semaphore.withPermit(
                Effect.gen(function* () {
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
                            logFeedbackFailure("queued-message update", failure),
                          ),
                        );
                    }
                  }

                  const handle =
                    chatState.handle ??
                    (yield* agent.openChat(
                      target,
                      message.context,
                      join(target.path, "sessions", "slack", message.chatKey),
                    ));
                  chatState.handle = handle;

                  const reply = yield* Effect.scoped(
                    Effect.gen(function* () {
                      yield* slackHeartbeat(updateStatus).pipe(Effect.forkScoped);
                      return yield* handle.prompt(message.text);
                    }),
                  );
                  const replyChunks = slackMessageChunks(reply);
                  const chunks = replyChunks.length === 0 ? ["Done."] : replyChunks;
                  const firstChunk = chunks[0];
                  let firstUnsentChunk = 0;
                  if (workingMessage !== undefined && firstChunk !== undefined) {
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
                        firstUnsentChunk = 1;
                      }
                    }
                  }
                  for (const chunk of chunks.slice(firstUnsentChunk)) {
                    yield* retrySlackDelivery("post", () =>
                      transport.postMessage(
                        config.botToken,
                        message.channel,
                        chunk,
                        message.threadTs,
                      ),
                    );
                  }
                  console.log(
                    `[slack] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
                  );
                }),
              ),
            (workingMessage, exit) =>
              Effect.all(
                [
                  updateStatus(""),
                  Effect.all(
                    [
                      reaction("remove", "eyes"),
                      reaction("add", Exit.isSuccess(exit) ? "white_check_mark" : "x"),
                    ],
                    { concurrency: "unbounded", discard: true },
                  ),
                  Exit.isFailure(exit) && workingMessage !== undefined
                    ? transport
                        .updateMessage(
                          config.botToken,
                          message.channel,
                          workingMessage.ts,
                          FAILED_MESSAGE,
                        )
                        .pipe(
                          Effect.catch((failure) =>
                            logFeedbackFailure("failure-message update", failure),
                          ),
                        )
                    : Effect.void,
                ],
                { concurrency: "unbounded", discard: true },
              ),
          ).pipe(
            Effect.catch((failure: ZiggyAgentError | SlackApiError) =>
              Effect.sync(() => {
                console.error(`[slack] ${message.chatKey} failed: ${failure.message}`);
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                chatState.pending = Math.max(0, chatState.pending - 1);
              }),
            ),
          );
        };

        while (true) {
          const inbound = yield* socket.next.pipe(Effect.mapError(socketFailure));
          const admission = classifySlackMessage(
            inbound,
            bot.userId,
            config.ownerUserId,
            config.channelMode ?? "always",
          );
          if (admission.kind === "accepted") {
            console.log(
              `[slack] admitted ${admission.message.chatKey} activation:${config.channelMode ?? "always"}`,
            );
            yield* processMessage(admission.message).pipe(Effect.forkScoped);
          } else if (admission.reason === "mention-required") {
            console.log(
              `[slack] ignored owner channel message reason:mention-required channel:${inbound.channel}`,
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
    return makeSlackGateway(agent);
  }),
);
