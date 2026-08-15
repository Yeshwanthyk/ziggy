import { Schema } from "effect";
import type {
  AutomationDefinitionProjection,
  AutomationDefinitionTransitionProjection,
} from "../application/automation-definitions";
import { AutomationRunProjection, AutomationScheduleRecord } from "../domain/automation";
import type { AutomationRunOutcome, AutomationStatusProjection } from "../domain/automation";

export const AutomationDefinitionProjectionJson = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  valid: Schema.Boolean,
  lifecycle: Schema.Literals(["active", "paused", "conflict"]),
  schedule: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  gateState: Schema.optional(Schema.Literals(["scheduled", "manual-only"])),
  message: Schema.optional(Schema.String),
});
export type AutomationDefinitionProjectionJson = typeof AutomationDefinitionProjectionJson.Type;

export const AutomationDefinitionsJson = Schema.Array(AutomationDefinitionProjectionJson);
export type AutomationDefinitionsJson = typeof AutomationDefinitionsJson.Type;

export const AutomationStatusProjectionJson = Schema.Struct({
  profilePath: Schema.String,
  observedAtMs: Schema.Finite,
  heartbeatAtMs: Schema.NullOr(Schema.Finite),
  lastTickAtMs: Schema.NullOr(Schema.Finite),
  lastTickStatus: Schema.NullOr(Schema.Literals(["ok", "error"])),
  lastTickError: Schema.NullOr(Schema.String),
  schedules: Schema.Array(AutomationScheduleRecord),
  activeRunCount: Schema.Finite,
  latestRun: Schema.NullOr(AutomationRunProjection),
  latestErrorRun: Schema.NullOr(AutomationRunProjection),
});
export type AutomationStatusProjectionJson = typeof AutomationStatusProjectionJson.Type;

export const AutomationRunsJson = Schema.Array(AutomationRunProjection);
export type AutomationRunsJson = typeof AutomationRunsJson.Type;
const encodeAutomationDefinitions = Schema.encodeSync(AutomationDefinitionsJson);
const encodeAutomationStatus = Schema.encodeSync(AutomationStatusProjectionJson);
const encodeAutomationRuns = Schema.encodeSync(AutomationRunsJson);

export const renderAutomationDefinitions = (
  definitions: ReadonlyArray<AutomationDefinitionProjection>,
): string =>
  definitions.length === 0
    ? "no automation definitions"
    : definitions
        .map((definition) =>
          definition.valid
            ? `${definition.id}\t${definition.lifecycle}\tvalid\t${definition.schedule}\t${definition.timezone}\t${definition.gateState}\t${definition.path}`
            : `${definition.id}\t${definition.lifecycle}\tinvalid\t-\t-\t-\t${definition.path}`,
        )
        .join("\n");

export const renderAutomationDefinitionsJson = (
  definitions: ReadonlyArray<AutomationDefinitionProjectionJson>,
): string => JSON.stringify(encodeAutomationDefinitions(definitions));

export const renderAutomationValidation = (
  definitions: ReadonlyArray<AutomationDefinitionProjection>,
): string =>
  definitions.length === 0
    ? "no automation definitions"
    : definitions
        .map((definition) =>
          definition.valid
            ? `${definition.path}\t${definition.lifecycle}\tvalid\t${definition.gateState}`
            : `${definition.path}\t${definition.lifecycle}\tinvalid\t${definition.message}`,
        )
        .join("\n");

export const renderAutomationTransition = (
  action: "paused" | "resumed",
  definition: AutomationDefinitionTransitionProjection,
): string => `${action} automation ${definition.id} at ${definition.path}`;

export const renderAutomationCreated = (definition: AutomationDefinitionProjection): string =>
  [
    `created automation ${definition.id} at ${definition.path}`,
    "manual-only: scheduled model calls remain blocked until you add a gate; broadcast is none",
  ].join("\n");

export interface AutomationCliResult {
  readonly exitCode: 0 | 1;
  readonly stderr: ReadonlyArray<string>;
}

export const renderAutomationOutcome = (outcome: AutomationRunOutcome): AutomationCliResult => {
  if (outcome.kind === "skipped-busy") {
    return { exitCode: 1, stderr: ["wake skipped: automation is already running"] };
  }
  if (outcome.kind === "declined") {
    return { exitCode: 0, stderr: [`wake declined: gate exited ${outcome.exitCode}`] };
  }
  if (outcome.delivery.kind === "resolution-failed") {
    return {
      exitCode: 1,
      stderr: [`wake delivery resolution failed: ${outcome.delivery.category}`],
    };
  }
  const stderr = [
    `wake delivery resolved: ${outcome.delivery.targets.length} targets`,
    ...outcome.delivery.targets.map((target) =>
      target.status === "delivered"
        ? `wake delivered: ${target.target}`
        : `wake delivery failed: ${target.target} (${target.category}, ${target.retriable ? "retriable" : "not retriable"})`,
    ),
  ];
  return {
    exitCode: outcome.delivery.targets.some((target) => target.status === "failed") ? 1 : 0,
    stderr,
  };
};

const iso = (value: number): string => new Date(value).toISOString();
const runSummary = (run: AutomationRunProjection): string =>
  `${run.runId} ${run.automationId} ${run.state} ${run.trigger} ${iso(run.recordedAtMs)}`;

export const renderAutomationStatus = (status: AutomationStatusProjection): string => {
  const heartbeat = status.heartbeatAtMs;
  const freshness =
    heartbeat === null || heartbeat > status.observedAtMs
      ? "unknown"
      : status.observedAtMs - heartbeat <= 90_000
        ? "fresh"
        : "stale";
  const invalid = status.schedules
    .filter((row) => row.definitionState === "invalid")
    .sort(
      (left, right) =>
        right.definitionObservedAtMs - left.definitionObservedAtMs ||
        left.automationId.localeCompare(right.automationId),
    )[0];
  const next = status.schedules
    .filter((row) => row.definitionState === "valid" && row.nextScheduledAtMs !== null)
    .sort(
      (left, right) =>
        (left.nextScheduledAtMs ?? 0) - (right.nextScheduledAtMs ?? 0) ||
        left.automationId.localeCompare(right.automationId),
    )[0];
  const counts = (state: "valid" | "invalid" | "deleted") =>
    status.schedules.filter((row) => row.definitionState === state).length;
  const tick =
    status.lastTickStatus === null || status.lastTickAtMs === null
      ? "unknown"
      : `${status.lastTickStatus} (${iso(status.lastTickAtMs)}${status.lastTickError === null ? "" : `; ${status.lastTickError}`})`;
  const runErrorAt =
    status.latestErrorRun?.finishedAtMs ?? status.latestErrorRun?.recordedAtMs ?? -1;
  const tickErrorAt = status.lastTickStatus === "error" ? (status.lastTickAtMs ?? -1) : -1;
  const latestError =
    status.latestErrorRun !== null && runErrorAt >= tickErrorAt
      ? `${status.latestErrorRun.runId} ${status.latestErrorRun.automationId} ${status.latestErrorRun.state} ${status.latestErrorRun.failureCategory ?? "-"}`
      : tickErrorAt >= 0
        ? `tick ${iso(tickErrorAt)} ${status.lastTickError}`
        : "none";
  return [
    `profile: ${status.profilePath}`,
    `scheduler: ${freshness === "fresh" ? "active" : freshness}`,
    `heartbeat: ${freshness}${heartbeat === null || freshness === "unknown" ? "" : ` (${iso(heartbeat)})`}`,
    `tick: ${tick}`,
    `definitions: ${counts("valid")} valid, ${counts("invalid")} invalid, ${counts("deleted")} deleted`,
    `definition error: ${invalid === undefined ? "none" : `${invalid.automationId} ${iso(invalid.definitionObservedAtMs)} ${invalid.definitionError}`}`,
    `next due: ${next?.nextScheduledAtMs === null || next === undefined ? "none" : `${iso(next.nextScheduledAtMs)} (${next.automationId})`}`,
    `active runs: ${status.activeRunCount}`,
    `latest run: ${status.latestRun === null ? "none" : runSummary(status.latestRun)}`,
    `latest error: ${latestError}`,
  ].join("\n");
};

export const renderAutomationStatusJson = (status: AutomationStatusProjectionJson): string =>
  JSON.stringify(encodeAutomationStatus(status));

export const renderAutomationRuns = (
  runs: ReadonlyArray<AutomationRunProjection>,
  observedAtMs: number,
): string => {
  if (runs.length === 0) return "no automation runs";
  const lines: Array<string> = [];
  for (const run of runs) {
    const duration =
      run.startedAtMs === null ? "-" : String((run.finishedAtMs ?? observedAtMs) - run.startedAtMs);
    lines.push(
      `${run.runId} ${run.automationId} ${run.state} ${run.trigger} scheduled ${run.scheduledForMs === null ? "-" : iso(run.scheduledForMs)} through ${run.missedThroughMs === null ? "-" : iso(run.missedThroughMs)} recorded ${iso(run.recordedAtMs)} started ${run.startedAtMs === null ? "-" : iso(run.startedAtMs)} duration ${duration} reason ${run.failureCategory ?? "-"} local ${run.localCompleted ? "completed" : "-"}`,
    );
    if (run.targets.length === 0) lines.push("  delivery none");
    else
      for (const target of run.targets)
        lines.push(
          `  delivery ${target.target} ${target.status} reason ${target.failureCategory ?? "-"} retriable ${target.retriable === null ? "-" : String(target.retriable)}`,
        );
  }
  return lines.join("\n");
};

export const renderAutomationRunsJson = (runs: ReadonlyArray<AutomationRunsJson[number]>): string =>
  JSON.stringify(encodeAutomationRuns(runs));
