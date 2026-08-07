import { join } from "node:path";
import { Context, Duration, Effect, Layer, Semaphore } from "effect";
import type * as Scope from "effect/Scope";
import { createMessage, DiscordApiError } from "../adapters/discord/api";
import {
  type DiscordInboundMessage,
  type DiscordSocket,
  type DiscordSocketError,
  openDiscordSocket,
} from "../adapters/discord/socket";
import { loadDiscordConfigFile } from "../adapters/fs/gateway-config";
import { type ZiggyAgentError } from "../domain/agent";
import type { DiscordGatewayConfig } from "../domain/discord";
import { codePointLength, type ChatContext } from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";
import { ZiggyAgent, type ChatHandle, type ZiggyAgentShape } from "./agent";

const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DISCORD_MESSAGE_LIMIT = 2_000;
const MAX_RETRY_SECONDS = 30;

export type DiscordGatewayError = DiscordApiError;

export interface DiscordTransport {
  readonly openSocket: (
    token: string,
    intents: number,
  ) => Effect.Effect<DiscordSocket, DiscordSocketError, Scope.Scope>;
  readonly createMessage: (
    token: string,
    channelId: string,
    text: string,
  ) => Effect.Effect<void, DiscordApiError>;
}

export interface DiscordGatewayShape {
  readonly runLoop: (
    target: ProfileTarget,
    config: DiscordGatewayConfig,
  ) => Effect.Effect<never, DiscordGatewayError>;
}

export class DiscordGateway extends Context.Service<DiscordGateway, DiscordGatewayShape>()(
  "ziggy/DiscordGateway",
) {}

interface InboundMessage {
  readonly chatKey: string;
  readonly channelId: string;
  readonly context: ChatContext;
  readonly text: string;
}

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  handle?: ChatHandle;
}

export const loadDiscordGatewayConfig = loadDiscordConfigFile;

export const normalizeDiscordMessage = (
  message: DiscordInboundMessage,
  ownerUserId: string,
): InboundMessage | undefined => {
  if (
    message.authorIsBot ||
    message.authorId !== ownerUserId ||
    message.content.trim().length === 0
  ) {
    return undefined;
  }

  if (message.guildId === undefined) {
    return {
      chatKey: `user-${message.authorId}`,
      channelId: message.channelId,
      context: { kind: "user", userId: "owner" },
      text: message.content,
    };
  }

  // Discord channel IDs are snowflakes; the "dc" prefix keeps group memory channel-scoped.
  const groupId = `dc${message.channelId}`;
  return {
    chatKey: `group-${groupId}`,
    channelId: message.channelId,
    context: { kind: "group", groupId },
    text: message.content,
  };
};

export const discordMessageChunks = (text: string): ReadonlyArray<string> => {
  const characters = [...text];
  const chunks: Array<string> = [];
  for (let offset = 0; offset < characters.length; offset += DISCORD_MESSAGE_LIMIT) {
    chunks.push(characters.slice(offset, offset + DISCORD_MESSAGE_LIMIT).join(""));
  }
  return chunks;
};

const retryDiscord = <A>(
  operation: () => Effect.Effect<A, DiscordApiError>,
): Effect.Effect<A, DiscordApiError> =>
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
      console.error(
        `[discord] Discord ${result.error.operation} failed; retrying in ${retryDelay}s`,
      );
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
  createMessage,
};

export const makeDiscordGateway = (
  agent: ZiggyAgentShape,
  transport: DiscordTransport = liveDiscordTransport,
): DiscordGatewayShape => ({
  runLoop: (target, config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const chats = new Map<string, ChatState>();
        const socket = yield* transport
          .openSocket(config.botToken, DISCORD_INTENTS)
          .pipe(Effect.mapError(socketFailure));
        yield* Effect.addFinalizer(() =>
          socket.close.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Discord socket close failed", { failure }),
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
                  join(target.path, "sessions", "discord", message.chatKey),
                );
              }

              const reply = yield* chatState.handle.prompt(message.text);
              for (const chunk of discordMessageChunks(reply)) {
                yield* retryDiscord(() =>
                  transport.createMessage(config.botToken, message.channelId, chunk),
                );
              }
              console.log(
                `[discord] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
              );
            }).pipe(
              Effect.catch((failure: ZiggyAgentError | DiscordApiError) =>
                Effect.sync(() => {
                  console.error(`[discord] ${message.chatKey} failed: ${failure.message}`);
                }),
              ),
            ),
          );
        };

        while (true) {
          const inbound = yield* socket.next.pipe(Effect.mapError(socketFailure));
          const message = normalizeDiscordMessage(inbound, config.ownerUserId);
          if (message !== undefined) {
            yield* processMessage(message).pipe(Effect.forkScoped);
          }
        }
      }),
    ),
});

export const DiscordGatewayLive = Layer.effect(
  DiscordGateway,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return makeDiscordGateway(agent);
  }),
);
