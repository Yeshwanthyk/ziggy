/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Deferred, Effect, Fiber, Predicate, Result } from "effect";
import type { AutomationScheduleRecord } from "../../domain/automation";
import {
  automationDatabasePath,
  automationRunStore,
  commitScheduleTick,
  discoverAutomationSources,
  initializeAutomationDatabase,
  makeAutomationRunStore,
  readAutomationRuns,
  readAutomationStatus,
  readScheduleRecords,
  recoverAutomationRuns,
} from "./automation-sqlite";
import { isLocalProcessAlive, makeLocalProcessAlive } from "./process";

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

const corruptPersistedRows = (path: string, statement: string): void => {
  const databasePath = automationDatabasePath(path);
  const db = new Database(databasePath, { readonly: true });
  const rows = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('automation_run','automation_schedule','automation_target_outcome','scheduler_state') ORDER BY name",
    )
    .all();
  const version = db
    .query<{ schema_version: number }, []>("PRAGMA schema_version")
    .get()?.schema_version;
  db.close(false);
  if (version === undefined) throw new Error("missing schema version");
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const execute = (sql: string): void => {
    const result = Bun.spawnSync(["sqlite3", databasePath], { stdin: Buffer.from(sql) });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  execute(`.dbconfig defensive off
PRAGMA writable_schema=ON;
${rows.map((row) => `UPDATE sqlite_schema SET sql=${quote(row.sql.replace(/ STRICT$/u, ""))} WHERE name=${quote(row.name)};`).join("\n")}
PRAGMA schema_version=${version + 1};`);
  execute(`.dbconfig defensive off
PRAGMA ignore_check_constraints=ON;
${statement};
PRAGMA writable_schema=ON;
${rows.map((row) => `UPDATE sqlite_schema SET sql=${quote(row.sql)} WHERE name=${quote(row.name)};`).join("\n")}
PRAGMA schema_version=${version + 2};`);
};

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("automation SQLite", () => {
  test("local PID liveness proves only ESRCH dead and otherwise stays conservative", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(isLocalProcessAlive(child.pid)).toBe(true);
    child.kill();
    await child.exited;
    expect(isLocalProcessAlive(child.pid)).toBe(false);

    const throwingProbe = (code: string) =>
      makeLocalProcessAlive(() => {
        throw Object.assign(new Error(code), { code });
      });
    expect(throwingProbe("ESRCH")(123)).toBe(false);
    expect(throwingProbe("EPERM")(123)).toBe(true);
    expect(
      makeLocalProcessAlive(() => {
        throw "unknown";
      })(123),
    ).toBe(true);
  });

  test("definition discovery regains interruption between sequential file reads", async () => {
    const path = await profile();
    await mkdir(join(path, "automations"));
    await writeFile(join(path, "automations", "a.md"), "a");
    await writeFile(join(path, "automations", "b.md"), "b");
    const firstRead = await Effect.runPromise(Deferred.make<void>());
    let reads = 0;
    const fiber = Effect.runFork(
      discoverAutomationSources(
        { path, name: "Test" },
        {
          afterRead: () => {
            reads += 1;
            return reads === 1
              ? Deferred.succeed(firstRead, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void;
          },
        },
      ),
    );
    await Effect.runPromise(Deferred.await(firstRead));

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(reads).toBe(1);
  });

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

  test("recovers only active rows whose local owner is proven dead", async () => {
    const path = await profile();
    const liveManual = makeAutomationRunStore(101);
    const liveSchedulerA = makeAutomationRunStore(201);
    const liveSchedulerB = makeAutomationRunStore(202);
    const dead = makeAutomationRunStore(301);
    const terminal = {
      state: "completed" as const,
      atMs: 900,
      localCompleted: true,
      failureCategory: null,
      gateExitCode: null,
    };
    const claimScheduled = async (id: string, atMs: number, ownerPid: number) => {
      const before = schedule(id, atMs, atMs - 100);
      await run(commitScheduleTick(path, atMs - 100, [{ expected: null, next: before }], ownerPid));
      const occurrence = {
        kind: "due" as const,
        runId: `scheduled:${id}:${new Date(atMs).toISOString()}`,
        scheduledForMs: atMs,
        missedThroughMs: null,
        scheduleFingerprint: fingerprint,
      };
      await run(
        commitScheduleTick(
          path,
          atMs,
          [
            {
              expected: before,
              next: { ...before, nextScheduledAtMs: atMs + 1_000, definitionObservedAtMs: atMs },
              occurrence,
            },
          ],
          ownerPid,
        ),
      );
      return occurrence.runId;
    };

    const manualId = "manual:00000000-0000-4000-8000-000000000101";
    await run(liveManual.admitManual(path, "manual-live", manualId, 100));
    const schedulerAId = await claimScheduled("scheduler-a", 200, 201);
    const schedulerBId = await claimScheduled("scheduler-b", 300, 202);
    const deadManualId = "manual:00000000-0000-4000-8000-000000000301";
    await run(dead.admitManual(path, "manual-dead", deadManualId, 400));
    await run(dead.start(path, deadManualId, 410, null));
    const deadScheduledId = await claimScheduled("scheduler-dead", 500, 301);

    const live = new Set([101, 201, 202]);
    await run(recoverAutomationRuns(path, 700, (pid) => live.has(pid)));
    const recovered = await run(readAutomationRuns(path));
    expect(Object.fromEntries(recovered.map((item) => [item.runId, item.state]))).toEqual({
      [deadScheduledId]: "unknown",
      [deadManualId]: "unknown",
      [schedulerBId]: "claimed",
      [schedulerAId]: "claimed",
      [manualId]: "claimed",
    });

    await run(liveManual.start(path, manualId, 800, null));
    await run(liveManual.finish(path, manualId, terminal, []));
    await run(liveSchedulerA.start(path, schedulerAId, 810, fingerprint));
    await run(liveSchedulerA.finish(path, schedulerAId, terminal, []));
    await run(liveSchedulerB.start(path, schedulerBId, 820, fingerprint));
    await run(liveSchedulerB.finish(path, schedulerBId, terminal, []));
    const deadIds = new Set([deadManualId, deadScheduledId]);
    const firstRecovery = (await run(readAutomationRuns(path))).filter((item) =>
      deadIds.has(item.runId),
    );
    await run(recoverAutomationRuns(path, 1_000, () => false));
    expect((await run(readAutomationRuns(path))).filter((item) => deadIds.has(item.runId))).toEqual(
      firstRecovery,
    );
  });

  test("rejects malformed write transitions before SQLite changes", async () => {
    const path = await profile();
    const runId = "manual:00000000-0000-4000-8000-000000000001";
    await run(automationRunStore.admitManual(path, "daily", runId, 100));
    await run(automationRunStore.start(path, runId, 110, null));

    const malformedTerminal = await run(
      Reflect.apply(automationRunStore.finish, automationRunStore, [
        path,
        runId,
        {
          state: "failed",
          atMs: 120,
          localCompleted: true,
          failureCategory: "AutomationInvalid",
          gateExitCode: null,
        },
        [],
      ]).pipe(Effect.result),
    );
    const malformedOccurrence = await run(
      Reflect.apply(commitScheduleTick, undefined, [
        path,
        100,
        [
          {
            expected: null,
            next: schedule("invalid", 1_000),
            occurrence: {
              kind: "due",
              runId: "scheduled:invalid:1970-01-01T00:00:01.000Z",
              scheduledForMs: 1_000,
              missedThroughMs: null,
              scheduleFingerprint: "not-a-fingerprint",
            },
          },
        ],
      ]).pipe(Effect.result),
    );

    expect(
      Result.isFailure(malformedTerminal) &&
        Predicate.isTagged(malformedTerminal.failure, "AutomationDatabaseError"),
    ).toBe(true);
    expect(
      Result.isFailure(malformedOccurrence) &&
        Predicate.isTagged(malformedOccurrence.failure, "AutomationDatabaseError"),
    ).toBe(true);
    expect(await run(readScheduleRecords(path))).toEqual([]);
    expect((await run(readAutomationRuns(path)))[0]).toMatchObject({
      state: "running",
      finishedAtMs: null,
      failureCategory: null,
      targets: [],
    });
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

  test("latest errors use completion order while run history keeps admission order", async () => {
    const path = await profile();
    const admittedLatestId = "manual:00000000-0000-4000-8000-000000000001";
    const finishedTieLowId = "manual:00000000-0000-4000-8000-000000000002";
    const finishedTieHighId = "manual:00000000-0000-4000-8000-000000000003";
    const rows = [
      {
        runId: admittedLatestId,
        automationId: "admitted-latest",
        recordedAtMs: 300,
        finishedAtMs: 400,
      },
      {
        runId: finishedTieLowId,
        automationId: "finished-tie-low",
        recordedAtMs: 100,
        finishedAtMs: 500,
      },
      {
        runId: finishedTieHighId,
        automationId: "finished-tie-high",
        recordedAtMs: 200,
        finishedAtMs: 500,
      },
    ];
    for (const row of rows) {
      await run(
        automationRunStore.admitManual(path, row.automationId, row.runId, row.recordedAtMs),
      );
      await run(automationRunStore.start(path, row.runId, row.recordedAtMs + 1, null));
      await run(
        automationRunStore.finish(
          path,
          row.runId,
          {
            state: "failed",
            atMs: row.finishedAtMs,
            localCompleted: true,
            failureCategory: "all-empty",
            gateExitCode: null,
          },
          [],
        ),
      );
    }

    expect((await run(readAutomationRuns(path))).map((item) => item.runId)).toEqual([
      admittedLatestId,
      finishedTieHighId,
      finishedTieLowId,
    ]);
    const status = await run(readAutomationStatus(path, 600));
    expect(status.latestRun?.runId).toBe(admittedLatestId);
    expect(status.latestErrorRun?.runId).toBe(finishedTieHighId);
  });

  test("malformed persisted run and target rows fail closed before normalization", async () => {
    const fixtures = [
      "UPDATE automation_run SET local_completed=2",
      "UPDATE automation_target_outcome SET retriable=2",
      "UPDATE automation_run SET recorded_at_ms=-1",
      "UPDATE automation_run SET finished_at_ms=1.5",
      "UPDATE automation_target_outcome SET ordinal=-1",
      "UPDATE automation_target_outcome SET ordinal=1.5",
      "UPDATE automation_run SET state='completed',failure_category='remote'",
      "UPDATE automation_run SET failure_category='gate-nonzero',gate_exit_code=1.5",
      "UPDATE automation_run SET state='running',owner_pid=1.5,finished_at_ms=NULL,local_completed=0,failure_category=NULL,gate_exit_code=NULL",
      "UPDATE automation_run SET state='completed',failure_category=NULL; UPDATE automation_target_outcome SET status='failed',failure_category='remote',retriable=1",
      "UPDATE automation_target_outcome SET target='not-a-canonical-target'",
      "UPDATE automation_target_outcome SET failure_category='not-a-category'",
      "UPDATE automation_run SET failure_category='not-a-category'",
      "UPDATE automation_run SET failure_category='rate-limited'; UPDATE automation_target_outcome SET failure_category='remote'",
      "UPDATE automation_run SET local_completed=0,failure_category='AutomationInvalid'",
      "UPDATE automation_run SET failure_category='all-empty'",
    ];
    for (const statement of fixtures) {
      const path = await profile();
      const runId = `manual:00000000-0000-4000-8000-${String(paths.length).padStart(12, "0")}`;
      await run(automationRunStore.admitManual(path, "corrupt", runId, 100));
      await run(automationRunStore.start(path, runId, 110, null));
      await run(
        automationRunStore.finish(
          path,
          runId,
          {
            state: "failed",
            atMs: 120,
            localCompleted: true,
            failureCategory: "remote",
            gateExitCode: null,
          },
          [
            {
              target: "telegram:chat:1",
              status: "failed",
              category: "remote",
              retriable: true,
            },
          ],
        ),
      );
      corruptPersistedRows(path, statement);
      expect(
        await run(
          readAutomationStatus(path, 200).pipe(
            Effect.match({
              onFailure: Predicate.isTagged("AutomationProjectionError"),
              onSuccess: () => false,
            }),
          ),
        ),
      ).toBe(true);
      expect(
        await run(
          readAutomationRuns(path).pipe(
            Effect.match({
              onFailure: Predicate.isTagged("AutomationProjectionError"),
              onSuccess: () => false,
            }),
          ),
        ),
      ).toBe(true);
    }
  });

  test("malformed scheduler and schedule rows fail status projection", async () => {
    for (const statement of [
      "UPDATE scheduler_state SET last_tick_status='ok',last_tick_error='definitions-unreadable'",
      "UPDATE scheduler_state SET heartbeat_at_ms=1.5",
      "UPDATE automation_schedule SET definition_error='invalid' WHERE definition_state='valid'",
    ]) {
      const path = await profile();
      await run(
        commitScheduleTick(path, 100, [{ expected: null, next: schedule("daily", 1_000) }]),
      );
      corruptPersistedRows(path, statement);
      expect(
        await run(
          readAutomationStatus(path, 200).pipe(
            Effect.match({
              onFailure: Predicate.isTagged("AutomationProjectionError"),
              onSuccess: () => false,
            }),
          ),
        ),
      ).toBe(true);
    }
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
