import { expect, test } from "bun:test";
import fc from "fast-check";
import { reduceTurnProgress, type TurnProgressEvent } from "ziggy/domain/slack-turn-progress";

const categories = ["Reading a file", "Running tests", "Editing a file", "Checking code"] as const;

test("parallel starts and ends belong to their call's phase, even when completion is interleaved", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...categories), { minLength: 2, maxLength: 30 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
      fc.array(fc.nat(), { minLength: 1, maxLength: 30 }),
      (names, failures, ordering) => {
        let state = reduceTurnProgress(undefined, { kind: "start", atMs: 0, queued: false });

        const calls = names.map((category, index) => ({
          category,
          id: `call-${index}`,
          failed: failures[index % failures.length] ?? false,
        }));

        const event = (
          call: (typeof calls)[number],
          phase: "start" | "end",
        ): TurnProgressEvent => ({
          kind: "tool",
          phase,
          category: call.category,
          toolCallId: call.id,
          failed: phase === "end" && call.failed,
          atMs: 100,
        });

        for (const call of calls) state = reduceTurnProgress(state, event(call, "start"));

        const completed = calls
          .map((call, index) => ({ call, order: ordering[index % ordering.length] ?? 0, index }))
          .sort((a, b) => a.order - b.order || a.index - b.index);

        for (const { call } of completed) {
          state = reduceTurnProgress(state, event(call, "end"));
          state = reduceTurnProgress(state, event(call, "end")); // duplicate delivery
          const stepId = state.calls[call.id]?.stepId;
          expect(state.steps.filter((step) => step.id === stepId)).toHaveLength(1);
        }

        state = reduceTurnProgress(state, { kind: "finish", outcome: "done", atMs: 1000 });
        expect(state.steps.every((step) => step.status !== "in_progress")).toBe(true);

        for (const call of calls.filter((item) => item.failed)) {
          expect(state.steps.find((step) => step.id === state.calls[call.id]?.stepId)?.status).toBe(
            "error",
          );
        }

        expect(state.toolCount).toBe(calls.length);
      },
    ),
    { numRuns: 200 },
  );
});

test("a read/test/read/test interleaving closes two phases, not four", () => {
  let state = reduceTurnProgress(undefined, { kind: "start", atMs: 0, queued: false });

  for (const [id, category, phase, failed] of [
    ["read", "Reading a file", "start", false],
    ["test", "Running tests", "start", false],
    ["read", "Reading a file", "end", false],
    ["test", "Running tests", "end", true],
  ] as const)
    state = reduceTurnProgress(state, {
      kind: "tool",
      toolCallId: id,
      category,
      phase,
      failed,
      atMs: 100,
    });
  state = reduceTurnProgress(state, { kind: "finish", outcome: "done", atMs: 1000 });
  expect(state.steps.map((step) => step.status)).toEqual(["complete", "error"]);
  expect(state.headline).toBe("Done in 1s · 2 steps");
});

test("unfinished calls never become completed at turn termination", () => {
  let state = reduceTurnProgress(undefined, { kind: "start", atMs: 0, queued: false });
  state = reduceTurnProgress(state, {
    kind: "tool",
    toolCallId: "a",
    category: "Reading a file",
    phase: "start",
    failed: false,
    atMs: 0,
  });
  state = reduceTurnProgress(state, { kind: "finish", outcome: "stopped", atMs: 40_000 });
  expect(state.steps[0]?.status).toBe("error");
  expect(state.headline).toBe("Stopped after 40s");
});

test("completed edits name available files and failed commands do not expose command text as a reason", () => {
  let state = reduceTurnProgress(undefined, { kind: "start", atMs: 0, queued: false });

  state = reduceTurnProgress(state, {
    kind: "tool",
    toolCallId: "edit",
    category: "Editing a file",
    phase: "start",
    failed: false,
    detail: "src/application/slack/turn.ts",
    atMs: 0,
  });
  state = reduceTurnProgress(state, {
    kind: "tool",
    toolCallId: "edit",
    category: "Editing a file",
    phase: "end",
    failed: false,
    atMs: 0,
  });
  state = reduceTurnProgress(state, {
    kind: "tool",
    toolCallId: "test",
    category: "Running tests",
    phase: "start",
    failed: false,
    detail: "bun test secret-argument",
    atMs: 0,
  });
  state = reduceTurnProgress(state, {
    kind: "tool",
    toolCallId: "test",
    category: "Running tests",
    phase: "end",
    failed: true,
    detail: "bun test secret-argument",
    atMs: 0,
  });

  expect(state.steps.map((step) => ({ title: step.title, details: step.details }))).toEqual([
    { title: "Edited turn.ts", details: undefined },
    { title: "Running tests: failed", details: "Failed" },
  ]);
});
