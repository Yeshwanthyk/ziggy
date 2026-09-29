import { expect, test } from "bun:test";
import fc from "fast-check";
import { reduceTurnProgress, type TurnProgressEvent } from "ziggy/domain/slack-turn-progress";

const categories = ["Reading a file", "Running tests", "Editing a file", "Asked ada"] as const;

test("consecutive tool categories form one step per change and failures remain errors", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...categories), { minLength: 1, maxLength: 80 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 80 }),
      (names, failures) => {
        let state = reduceTurnProgress(undefined, { kind: "start", atMs: 0, queued: false });
        let changes = 0;
        let categoryFailed = false;

        for (const [index, category] of names.entries()) {
          if (category !== names[index - 1]) {
            changes += 1;
            categoryFailed = false;
          }

          const failed = failures[index % failures.length] ?? false;

          const events: ReadonlyArray<TurnProgressEvent> = [
            { kind: "tool", phase: "start", category, atMs: index * 1000, failed: false },
            {
              kind: "tool",
              phase: "end",
              category,
              atMs: index * 1000 + 20,
              failed,
              detail: "2 failing",
            },
          ];

          for (const event of events) state = reduceTurnProgress(state, event);
          expect(state.steps.length).toBe(changes);

          categoryFailed ||= failed;
          expect(state.steps.at(-1)?.status === "error").toBe(categoryFailed);
          expect(
            state.steps.every(
              (step) => step.title.length <= 80 && (step.details?.length ?? 0) <= 120,
            ),
          ).toBe(true);
        }

        expect(state.toolCount).toBe(names.length);
      },
    ),
    { numRuns: 200 },
  );
});

test("queued, running and terminal headlines reflect elapsed time and tool count", () => {
  const queued = reduceTurnProgress(undefined, { kind: "start", queued: true, atMs: 0 });
  expect(queued.headline).toBe("Queued behind an earlier request");
  const active = reduceTurnProgress(queued, { kind: "active", atMs: 12_000 });
  expect(active.headline).toBe("Thinking · 12s");

  const tool = reduceTurnProgress(active, {
    kind: "tool",
    category: "Running tests",
    phase: "start",
    failed: false,
    atMs: 100_000,
  });

  expect(tool.headline).toBe("Running tests · 1m 40s");
  expect(
    reduceTurnProgress(tool, { kind: "finish", atMs: 192_000, outcome: "done" }).headline,
  ).toBe("Done in 3m 12s · 1 steps");
  expect(
    reduceTurnProgress(active, { kind: "finish", atMs: 40_000, outcome: "stopped" }).headline,
  ).toBe("Stopped after 40s");
  expect(
    reduceTurnProgress(active, { kind: "finish", atMs: 65_000, outcome: "failed" }).headline,
  ).toBe("Couldn't finish · 1m 5s");
});
