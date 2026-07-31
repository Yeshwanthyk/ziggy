/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises Node filesystem */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import type { ProfileTarget } from "../domain/profile";
import {
  makeAutomationScheduler,
  type AutomationScheduleLoader,
  type ScheduledAutomationRunner,
} from "./automation-scheduler";

const temporaryPaths: Array<string> = [];

const makeProfile = async (): Promise<ProfileTarget> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-scheduler-"));
  temporaryPaths.push(path);
  return { path, name: "Scheduler test" };
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("foreground automation scheduler", () => {
  test("runs one canonical firing and never replays its cursor", async () => {
    const target = await makeProfile();
    const events: Array<string> = [];
    const loader: AutomationScheduleLoader = {
      listScheduled: () =>
        Effect.succeed([{ id: "digest", enabled: true, schedule: { kind: "every", seconds: 60 } }]),
    };
    const runner: ScheduledAutomationRunner = {
      runScheduled: (_target, id, trigger) =>
        Effect.sync(() => events.push(`${id}:${trigger.firingId}`)),
    };
    const scheduler = makeAutomationScheduler(loader, runner, {
      graceSeconds: 30,
      pollSeconds: 10,
    });

    const first = await Effect.runPromise(
      scheduler.tick(target, new Date("2026-07-30T12:01:00.000Z")),
    );
    const second = await Effect.runPromise(
      scheduler.tick(target, new Date("2026-07-30T12:01:00.000Z")),
    );

    expect(first[0]?.decision.kind).toBe("ran");
    expect(second[0]?.decision.kind).toBe("not-due");
    expect(events).toEqual(["digest:digest@2026-07-30T12:01:00.000Z"]);
    const health = await readFile(
      join(target.path, ".runtime", "automations", "scheduler-health.json"),
      "utf8",
    );
    expect(health).toBe(
      '{"heartbeatAt":"2026-07-30T12:01:00.000Z","lastSuccessAt":"2026-07-30T12:01:00.000Z"}\n',
    );
  });

  test("runs different IDs concurrently", async () => {
    const target = await makeProfile();
    const bothStarted = await Effect.runPromise(Deferred.make<void>());
    const starts: Array<string> = [];
    const loader: AutomationScheduleLoader = {
      listScheduled: () =>
        Effect.succeed([
          { id: "one", enabled: true, schedule: { kind: "every", seconds: 60 } },
          { id: "two", enabled: true, schedule: { kind: "every", seconds: 60 } },
        ]),
    };
    const runner: ScheduledAutomationRunner = {
      runScheduled: (_target, id) =>
        Effect.gen(function* () {
          starts.push(id);
          if (starts.length === 2) {
            yield* Deferred.succeed(bothStarted, undefined);
          }
          yield* Deferred.await(bothStarted);
        }),
    };

    await Effect.runPromise(
      makeAutomationScheduler(loader, runner, {
        graceSeconds: 30,
        pollSeconds: 10,
      }).tick(target, new Date("2026-07-30T12:01:00.000Z")),
    );

    expect([...starts].sort()).toEqual(["one", "two"]);
  });

  test("advances one stale firing without running it", async () => {
    const target = await makeProfile();
    const events: Array<string> = [];
    const loader: AutomationScheduleLoader = {
      listScheduled: () =>
        Effect.succeed([
          {
            id: "once",
            enabled: true,
            schedule: { kind: "at", instant: "2026-07-30T12:00:00.000Z" },
          },
        ]),
    };
    const runner: ScheduledAutomationRunner = {
      runScheduled: (_target, _id, trigger) =>
        Effect.sync(() => events.push(trigger.skipReason === undefined ? "ran" : "skipped")),
    };
    const result = await Effect.runPromise(
      makeAutomationScheduler(loader, runner, {
        graceSeconds: 30,
        pollSeconds: 10,
      }).tick(target, new Date("2026-07-30T12:05:00.000Z")),
    );

    expect(result[0]?.decision).toEqual({
      kind: "missed",
      instant: new Date("2026-07-30T12:00:00.000Z"),
    });
    expect(events).toEqual(["skipped"]);
  });
});
