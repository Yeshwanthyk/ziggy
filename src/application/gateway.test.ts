/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- test callbacks expose Bun's Promise boundary */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { TelegramUpdate } from "../adapters/telegram/api";
import type { ZiggyAgentShape } from "./agent";
import {
  makeTelegramGateway,
  nextTelegramOffset,
  normalizeTelegramUpdate,
  type TelegramTransport,
} from "./gateway";

const update = (updateId: number, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    from: { id: 7 },
    chat: { id: 7, type: "private" },
    text,
  },
});

describe("Telegram gateway boundary", () => {
  test("maps an owner DM to owner memory without changing its chat route", () => {
    expect(normalizeTelegramUpdate(update(1, "hello"), 7)).toEqual({
      chatKey: "user-7",
      chatId: 7,
      context: { kind: "user", userId: "owner" },
      text: "hello",
    });
  });

  test("rejects non-owner messages before Pi", () => {
    expect(normalizeTelegramUpdate(update(1, "hello"), 8)).toBeUndefined();
  });

  test("keeps group memory channel-scoped", () => {
    expect(
      normalizeTelegramUpdate(
        {
          update_id: 1,
          message: {
            message_id: 1,
            from: { id: 7 },
            chat: { id: -42, type: "supergroup" },
            text: "hello group",
          },
        },
        7,
      ),
    ).toEqual({
      chatKey: "group-tg42",
      chatId: -42,
      context: { kind: "group", groupId: "tg42" },
      text: "hello group",
    });
  });
});

describe("Telegram gateway startup", () => {
  test("empty startup backlog starts the normal poll at zero", () => {
    expect(nextTelegramOffset([])).toBe(0);
  });

  test("a startup tail advances to the next update", () => {
    expect(nextTelegramOffset([update(41, "old")])).toBe(42);
  });

  test("drops the cold-start tail and processes the first new update once", async () => {
    const calls: Array<{ readonly offset: number; readonly timeout: number }> = [];
    const openedChats: Array<{ readonly context: unknown; readonly sessionDirectory: string }> = [];
    const prompts: Array<string> = [];
    const replies: Array<string> = [];
    let poll = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        const transport: TelegramTransport = {
          getUpdates: (_token, offset, timeout) =>
            Effect.gen(function* () {
              calls.push({ offset, timeout });
              poll += 1;
              if (poll === 1) {
                return [update(41, "offline backlog")];
              }
              if (poll === 2) {
                return [update(42, "new message")];
              }
              return yield* Effect.never;
            }),
          sendMessage: (_token, _chatId, text) =>
            Effect.gen(function* () {
              replies.push(text);
              yield* Deferred.succeed(replied, undefined);
            }),
        };
        const agent: ZiggyAgentShape = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openChat: (_target, context, sessionDirectory) =>
            Effect.sync(() => {
              openedChats.push({ context, sessionDirectory });
              return {
                prompt: (text: string) =>
                  Effect.sync(() => {
                    prompts.push(text);
                    return "reply";
                  }),
                dispose: Effect.void,
              };
            }),
        };
        const gateway = makeTelegramGateway(agent, transport);
        const target = { path: "/tmp/ziggy-gateway-test", name: "Test" };
        const config = { botToken: "token", ownerUserId: 7 };

        yield* Effect.raceFirst(gateway.runLoop(target, config), Deferred.await(replied));
      }),
    );

    expect(calls.slice(0, 2)).toEqual([
      { offset: -1, timeout: 0 },
      { offset: 42, timeout: 30 },
    ]);
    expect(openedChats).toEqual([
      {
        context: { kind: "user", userId: "owner" },
        sessionDirectory: "/tmp/ziggy-gateway-test/sessions/telegram/user-7",
      },
    ]);
    expect(prompts).toEqual(["new message"]);
    expect(replies).toEqual(["reply"]);
  });
});
