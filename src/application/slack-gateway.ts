import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Duration, Effect, Layer, Semaphore } from "effect";
import type * as Scope from "effect/Scope";
import { authTest, postMessage, SlackApiError } from "../adapters/slack/api";
import {
  type SlackInboundMessage,
  type SlackSocket,
  type SlackSocketError,
  openSlackSocket,
} from "../adapters/slack/socket";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { type ZiggyAgentError } from "../domain/agent";
import { GatewayConfigError } from "../domain/gateway";
import { codePointLength, type ChatContext } from "../domain/memory";
import { decodeSlackGatewayConfigJson, type SlackGatewayConfig } from "../domain/slack";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ChatHandle, type ZiggyAgentShape } from "./agent";

const SLACK_MESSAGE_LIMIT = 4_000;
const MAX_RETRY_SECONDS = 30;

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
  readonly text: string;
  readonly threadTs: string | undefined;
}

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  handle?: ChatHandle;
}

const configGuidance = (configPath: string): string =>
  `create ${configPath} with {"botToken":"xoxb-...","appToken":"xapp-...","ownerUserId":"U0123ABC"}`;

export const loadSlackGatewayConfig = (
  target: ProfileTarget,
): Effect.Effect<SlackGatewayConfig, GatewayConfigError> =>
  Effect.gen(function* () {
    const soulPath = join(target.path, "SOUL.md");
    const soulStatus = yield* Effect.tryPromise({
      try: () => stat(soulPath),
      catch: (cause) =>
        new GatewayConfigError({
          path: soulPath,
          message:
            fileSystemCauseDetails(cause).code === "ENOENT"
              ? `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`
              : `could not inspect ${soulPath}`,
        }),
    });
    if (!soulStatus.isFile()) {
      return yield* new GatewayConfigError({
        path: soulPath,
        message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
      });
    }

    const configPath = join(target.path, "slack.json");
    const source = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf8"),
      catch: () =>
        new GatewayConfigError({
          path: configPath,
          message: configGuidance(configPath),
        }),
    });
    return yield* decodeSlackGatewayConfigJson(source).pipe(
      Effect.mapError(
        () =>
          new GatewayConfigError({
            path: configPath,
            message: configGuidance(configPath),
          }),
      ),
    );
  });

export const normalizeSlackMessage = (
  message: SlackInboundMessage,
  botUserId: string,
  ownerUserId: string,
): InboundMessage | undefined => {
  if (
    message.text.trim().length === 0 ||
    message.userId === botUserId ||
    message.userId !== ownerUserId
  ) {
    return undefined;
  }

  if (message.channelType === "im") {
    return {
      chatKey: `user-${message.userId}`,
      channel: message.channel,
      context: { kind: "user", userId: "owner" },
      text: message.text,
      threadTs: message.threadTs,
    };
  }

  // Slack channel IDs are alphanumeric; the "sl" prefix keeps group memory channel-scoped.
  const groupId = `sl${message.channel}`;
  return {
    chatKey: `group-${groupId}`,
    channel: message.channel,
    context: { kind: "group", groupId },
    text: message.text,
    threadTs: message.threadTs,
  };
};

export const slackMessageChunks = (text: string): ReadonlyArray<string> => {
  const characters = [...text];
  const chunks: Array<string> = [];
  for (let offset = 0; offset < characters.length; offset += SLACK_MESSAGE_LIMIT) {
    chunks.push(characters.slice(offset, offset + SLACK_MESSAGE_LIMIT).join(""));
  }
  return chunks;
};

const retrySlack = <A>(
  operation: () => Effect.Effect<A, SlackApiError>,
): Effect.Effect<A, SlackApiError> =>
  Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const result = yield* operation().pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (result.ok) {
        return result.value;
      }
      if (!result.error.retriable) {
        return yield* result.error;
      }

      const exponentialDelay = 2 ** Math.min(attempt, 5);
      const retryDelay = Math.min(
        MAX_RETRY_SECONDS,
        Math.max(1, result.error.retryAfterSeconds ?? exponentialDelay),
      );
      console.error(`[slack] Slack ${result.error.operation} failed; retrying in ${retryDelay}s`);
      yield* Effect.sleep(Duration.seconds(retryDelay));
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
  authTest,
  openSocket: openSlackSocket,
  postMessage,
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
        const socket = yield* transport.openSocket(config.appToken).pipe(
          Effect.mapError(socketFailure),
        );
        yield* Effect.addFinalizer(() =>
          socket.close.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Slack socket close failed", { failure }),
            ),
            Effect.andThen(disposeChats(chats)),
          ),
        );

        const processMessage = (message: InboundMessage) => {
          let state = chats.get(message.chatKey);
          if (state === undefined) {
            state = { semaphore: Semaphore.makeUnsafe(1) };
            chats.set(message.chatKey, state);
          }
          const chatState = state;

          return chatState.semaphore.withPermit(
            Effect.gen(function* () {
              if (chatState.handle === undefined) {
                chatState.handle = yield* agent.openChat(
                  target,
                  message.context,
                  join(target.path, "sessions", "slack", message.chatKey),
                );
              }

              const reply = yield* chatState.handle.prompt(message.text);
              for (const chunk of slackMessageChunks(reply)) {
                yield* retrySlack(() =>
                  transport.postMessage(config.botToken, message.channel, chunk, message.threadTs),
                );
              }
              console.log(
                `[slack] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
              );
            }).pipe(
              Effect.catch((failure: ZiggyAgentError | SlackApiError) =>
                Effect.sync(() => {
                  console.error(`[slack] ${message.chatKey} failed: ${failure.message}`);
                }),
              ),
            ),
          );
        };

        while (true) {
          const inbound = yield* socket.next.pipe(Effect.mapError(socketFailure));
          const message = normalizeSlackMessage(inbound, bot.userId, config.ownerUserId);
          if (message !== undefined) {
            yield* processMessage(message).pipe(Effect.forkScoped);
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
