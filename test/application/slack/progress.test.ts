/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun test owns Effect execution. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTurnProgress } from "ziggy/application/slack/progress";
import type { SlackTransport } from "ziggy/application/slack/model";

test("appends extending snapshots and corrects a divergent final answer in the same message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const appends: Array<string | undefined> = [];
      const updates: Array<string> = [];
      const stops: Array<string | undefined> = [];
      const posts: Array<string> = [];

      const transport: SlackTransport = {
        authTest: () => Effect.succeed({ userId: "bot" }),
        openSocket: () => Effect.never,
        getThreadReplies: () => Effect.succeed({ messages: [], truncated: false }),
        postMessage: (_token, _channel, text) =>
          Effect.sync(() => {
            posts.push(text);

            return { ts: "post" };
          }),
        updateMessage: (_token, _channel, _ts, text) =>
          Effect.sync(() => {
            updates.push(text);
          }),
        setStatus: () => Effect.void,
        addReaction: () => Effect.void,
        removeReaction: () => Effect.void,
        startStream: () => Effect.succeed({ ts: "one" }),
        appendStream: (_token, _channel, _ts, _chunks, markdownText) =>
          Effect.sync(() => {
            appends.push(markdownText);
          }),
        stopStream: (_token, _channel, _ts, markdownText) =>
          Effect.sync(() => {
            stops.push(markdownText);
          }),
      };

      const progress = makeTurnProgress(
        transport,
        "token",
        "D1",
        "1.0",
        undefined,
        () => 1000,
        () => Effect.void,
      );

      expect(yield* progress.start(false, true)).toBe(true);
      yield* progress.text("hello");
      yield* progress.text("hello world");
      yield* progress.text("different draft");
      yield* progress.finish("done", "correct final");
      expect(appends).toEqual(["hello", " world"]);
      expect(stops).toEqual([undefined]);
      expect(updates).toEqual(["correct final"]);
      expect(posts).toEqual([]);
    }),
  ));

test("stopping a failed stream leaves an explicit failure answer and headline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stops: Array<{
        readonly text: string | undefined;
        readonly title: string | undefined;
      }> = [];

      const transport: SlackTransport = {
        authTest: () => Effect.succeed({ userId: "bot" }),
        openSocket: () => Effect.never,
        getThreadReplies: () => Effect.succeed({ messages: [], truncated: false }),
        postMessage: () => Effect.succeed({ ts: "post" }),
        updateMessage: () => Effect.void,
        setStatus: () => Effect.void,
        addReaction: () => Effect.void,
        removeReaction: () => Effect.void,
        startStream: () => Effect.succeed({ ts: "one" }),
        appendStream: () => Effect.void,
        stopStream: (_token, _channel, _ts, text, chunks) =>
          Effect.sync(() => {
            stops.push({
              text,
              title: chunks?.find((chunk) => chunk.type === "plan_update")?.title,
            });
          }),
      };

      const progress = makeTurnProgress(
        transport,
        "token",
        "D1",
        "1.0",
        undefined,
        () => 65_000,
        () => Effect.void,
      );

      yield* progress.start(false, true);
      yield* progress.finish("failed");
      yield* progress.finish("done", "too late");

      expect(stops).toEqual([
        { text: "I couldn't complete that request.", title: "Couldn't finish · 0s" },
      ]);
    }),
  ));
