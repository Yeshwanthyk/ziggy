/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun test owns Effect execution. */
import { expect, test } from "bun:test";
import { SlackApiError } from "ziggy/adapters/slack/api";
import { Effect } from "effect";
import { makeTurnProgress } from "ziggy/application/slack/progress";
import type { SlackTransport } from "ziggy/application/slack/model";

test("appends extending snapshots and posts a divergent final answer without replacing the plan", () =>
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
      expect(yield* progress.finish("done", "correct final")).toBe(true);
      expect(appends).toEqual(["hello", " world"]);
      expect(stops).toEqual([undefined]);
      expect(updates).toEqual([]);
      expect(posts).toEqual(["correct final"]);
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
      expect(yield* progress.finish("failed")).toBe(true);
      expect(yield* progress.finish("done", "too late")).toBe(true);

      expect(stops).toEqual([
        { text: "I couldn't complete that request.", title: "Couldn't finish · 0s" },
      ]);
    }),
  ));

test("a failed stop and correction cannot claim that the final answer landed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const posts: Array<string> = [];
      const updates: Array<string> = [];

      const failure = new SlackApiError({
        operation: "stopStream",
        reason: "network",
        retriable: true,
        message: "timeout",
        cause: "fixture",
      });

      const transport: SlackTransport = {
        authTest: () => Effect.succeed({ userId: "bot" }),
        openSocket: () => Effect.never,
        getThreadReplies: () => Effect.succeed({ messages: [], truncated: false }),
        postMessage: (_token, _channel, text) =>
          Effect.sync(() => {
            posts.push(text);

            return { ts: "fallback" };
          }),
        updateMessage: (_token, _channel, _ts, text) =>
          Effect.sync(() => {
            updates.push(text);
          }),
        setStatus: () => Effect.void,
        addReaction: () => Effect.void,
        removeReaction: () => Effect.void,
        startStream: () => Effect.succeed({ ts: "stream" }),
        appendStream: () => Effect.void,
        stopStream: () => Effect.fail(failure),
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

      yield* progress.start(false, true);
      expect(yield* progress.finish("done", "the answer")).toBe(false);
      expect(posts).toEqual([]);
      expect(updates).toEqual([]);
    }),
  ));

test("an ambiguous progress append does not prevent final answer delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const posts: Array<string> = [];
      const stops: Array<string | undefined> = [];

      const failure = new SlackApiError({
        operation: "appendStream",
        reason: "network",
        retriable: true,
        message: "timeout",
        cause: "fixture",
      });

      const transport: SlackTransport = {
        authTest: () => Effect.succeed({ userId: "bot" }),
        openSocket: () => Effect.never,
        getThreadReplies: () => Effect.succeed({ messages: [], truncated: false }),
        postMessage: (_token, _channel, text) =>
          Effect.sync(() => {
            posts.push(text);

            return { ts: "follow-up" };
          }),
        updateMessage: () => Effect.void,
        setStatus: () => Effect.void,
        addReaction: () => Effect.void,
        removeReaction: () => Effect.void,
        startStream: () => Effect.succeed({ ts: "stream" }),
        appendStream: () => Effect.fail(failure),
        stopStream: (_token, _channel, _ts, text) =>
          Effect.sync(() => {
            stops.push(text);
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

      yield* progress.start(false, true);
      yield* progress.text("partial");
      expect(yield* progress.finish("done", "answer")).toBe(true);
      expect(stops).toEqual([undefined]);
      expect(posts).toEqual(["answer"]);
    }),
  ));

test("elapsed-time progress does not append plan updates for every event", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let now = 0;
      const plans: Array<string> = [];

      const transport: SlackTransport = {
        authTest: () => Effect.succeed({ userId: "bot" }),
        openSocket: () => Effect.never,
        getThreadReplies: () => Effect.succeed({ messages: [], truncated: false }),
        postMessage: () => Effect.succeed({ ts: "post" }),
        updateMessage: () => Effect.void,
        setStatus: () => Effect.void,
        addReaction: () => Effect.void,
        removeReaction: () => Effect.void,
        startStream: () => Effect.succeed({ ts: "stream" }),
        appendStream: (_token, _channel, _ts, chunks) =>
          Effect.sync(() => {
            plans.push(
              ...chunks.filter((chunk) => chunk.type === "plan_update").map((chunk) => chunk.title),
            );
          }),
        stopStream: () => Effect.void,
      };

      const progress = makeTurnProgress(
        transport,
        "token",
        "D1",
        "1.0",
        undefined,
        () => now,
        () => Effect.void,
      );

      yield* progress.start(false, true);

      for (let second = 1; second <= 12; second += 1) {
        now = second * 1000;
        yield* progress.change({ kind: "tick", atMs: now });
      }

      expect(plans).toEqual(["Thinking · 10s"]);
    }),
  ));
