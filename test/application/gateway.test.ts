/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- test callbacks expose Bun's Promise boundary */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { TelegramUpdate } from "ziggy/adapters/telegram/api";
import { formatSpecialistVoice, makeChatHandle, type ZiggyAgentApi } from "ziggy/application/agent";
import {
  isTelegramStopCommand,
  makeTelegramGateway,
  nextTelegramOffset,
  normalizeTelegramUpdate,
  type TelegramTransport,
} from "ziggy/application/gateway";

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

  test("treats only exact owner stop text as a stop command", () => {
    expect(isTelegramStopCommand("stop")).toBe(true);
    expect(isTelegramStopCommand("/stop")).toBe(true);
    expect(isTelegramStopCommand(" STOP ")).toBe(true);
    expect(isTelegramStopCommand("stop now")).toBe(false);
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
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: (_target, context, sessionDirectory) =>
            Effect.sync(() => {
              openedChats.push({ context, sessionDirectory });
              return makeChatHandle({
                prompt: (text: string) =>
                  Effect.sync(() => {
                    prompts.push(text);
                    return "reply";
                  }),
                dispose: Effect.void,
              });
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

describe("Telegram gateway stop", () => {
  test("aborts an in-flight prompt without prompting the stop text", async () => {
    const prompts: Array<string> = [];
    const replies: Array<string> = [];
    let aborted = 0;
    let poll = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const transport: TelegramTransport = {
          getUpdates: () =>
            Effect.gen(function* () {
              poll += 1;
              if (poll === 1) return [];
              if (poll === 2) return [update(1, "long request")];
              if (poll === 3) {
                yield* Deferred.await(started);
                return [update(2, "stop")];
              }
              return yield* Effect.never;
            }),
          sendMessage: (_token, _chatId, text) =>
            Effect.gen(function* () {
              replies.push(text);
              if (text === "Stopped.") yield* Deferred.succeed(stopped, undefined);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                isIdle: false,
                prompt: (text) =>
                  Effect.gen(function* () {
                    prompts.push(text);
                    yield* Deferred.succeed(started, undefined);
                    return yield* Effect.never;
                  }),
                abort: Effect.sync(() => {
                  aborted += 1;
                }),
                dispose: Effect.void,
              }),
            ),
        };

        yield* Effect.raceFirst(
          makeTelegramGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-telegram-stop-test", name: "Test" },
            { botToken: "token", ownerUserId: 7 },
          ),
          Deferred.await(stopped),
        );
      }),
    );

    expect(prompts).toEqual(["long request"]);
    expect(aborted).toBe(1);
    expect(replies).toEqual(["Stopped."]);
  });

  test("replies that nothing was running when owner stop arrives idle", async () => {
    const prompts: Array<string> = [];
    const replies: Array<string> = [];
    let aborted = 0;
    let openChatCalls = 0;
    let poll = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const acknowledged = yield* Deferred.make<void>();
        const transport: TelegramTransport = {
          getUpdates: () =>
            Effect.gen(function* () {
              poll += 1;
              if (poll === 1) return [];
              if (poll === 2) return [update(1, "/stop")];
              return yield* Effect.never;
            }),
          sendMessage: (_token, _chatId, text) =>
            Effect.gen(function* () {
              replies.push(text);
              yield* Deferred.succeed(acknowledged, undefined);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.sync(() => {
              openChatCalls += 1;
              return makeChatHandle({
                prompt: (text) =>
                  Effect.sync(() => {
                    prompts.push(text);
                    return "should not prompt";
                  }),
                abort: Effect.sync(() => {
                  aborted += 1;
                }),
                dispose: Effect.void,
              });
            }),
        };

        yield* Effect.raceFirst(
          makeTelegramGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-telegram-idle-stop-test", name: "Test" },
            { botToken: "token", ownerUserId: 7 },
          ),
          Deferred.await(acknowledged),
        );
      }),
    );

    expect(openChatCalls).toBe(0);
    expect(prompts).toEqual([]);
    expect(aborted).toBe(0);
    expect(replies).toEqual(["Nothing was running."]);
  });

  test("posts specialist voices then still delivers the parent reply", async () => {
    const replies: Array<string> = [];
    let poll = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        const transport: TelegramTransport = {
          getUpdates: () =>
            Effect.gen(function* () {
              poll += 1;
              if (poll === 1) return [];
              if (poll === 2) return [update(1, "discuss please")];
              return yield* Effect.never;
            }),
          sendMessage: (_token, _chatId, text) =>
            Effect.gen(function* () {
              replies.push(text);
              if (text === "parent wrap") yield* Deferred.succeed(replied, undefined);
            }),
        };
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openSpecialistChat: () =>
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
          openChat: () =>
            Effect.succeed(
              makeChatHandle({
                prompt: (_text, options) => {
                  options?.onProgress?.({
                    kind: "voice",
                    agentId: "alpha",
                    text: "first look",
                  });
                  options?.onProgress?.({
                    kind: "voice",
                    agentId: "beta",
                    text: "second look",
                  });
                  return Effect.succeed("parent wrap");
                },
                dispose: Effect.void,
              }),
            ),
        };

        yield* Effect.raceFirst(
          makeTelegramGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-telegram-voice-test", name: "Test" },
            { botToken: "token", ownerUserId: 7 },
          ),
          Deferred.await(replied),
        );
      }),
    );

    expect(replies).toContain(formatSpecialistVoice("alpha", "first look"));
    expect(replies).toContain(formatSpecialistVoice("beta", "second look"));
    expect(replies.some((text) => text.includes("**alpha:**"))).toBe(true);
    expect(replies.some((text) => text.includes("**beta:**"))).toBe(true);
    expect(replies).toContain("parent wrap");
  });
});
