import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import {
  AutomationDatabaseError,
  AutomationProjectionError,
  type AutomationRunProjection,
  type AutomationScheduleRecord,
  type AutomationStatusProjection,
  type AutomationTargetOutcome,
  manualRunId,
} from "../../domain/automation";
import type { ProfileTarget } from "../../domain/profile";

const DATABASE_NAME = "automation-scheduler.sqlite";
const SCHEMA = `
CREATE TABLE scheduler_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), heartbeat_at_ms INTEGER CHECK (heartbeat_at_ms >= 0),
  last_tick_at_ms INTEGER CHECK (last_tick_at_ms >= 0), last_tick_status TEXT CHECK (last_tick_status IN ('ok', 'error')),
  last_tick_error TEXT,
  CHECK ((last_tick_status IS NULL AND last_tick_at_ms IS NULL AND last_tick_error IS NULL)
    OR (last_tick_status = 'ok' AND last_tick_at_ms IS NOT NULL AND last_tick_error IS NULL)
    OR (last_tick_status = 'error' AND last_tick_at_ms IS NOT NULL AND last_tick_error = 'definitions-unreadable'))
) STRICT;
CREATE TABLE automation_schedule (
  automation_id TEXT PRIMARY KEY, definition_state TEXT NOT NULL CHECK (definition_state IN ('valid', 'invalid', 'deleted')),
  schedule_fingerprint TEXT, next_scheduled_at_ms INTEGER CHECK (next_scheduled_at_ms >= 0),
  definition_observed_at_ms INTEGER NOT NULL CHECK (definition_observed_at_ms >= 0), definition_error TEXT,
  CHECK (schedule_fingerprint IS NULL OR (length(schedule_fingerprint) = 64 AND schedule_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK ((definition_state = 'valid' AND schedule_fingerprint IS NOT NULL AND next_scheduled_at_ms IS NOT NULL AND definition_error IS NULL)
    OR (definition_state = 'invalid' AND definition_error IS NOT NULL)
    OR (definition_state = 'deleted' AND next_scheduled_at_ms IS NULL AND definition_error IS NULL))
) STRICT;
CREATE TABLE automation_run (
  run_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN ('manual-force', 'scheduled')),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'completed', 'failed', 'skipped-gate', 'skipped-busy', 'missed', 'unknown')),
  schedule_fingerprint TEXT, scheduled_for_ms INTEGER CHECK (scheduled_for_ms >= 0), missed_through_ms INTEGER CHECK (missed_through_ms >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0), started_at_ms INTEGER CHECK (started_at_ms >= 0), finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  local_completed INTEGER NOT NULL DEFAULT 0 CHECK (local_completed IN (0, 1)), failure_category TEXT, gate_exit_code INTEGER,
  CHECK ((trigger = 'manual-force' AND schedule_fingerprint IS NULL AND scheduled_for_ms IS NULL)
    OR (trigger = 'scheduled' AND schedule_fingerprint IS NOT NULL AND scheduled_for_ms IS NOT NULL)),
  CHECK ((state = 'claimed' AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state = 'running' AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (state IN ('completed', 'failed', 'skipped-gate', 'skipped-busy', 'missed', 'unknown') AND finished_at_ms IS NOT NULL)),
  CHECK ((state = 'missed' AND trigger = 'scheduled' AND missed_through_ms IS NOT NULL AND missed_through_ms >= scheduled_for_ms)
    OR (state <> 'missed' AND missed_through_ms IS NULL)),
  CHECK ((state = 'completed' AND local_completed = 1 AND failure_category IS NULL)
    OR (state = 'failed' AND failure_category IS NOT NULL)
    OR (state = 'skipped-gate' AND local_completed = 0 AND failure_category IN ('gate-missing', 'gate-nonzero'))
    OR (state = 'unknown' AND local_completed = 0 AND failure_category = 'process-start')
    OR (state IN ('claimed', 'running', 'skipped-busy', 'missed') AND local_completed = 0 AND failure_category IS NULL)),
  CHECK ((failure_category = 'gate-nonzero' AND gate_exit_code IS NOT NULL AND gate_exit_code <> 0)
    OR (failure_category <> 'gate-nonzero' AND gate_exit_code IS NULL)
    OR (failure_category IS NULL AND gate_exit_code IS NULL))
) STRICT;
CREATE TABLE automation_target_outcome (
  run_id TEXT NOT NULL REFERENCES automation_run(run_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')), failure_category TEXT, retriable INTEGER CHECK (retriable IN (0, 1)),
  PRIMARY KEY (run_id, ordinal), UNIQUE (run_id, target),
  CHECK ((status = 'delivered' AND failure_category IS NULL AND retriable IS NULL)
    OR (status = 'failed' AND failure_category IS NOT NULL AND retriable IS NOT NULL))
) STRICT;
CREATE INDEX automation_schedule_due ON automation_schedule(next_scheduled_at_ms, automation_id) WHERE definition_state = 'valid';
CREATE INDEX automation_schedule_invalid ON automation_schedule(definition_observed_at_ms DESC, automation_id) WHERE definition_state = 'invalid';
CREATE UNIQUE INDEX automation_run_scheduled_occurrence ON automation_run(automation_id, scheduled_for_ms) WHERE trigger = 'scheduled';
CREATE UNIQUE INDEX automation_run_active_automation ON automation_run(automation_id) WHERE state IN ('claimed', 'running');
CREATE INDEX automation_run_recent ON automation_run(recorded_at_ms DESC, run_id DESC);
CREATE INDEX automation_run_by_automation_recent ON automation_run(automation_id, recorded_at_ms DESC, run_id DESC);
PRAGMA user_version = 1;`;

// oxfmt-ignore
const ScheduleRow = Schema.Struct({ automationId: Schema.String, definitionState: Schema.Literals(["valid", "invalid", "deleted"]), scheduleFingerprint: Schema.NullOr(Schema.String), nextScheduledAtMs: Schema.NullOr(Schema.Finite), definitionObservedAtMs: Schema.Finite, definitionError: Schema.NullOr(Schema.String) });
// oxfmt-ignore
const StateRow = Schema.Struct({ heartbeatAtMs: Schema.NullOr(Schema.Finite), lastTickAtMs: Schema.NullOr(Schema.Finite), lastTickStatus: Schema.NullOr(Schema.Literals(["ok", "error"])), lastTickError: Schema.NullOr(Schema.String) });
// oxfmt-ignore
const RunRow = Schema.Struct({ runId: Schema.String, automationId: Schema.String, trigger: Schema.Literals(["manual-force", "scheduled"]), state: Schema.Literals(["claimed", "running", "completed", "failed", "skipped-gate", "skipped-busy", "missed", "unknown"]), scheduleFingerprint: Schema.NullOr(Schema.String), scheduledForMs: Schema.NullOr(Schema.Finite), missedThroughMs: Schema.NullOr(Schema.Finite), recordedAtMs: Schema.Finite, startedAtMs: Schema.NullOr(Schema.Finite), finishedAtMs: Schema.NullOr(Schema.Finite), localCompleted: Schema.Finite, failureCategory: Schema.NullOr(Schema.String), gateExitCode: Schema.NullOr(Schema.Finite) });
// oxfmt-ignore
const TargetRow = Schema.Struct({ runId: Schema.String, ordinal: Schema.Finite, target: Schema.String, status: Schema.Literals(["delivered", "failed"]), failureCategory: Schema.NullOr(Schema.String), retriable: Schema.NullOr(Schema.Finite) });
const VersionRow = Schema.Struct({ user_version: Schema.Finite });
const MasterRow = Schema.Struct({ name: Schema.String, type: Schema.String, sql: Schema.String });
const decodeSchedules = Schema.decodeUnknownSync(Schema.Array(ScheduleRow));
const decodeState = Schema.decodeUnknownSync(Schema.NullOr(StateRow));
const decodeRuns = Schema.decodeUnknownSync(Schema.Array(RunRow));
const decodeTargets = Schema.decodeUnknownSync(Schema.Array(TargetRow));
const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Finite }));
const decodeVersion = Schema.decodeUnknownSync(Schema.NullOr(VersionRow));
const decodeMaster = Schema.decodeUnknownSync(Schema.Array(MasterRow));

export const automationDatabasePath = (profilePath: string): string =>
  join(profilePath, ".runtime", DATABASE_NAME);
const dbError = (operation: string, path: string, cause: unknown) =>
  new AutomationDatabaseError({
    operation,
    path,
    message: `automation database ${operation} failed at ${path}`,
    cause,
  });

const validateSchema = (db: Database, path: string, initialize: boolean): void => {
  const version = decodeVersion(db.query("PRAGMA user_version").get());
  const applicationObjects = decodeMaster(
    db
      .query(
        "SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  );
  if (initialize && version?.user_version === 0 && applicationObjects.length === 0) {
    db.transaction(() => db.exec(SCHEMA)).immediate();
    return;
  }
  // oxfmt-ignore
  const expected = ["automation_run", "automation_run_active_automation", "automation_run_by_automation_recent", "automation_run_recent", "automation_run_scheduled_occurrence", "automation_schedule", "automation_schedule_due", "automation_schedule_invalid", "automation_target_outcome", "scheduler_state"];
  const shape = createHash("sha256").update(JSON.stringify(applicationObjects)).digest("hex");
  if (
    version?.user_version !== 1 ||
    applicationObjects.map((row) => row.name).join("|") !== expected.join("|") ||
    shape !== "5390f470cf1d6f4ca446454de8a94a69ebe7660af0cfbaf5b947adc97f026055"
  ) {
    throw dbError("validate schema", path, {
      version: version?.user_version,
      objects: applicationObjects,
    });
  }
};

const withWritable = <A>(
  profilePath: string,
  operation: string,
  use: (db: Database) => A,
): Effect.Effect<A, AutomationDatabaseError> => {
  const path = automationDatabasePath(profilePath);
  return Effect.tryPromise({
    try: () => mkdir(join(profilePath, ".runtime"), { recursive: true }),
    catch: (cause) => dbError("create runtime directory", path, cause),
  }).pipe(
    Effect.andThen(
      Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const db = new Database(path, { create: true, readwrite: true, strict: true });
            try {
              db.exec(
                "PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
              );
              validateSchema(db, path, true);
              return db;
            } catch (cause) {
              db.close(false);
              throw cause;
            }
          },
          catch: (cause) =>
            cause instanceof AutomationDatabaseError ? cause : dbError("open", path, cause),
        }),
        (db) =>
          Effect.try({
            try: () => use(db),
            catch: (cause) =>
              cause instanceof AutomationDatabaseError ? cause : dbError(operation, path, cause),
          }),
        (db) => Effect.sync(() => db.close(false)),
      ),
    ),
  );
};

const scheduleQuery = `SELECT automation_id automationId, definition_state definitionState,
 schedule_fingerprint scheduleFingerprint, next_scheduled_at_ms nextScheduledAtMs,
 definition_observed_at_ms definitionObservedAtMs, definition_error definitionError
 FROM automation_schedule ORDER BY automation_id`;
const runColumns = `run_id runId, automation_id automationId, trigger, state, schedule_fingerprint scheduleFingerprint,
 scheduled_for_ms scheduledForMs, missed_through_ms missedThroughMs, recorded_at_ms recordedAtMs,
 started_at_ms startedAtMs, finished_at_ms finishedAtMs, local_completed localCompleted,
 failure_category failureCategory, gate_exit_code gateExitCode`;

export const initializeAutomationDatabase = (profilePath: string) =>
  withWritable(profilePath, "initialize", () => undefined);
export const readScheduleRecords = (profilePath: string) =>
  withWritable(profilePath, "read schedules", (db) =>
    decodeSchedules(db.query(scheduleQuery).all()),
  );
export const recoverAutomationRuns = (profilePath: string, atMs: number) =>
  withWritable(profilePath, "recover runs", (db) =>
    db
      .transaction(() => {
        db.query(
          "UPDATE automation_run SET state='unknown', finished_at_ms=?, failure_category='process-start' WHERE state IN ('claimed','running')",
        ).run(atMs);
      })
      .immediate(),
  );

// oxfmt-ignore
export interface ScheduleOccurrence { readonly kind: "due" | "missed"; readonly runId: string; readonly scheduledForMs: number; readonly missedThroughMs: number | null; readonly scheduleFingerprint: string }
// oxfmt-ignore
export interface ScheduleMutation { readonly expected: AutomationScheduleRecord | null; readonly next: AutomationScheduleRecord; readonly occurrence?: ScheduleOccurrence }
// oxfmt-ignore
export interface ScheduleCommitResult { readonly stale: boolean; readonly claimed: ReadonlyArray<{ readonly automationId: string; readonly runId: string; readonly scheduledForMs: number; readonly scheduleFingerprint: string }> }

const sameSchedule = (
  left: AutomationScheduleRecord | undefined,
  right: AutomationScheduleRecord | null,
): boolean =>
  left !== undefined &&
  right !== null &&
  left.automationId === right.automationId &&
  left.definitionState === right.definitionState &&
  left.scheduleFingerprint === right.scheduleFingerprint &&
  left.nextScheduledAtMs === right.nextScheduledAtMs &&
  left.definitionObservedAtMs === right.definitionObservedAtMs &&
  left.definitionError === right.definitionError;

export const commitScheduleTick = (
  profilePath: string,
  atMs: number,
  mutations: ReadonlyArray<ScheduleMutation>,
) =>
  withWritable(
    profilePath,
    "commit tick",
    (db): ScheduleCommitResult =>
      db
        .transaction(() => {
          const current = new Map(
            decodeSchedules(db.query(scheduleQuery).all()).map((row) => [row.automationId, row]),
          );
          if (
            mutations.some((mutation) =>
              mutation.expected === null
                ? current.has(mutation.next.automationId)
                : !sameSchedule(current.get(mutation.next.automationId), mutation.expected),
            )
          ) {
            return { stale: true, claimed: [] };
          }
          const claimed: Array<{
            automationId: string;
            runId: string;
            scheduledForMs: number;
            scheduleFingerprint: string;
          }> = [];
          for (const mutation of mutations) {
            const row = mutation.next;
            db.query(`INSERT INTO automation_schedule VALUES (?,?,?,?,?,?) ON CONFLICT(automation_id) DO UPDATE SET
        definition_state=excluded.definition_state, schedule_fingerprint=excluded.schedule_fingerprint,
        next_scheduled_at_ms=excluded.next_scheduled_at_ms, definition_observed_at_ms=excluded.definition_observed_at_ms,
        definition_error=excluded.definition_error`).run(
              row.automationId,
              row.definitionState,
              row.scheduleFingerprint,
              row.nextScheduledAtMs,
              row.definitionObservedAtMs,
              row.definitionError,
            );
            const occurrence = mutation.occurrence;
            if (occurrence === undefined) continue;
            if (occurrence.kind === "missed") {
              db.query("INSERT INTO automation_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
                occurrence.runId,
                row.automationId,
                "scheduled",
                "missed",
                occurrence.scheduleFingerprint,
                occurrence.scheduledForMs,
                occurrence.missedThroughMs,
                atMs,
                null,
                atMs,
                0,
                null,
                null,
              );
              continue;
            }
            const busy =
              db
                .query(
                  "SELECT 1 FROM automation_run WHERE automation_id=? AND state IN ('claimed','running') LIMIT 1",
                )
                .get(row.automationId) !== null;
            const state = busy ? "skipped-busy" : "claimed";
            db.query("INSERT INTO automation_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
              occurrence.runId,
              row.automationId,
              "scheduled",
              state,
              occurrence.scheduleFingerprint,
              occurrence.scheduledForMs,
              null,
              atMs,
              null,
              busy ? atMs : null,
              0,
              null,
              null,
            );
            if (!busy)
              claimed.push({
                automationId: row.automationId,
                runId: occurrence.runId,
                scheduledForMs: occurrence.scheduledForMs,
                scheduleFingerprint: occurrence.scheduleFingerprint,
              });
          }
          db.query(`INSERT INTO scheduler_state(singleton,heartbeat_at_ms,last_tick_at_ms,last_tick_status,last_tick_error)
      VALUES(1,?,?, 'ok',NULL) ON CONFLICT(singleton) DO UPDATE SET heartbeat_at_ms=excluded.heartbeat_at_ms,
      last_tick_at_ms=excluded.last_tick_at_ms,last_tick_status='ok',last_tick_error=NULL`).run(
            atMs,
            atMs,
          );
          return { stale: false, claimed };
        })
        .immediate(),
  );

export const recordDefinitionTickFailure = (profilePath: string, atMs: number) =>
  withWritable(profilePath, "record tick error", (db) =>
    db
      .transaction(() => {
        db.query(`INSERT INTO scheduler_state(singleton,heartbeat_at_ms,last_tick_at_ms,last_tick_status,last_tick_error)
      VALUES(1,?,?,'error','definitions-unreadable') ON CONFLICT(singleton) DO UPDATE SET heartbeat_at_ms=excluded.heartbeat_at_ms,
      last_tick_at_ms=excluded.last_tick_at_ms,last_tick_status='error',last_tick_error='definitions-unreadable'`).run(
          atMs,
          atMs,
        );
      })
      .immediate(),
  );

// oxfmt-ignore
export interface AutomationRunStore { readonly admitManual: (profilePath: string, automationId: string, runId: string, atMs: number) => Effect.Effect<"claimed" | "skipped-busy", AutomationDatabaseError>; readonly start: (profilePath: string, runId: string, atMs: number, fingerprint: string | null) => Effect.Effect<void, AutomationDatabaseError>; readonly finish: (profilePath: string, runId: string, terminal: RunTerminal, targets: ReadonlyArray<AutomationTargetOutcome>) => Effect.Effect<void, AutomationDatabaseError> }
// oxfmt-ignore
export interface RunTerminal { readonly state: "completed" | "failed" | "skipped-gate"; readonly atMs: number; readonly localCompleted: boolean; readonly failureCategory: string | null; readonly gateExitCode: number | null }

export const automationRunStore: AutomationRunStore = {
  admitManual: (profilePath, automationId, runId, atMs) =>
    withWritable(profilePath, "admit manual run", (db) =>
      db
        .transaction(() => {
          const busy =
            db
              .query(
                "SELECT 1 FROM automation_run WHERE automation_id=? AND state IN ('claimed','running') LIMIT 1",
              )
              .get(automationId) !== null;
          db.query(
            "INSERT INTO automation_run VALUES (?,?,?,?,NULL,NULL,NULL,?,?,?,0,NULL,NULL)",
          ).run(
            runId,
            automationId,
            "manual-force",
            busy ? "skipped-busy" : "claimed",
            atMs,
            null,
            busy ? atMs : null,
          );
          return busy ? ("skipped-busy" as const) : ("claimed" as const);
        })
        .immediate(),
    ),
  start: (profilePath, runId, atMs, fingerprint) =>
    withWritable(profilePath, "start run", (db) =>
      db
        .transaction(() => {
          const result = db
            .query(
              "UPDATE automation_run SET state='running', started_at_ms=? WHERE run_id=? AND state='claimed' AND schedule_fingerprint IS ?",
            )
            .run(atMs, runId, fingerprint);
          if (result.changes !== 1)
            throw dbError("start claimed run", automationDatabasePath(profilePath), runId);
        })
        .immediate(),
    ),
  finish: (profilePath, runId, terminal, targets) =>
    withWritable(profilePath, "finish run", (db) =>
      db
        .transaction(() => {
          for (const [ordinal, target] of targets.entries())
            db.query("INSERT INTO automation_target_outcome VALUES (?,?,?,?,?,?)").run(
              runId,
              ordinal,
              target.target,
              target.status,
              target.status === "failed" ? target.category : null,
              target.status === "failed" ? Number(target.retriable) : null,
            );
          const result = db
            .query(`UPDATE automation_run SET state=?,finished_at_ms=?,local_completed=?,failure_category=?,gate_exit_code=?
      WHERE run_id=? AND state='running'`)
            .run(
              terminal.state,
              terminal.atMs,
              Number(terminal.localCompleted),
              terminal.failureCategory,
              terminal.gateExitCode,
              runId,
            );
          if (result.changes !== 1)
            throw dbError("finish running run", automationDatabasePath(profilePath), runId);
        })
        .immediate(),
    ),
};

export const makeLiveManualRunId = (): string => manualRunId(randomUUID());

// oxfmt-ignore
export interface AutomationSourceObservation { readonly idSource: string; readonly path: string; readonly source: string | null; readonly error: string | null }
const missing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
// oxfmt-ignore
export const discoverAutomationSources = (target: ProfileTarget): Effect.Effect<ReadonlyArray<AutomationSourceObservation>, AutomationProjectionError> => {
  const directory = join(target.path, "automations");
  return Effect.tryPromise({ try: async () => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (cause) { if (missing(cause)) return []; throw cause; }
    const observations: Array<AutomationSourceObservation> = [];
    for (const entry of entries.filter((item) => item.name.endsWith(".md") && item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const idSource = entry.name.slice(0, -3);
      try { observations.push({ idSource, path, source: await readFile(path, "utf8"), error: null }); }
      catch { observations.push({ idSource, path, source: null, error: `could not read automation ${idSource} at ${path}` }); }
    }
    return observations;
  }, catch: (cause) => new AutomationProjectionError({ operation: "list definitions", path: directory, message: `could not list automation definitions at ${directory}`, cause }) });
};

// oxfmt-ignore
const openReadonlyIfPresent = <A>(profilePath: string, operation: string, absent: A, use: (db: Database) => A): Effect.Effect<A, AutomationProjectionError> => {
  const path = automationDatabasePath(profilePath);
  const inspectError = (cause: unknown) => ({ cause, absent: missing(cause) });
  return Effect.tryPromise({ try: () => lstat(path), catch: inspectError }).pipe(Effect.matchEffect({
    onFailure: (failure) => failure.absent ? Effect.succeed(absent) : Effect.fail(new AutomationProjectionError({ operation, path, message: `could not inspect automation database at ${path}`, cause: failure.cause })),
    onSuccess: () => Effect.acquireUseRelease(
      Effect.try({ try: () => new Database(path, { readonly: true, create: false, strict: true }), catch: (cause) => new AutomationProjectionError({ operation, path, message: `could not open automation database at ${path}`, cause }) }),
      (db) => Effect.try({ try: () => { validateSchema(db, path, false); return use(db); }, catch: (cause) => new AutomationProjectionError({ operation, path, message: `could not read automation database at ${path}`, cause }) }),
      (db) => Effect.sync(() => db.close(false)),
    ),
  }));
};

const readRunRows = (
  db: Database,
  where: string,
  bindings: ReadonlyArray<string>,
  limit: number,
): ReadonlyArray<AutomationRunProjection> => {
  const rows = decodeRuns(
    db
      .query(
        `SELECT ${runColumns} FROM automation_run ${where} ORDER BY recorded_at_ms DESC, run_id DESC LIMIT ${limit}`,
      )
      .all(...bindings),
  );
  if (rows.length === 0) return [];
  const targets = decodeTargets(
    db
      .query(`SELECT run_id runId,ordinal,target,status,failure_category failureCategory,retriable
    FROM automation_target_outcome WHERE run_id IN (${rows.map(() => "?").join(",")}) ORDER BY ordinal,target`)
      .all(...rows.map((row) => row.runId)),
  );
  return rows.map((row) => ({
    ...row,
    localCompleted: row.localCompleted === 1,
    targets: targets
      .filter((target) => target.runId === row.runId)
      .map(({ runId: _runId, retriable, ...target }) => ({
        ...target,
        retriable: retriable === null ? null : retriable === 1,
      })),
  }));
};

const emptyStatus = (profilePath: string, observedAtMs: number): AutomationStatusProjection => ({
  profilePath,
  observedAtMs,
  heartbeatAtMs: null,
  lastTickAtMs: null,
  lastTickStatus: null,
  lastTickError: null,
  schedules: [],
  activeRunCount: 0,
  latestRun: null,
  latestErrorRun: null,
});
export const readAutomationStatus = (profilePath: string, observedAtMs: number) =>
  openReadonlyIfPresent(profilePath, "status", emptyStatus(profilePath, observedAtMs), (db) =>
    db.transaction(() => {
      const state = decodeState(
        db
          .query(
            "SELECT heartbeat_at_ms heartbeatAtMs,last_tick_at_ms lastTickAtMs,last_tick_status lastTickStatus,last_tick_error lastTickError FROM scheduler_state WHERE singleton=1",
          )
          .get(),
      );
      const schedules = decodeSchedules(db.query(scheduleQuery).all());
      const active = decodeCount(
        db
          .query("SELECT count(*) count FROM automation_run WHERE state IN ('claimed','running')")
          .get(),
      );
      const latestRun = readRunRows(db, "", [], 1)[0] ?? null;
      const latestErrorRun =
        readRunRows(db, "WHERE state IN ('failed','missed','unknown')", [], 1)[0] ?? null;
      return {
        ...emptyStatus(profilePath, observedAtMs),
        ...state,
        schedules,
        activeRunCount: active.count,
        latestRun,
        latestErrorRun,
      };
    })(),
  );
export const readAutomationRuns = (profilePath: string, automationId?: string) =>
  openReadonlyIfPresent(profilePath, "runs", [], (db) =>
    db.transaction(() =>
      readRunRows(
        db,
        automationId === undefined ? "" : "WHERE automation_id=?",
        automationId === undefined ? [] : [automationId],
        10,
      ),
    )(),
  );

export const validateAutomationProjectionProfile = (
  target: ProfileTarget,
): Effect.Effect<void, AutomationProjectionError> => {
  const soulPath = join(target.path, "SOUL.md");
  return Effect.tryPromise({
    try: () => lstat(soulPath),
    catch: (cause) =>
      new AutomationProjectionError({
        operation: "inspect profile",
        path: soulPath,
        message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.void
        : Effect.fail(
            new AutomationProjectionError({
              operation: "inspect profile",
              path: soulPath,
              message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
              cause: "SOUL.md is not a file",
            }),
          ),
    ),
  );
};
