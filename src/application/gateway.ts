import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Duration, Effect, Layer, Semaphore } from "effect";
import {
  getUpdates,
  sendMessage,
  type TelegramApiError,
  type TelegramUpdate,
} from "../adapters/telegram/api";
import { ZiggyAgent, type ChatHandle, type ZiggyAgentShape } from "./agent";
import { type ZiggyAgentError, ProfileNotInitialized } from "../domain/agent";
import { codePointLength, type ChatContext } from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";
import {
  decodeTelegramGatewayConfigJson,
  GatewayConfigError,
  type TelegramGatewayConfig,
} from "../domain/telegram";

const TELEGRAM_LONG_POLL_SECONDS = 30;
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const MAX_RETRY_SECONDS = 30;

export type GatewayError = TelegramApiError;

export interface GatewayShape {
  readonly runLoop: (
    target: ProfileTarget,
    config: TelegramGatewayConfig,
  ) => Effect.Effect<never, GatewayError>;
}

export class Gateway extends Context.Service<Gateway, GatewayShape>()("ziggy/Gateway") {}

interface InboundMessage {
  readonly chatKey: string;
  readonly chatId: number;
  readonly context: ChatContext;
  readonly text: string;
}

interface ChatState {
  readonly semaphore: Semaphore.Semaphore;
  handle?: ChatHandle;
}

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const configGuidance = (configPath: string): string =>
  `create ${configPath} with {"botToken":"...","ownerUserId":123}`;

export const loadGatewayConfig = (
  target: ProfileTarget,
): Effect.Effect<TelegramGatewayConfig, ProfileNotInitialized | GatewayConfigError> =>
  Effect.gen(function* () {
    const soulPath = join(target.path, "SOUL.md");
    const soulStatus = yield* Effect.tryPromise({
      try: () => stat(soulPath),
      catch: (cause) =>
        errorCode(cause) === "ENOENT"
          ? new ProfileNotInitialized({
              profilePath: target.path,
              message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
            })
          : new GatewayConfigError({
              path: soulPath,
              message: `could not inspect ${soulPath}`,
            }),
    });
    if (!soulStatus.isFile()) {
      return yield* new ProfileNotInitialized({
        profilePath: target.path,
        message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
      });
    }

    const configPath = join(target.path, "telegram.json");
    const source = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf8"),
      catch: () =>
        new GatewayConfigError({
          path: configPath,
          message: configGuidance(configPath),
        }),
    });
    return yield* decodeTelegramGatewayConfigJson(source).pipe(
      Effect.mapError(
        () =>
          new GatewayConfigError({
            path: configPath,
            message: configGuidance(configPath),
          }),
      ),
    );
  });

const normalizeUpdate = (
  update: TelegramUpdate,
  ownerUserId: number,
): InboundMessage | undefined => {
  const message = update.message;
  if (message?.from?.id !== ownerUserId || message.text === undefined) {
    return undefined;
  }

  if (message.chat.type === "private") {
    return {
      chatKey: `user-${message.from.id}`,
      chatId: message.chat.id,
      context: { kind: "user", userId: String(message.from.id) },
      text: message.text,
    };
  }

  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    // Telegram group IDs are negative; the "tg" prefix makes a stable filesystem-safe memory ID.
    const groupId = `tg${Math.abs(message.chat.id)}`;
    return {
      chatKey: `group-${groupId}`,
      chatId: message.chat.id,
      context: { kind: "group", groupId },
      text: message.text,
    };
  }

  return undefined;
};

const chunkMessage = (text: string): ReadonlyArray<string> => {
  const characters = [...text];
  const chunks: Array<string> = [];
  for (let offset = 0; offset < characters.length; offset += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(characters.slice(offset, offset + TELEGRAM_MESSAGE_LIMIT).join(""));
  }
  return chunks;
};

const retryTelegram = <A>(
  operation: () => Effect.Effect<A, TelegramApiError>,
): Effect.Effect<A, TelegramApiError> =>
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
        `[gateway] Telegram ${result.error.operation} failed; retrying in ${retryDelay}s`,
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
            Effect.catch((error) =>
              Effect.sync(() => {
                console.error(`[gateway] ${chatKey} dispose failed: ${error.message}`);
              }),
            ),
          ),
    { concurrency: "unbounded", discard: true },
  );

const makeRunLoop =
  (agent: ZiggyAgentShape): GatewayShape["runLoop"] =>
  (target, config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const chats = new Map<string, ChatState>();
        yield* Effect.addFinalizer(() => disposeChats(chats));

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
                  join(target.path, "sessions", "telegram", message.chatKey),
                );
              }

              const reply = yield* chatState.handle.prompt(message.text);
              for (const chunk of chunkMessage(reply)) {
                yield* retryTelegram(() => sendMessage(config.botToken, message.chatId, chunk));
              }
              console.log(
                `[gateway] ${message.chatKey} in:${codePointLength(message.text)} out:${codePointLength(reply)} chars`,
              );
            }).pipe(
              Effect.catch((error: ZiggyAgentError | TelegramApiError) =>
                Effect.sync(() => {
                  console.error(`[gateway] ${message.chatKey} failed: ${error.message}`);
                }),
              ),
            ),
          );
        };

        let offset = 0;
        while (true) {
          const updates = yield* retryTelegram(() =>
            getUpdates(config.botToken, offset, TELEGRAM_LONG_POLL_SECONDS),
          );
          offset = updates.reduce(
            (nextOffset, update) => Math.max(nextOffset, update.update_id + 1),
            offset,
          );
          const messages = updates.flatMap((update) => {
            const message = normalizeUpdate(update, config.ownerUserId);
            return message === undefined ? [] : [message];
          });
          yield* Effect.forEach(messages, processMessage, {
            concurrency: "unbounded",
            discard: true,
          });
        }
      }),
    );

export const GatewayLive = Layer.effect(
  Gateway,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    return { runLoop: makeRunLoop(agent) };
  }),
);
