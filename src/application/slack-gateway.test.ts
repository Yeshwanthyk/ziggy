/* oxlint-disable ziggy-effect/no-effect-execution-boundary, ziggy-effect/no-native-promise-ownership, ziggy-effect/no-error-constructor -- tests are approved execution boundaries and use typed adapter-error fixtures. */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Result } from "effect";
import { SlackApiError } from "../adapters/slack/api";
import type { SlackInboundMessage } from "../adapters/slack/socket";
import { ProviderCallError } from "../domain/agent";
import type { ZiggyAgentShape } from "./agent";
import {
  makeSlackGateway,
  normalizeSlackMessage,
  retrySlackDelivery,
  slackHeartbeat,
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
      sourceTs: "1.0",
      statusThreadTs: "0.9",
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
      sourceTs: "1.0",
      statusThreadTs: "1.0",
      text: "hello",
      threadTs: undefined,
    });
  });

  test("isolates an actual Slack thread session while retaining channel group memory", () => {
    expect(
      normalizeSlackMessage(
        message({ channelType: "channel", threadTs: "123.456" }),
        "UBOT",
        "U123",
      ),
    ).toEqual({
      chatKey: "group-slC123-thread-123.456",
      channel: "C123",
      context: { kind: "group", groupId: "slC123" },
      sourceTs: "1.0",
      statusThreadTs: "123.456",
      text: "hello",
      threadTs: "123.456",
    });
  });

  test("requires and strips the bot mention when channel activation is mention-only", () => {
    expect(
      normalizeSlackMessage(message({ channelType: "channel" }), "UBOT", "U123", "mention"),
    ).toBeUndefined();
    expect(
      normalizeSlackMessage(
        message({ channelType: "channel", text: "  <@UBOT> explain this  " }),
        "UBOT",
        "U123",
        "mention",
      ),
    ).toEqual({
      chatKey: "group-slC123",
      channel: "C123",
      context: { kind: "group", groupId: "slC123" },
      sourceTs: "1.0",
      statusThreadTs: "1.0",
      text: "explain this",
      threadTs: undefined,
    });
    expect(
      normalizeSlackMessage(
        message({ channelType: "channel", text: "<@UBOT>" }),
        "UBOT",
        "U123",
        "mention",
      ),
    ).toBeUndefined();
  });

  test("keeps direct messages active regardless of channel activation", () => {
    expect(normalizeSlackMessage(message(), "UBOT", "U123", "mention")?.text).toBe("hello");
  });

  test("chunks by Unicode code point at Slack's limit", () => {
    const chunks = slackMessageChunks("🦆".repeat(4_001));
    expect(chunks.map((chunk) => [...chunk].length)).toEqual([4_000, 1]);
  });

  test("escapes executable broadcast mentions and prefers a line boundary", () => {
    expect(slackMessageChunks("hello <!channel> and <!here|here>")).toEqual([
      "hello &lt;!channel> and &lt;!here|here>",
    ]);

    const chunks = slackMessageChunks(`${"a".repeat(3_990)}\n${"b".repeat(20)}`);
    expect(chunks.map((chunk) => [...chunk].length)).toEqual([3_991, 20]);
  });

  test("bounds idempotent update retries and does not retry ambiguous posts", async () => {
    const failure = (operation: "postMessage" | "updateMessage") =>
      new SlackApiError({
        operation,
        reason: "server",
        retriable: true,
        message: "test failure",
        cause: new Error("test failure"),
      });
    let updateAttempts = 0;
    const delays: Array<number> = [];
    const update = await Effect.runPromise(
      retrySlackDelivery(
        "update",
        () => {
          updateAttempts += 1;
          return Effect.fail(failure("updateMessage"));
        },
        (seconds) => Effect.sync(() => delays.push(seconds)),
      ).pipe(Effect.result),
    );
    let postAttempts = 0;
    const post = await Effect.runPromise(
      retrySlackDelivery(
        "post",
        () => {
          postAttempts += 1;
          return Effect.fail(failure("postMessage"));
        },
        () => Effect.void,
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(update) && update.failure.reason).toBe("server");
    expect(updateAttempts).toBe(4);
    expect(delays).toEqual([1, 2, 4]);
    expect(Result.isFailure(post) && post.failure.reason).toBe("server");
    expect(postAttempts).toBe(1);
  });

  test("emits a bounded long-running heartbeat", async () => {
    const statuses: Array<string> = [];
    let waits = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const emitted = yield* Deferred.make<void>();
        const heartbeat = slackHeartbeat(
          (status) =>
            Effect.gen(function* () {
              statuses.push(status);
              yield* Deferred.succeed(emitted, undefined);
            }),
          () => {
            waits += 1;
            return waits === 1 ? Effect.void : Effect.never;
          },
        );
        yield* Effect.raceFirst(heartbeat, Deferred.await(emitted));
      }),
    );

    expect(statuses).toEqual(["is still working... (30s)"]);
  });

  test("shows queued feedback before serializing turns in one chat", () => {
    const posts: Array<string> = [];
    const updates: Array<string> = [];
    let nextCall = 0;
    let promptCall = 0;

    return Effect.runPromise(
      Effect.gen(function* () {
        const bothAdmitted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const bothFinished = yield* Deferred.make<void>();
        let clearedStatuses = 0;
        const transport: SlackTransport = {
          addReaction: () => Effect.void,
          authTest: () => Effect.succeed({ userId: "UBOT" }),
          openSocket: () =>
            Effect.succeed({
              next: Effect.suspend(() => {
                nextCall += 1;
                if (nextCall === 1) return Effect.succeed(message({ ts: "1.0" }));
                if (nextCall === 2) return Effect.succeed(message({ ts: "2.0" }));
                return Effect.never;
              }),
              close: Effect.void,
            }),
          setStatus: (_token, _channel, _threadTs, status) =>
            Effect.gen(function* () {
              if (status === "") {
                clearedStatuses += 1;
                if (clearedStatuses === 2) yield* Deferred.succeed(bothFinished, undefined);
              }
            }),
          postMessage: (_token, _channel, text) =>
            Effect.gen(function* () {
              posts.push(text);
              if (posts.length === 2) yield* Deferred.succeed(bothAdmitted, undefined);
              return { ts: `${posts.length}.1` };
            }),
          removeReaction: () => Effect.void,
          updateMessage: (_token, _channel, _ts, text) =>
            Effect.sync(() => {
              updates.push(text);
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
          openChat: () =>
            Effect.succeed({
              prompt: () => {
                promptCall += 1;
                return promptCall === 1
                  ? Deferred.await(releaseFirst).pipe(Effect.as("first reply"))
                  : Effect.succeed("second reply");
              },
              dispose: Effect.void,
            }),
        };

        yield* Effect.raceFirst(
          makeSlackGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-slack-queue-test", name: "Test" },
            { botToken: "bot-token", appToken: "app-token", ownerUserId: "U123" },
          ),
          Effect.gen(function* () {
            yield* Deferred.await(bothAdmitted);
            expect(posts).toEqual(["Working on that…", "Queued behind an earlier request…"]);
            yield* Deferred.succeed(releaseFirst, undefined);
            yield* Deferred.await(bothFinished);
          }),
        );

        expect(updates).toEqual(["first reply", "Working on that…", "second reply"]);
      }),
    );
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
    const updates: Array<{
      readonly channel: string;
      readonly text: string;
      readonly ts: string;
    }> = [];
    const statuses: Array<{
      readonly channel: string;
      readonly status: string;
      readonly threadTs: string;
    }> = [];
    const reactions: Array<string> = [];
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
          addReaction: (_token, channel, ts, name) =>
            Effect.sync(() => reactions.push(`add:${channel}:${ts}:${name}`)),
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
          setStatus: (_token, channel, threadTs, status) =>
            Effect.gen(function* () {
              statuses.push({ channel, threadTs, status });
              if (status === "") {
                yield* Deferred.succeed(replied, undefined);
              }
            }),
          postMessage: (token, channel, text, threadTs) =>
            Effect.sync(() => {
              posts.push({ token, channel, text, threadTs });
              return { ts: "2.0" };
            }),
          removeReaction: (_token, channel, ts, name) =>
            Effect.sync(() => reactions.push(`remove:${channel}:${ts}:${name}`)),
          updateMessage: (_token, channel, ts, text) =>
            Effect.sync(() => {
              updates.push({ channel, ts, text });
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
            text: "Working on that…",
            threadTs: "0.9",
          },
        ]);
        expect(updates).toEqual([{ channel: "C123", ts: "2.0", text: "hello back" }]);
        expect(statuses).toEqual([
          { channel: "C123", threadTs: "0.9", status: "is thinking..." },
          { channel: "C123", threadTs: "0.9", status: "" },
        ]);
        expect(reactions).toEqual([
          "add:C123:1.0:eyes",
          "remove:C123:1.0:eyes",
          "add:C123:1.0:white_check_mark",
        ]);
        expect(socketClosed).toBe(true);
        expect(chatDisposed).toBe(true);
      }),
    );
  });

  test("clears the working status when the agent turn fails", () => {
    const statuses: Array<string> = [];
    const reactions: Array<string> = [];
    let nextCall = 0;

    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Bun test is the Effect execution boundary.
    return Effect.runPromise(
      Effect.gen(function* () {
        const cleared = yield* Deferred.make<void>();
        const transport: SlackTransport = {
          addReaction: (_token, _channel, _ts, name) =>
            Effect.sync(() => reactions.push(`add:${name}`)),
          authTest: () => Effect.succeed({ userId: "UBOT" }),
          openSocket: () =>
            Effect.succeed({
              next: Effect.suspend(() => {
                nextCall += 1;
                return nextCall === 1 ? Effect.succeed(message()) : Effect.never;
              }),
              close: Effect.void,
            }),
          setStatus: (_token, _channel, _threadTs, status) =>
            Effect.gen(function* () {
              statuses.push(status);
              if (status === "") {
                yield* Deferred.succeed(cleared, undefined);
              }
            }),
          postMessage: () => Effect.succeed({ ts: "2.0" }),
          removeReaction: (_token, _channel, _ts, name) =>
            Effect.sync(() => reactions.push(`remove:${name}`)),
          updateMessage: (_token, _channel, _ts, text) =>
            Effect.sync(() => {
              expect(text).toBe("I couldn't complete that request.");
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
          openChat: () =>
            Effect.succeed({
              prompt: () =>
                Effect.fail(
                  new ProviderCallError({
                    profilePath: "/tmp/ziggy-slack-gateway-test",
                    operation: "prompt",
                    message: "test failure",
                    cause: "test failure",
                  }),
                ),
              dispose: Effect.void,
            }),
        };

        yield* Effect.raceFirst(
          makeSlackGateway(agent, transport).runLoop(
            { path: "/tmp/ziggy-slack-gateway-test", name: "Test" },
            { botToken: "bot-token", appToken: "app-token", ownerUserId: "U123" },
          ),
          Deferred.await(cleared),
        );

        expect(statuses).toEqual(["is thinking...", ""]);
        expect(reactions).toEqual(["add:eyes", "remove:eyes", "add:x"]);
      }),
    );
  });
});
