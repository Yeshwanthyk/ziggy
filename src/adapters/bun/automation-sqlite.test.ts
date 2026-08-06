/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Predicate } from "effect";
import type { AutomationScheduleRecord } from "../../domain/automation";
import {
  automationDatabasePath,
  automationRunStore,
  commitScheduleTick,
  initializeAutomationDatabase,
  readAutomationRuns,
  readAutomationStatus,
  readScheduleRecords,
} from "./automation-sqlite";

const paths: Array<string> = [];
const profile = async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-scheduler-db-"));
  paths.push(path);
  return path;
};
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fingerprint = "a".repeat(64);
const schedule = (id: string, next: number, observed = 100): AutomationScheduleRecord => ({
  automationId: id,
  definitionState: "valid",
  scheduleFingerprint: fingerprint,
  nextScheduledAtMs: next,
  definitionObservedAtMs: observed,
  definitionError: null,
});

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("automation SQLite", () => {
  test("initializes exactly schema version one with four tables and six named indexes", async () => {
    const path = await profile();
    await run(initializeAutomationDatabase(path));
    const db = new Database(automationDatabasePath(path), {
      readonly: true,
      create: false,
      strict: true,
    });
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "automation_run" },
        { name: "automation_schedule" },
        { name: "automation_target_outcome" },
        { name: "scheduler_state" },
      ]);
      expect(
        db
          .query(
            "SELECT count(*) count FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
          )
          .get(),
      ).toEqual({ count: 6 });
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close(false);
    }
  });

  test("claims and advances together, while a stale concurrent claimant writes nothing", async () => {
    const path = await profile();
    const first = schedule("daily", 1_000);
    expect(await run(commitScheduleTick(path, 100, [{ expected: null, next: first }]))).toEqual({
      stale: false,
      claimed: [],
    });
    const advanced = schedule("daily", 2_000, 1_000);
    const mutation = {
      expected: first,
      next: advanced,
      occurrence: {
        kind: "due" as const,
        runId: "scheduled:daily:1970-01-01T00:00:01.000Z",
        scheduledForMs: 1_000,
        missedThroughMs: null,
        scheduleFingerprint: fingerprint,
      },
    };
    const [left, right] = await Promise.all([
      run(commitScheduleTick(path, 1_000, [mutation])),
      run(commitScheduleTick(path, 1_000, [mutation])),
    ]);
    expect([left, right].sort((a, b) => Number(a.stale) - Number(b.stale))).toEqual([
      {
        stale: false,
        claimed: [
          {
            automationId: "daily",
            runId: mutation.occurrence.runId,
            scheduledForMs: 1_000,
            scheduleFingerprint: fingerprint,
          },
        ],
      },
      { stale: true, claimed: [] },
    ]);
    expect(await run(readScheduleRecords(path))).toEqual([advanced]);
    expect((await run(readAutomationRuns(path))).map((item) => [item.runId, item.state])).toEqual([
      [mutation.occurrence.runId, "claimed"],
    ]);
  });

  test("same automation is skipped busy, different automations remain independently active", async () => {
    const path = await profile();
    const daily = schedule("daily", 2_000);
    const weekly = schedule("weekly", 2_000);
    await run(
      commitScheduleTick(path, 100, [
        { expected: null, next: daily },
        { expected: null, next: weekly },
      ]),
    );
    const due = (row: AutomationScheduleRecord) => ({
      expected: row,
      next: { ...row, nextScheduledAtMs: 3_000, definitionObservedAtMs: 2_000 },
      occurrence: {
        kind: "due" as const,
        runId: `scheduled:${row.automationId}:1970-01-01T00:00:02.000Z`,
        scheduledForMs: 2_000,
        missedThroughMs: null,
        scheduleFingerprint: fingerprint,
      },
    });
    const claimed = await run(commitScheduleTick(path, 2_000, [due(daily), due(weekly)]));
    expect(claimed.claimed.map((item) => item.automationId)).toEqual(["daily", "weekly"]);
    expect(
      await run(
        automationRunStore.admitManual(
          path,
          "daily",
          "manual:00000000-0000-4000-8000-000000000001",
          2_001,
        ),
      ),
    ).toBe("skipped-busy");
    expect(
      (await run(readAutomationRuns(path))).map((item) => [item.automationId, item.state]),
    ).toEqual([
      ["daily", "skipped-busy"],
      ["weekly", "claimed"],
      ["daily", "claimed"],
    ]);
  });

  test("persists ordered partial delivery truth in one terminal transaction", async () => {
    const path = await profile();
    const runId = "manual:00000000-0000-4000-8000-000000000001";
    await run(automationRunStore.admitManual(path, "daily", runId, 100));
    await run(automationRunStore.start(path, runId, 110, null));
    await run(
      automationRunStore.finish(
        path,
        runId,
        {
          state: "failed",
          atMs: 150,
          localCompleted: true,
          failureCategory: "rate-limited",
          gateExitCode: null,
        },
        [
          { target: "discord:channel:1", status: "delivered" },
          {
            target: "telegram:chat:2",
            status: "failed",
            category: "rate-limited",
            retriable: true,
          },
        ],
      ),
    );
    expect(await run(readAutomationRuns(path))).toEqual([
      {
        runId,
        automationId: "daily",
        trigger: "manual-force",
        state: "failed",
        scheduleFingerprint: null,
        scheduledForMs: null,
        missedThroughMs: null,
        recordedAtMs: 100,
        startedAtMs: 110,
        finishedAtMs: 150,
        localCompleted: true,
        failureCategory: "rate-limited",
        gateExitCode: null,
        targets: [
          {
            ordinal: 0,
            target: "discord:channel:1",
            status: "delivered",
            failureCategory: null,
            retriable: null,
          },
          {
            ordinal: 1,
            target: "telegram:chat:2",
            status: "failed",
            failureCategory: "rate-limited",
            retriable: true,
          },
        ],
      },
    ]);
  });

  test("rejects a version-one object whose frozen SQL shape changed", async () => {
    const path = await profile();
    await run(initializeAutomationDatabase(path));
    const db = new Database(automationDatabasePath(path));
    try {
      db.exec(
        "DROP INDEX automation_run_recent; CREATE INDEX automation_run_recent ON automation_run(run_id)",
      );
    } finally {
      db.close(false);
    }
    expect(
      await run(
        readAutomationStatus(path, 100).pipe(
          Effect.match({
            onFailure: Predicate.isTagged("AutomationProjectionError"),
            onSuccess: () => false,
          }),
        ),
      ),
    ).toBe(true);
  });

  test("read-only projection does not initialize or add sidecars to an empty existing database", async () => {
    const path = await profile();
    const runtime = join(path, ".runtime");
    await mkdir(runtime);
    const databasePath = automationDatabasePath(path);
    new Database(databasePath).close(false);
    const before = await readFile(databasePath);
    const entries = await readdir(runtime);
    expect(
      await run(
        readAutomationStatus(path, 100).pipe(
          Effect.match({
            onFailure: Predicate.isTagged("AutomationProjectionError"),
            onSuccess: () => false,
          }),
        ),
      ),
    ).toBe(true);
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readdir(runtime)).toEqual(entries);
  });

  test("an absent database is an empty read and creates no runtime directory", async () => {
    const path = await profile();
    expect(await run(readAutomationStatus(path, 100))).toEqual({
      profilePath: path,
      observedAtMs: 100,
      heartbeatAtMs: null,
      lastTickAtMs: null,
      lastTickStatus: null,
      lastTickError: null,
      schedules: [],
      activeRunCount: 0,
      latestRun: null,
      latestErrorRun: null,
    });
    expect(await Bun.file(join(path, ".runtime")).exists()).toBe(false);
  });
});
