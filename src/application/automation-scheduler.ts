import { Clock, Context, Cron, Deferred, Duration, Effect, Layer, Result, Scope } from "effect";
import {
  commitScheduleTick,
  discoverAutomationSources,
  initializeAutomationDatabase,
  readAutomationRuns,
  readAutomationStatus,
  readScheduleRecords,
  recordDefinitionTickFailure,
  recoverAutomationRuns,
  type ScheduleCommitResult,
  type ScheduleMutation,
  validateAutomationProjectionProfile,
} from "../adapters/bun/automation-sqlite";
import {
  type Automation,
  AutomationDatabaseError,
  AutomationProjectionError,
  AutomationSchedulerError,
  type AutomationId,
  type AutomationRunProjection,
  type AutomationScheduleRecord,
  type AutomationStatusProjection,
  automationScheduleFingerprint,
  boundAutomationText,
  missedRunId,
  parseAutomationFile,
  scheduledRunId,
  validateAutomationId,
} from "../domain/automation";
import type { ProfileTarget } from "../domain/profile";
import { Automations, type AutomationsShape } from "./automations";

// oxfmt-ignore
export interface AutomationSchedulerShape { readonly run: (target: ProfileTarget) => Effect.Effect<never, AutomationSchedulerError>; readonly status: (target: ProfileTarget) => Effect.Effect<AutomationStatusProjection, AutomationProjectionError>; readonly runs: (target: ProfileTarget, automationId?: AutomationId) => Effect.Effect<ReadonlyArray<AutomationRunProjection>, AutomationProjectionError> }
// oxfmt-ignore
export class AutomationScheduler extends Context.Service<AutomationScheduler, AutomationSchedulerShape>()("ziggy/AutomationScheduler") {}
// oxfmt-ignore
interface ValidObservation { readonly id: AutomationId; readonly automation: Automation; readonly fingerprint: string }
type Observation =
  | { readonly kind: "valid"; readonly idSource: string; readonly valid: ValidObservation }
  | { readonly kind: "invalid"; readonly idSource: string; readonly error: string };

const discover = (target: ProfileTarget) =>
  Effect.gen(function* () {
    const sources = yield* discoverAutomationSources(target);
    const observations: Array<Observation> = [];
    for (const source of sources) {
      if (source.source === null) {
        observations.push({
          kind: "invalid",
          idSource: source.idSource,
          error: boundAutomationText(source.error ?? "automation definition unreadable"),
        });
        continue;
      }
      const sourceText = source.source;
      const parsed = yield* Effect.gen(function* () {
        const id = yield* validateAutomationId(source.idSource);
        const automation = yield* parseAutomationFile(id, source.path, sourceText);
        return {
          id,
          automation,
          fingerprint: automationScheduleFingerprint(automation),
        } satisfies ValidObservation;
      }).pipe(Effect.result);
      observations.push(
        Result.isSuccess(parsed)
          ? { kind: "valid", idSource: source.idSource, valid: parsed.success }
          : {
              kind: "invalid",
              idSource: source.idSource,
              error: boundAutomationText(parsed.failure.message),
            },
      );
    }
    return observations;
  });

// oxfmt-ignore
const cronMs = { next: (automation: Automation, afterMs: number): number => Cron.next(automation.schedule.cron, new Date(afterMs)).getTime(), previous: (automation: Automation, atOrBeforeMs: number): number => Cron.match(automation.schedule.cron, new Date(atOrBeforeMs)) ? Math.floor(atOrBeforeMs / 1_000) * 1_000 : Cron.prev(automation.schedule.cron, new Date(atOrBeforeMs)).getTime() };

// oxfmt-ignore
const invalidSchedule = (previous: AutomationScheduleRecord | undefined, id: string, error: string, observedAtMs: number): AutomationScheduleRecord => ({ automationId: id, definitionState: "invalid", scheduleFingerprint: previous?.scheduleFingerprint ?? null, nextScheduledAtMs: previous?.definitionState === "deleted" ? null : previous?.nextScheduledAtMs ?? null, definitionObservedAtMs: observedAtMs, definitionError: error });

// oxfmt-ignore
const validMutation = (previous: AutomationScheduleRecord | undefined, observation: ValidObservation, observedAtMs: number, startup: boolean): ScheduleMutation => {
  const { automation, fingerprint, id } = observation;
  const base = { automationId: id, definitionState: "valid" as const, scheduleFingerprint: fingerprint, definitionObservedAtMs: observedAtMs, definitionError: null };
  const reset = previous === undefined || previous.definitionState === "deleted" || previous.scheduleFingerprint !== fingerprint || previous.nextScheduledAtMs === null;
  if (reset) return { expected: previous ?? null, next: { ...base, nextScheduledAtMs: cronMs.next(automation, observedAtMs) } };
  const cursor = previous.nextScheduledAtMs;
  if (cursor > observedAtMs) return { expected: previous, next: { ...base, nextScheduledAtMs: cursor } };
  const second = cronMs.next(automation, cursor);
  if (startup || previous.definitionState === "invalid" || second <= observedAtMs) {
    const last = cronMs.previous(automation, observedAtMs);
    return { expected: previous, next: { ...base, nextScheduledAtMs: cronMs.next(automation, observedAtMs) }, occurrence: { kind: "missed", runId: missedRunId(id, fingerprint, cursor, last), scheduledForMs: cursor, missedThroughMs: last, scheduleFingerprint: fingerprint } };
  }
  return { expected: previous, next: { ...base, nextScheduledAtMs: second }, occurrence: { kind: "due", runId: scheduledRunId(id, cursor), scheduledForMs: cursor, missedThroughMs: null, scheduleFingerprint: fingerprint } };
};

const proposals = (
  current: ReadonlyArray<AutomationScheduleRecord>,
  observations: ReadonlyArray<Observation>,
  observedAtMs: number,
  startup: boolean,
): ReadonlyArray<ScheduleMutation> => {
  const previous = new Map(current.map((row) => [row.automationId, row]));
  const seen = new Set<string>();
  const mutations: Array<ScheduleMutation> = [];
  for (const observation of observations) {
    seen.add(observation.idSource);
    const before = previous.get(observation.idSource);
    mutations.push(
      observation.kind === "valid"
        ? validMutation(before, observation.valid, observedAtMs, startup)
        : {
            expected: before ?? null,
            next: invalidSchedule(before, observation.idSource, observation.error, observedAtMs),
          },
    );
  }
  for (const before of current)
    if (!seen.has(before.automationId) && before.definitionState !== "deleted")
      mutations.push({
        expected: before,
        next: {
          automationId: before.automationId,
          definitionState: "deleted",
          scheduleFingerprint: before.scheduleFingerprint,
          nextScheduledAtMs: null,
          definitionObservedAtMs: observedAtMs,
          definitionError: null,
        },
      });
  // oxfmt-ignore
  return mutations.sort((left, right) => (left.occurrence?.scheduledForMs ?? Number.MAX_SAFE_INTEGER) - (right.occurrence?.scheduledForMs ?? Number.MAX_SAFE_INTEGER) || left.next.automationId.localeCompare(right.next.automationId));
};

const schedulerFailure = (operation: string, cause: unknown) =>
  new AutomationSchedulerError({
    operation,
    message: `automation scheduler failed to ${operation}`,
    cause,
  });

type ScanResult =
  | { readonly kind: "committed"; readonly result: ScheduleCommitResult }
  | { readonly kind: "definitions-unreadable"; readonly retryAtMs: number };

type ScheduleClaim = ScheduleCommitResult["claimed"][number];
export interface AutomationSchedulerRuntime {
  readonly afterScheduleCommit: (result: ScheduleCommitResult) => Effect.Effect<void>;
  readonly afterWorkerRegistered: (claim: ScheduleClaim) => Effect.Effect<void>;
}

const liveSchedulerRuntime: AutomationSchedulerRuntime = {
  afterScheduleCommit: () => Effect.void,
  afterWorkerRegistered: () => Effect.void,
};

type RestoreInterruptibility = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
type RegisterClaims = (
  result: ScheduleCommitResult,
  restore: RestoreInterruptibility,
) => Effect.Effect<void, never, Scope.Scope>;

const scan = (
  target: ProfileTarget,
  atMs: number,
  startup: boolean,
  runtime: AutomationSchedulerRuntime,
  registerClaims: RegisterClaims,
) =>
  Effect.gen(function* () {
    yield* recoverAutomationRuns(target.path, atMs);
    const observations = yield* discover(target).pipe(Effect.result);
    if (Result.isFailure(observations)) {
      yield* recordDefinitionTickFailure(target.path, atMs);
      return {
        kind: "definitions-unreadable",
        retryAtMs: atMs + 60_000,
      } satisfies ScanResult;
    }
    const current = yield* readScheduleRecords(target.path);
    const result = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const committed = yield* commitScheduleTick(
          target.path,
          atMs,
          proposals(current, observations.success, atMs, startup),
        );
        yield* runtime.afterScheduleCommit(committed);
        yield* registerClaims(committed, restore);
        return committed;
      }),
    );
    return { kind: "committed", result } satisfies ScanResult;
  });

export const makeAutomationScheduler = (
  automations: AutomationsShape,
  runtime: AutomationSchedulerRuntime = liveSchedulerRuntime,
): AutomationSchedulerShape => {
  const run = (target: ProfileTarget): Effect.Effect<never, AutomationSchedulerError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const startupAt = yield* Clock.currentTimeMillis;
        yield* initializeAutomationDatabase(target.path);
        const fatal = yield* Deferred.make<never, AutomationDatabaseError>();
        const registerClaims: RegisterClaims = (result, restore) =>
          Effect.gen(function* () {
            for (const claim of result.claimed) {
              const worker = automations
                .run(target, claim.automationId, {
                  kind: "scheduled",
                  scheduledFor: new Date(claim.scheduledForMs).toISOString(),
                  scheduleFingerprint: claim.scheduleFingerprint,
                })
                .pipe(
                  Effect.catchTag("AutomationDatabaseError", (failure) =>
                    Deferred.fail(fatal, failure).pipe(Effect.asVoid),
                  ),
                  Effect.catch(() => Effect.void),
                );
              yield* restore(worker).pipe(Effect.forkScoped);
              yield* runtime.afterWorkerRegistered(claim);
            }
          });
        let initial = yield* scan(target, startupAt, true, runtime, registerClaims);
        while (initial.kind === "committed" && initial.result.stale)
          initial = yield* scan(
            target,
            yield* Clock.currentTimeMillis,
            true,
            runtime,
            registerClaims,
          );
        let retryAtMs = initial.kind === "definitions-unreadable" ? initial.retryAtMs : null;

        const cycle = Effect.gen(function* () {
          const schedules = yield* readScheduleRecords(target.path);
          const now = yield* Clock.currentTimeMillis;
          const earliest = schedules
            .flatMap((row) =>
              row.definitionState === "valid" && row.nextScheduledAtMs !== null
                ? [row.nextScheduledAtMs]
                : [],
            )
            .sort((left, right) => left - right)[0];
          yield* Effect.sleep(
            Duration.millis(
              retryAtMs === null
                ? earliest === undefined
                  ? 60_000
                  : Math.min(60_000, Math.max(0, earliest - now))
                : Math.max(0, retryAtMs - now),
            ),
          );
          let scanResult = yield* scan(
            target,
            yield* Clock.currentTimeMillis,
            false,
            runtime,
            registerClaims,
          );
          while (scanResult.kind === "committed" && scanResult.result.stale)
            scanResult = yield* scan(
              target,
              yield* Clock.currentTimeMillis,
              false,
              runtime,
              registerClaims,
            );
          retryAtMs = scanResult.kind === "definitions-unreadable" ? scanResult.retryAtMs : null;
        });
        return yield* Effect.raceFirst(Effect.forever(cycle), Deferred.await(fatal));
      }).pipe(Effect.mapError((cause) => schedulerFailure("run", cause))),
    );

  return {
    run,
    status: (target) =>
      Effect.gen(function* () {
        yield* validateAutomationProjectionProfile(target);
        return yield* readAutomationStatus(target.path, yield* Clock.currentTimeMillis);
      }),
    runs: (target, automationId) =>
      Effect.gen(function* () {
        yield* validateAutomationProjectionProfile(target);
        return yield* readAutomationRuns(target.path, automationId);
      }),
  };
};

export const AutomationSchedulerLive = Layer.effect(
  AutomationScheduler,
  Effect.gen(function* () {
    const automations = yield* Automations;
    return makeAutomationScheduler(automations);
  }),
);
