/* oxlint-disable ziggy-effect/no-effect-execution-boundary, ziggy-effect/no-native-promise-ownership -- tests are approved execution boundaries */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { DiscordInboundMessage, DiscordSocket } from "../adapters/discord/socket";
import type { ZiggyAgentShape } from "./agent";
import {
  discordMessageChunks,
  makeDiscordGateway,
  normalizeDiscordMessage,
  type DiscordTransport,
} from "./discord-gateway";

const message = (overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage => ({
  id: "m1",
  channelId: "456",
  guildId: undefined,
  authorId: "123",
  authorIsBot: false,
  content: "hello",
  ...overrides,
});

describe("Discord gateway boundary", () => {
  test("maps an owner DM to owner memory without changing its chat route", () => {
    expect(normalizeDiscordMessage(message(), "123")).toEqual({
      chatKey: "user-123",
      channelId: "456",
      context: { kind: "user", userId: "owner" },
      text: "hello",
    });
  });

  test("rejects non-owner and bot messages", () => {
    expect(normalizeDiscordMessage(message(), "999")).toBeUndefined();
    expect(normalizeDiscordMessage(message({ authorIsBot: true }), "123")).toBeUndefined();
  });

  test("keeps guild-channel memory channel-scoped", () => {
    expect(normalizeDiscordMessage(message({ guildId: "789" }), "123")).toEqual({
      chatKey: "group-dc456",
      channelId: "456",
      context: { kind: "group", groupId: "dc456" },
      text: "hello",
    });
  });

  test("chunks by Unicode code point at Discord's limit", () => {
    const chunks = discordMessageChunks("🦆".repeat(2_001));
    expect(chunks.map((chunk) => [...chunk].length)).toEqual([2_000, 1]);
  });

  test("runs an authorized DM through the agent and finalizes cleanly", async () => {
    const events: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        let nextCall = 0;
        const socket: DiscordSocket = {
          next: Effect.suspend(() => {
            nextCall += 1;
            events.push("next");
            return nextCall === 1 ? Effect.succeed(message()) : Effect.never;
          }),
          close: Effect.sync(() => {
            events.push("close");
          }),
        };
        const transport: DiscordTransport = {
          openSocket: (token, intents) =>
            Effect.sync(() => {
              events.push(`openSocket:${token}:${intents}`);
              return socket;
            }),
          createMessage: (token, channelId, text) =>
            Effect.gen(function* () {
              events.push(`createMessage:${token}:${channelId}:${text}`);
              yield* Deferred.succeed(replied, undefined);
            }),
        };
        const agent: ZiggyAgentShape = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () => Effect.succeed("reply"),
          openTui: () => Effect.succeed(0),
          openChat: (target, context, sessionDirectory) =>
            Effect.sync(() => {
              events.push(`openChat:${target.name}:${JSON.stringify(context)}:${sessionDirectory}`);
              return {
                prompt: (text: string) =>
                  Effect.sync(() => {
                    events.push(`prompt:${text}`);
                    return "hello back";
                  }),
                dispose: Effect.sync(() => {
                  events.push("dispose");
                }),
              };
            }),
        };
        const gateway = makeDiscordGateway(agent, transport);
        const target = { path: "/tmp/ziggy-discord-test", name: "Test" };
        const config = { botToken: "token", ownerUserId: "123" };

        yield* Effect.raceFirst(gateway.runLoop(target, config), Deferred.await(replied));
      }),
    );

    expect(events).toEqual([
      "openSocket:token:37377",
      "next",
      "next",
      'openChat:Test:{"kind":"user","userId":"owner"}:/tmp/ziggy-discord-test/sessions/discord/user-123',
      "prompt:hello",
      "createMessage:token:456:hello back",
      "close",
      "dispose",
    ]);
  });
});
