/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- test fixtures own disposable filesystem state */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  automationRunStore,
  readAutomationRuns,
  readAutomationStatus,
  readScheduleRecords,
} from "../adapters/bun/automation-sqlite";
import type { ProfileTarget } from "../domain/profile";
import type { AutomationsShape } from "./automations";
import { makeAutomationScheduler } from "./automation-scheduler";

const paths: Array<string> = [];
const start = Date.parse("2026-01-01T00:00:00.000Z");
const eventLoopTurn = Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));
const awaitHeartbeat = (target: ProfileTarget, expected: number) =>
  Effect.gen(function* () {
    for (;;) {
      const heartbeat = (yield* readAutomationStatus(target.path, expected)).heartbeatAtMs;
      if (heartbeat === expected) return heartbeat;
      yield* eventLoopTurn;
    }
  });
const awaitDispatches = (events: ReadonlyArray<string>, count: number) =>
  Effect.gen(function* () {
    while (events.length < count) yield* eventLoopTurn;
  });
const definition = (cron: string) =>
  [
    "---",
    "version: 1",
    `cron: ${cron}`,
    "timezone: UTC",
    "gate: true",
    "broadcast: none",
    "---",
    "Run.",
    "",
  ].join("\n");
const profile = async (
  definitions: ReadonlyArray<readonly [string, string]>,
): Promise<ProfileTarget> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-scheduler-"));
  paths.push(path);
  await mkdir(join(path, "automations"));
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  for (const [id, source] of definitions)
    await writeFile(join(path, "automations", `${id}.md`), source);
  return { path, name: "Test" };
};

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("automation scheduler engine", () => {
  test("arms the earliest occurrence, dispatches without waiting, and keeps unrelated IDs independent", async () => {
    const target = await profile([
      ["first", definition("1 * * * *")],
      ["second", definition("2 * * * *")],
    ]);
    const dispatched: Array<string> = [];
    const automations: AutomationsShape = {
      run: (_target, id) =>
        Effect.sync(() => {
          dispatched.push(id);
        }).pipe(Effect.andThen(Effect.never)),
    };
    const scheduler = makeAutomationScheduler(automations);
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(scheduler.run(target));
        expect(yield* awaitHeartbeat(target, start)).toBe(start);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(59_000);
        expect(dispatched).toEqual([]);
        yield* TestClock.adjust(1_000);
        yield* awaitHeartbeat(target, start + 60_000);
        yield* awaitDispatches(dispatched, 1);
        expect(dispatched).toEqual(["first"]);
        yield* TestClock.adjust(60_000);
        yield* awaitHeartbeat(target, start + 120_000);
        yield* awaitDispatches(dispatched, 2);
        expect(dispatched).toEqual(["first", "second"]);
        expect(
          (yield* readAutomationRuns(target.path)).map((run) => [run.automationId, run.state]),
        ).toEqual([
          ["second", "claimed"],
          ["first", "claimed"],
        ]);
        yield* Fiber.interrupt(fiber);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("startup recovers active work and compacts an outage into one missed range", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const scheduler = makeAutomationScheduler({ run: () => Effect.never });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const first = yield* Effect.forkScoped(scheduler.run(target));
        yield* awaitHeartbeat(target, start);
        yield* Fiber.interrupt(first);
        const manualId = "manual:00000000-0000-4000-8000-000000000001";
        yield* automationRunStore.admitManual(target.path, "other", manualId, start + 10);
        yield* automationRunStore.start(target.path, manualId, start + 10, null);
        yield* TestClock.setTime(start + 300_000);
        const second = yield* Effect.forkScoped(scheduler.run(target));
        yield* awaitHeartbeat(target, start + 300_000);
        const runs = yield* readAutomationRuns(target.path);
        expect(
          runs.map((run) => [run.automationId, run.state, run.scheduledForMs, run.missedThroughMs]),
        ).toEqual([
          ["daily", "missed", start + 60_000, start + 300_000],
          ["other", "unknown", null, null],
        ]);
        expect((yield* readScheduleRecords(target.path))[0]?.nextScheduledAtMs).toBe(
          start + 360_000,
        );
        yield* Fiber.interrupt(second);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("empty schedules heartbeat at sixty seconds and interruption stops later ticks", async () => {
    const target = await profile([]);
    const scheduler = makeAutomationScheduler({ run: () => Effect.never });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(scheduler.run(target));
        expect(yield* awaitHeartbeat(target, start)).toBe(start);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(59_000);
        expect((yield* readAutomationStatus(target.path, start + 59_000)).heartbeatAtMs).toBe(
          start,
        );
        yield* TestClock.adjust(1_000);
        expect(yield* awaitHeartbeat(target, start + 60_000)).toBe(start + 60_000);
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(120_000);
        expect((yield* readAutomationStatus(target.path, start + 180_000)).heartbeatAtMs).toBe(
          start + 60_000,
        );
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });
});
