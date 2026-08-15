/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Deferred, Effect, Fiber, Predicate, Result } from "effect";
import type { AutomationScheduleRecord } from "ziggy/domain/automation";
import {
  automationDatabasePath,
  automationRunStore,
  automationSchemaV1TestOnly,
  commitScheduleTick as commitScheduleTickOwned,
  initializeAutomationDatabase,
  makeAutomationRunStore,
  readAutomationRuns,
  readAutomationStatus,
  readScheduleRecords,
  recoverAutomationRuns,
  recoverResidentAutomationRuns,
} from "ziggy/adapters/bun/automation-sqlite";
import { discoverAutomationSources } from "ziggy/adapters/fs/automation-files";
import { isLocalProcessAlive, makeLocalProcessAlive } from "ziggy/adapters/bun/process";

const paths: Array<string> = [];
const profile = async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-scheduler-db-"));
  paths.push(path);
  await Effect.runPromise(initializeAutomationDatabase(path));
  return path;
};
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fingerprint = "a".repeat(64);
const defaultResidentOwnerId = "00000000-0000-4000-8000-000000000001";
const commitScheduleTick = (
  profilePath: string,
  atMs: number,
  mutations: Parameters<typeof commitScheduleTickOwned>[2],
  ownerPid: number = process.pid,
) => commitScheduleTickOwned(profilePath, atMs, mutations, defaultResidentOwnerId, ownerPid);
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

  test("initializes exactly schema version two with fenced ownership and six named indexes", async () => {
    const path = await profile();
    await run(initializeAutomationDatabase(path));
    const db = new Database(automationDatabasePath(path), {
      readonly: true,
      create: false,
      strict: true,
    });
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
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

  test("migrates only the frozen v1 shape, blocks live owners, and preserves terminal history", async () => {
    const path = await profile();
    const databasePath = automationDatabasePath(path);
    await rm(databasePath);
    const v1 = new Database(databasePath);
    const terminalId = "manual:00000000-0000-4000-8000-000000000090";
    const activeId = "manual:00000000-0000-4000-8000-000000000091";
    try {
      v1.exec(automationSchemaV1TestOnly);
      v1.query(
        `INSERT INTO automation_run (run_id,automation_id,trigger,state,owner_pid,schedule_fingerprint,scheduled_for_ms,missed_through_ms,recorded_at_ms,started_at_ms,finished_at_ms,local_completed,failure_category,gate_exit_code) VALUES (?,?,'manual-force','completed',NULL,NULL,NULL,NULL,10,11,12,1,NULL,NULL)`,
      ).run(terminalId, "terminal");
      v1.query(
        `INSERT INTO automation_run (run_id,automation_id,trigger,state,owner_pid,schedule_fingerprint,scheduled_for_ms,missed_through_ms,recorded_at_ms,started_at_ms,finished_at_ms,local_completed,failure_category,gate_exit_code) VALUES (?,?,'manual-force','running',777,NULL,NULL,NULL,20,21,NULL,0,NULL,NULL)`,
      ).run(activeId, "active");
    } finally {
      v1.close(false);
    }

    const blocked = await run(
      initializeAutomationDatabase(path, undefined, (pid) => pid === 777).pipe(Effect.result),
    );
    expect(Result.isFailure(blocked) && blocked.failure.operation).toBe("migrate live v1 owner");
    const stillV1 = new Database(databasePath, { readonly: true });
    expect(stillV1.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    stillV1.close(false);

    await run(initializeAutomationDatabase(path, undefined, () => false));
    const migrated = new Database(databasePath, { readonly: true });
    try {
      expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(
        migrated
          .query(
            "SELECT run_id runId,state,recorded_at_ms recordedAtMs,started_at_ms startedAtMs,finished_at_ms finishedAtMs,local_completed localCompleted,failure_category failureCategory FROM automation_run ORDER BY run_id",
          )
          .all(),
      ).toEqual([
        {
          runId: terminalId,
          state: "completed",
          recordedAtMs: 10,
          startedAtMs: 11,
          finishedAtMs: 12,
          localCompleted: 1,
          failureCategory: null,
        },
        {
          runId: activeId,
          state: "unknown",
          recordedAtMs: 20,
          startedAtMs: 21,
          finishedAtMs: 20,
          localCompleted: 0,
          failureCategory: "process-start",
        },
      ]);
    } finally {
      migrated.close(false);
    }
  });

  test("refuses unknown schema versions without mutation", async () => {
    const path = await profile();
    const databasePath = automationDatabasePath(path);
    const db = new Database(databasePath);
    db.exec("PRAGMA user_version = 99");
    db.close(false);

    const result = await run(initializeAutomationDatabase(path).pipe(Effect.result));
    expect(Result.isFailure(result) && result.failure.operation).toBe("validate schema");
    const unchanged = new Database(databasePath, { readonly: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    unchanged.close(false);
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

  test("manual recovery changes only dead manual owners", async () => {
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
      [deadScheduledId]: "claimed",
      [deadManualId]: "unknown",
      [schedulerBId]: "claimed",
      [schedulerAId]: "claimed",
      [manualId]: "claimed",
    });

    await run(liveManual.start(path, manualId, 800, null));
    await run(liveManual.finish(path, manualId, terminal, []));
    const resident = { kind: "resident" as const, id: "00000000-0000-4000-8000-000000000001" };
    await run(liveSchedulerA.start(path, schedulerAId, 810, fingerprint, resident));
    await run(liveSchedulerA.finish(path, schedulerAId, terminal, [], resident));
    await run(liveSchedulerB.start(path, schedulerBId, 820, fingerprint, resident));
    await run(liveSchedulerB.finish(path, schedulerBId, terminal, [], resident));
    const deadIds = new Set([deadManualId, deadScheduledId]);
    const firstRecovery = (await run(readAutomationRuns(path))).filter((item) =>
      deadIds.has(item.runId),
    );
    await run(recoverAutomationRuns(path, 1_000, () => false));
    expect((await run(readAutomationRuns(path))).filter((item) => deadIds.has(item.runId))).toEqual(
      firstRecovery,
    );
  });

  test("resident startup fences foreign UUIDs without touching its own claims", async () => {
    const path = await profile();
    const before = schedule("daily", 1_000);
    await run(
      commitScheduleTickOwned(
        path,
        0,
        [{ expected: null, next: before }],
        "00000000-0000-4000-8000-000000000010",
        4242,
      ),
    );
    await run(
      commitScheduleTickOwned(
        path,
        1_000,
        [
          {
            expected: before,
            next: { ...before, nextScheduledAtMs: 2_000, definitionObservedAtMs: 1_000 },
            occurrence: {
              kind: "due",
              runId: "scheduled:daily:1970-01-01T00:00:01.000Z",
              scheduledForMs: 1_000,
              missedThroughMs: null,
              scheduleFingerprint: fingerprint,
            },
          },
        ],
        "00000000-0000-4000-8000-000000000010",
        4242,
      ),
    );

    const store = makeAutomationRunStore(4242);
    const wrongStart = await run(
      store
        .start(path, "scheduled:daily:1970-01-01T00:00:01.000Z", 1_050, fingerprint, {
          kind: "resident",
          id: "00000000-0000-4000-8000-000000000099",
        })
        .pipe(Effect.result),
    );
    expect(Result.isFailure(wrongStart) && wrongStart.failure.operation).toBe("start claimed run");
    await run(recoverResidentAutomationRuns(path, "00000000-0000-4000-8000-000000000010", 1_100));
    expect((await run(readAutomationRuns(path)))[0]?.state).toBe("claimed");
    await run(recoverResidentAutomationRuns(path, "00000000-0000-4000-8000-000000000011", 1_200));
    expect((await run(readAutomationRuns(path)))[0]).toMatchObject({
      state: "unknown",
      finishedAtMs: 1_200,
      failureCategory: "process-start",
    });
  });

  test("rejects malformed write transitions before SQLite changes", async () => {
    const path = await profile();
    const runId = "manual:00000000-0000-4000-8000-000000000001";
    await run(automationRunStore.admitManual(path, "daily", runId, 100));
    await run(automationRunStore.start(path, runId, 110, null));

    const malformedTerminal = await run(
      // oxlint-disable-next-line ziggy/no-reflect-apply -- finish rejects malformed terminal at schema decode; test must bypass the typed contract
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
      // oxlint-disable-next-line ziggy/no-reflect-apply -- commitScheduleTick rejects malformed mutations at schema decode; test must bypass the typed contract
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
    await rm(runtime, { recursive: true });
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
    await rm(join(path, ".runtime"), { recursive: true });
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
