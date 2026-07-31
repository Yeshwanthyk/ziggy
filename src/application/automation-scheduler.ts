import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Clock, Effect, Schema } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import type { AutomationDueDecision, AutomationSchedule } from "../domain/automation-schedule";
import { canonicalAutomationFiringId, decideAutomationDue } from "../domain/automation-schedule";
import type { ProfileTarget } from "../domain/profile";

export interface ScheduledAutomation {
  readonly id: string;
  readonly enabled: boolean;
  readonly schedule: AutomationSchedule;
}

export interface ScheduledAutomationTrigger {
  readonly kind: "scheduled";
  readonly firingId: string;
  readonly scheduledInstant: string;
  readonly skipReason?: string;
}

export class AutomationSchedulerError extends Schema.TaggedErrorClass<AutomationSchedulerError>()(
  "AutomationSchedulerError",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    automationId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AutomationScheduleLoader {
  readonly listScheduled: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<ScheduledAutomation>, AutomationSchedulerError>;
}

export interface ScheduledAutomationRunner {
  readonly runScheduled: (
    target: ProfileTarget,
    automationId: string,
    trigger: ScheduledAutomationTrigger,
  ) => Effect.Effect<void, AutomationSchedulerError>;
}

export interface AutomationSchedulerOptions {
  readonly graceSeconds: number;
  readonly pollSeconds: number;
}

export interface AutomationSchedulerTick {
  readonly automationId: string;
  readonly decision:
    | AutomationDueDecision
    | { readonly kind: "disabled" }
    | { readonly kind: "ran"; readonly firingId: string }
    | { readonly kind: "failed"; readonly firingId: string };
}

export interface AutomationSchedulerShape {
  readonly tick: (
    target: ProfileTarget,
    now: Date,
  ) => Effect.Effect<ReadonlyArray<AutomationSchedulerTick>, AutomationSchedulerError>;
  readonly runLoop: (target: ProfileTarget) => Effect.Effect<never, AutomationSchedulerError>;
}

const schedulerRoot = (target: ProfileTarget) => join(target.path, ".runtime", "automations");
const cursorPath = (target: ProfileTarget, id: string) =>
  join(schedulerRoot(target), "cursors", `${id}.txt`);
const leasePath = (target: ProfileTarget) => join(schedulerRoot(target), "scheduler-lease.sqlite");
const healthPath = (target: ProfileTarget) => join(schedulerRoot(target), "scheduler-health.json");

const schedulerFailure = (
  operation: string,
  message: string,
  cause?: unknown,
  path?: string,
  automationId?: string,
) =>
  new AutomationSchedulerError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(path === undefined ? {} : { path }),
    ...(automationId === undefined ? {} : { automationId }),
  });

const ensureParent = (path: string) =>
  Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true }),
    catch: (cause) =>
      schedulerFailure("create directory", `could not create ${dirname(path)}`, cause, path),
  });

const atomicWrite = (path: string, contents: string) =>
  Effect.gen(function* () {
    yield* ensureParent(path);
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    yield* Effect.tryPromise({
      try: () => writeFile(temporaryPath, contents, { mode: 0o600 }),
      catch: (cause) => schedulerFailure("write", `could not write ${temporaryPath}`, cause, path),
    });
    yield* Effect.tryPromise({
      try: () => rename(temporaryPath, path),
      catch: (cause) => schedulerFailure("replace", `could not replace ${path}`, cause, path),
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => rm(temporaryPath, { force: true }).then(() => undefined)),
      ),
    );
  });

const readCursor = (
  target: ProfileTarget,
  automationId: string,
): Effect.Effect<Date | undefined, AutomationSchedulerError> => {
  const path = cursorPath(target, automationId);
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      schedulerFailure("read cursor", `could not read ${path}`, cause, path, automationId),
  }).pipe(
    Effect.map((source) => {
      const timestamp = Date.parse(source.trim());
      return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
    }),
    Effect.catch((failure) =>
      fileSystemCauseDetails(failure.cause).code === "ENOENT"
        ? Effect.sync(() => undefined)
        : Effect.fail(failure),
    ),
  );
};

const advanceCursor = (target: ProfileTarget, automationId: string, instant: Date) =>
  atomicWrite(cursorPath(target, automationId), `${instant.toISOString()}\n`);

const HealthSchema = Schema.Struct({
  heartbeatAt: Schema.String,
  instanceId: Schema.optional(Schema.String),
  lastSuccessAt: Schema.optional(Schema.String),
  lastErrorAt: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  stoppedAt: Schema.optional(Schema.String),
});
const decodeHealth = Schema.decodeUnknownEffect(Schema.fromJsonString(HealthSchema));

const readHealth = (target: ProfileTarget) => {
  const path = healthPath(target);
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => schedulerFailure("read health", `could not read ${path}`, cause, path),
  }).pipe(
    Effect.flatMap(decodeHealth),
    Effect.orElseSucceed(() => undefined),
  );
};

const writeHeartbeat = (target: ProfileTarget, now: Date, instanceId: string) =>
  Effect.gen(function* () {
    const previous = yield* readHealth(target);
    yield* atomicWrite(
      healthPath(target),
      `${JSON.stringify({
        ...previous,
        heartbeatAt: now.toISOString(),
        instanceId,
        stoppedAt: undefined,
      })}\n`,
    );
  });

const writeStoppedHealth = (target: ProfileTarget, now: Date, instanceId: string) =>
  Effect.gen(function* () {
    const previous = yield* readHealth(target);
    if (previous?.instanceId !== instanceId) return;
    yield* atomicWrite(
      healthPath(target),
      `${JSON.stringify({
        ...previous,
        heartbeatAt: now.toISOString(),
        instanceId,
        stoppedAt: now.toISOString(),
      })}\n`,
    );
  });

const writeHealth = (
  target: ProfileTarget,
  now: Date,
  outcome: "success" | "error",
  message?: string,
  instanceId?: string,
) =>
  Effect.gen(function* () {
    const previousSuccess = (yield* readHealth(target))?.lastSuccessAt;
    yield* atomicWrite(
      healthPath(target),
      `${JSON.stringify({
        heartbeatAt: now.toISOString(),
        ...(instanceId === undefined ? {} : { instanceId }),
        ...(outcome === "success"
          ? { lastSuccessAt: now.toISOString() }
          : {
              ...(previousSuccess === undefined ? {} : { lastSuccessAt: previousSuccess }),
              lastErrorAt: now.toISOString(),
              lastError: message ?? "scheduler tick failed",
            }),
      })}\n`,
    );
  });

const runOne = (
  runner: ScheduledAutomationRunner,
  target: ProfileTarget,
  automation: ScheduledAutomation,
  now: Date,
  graceSeconds: number,
): Effect.Effect<AutomationSchedulerTick, AutomationSchedulerError> =>
  Effect.gen(function* () {
    if (!automation.enabled) {
      return { automationId: automation.id, decision: { kind: "disabled" } };
    }
    const previous = yield* readCursor(target, automation.id);
    const due = decideAutomationDue(
      automation.id,
      automation.schedule,
      previous,
      now,
      graceSeconds,
    );
    if (due.kind === "not-due") {
      return { automationId: automation.id, decision: due };
    }
    if (due.kind === "missed") {
      const firingId = canonicalAutomationFiringId(automation.id, due.instant);
      const result = yield* runner
        .runScheduled(target, automation.id, {
          kind: "scheduled",
          firingId,
          scheduledInstant: due.instant.toISOString(),
          skipReason: `Scheduled firing was outside the ${graceSeconds}-second catch-up window.`,
        })
        .pipe(
          Effect.match({
            onFailure: (): AutomationSchedulerTick => ({
              automationId: automation.id,
              decision: { kind: "failed", firingId },
            }),
            onSuccess: (): AutomationSchedulerTick => ({
              automationId: automation.id,
              decision: due,
            }),
          }),
        );
      yield* advanceCursor(target, automation.id, due.instant);
      return result;
    }

    const result = yield* runner
      .runScheduled(target, automation.id, {
        kind: "scheduled",
        firingId: due.firingId,
        scheduledInstant: due.instant.toISOString(),
      })
      .pipe(
        Effect.match({
          onFailure: (): AutomationSchedulerTick => ({
            automationId: automation.id,
            decision: { kind: "failed", firingId: due.firingId },
          }),
          onSuccess: (): AutomationSchedulerTick => ({
            automationId: automation.id,
            decision: { kind: "ran", firingId: due.firingId },
          }),
        }),
      );
    yield* advanceCursor(target, automation.id, due.instant);
    return result;
  });

export const makeAutomationScheduler = (
  loader: AutomationScheduleLoader,
  runner: ScheduledAutomationRunner,
  options: AutomationSchedulerOptions,
): AutomationSchedulerShape => {
  const tickOnce = (target: ProfileTarget, now: Date, instanceId?: string) =>
    Effect.gen(function* () {
      const automations = yield* loader.listScheduled(target);
      const outcomes = yield* Effect.forEach(
        automations,
        (automation) => runOne(runner, target, automation, now, options.graceSeconds),
        { concurrency: "unbounded" },
      );
      yield* writeHealth(target, now, "success", undefined, instanceId);
      return outcomes;
    }).pipe(
      Effect.tapError((failure) =>
        writeHealth(target, now, "error", failure.message, instanceId).pipe(
          Effect.catch((healthFailure) =>
            Effect.logWarning("could not write automation scheduler health", {
              failure: healthFailure,
            }),
          ),
        ),
      ),
    );

  const tick: AutomationSchedulerShape["tick"] = (target, now) => tickOnce(target, now);

  const runLoop: AutomationSchedulerShape["runLoop"] = (target) => {
    const path = leasePath(target);
    const instanceId = crypto.randomUUID();
    const acquire = Effect.gen(function* () {
      yield* ensureParent(path);
      return yield* Effect.try({
        try: () => {
          const database = new Database(path, { create: true });
          database.exec("PRAGMA busy_timeout = 0");
          database.exec("BEGIN IMMEDIATE");
          return database;
        },
        catch: (cause) =>
          schedulerFailure(
            "acquire scheduler lease",
            `scheduler already owns Profile ${target.path}`,
            cause,
            path,
          ),
      });
    });
    return Effect.acquireRelease(acquire, (database) =>
      Effect.sync(() => {
        if (database.inTransaction) database.exec("ROLLBACK");
        database.close();
      }),
    ).pipe(
      Effect.flatMap(() => {
        const ticks = Effect.forever(
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            yield* tickOnce(target, now, instanceId);
            yield* Effect.sleep(`${options.pollSeconds} seconds`);
          }),
        );
        const heartbeats = Effect.forever(
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            yield* writeHeartbeat(target, now, instanceId);
            yield* Effect.sleep("10 seconds");
          }),
        );
        return Effect.all([ticks, heartbeats], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.andThen(Effect.never));
      }),
      Effect.scoped,
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((milliseconds) =>
            writeStoppedHealth(target, new Date(milliseconds), instanceId),
          ),
          Effect.catch((failure) =>
            Effect.logWarning("could not write stopped scheduler health", { failure }),
          ),
        ),
      ),
    );
  };

  return { tick, runLoop };
};

export const scheduledFiringId = canonicalAutomationFiringId;
