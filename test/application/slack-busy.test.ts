/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { ChatNotStreaming } from "ziggy/domain/agent";
import { makeChatHandle, type ZiggyAgentApi } from "ziggy/application/agent";
import {
  makeSlackGateway,
  type SlackTransport,
  type SlackIngressRuntime,
} from "ziggy/application/slack-gateway";
import type { SlackGatewayConfig } from "ziggy/domain/slack";
import type { SlackInboundMessage } from "ziggy/adapters/slack/socket";

for (const scenario of [
  "default",
  "steer",
  "channel",
  "queue",
  "idle",
  "race",
  "other-thread",
  "attachment",
] as const) {
  test(`busy Slack message: ${scenario}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const prompts: string[] = [];
        const steers: string[] = [];
        const posts: string[] = [];
        const finished: string[] = [];
        let next = 0;
        const handle = makeChatHandle({
          isIdle: scenario === "idle",
          prompt: (text) =>
            Effect.gen(function* () {
              prompts.push(text);
              if (prompts.length === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return "reply";
            }),
          steer: (text) =>
            Effect.gen(function* () {
              steers.push(text);
              if (scenario === "race")
                return yield* new ChatNotStreaming({
                  profilePath: "/tmp/slack-busy",
                  operation: "steer",
                  message: "no live turn to steer",
                });
            }),
        });
        const agent: ZiggyAgentApi = {
          runOnce: () => Effect.succeed(0),
          openTui: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({ answer: "unused", session: { id: "unused", file: "/unused" } }),
          openSpecialistChat: () => Effect.succeed(handle),
          openChat: () => Effect.succeed(handle),
        };
        const transport: SlackTransport = {
          authTest: () => Effect.succeed({ userId: "UBOT" }),
          openSocket: () =>
            Effect.succeed({
              next: Effect.gen(function* () {
                next += 1;
                if (next > 2) return yield* Effect.never;
                if (next === 2) yield* Deferred.await(started);
                const inbound: SlackInboundMessage = {
                  channel: scenario === "channel" ? "C123" : "D123",
                  channelType: scenario === "channel" ? "channel" : "im",
                  userId: "U123",
                  text: `${scenario === "channel" ? "<@UBOT> " : ""}${next === 1 ? "first" : "second"}`,
                  ts: `${next}.0`,
                  threadTs: scenario === "other-thread" && next === 2 ? "9.0" : "0.9",
                };
                return scenario === "attachment" && next === 2
                  ? { ...inbound, files: [{ id: "F123", name: "notes.txt" }] }
                  : inbound;
              }),
              nextConnectionState: Effect.never,
              close: Effect.void,
            }),
          getThreadReplies: () => Effect.succeed({ messages: [], truncated: false }),
          setStatus: () => Effect.void,
          addReaction: () => Effect.void,
          removeReaction: () => Effect.void,
          postMessage: (_token, _channel, text) =>
            Effect.gen(function* () {
              posts.push(text);
              if (text === "Queued behind an earlier request…")
                yield* Deferred.succeed(release, undefined);
              return { ts: `${posts.length}.1` };
            }),
          updateMessage: () => Effect.void,
        };
        const ingress: SlackIngressRuntime = {
          initialize: () => Effect.void,
          recover: () => Effect.void,
          replayable: () => Effect.succeed([]),
          admit: () => Effect.succeed("accepted"),
          start: () => Effect.succeed(true),
          finish: (_path, payload, _owner, state) =>
            Effect.gen(function* () {
              finished.push(`${payload.sourceTs}:${state}`);
              if (payload.sourceTs === "2.0") yield* Deferred.succeed(release, undefined);
              if (finished.length === 2) yield* Deferred.succeed(done, undefined);
            }),
        };
        const baseConfig = {
          botToken: "bot",
          appToken: "app",
          ownerUserId: "U123",
        };
        const config: SlackGatewayConfig =
          scenario === "queue" || scenario === "steer"
            ? { ...baseConfig, busyMessageMode: scenario }
            : baseConfig;
        yield* Effect.raceFirst(
          makeSlackGateway(agent, transport, undefined, ingress).runLoop(
            { path: "/tmp/slack-busy", name: "Test" },
            config,
          ),
          Deferred.await(done),
        );
        const shouldSteer =
          scenario === "default" || scenario === "steer" || scenario === "channel";
        expect(steers).toEqual(shouldSteer || scenario === "race" ? ["second"] : []);
        expect(prompts.length).toBe(shouldSteer ? 1 : 2);
        expect(posts).toEqual(
          shouldSteer
            ? ["Working on that…"]
            : ["Working on that…", "Queued behind an earlier request…"],
        );
        expect(finished.sort()).toEqual(["1.0:completed", "2.0:completed"]);
      }),
    ));
}
