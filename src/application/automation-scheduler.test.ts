/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- test fixtures own disposable filesystem state */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { acquireGatewayOwner } from "../adapters/bun/gateway-owner";
import {
  automationRunStore,
  commitScheduleTick,
  initializeAutomationDatabase,
  makeAutomationRunStore,
  readAutomationRuns,
  readAutomationStatus,
  readScheduleRecords,
} from "../adapters/bun/automation-sqlite";
import { automationFileStore } from "../adapters/fs/automation-files";
import { AutomationDatabaseError, AutomationSchedulerError } from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentShape } from "./agent";
import { type AutomationCapabilities, type AutomationsShape, makeAutomations } from "./automations";
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
const runScheduler = (
  scheduler: ReturnType<typeof makeAutomationScheduler>,
  target: ProfileTarget,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* acquireGatewayOwner(target);
      return yield* scheduler.run(target, owner);
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause._tag === "AutomationSchedulerError"
        ? cause
        : new AutomationSchedulerError({
            operation: "acquire owner",
            message: cause.message,
            cause,
          }),
    ),
  );
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
  test("paused filenames clear the next occurrence on the next scan and resume from a fresh future cursor", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const dispatched: Array<string> = [];
    const scheduler = makeAutomationScheduler({
      run: (_target, id) =>
        Effect.sync(() => dispatched.push(id)).pipe(
          Effect.as({ kind: "executed", delivery: { kind: "resolved", targets: [] } } as const),
        ),
    });
    const active = join(target.path, "automations", "daily.md");
    const paused = join(target.path, "automations", "daily.paused.md");
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        yield* Effect.promise(() => rename(active, paused));
        yield* TestClock.adjust(60_000);
        yield* awaitHeartbeat(target, start + 60_000);
        expect(dispatched).toEqual([]);
        expect((yield* readScheduleRecords(target.path))[0]).toMatchObject({
          definitionState: "deleted",
          nextScheduledAtMs: null,
        });

        yield* Effect.promise(() => rename(paused, active));
        yield* TestClock.adjust(60_000);
        yield* awaitHeartbeat(target, start + 120_000);
        expect(dispatched).toEqual([]);
        expect((yield* readScheduleRecords(target.path))[0]).toMatchObject({
          definitionState: "valid",
          nextScheduledAtMs: start + 180_000,
        });
        yield* Fiber.interrupt(fiber);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("an active-paused conflict is one invalid schedule and is never dispatched", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    await writeFile(join(target.path, "automations", "daily.paused.md"), definition("* * * * *"));
    const dispatched: Array<string> = [];
    const scheduler = makeAutomationScheduler({
      run: (_target, id) =>
        Effect.sync(() => dispatched.push(id)).pipe(
          Effect.as({ kind: "executed", delivery: { kind: "resolved", targets: [] } } as const),
        ),
    });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        const rows = yield* readScheduleRecords(target.path);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.definitionState).toBe("invalid");
        expect(rows[0]?.definitionError).toContain("conflicting active and paused");
        yield* TestClock.adjust(120_000);
        expect(dispatched).toEqual([]);
        yield* Fiber.interrupt(fiber);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

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
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
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

  test("interruption after a committed claim waits for scoped worker registration", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const registered: Array<string> = [];
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const committed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const scheduler = makeAutomationScheduler(
          { run: () => Effect.never },
          {
            afterScheduleCommit: (result) =>
              result.claimed.length === 0
                ? Effect.void
                : Deferred.succeed(committed, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
            afterWorkerRegistered: (claim) =>
              Effect.sync(() => {
                registered.push(claim.automationId);
              }),
          },
        );
        const schedulerFiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        yield* TestClock.adjust(60_000);
        yield* Deferred.await(committed);
        expect((yield* readAutomationRuns(target.path)).map((item) => item.state)).toEqual([
          "claimed",
        ]);

        const interruption = yield* Effect.forkScoped(Fiber.interrupt(schedulerFiber));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interruption);

        expect(registered).toEqual(["daily"]);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("startup preserves a live manual run until its truthful terminal commit", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const agent: ZiggyAgentShape = {
          runOnce: () => Effect.succeed(0),
          runSpecialist: () =>
            Effect.succeed({
              answer: "local reply",
              session: { id: "specialist", file: "/sessions/specialist.jsonl" },
            }),
          openTui: () => Effect.succeed(0),
          openChat: () =>
            Effect.succeed({
              prompt: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as("local reply"),
                ),
              dispose: Effect.void,
            }),
        };
        const capabilities: AutomationCapabilities = {
          gate: { run: () => Effect.succeed({ kind: "passed" }) },
          files: automationFileStore,
          printReply: () => Effect.void,
          loadTelegramConfig: () => Effect.succeed({ botToken: "t", ownerUserId: 1 }),
          loadDiscordConfig: () => Effect.succeed({ botToken: "d", ownerUserId: "1" }),
          loadSlackConfig: () => Effect.succeed({ botToken: "s", appToken: "a", ownerUserId: "U" }),
          sendTelegram: () => Effect.void,
          sendDiscord: () => Effect.void,
          sendSlack: () => Effect.void,
        };
        const automations = makeAutomations(agent, capabilities);
        const manual = yield* Effect.forkScoped(
          automations.run(target, "daily", { kind: "manual-force" }),
        );
        yield* Deferred.await(entered);
        expect((yield* readAutomationRuns(target.path))[0]?.state).toBe("running");

        const scheduler = makeAutomationScheduler(automations);
        const schedulerFiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        expect((yield* readAutomationRuns(target.path))[0]?.state).toBe("running");

        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(manual)).toEqual({
          kind: "executed",
          delivery: { kind: "resolved", targets: [] },
        });
        expect((yield* readAutomationRuns(target.path))[0]?.state).toBe("completed");
        yield* Fiber.interrupt(schedulerFiber);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("startup recovers an exited child owner and compacts an outage into one missed range", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadStore = makeAutomationRunStore(child.pid);
    await child.exited;
    const scheduler = makeAutomationScheduler({ run: () => Effect.never });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const first = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        yield* Fiber.interrupt(first);
        const manualId = "manual:00000000-0000-4000-8000-000000000001";
        yield* deadStore.admitManual(target.path, "other", manualId, start + 10);
        yield* deadStore.start(target.path, manualId, start + 10, null);
        yield* TestClock.setTime(start + 300_000);
        const second = yield* Effect.forkScoped(runScheduler(scheduler, target));
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

  test("recovers a dead owner during an ordinary scheduler cycle", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadStore = makeAutomationRunStore(child.pid);
    await child.exited;
    const dispatched: Array<string> = [];
    const scheduler = makeAutomationScheduler({
      run: (_target, automationId) =>
        Effect.sync(() => dispatched.push(automationId)).pipe(Effect.andThen(Effect.never)),
    });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);

        const orphanId = "manual:00000000-0000-4000-8000-000000000001";
        yield* deadStore.admitManual(target.path, "daily", orphanId, start + 10);
        yield* deadStore.start(target.path, orphanId, start + 20, null);
        yield* TestClock.adjust(60_000);
        yield* awaitHeartbeat(target, start + 60_000);
        yield* awaitDispatches(dispatched, 1);

        expect(dispatched).toEqual(["daily"]);
        expect(
          (yield* readAutomationRuns(target.path)).map((item) => [
            item.runId,
            item.state,
            item.failureCategory,
          ]),
        ).toEqual([
          ["scheduled:daily:2026-01-01T00:01:00.000Z", "claimed", null],
          [orphanId, "unknown", "process-start"],
        ]);
        yield* Fiber.interrupt(fiber);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("definition scan failures re-arm from each failure event despite an overdue cursor", async () => {
    const target = await profile([]);
    await Effect.runPromise(initializeAutomationDatabase(target.path));
    await Effect.runPromise(
      commitScheduleTick(
        target.path,
        start - 120_000,
        [
          {
            expected: null,
            next: {
              automationId: "retained",
              definitionState: "valid",
              scheduleFingerprint: "a".repeat(64),
              nextScheduledAtMs: start - 60_000,
              definitionObservedAtMs: start - 120_000,
              definitionError: null,
            },
          },
        ],
        "00000000-0000-4000-8000-000000000001",
      ),
    );
    await rm(join(target.path, "automations"), { recursive: true });
    await writeFile(join(target.path, "automations"), "not a directory");
    const scheduler = makeAutomationScheduler({ run: () => Effect.never });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        expect(yield* readAutomationStatus(target.path, start)).toMatchObject({
          heartbeatAtMs: start,
          lastTickAtMs: start,
          lastTickStatus: "error",
          lastTickError: "definitions-unreadable",
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(59_999);
        expect(yield* readAutomationStatus(target.path, start + 59_999)).toMatchObject({
          heartbeatAtMs: start,
          lastTickAtMs: start,
        });
        yield* TestClock.adjust(1);
        yield* awaitHeartbeat(target, start + 60_000);
        expect(yield* readAutomationStatus(target.path, start + 60_000)).toMatchObject({
          heartbeatAtMs: start + 60_000,
          lastTickAtMs: start + 60_000,
          lastTickStatus: "error",
        });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(59_999);
        expect(yield* readAutomationStatus(target.path, start + 119_999)).toMatchObject({
          heartbeatAtMs: start + 60_000,
          lastTickAtMs: start + 60_000,
        });
        yield* TestClock.adjust(1);
        yield* awaitHeartbeat(target, start + 120_000);
        expect(yield* readAutomationStatus(target.path, start + 120_000)).toMatchObject({
          heartbeatAtMs: start + 120_000,
          lastTickAtMs: start + 120_000,
          lastTickStatus: "error",
        });
        yield* Fiber.interrupt(fiber);
      }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });

  test("fails the scheduler when a dispatched run cannot persist lifecycle state", async () => {
    const target = await profile([["daily", definition("* * * * *")]]);
    const databaseFailure = new AutomationDatabaseError({
      operation: "start run",
      path: target.path,
      message: "injected lifecycle write failure",
      cause: "fixture",
    });
    const agent: ZiggyAgentShape = {
      runOnce: () => Effect.succeed(0),
      runSpecialist: () =>
        Effect.succeed({
          answer: "local reply",
          session: { id: "specialist", file: "/sessions/specialist.jsonl" },
        }),
      openTui: () => Effect.succeed(0),
      openChat: () =>
        Effect.succeed({
          prompt: () => Effect.never,
          dispose: Effect.void,
        }),
    };
    const capabilities: AutomationCapabilities = {
      gate: { run: () => Effect.succeed({ kind: "passed" }) },
      files: automationFileStore,
      printReply: () => Effect.void,
      loadTelegramConfig: () => Effect.succeed({ botToken: "t", ownerUserId: 1 }),
      loadDiscordConfig: () => Effect.succeed({ botToken: "d", ownerUserId: "1" }),
      loadSlackConfig: () => Effect.succeed({ botToken: "s", appToken: "a", ownerUserId: "U" }),
      sendTelegram: () => Effect.void,
      sendDiscord: () => Effect.void,
      sendSlack: () => Effect.void,
    };
    const automations = makeAutomations(agent, capabilities, {
      store: { ...automationRunStore, start: () => Effect.fail(databaseFailure) },
      now: Clock.currentTimeMillis,
      makeManualRunId: () => "manual:00000000-0000-4000-8000-000000000001",
    });
    const scheduler = makeAutomationScheduler(automations);
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
        yield* awaitHeartbeat(target, start);
        yield* TestClock.adjust(60_000);
        const result = yield* Fiber.join(fiber).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "AutomationSchedulerError",
            operation: "run",
            cause: databaseFailure,
          },
        });
        const before = yield* readAutomationRuns(target.path);
        expect(before.map((item) => [item.state, item.failureCategory])).toEqual([
          ["claimed", null],
        ]);
        yield* TestClock.adjust(60_000);
        expect(yield* readAutomationRuns(target.path)).toEqual(before);
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
        const fiber = yield* Effect.forkScoped(runScheduler(scheduler, target));
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
