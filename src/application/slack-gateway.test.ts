import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { SlackInboundMessage } from "../adapters/slack/socket";
import type { ZiggyAgentShape } from "./agent";
import {
  makeSlackGateway,
  normalizeSlackMessage,
  slackMessageChunks,
  type SlackTransport,
} from "./slack-gateway";

const message = (overrides: Partial<SlackInboundMessage> = {}): SlackInboundMessage => ({
  channel: "C123",
  channelType: "im",
  userId: "U123",
  text: "hello",
  ts: "1.0",
  threadTs: undefined,
  ...overrides,
});

describe("Slack gateway boundary", () => {
  test("maps an owner DM to owner memory without changing its chat route or thread", () => {
    expect(normalizeSlackMessage(message({ threadTs: "0.9" }), "UBOT", "U123")).toEqual({
      chatKey: "user-U123",
      channel: "C123",
      context: { kind: "user", userId: "owner" },
      text: "hello",
      threadTs: "0.9",
    });
  });

  test("rejects non-owner and bot messages", () => {
    expect(normalizeSlackMessage(message(), "UBOT", "U999")).toBeUndefined();
    expect(normalizeSlackMessage(message({ userId: "UBOT" }), "UBOT", "UBOT")).toBeUndefined();
  });

  test("keeps channel memory channel-scoped", () => {
    expect(normalizeSlackMessage(message({ channelType: "channel" }), "UBOT", "U123")).toEqual({
      chatKey: "group-slC123",
      channel: "C123",
      context: { kind: "group", groupId: "slC123" },
      text: "hello",
      threadTs: undefined,
    });
  });

  test("chunks by Unicode code point at Slack's limit", () => {
    const chunks = slackMessageChunks("🦆".repeat(4_001));
    expect(chunks.map((chunk) => [...chunk].length)).toEqual([4_000, 1]);
  });

  test("runs an authorized threaded DM through the agent and finalizes cleanly", () => {
    const openedChats: Array<{
      readonly context: unknown;
      readonly sessionDirectory: string;
    }> = [];
    const prompts: Array<string> = [];
    const posts: Array<{
      readonly token: string;
      readonly channel: string;
      readonly text: string;
      readonly threadTs: string | undefined;
    }> = [];
    let nextCall = 0;
    let socketClosed = false;
    let chatDisposed = false;

    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Bun test is the Effect execution boundary.
    return Effect.runPromise(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        const inbound = Effect.succeed(message({ threadTs: "0.9" }));
        const pending: Effect.Effect<SlackInboundMessage> = Effect.never;
        const transport: SlackTransport = {
          authTest: (token) => {
            expect(token).toBe("bot-token");
            return Effect.succeed({ userId: "UBOT" });
          },
          openSocket: (appToken) =>
            Effect.sync(() => {
              expect(appToken).toBe("app-token");
              return {
                next: Effect.suspend(() => {
                  nextCall += 1;
                  return nextCall === 1 ? inbound : pending;
                }),
                close: Effect.sync(() => {
                  socketClosed = true;
                }),
              };
            }),
          postMessage: (token, channel, text, threadTs) =>
            Effect.gen(function* () {
              posts.push({ token, channel, text, threadTs });
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
                    return "hello back";
                  }),
                dispose: Effect.sync(() => {
                  chatDisposed = true;
                }),
              };
            }),
        };
        const gateway = makeSlackGateway(agent, transport);

        yield* Effect.raceFirst(
          gateway.runLoop(
            { path: "/tmp/ziggy-slack-gateway-test", name: "Test" },
            {
              botToken: "bot-token",
              appToken: "app-token",
              ownerUserId: "U123",
            },
          ),
          Deferred.await(replied),
        );

        expect(openedChats).toEqual([
          {
            context: { kind: "user", userId: "owner" },
            sessionDirectory: "/tmp/ziggy-slack-gateway-test/sessions/slack/user-U123",
          },
        ]);
        expect(prompts).toEqual(["hello"]);
        expect(posts).toEqual([
          {
            token: "bot-token",
            channel: "C123",
            text: "hello back",
            threadTs: "0.9",
          },
        ]);
        expect(socketClosed).toBe(true);
        expect(chatDisposed).toBe(true);
      }),
    );
  });
});
