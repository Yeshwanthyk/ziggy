import type { ScenarioDeclaration } from "../../tests/scenarios/registry.ts";
import type { ProcessResult, ProcessRunner } from "../../tests/testkit/boundaries.ts";
import {
  emptyRuntimeObservations,
  VERIFICATION_OBSERVATION_MARKER,
  type RuntimeObservations,
} from "../../tests/testkit/verification-observations.ts";

export interface ScenarioExecution {
  readonly id: string;
  readonly file: string;
  readonly result: "passed" | "failed";
  readonly seed: string;
  readonly schedule: string;
  readonly boundaryConfiguration: string;
  readonly observations: RuntimeObservations;
  readonly process: ProcessResult;
}

export async function executeScenarios(
  root: string,
  scenarios: ReadonlyArray<ScenarioDeclaration>,
  runner: ProcessRunner,
): Promise<ReadonlyArray<ScenarioExecution>> {
  const results: ScenarioExecution[] = [];
  for (const scenario of scenarios) {
    const process = await runner.run({
      argv: ["bun", "test", scenario.file],
      cwd: root,
      timeoutMs: 120_000,
    });
    const output = `${process.stdout}\n${process.stderr}`;
    const marker = parseObservationMarker(output, scenario.id);
    const hasTests = /\b[1-9]\d* pass\b/.test(output) || /\(pass\)/.test(output);
    const skipped = /\([Ss]kip\)|\b[1-9]\d* skip\b|\b0 pass\b/.test(output);
    const namesDeclaredFile = output.includes(scenario.file);
    const passed =
      process.exitCode === 0 &&
      !process.timedOut &&
      hasTests &&
      !skipped &&
      namesDeclaredFile &&
      (scenario.stage !== "s1" || marker.valid);
    results.push({
      id: scenario.id,
      file: scenario.file,
      result: passed ? "passed" : "failed",
      seed: scenario.seed,
      schedule: scenario.schedule,
      boundaryConfiguration: scenario.boundaryConfiguration,
      observations: marker.observations,
      process: stripObservationMarkers(process),
    });
  }
  return results;
}

function stripObservationMarkers(process: ProcessResult): ProcessResult {
  return {
    ...process,
    stdout: stripObservationMarkerLines(process.stdout),
    stderr: stripObservationMarkerLines(process.stderr),
  };
}

function stripObservationMarkerLines(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(VERIFICATION_OBSERVATION_MARKER))
    .join("\n");
}

function parseObservationMarker(
  output: string,
  scenarioId: string,
): { readonly valid: boolean; readonly observations: RuntimeObservations } {
  const lines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(VERIFICATION_OBSERVATION_MARKER));
  if (lines.length === 0) {
    return { valid: false, observations: emptyRuntimeObservations() };
  }
  if (lines.length !== 1) {
    return { valid: false, observations: emptyRuntimeObservations() };
  }
  const line = lines[0];
  if (line === undefined || line.length > 32_768) {
    return { valid: false, observations: emptyRuntimeObservations() };
  }
  try {
    const value: unknown = JSON.parse(line.slice(VERIFICATION_OBSERVATION_MARKER.length));
    const record = requireRecord(value);
    if (record.scenarioId !== scenarioId) {
      return { valid: false, observations: emptyRuntimeObservations() };
    }
    return { valid: true, observations: decodeObservations(record.observations) };
  } catch {
    return { valid: false, observations: emptyRuntimeObservations() };
  }
}

function decodeObservations(value: unknown): RuntimeObservations {
  const record = requireRecord(value);
  requireExactKeys(record, [
    "canonicalEventTrace",
    "providerInputs",
    "faultSchedule",
    "filesystemDiffs",
  ]);
  return {
    canonicalEventTrace: requireArray(record.canonicalEventTrace, 512).map((item) => {
      const event = requireRecord(item);
      requireExactKeys(event, ["schemaVersion", "seq", "emittedAt", "eventType", "sessionId"]);
      if (event.schemaVersion !== 1) {
        throw new Error("invalid observed Session schema version");
      }
      return {
        schemaVersion: 1,
        seq: requireNonNegativeInteger(event.seq),
        emittedAt: requireString(event.emittedAt),
        eventType: requireString(event.eventType),
        sessionId: requireString(event.sessionId),
      };
    }),
    providerInputs: requireArray(record.providerInputs, 64).map((item) => {
      const input = requireRecord(item);
      requireExactKeys(input, [
        "callIndex",
        "sessionId",
        "cacheRetention",
        "provider",
        "model",
        "systemPromptCodePoints",
        "messageRoles",
        "toolNames",
      ]);
      const sessionId = input.sessionId === null ? null : requireString(input.sessionId);
      const cacheRetention = requireCacheRetention(input.cacheRetention);
      return {
        callIndex: requireNonNegativeInteger(input.callIndex),
        sessionId,
        cacheRetention,
        provider: requireString(input.provider),
        model: requireString(input.model),
        systemPromptCodePoints: requireNonNegativeInteger(input.systemPromptCodePoints),
        messageRoles: requireStringArray(input.messageRoles, 256),
        toolNames: requireStringArray(input.toolNames, 64),
      };
    }),
    faultSchedule: requireArray(record.faultSchedule, 64).map((item) => {
      const fault = requireRecord(item);
      requireExactKeys(fault, ["boundary", "point", "occurrence", "outcome"]);
      const outcome = fault.outcome;
      if (outcome !== "continued" && outcome !== "failed" && outcome !== "recovered") {
        throw new Error("invalid fault outcome");
      }
      return {
        boundary: requireString(fault.boundary),
        point: requireString(fault.point),
        occurrence: requireNonNegativeInteger(fault.occurrence),
        outcome,
      };
    }),
    filesystemDiffs: requireArray(record.filesystemDiffs, 128).map((item) => {
      const diff = requireRecord(item);
      requireExactKeys(diff, ["path", "change", "beforeDigest", "afterDigest"]);
      const change = diff.change;
      if (
        change !== "created" &&
        change !== "modified" &&
        change !== "deleted" &&
        change !== "unchanged"
      ) {
        throw new Error("invalid filesystem change");
      }
      return {
        path: requireString(diff.path),
        change,
        beforeDigest: requireNullableDigest(diff.beforeDigest),
        afterDigest: requireNullableDigest(diff.afterDigest),
      };
    }),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("observation must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function requireExactKeys(record: Record<string, unknown>, keys: ReadonlyArray<string>): void {
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new Error("observation has invalid fields");
  }
}

function requireArray(value: unknown, maximum: number): ReadonlyArray<unknown> {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("observation array is invalid or unbounded");
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("observation string is invalid or unbounded");
  }
  return value;
}

function requireStringArray(value: unknown, maximum: number): ReadonlyArray<string> {
  return requireArray(value, maximum).map(requireString);
}

function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("observation integer is invalid");
  }
  return value;
}

function requireCacheRetention(value: unknown): "none" | "short" | "long" | null {
  if (value === null || value === "none" || value === "short" || value === "long") {
    return value;
  }
  throw new Error("invalid cache retention");
}

function requireNullableDigest(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const digest = requireString(value);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("invalid fixture digest");
  }
  return digest;
}
