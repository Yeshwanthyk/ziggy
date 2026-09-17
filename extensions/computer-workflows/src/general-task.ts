/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Task boundary failures become Pi tool failures. */
/* oxlint-disable ziggy/no-runtime-typeof, ziggy/no-unknown-parameters -- Canonical hashing accepts schema-decoded domain values only. */
/* oxlint-disable ziggy/require-readable-spacing -- Validation predicates remain adjacent for auditability. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Artifact verification is the bounded filesystem evidence adapter. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread, ziggy/no-known-value-widening -- Exact optional candidate fields and resolved input evidence are preserved. */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Parse } from "typebox/value";
import {
  GeneralTaskCandidateSchema,
  GeneralTaskDefinitionSchema,
  GeneralTaskRunSchema,
  type GeneralTaskCandidate,
  type GeneralTaskDefinition,
  type GeneralTaskRun,
} from "./schema.ts";

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const validateGeneralTask = (value: unknown): GeneralTaskDefinition => {
  const task = Parse(GeneralTaskDefinitionSchema, value);
  const inputIds = new Set<string>();
  for (const input of task.inputs) {
    if (inputIds.has(input.id)) throw new Error(`Duplicate task input '${input.id}'.`);
    inputIds.add(input.id);
  }
  if (task.startContext.urlInput !== undefined && !inputIds.has(task.startContext.urlInput)) {
    throw new Error(
      `Browser start context references unknown input '${task.startContext.urlInput}'.`,
    );
  }
  if (task.startContext.kind === "browser" && task.startContext.browserProfile === undefined) {
    throw new Error("Browser tasks require a named browserProfile.");
  }
  const criterionIds = new Set<string>();
  for (const criterion of task.completionCriteria) {
    if (criterionIds.has(criterion.id)) throw new Error(`Duplicate criterion '${criterion.id}'.`);
    criterionIds.add(criterion.id);
  }
  return task;
};

export const makeGeneralTaskCandidate = (input: {
  readonly task: unknown;
  readonly sourceDraftId: string;
  readonly baseRevision?: string;
  readonly now?: Date;
}): GeneralTaskCandidate => {
  const task = validateGeneralTask(input.task);
  return Parse(GeneralTaskCandidateSchema, {
    format: "ziggy-general-task-candidate",
    formatVersion: 1,
    id: crypto.randomUUID(),
    candidateHash: sha256(stableJson(task)),
    sourceDraftId: input.sourceDraftId,
    baseRevision: input.baseRevision ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
    task,
  });
};

const validateTaskInputs = (
  task: GeneralTaskDefinition,
  inputs: Readonly<Record<string, string>>,
): string => {
  const expected = task.inputs.map(({ id }) => id).toSorted();
  const actual = Object.keys(inputs).toSorted();
  if (stableJson(expected) !== stableJson(actual)) {
    throw new Error(`Task inputs must exactly match: ${expected.join(", ") || "none"}.`);
  }
  if (Object.values(inputs).some((value) => value.length === 0 || value.length > 8_192)) {
    throw new Error("Task input values must be non-empty and at most 8192 characters.");
  }
  return sha256(stableJson(inputs));
};

export const resolveTaskInputs = (
  task: GeneralTaskDefinition,
  provided: Readonly<Record<string, string>>,
): { readonly inputs: Readonly<Record<string, string>>; readonly hash: string } => {
  const resolved: Record<string, string> = {};
  const allowed = new Set(task.inputs.map(({ id }) => id));
  for (const key of Object.keys(provided)) {
    if (!allowed.has(key)) throw new Error(`Unknown task input '${key}'.`);
  }
  for (const declaration of task.inputs) {
    const value = provided[declaration.id] ?? declaration.default;
    if (value === undefined) throw new Error(`Missing required task input '${declaration.id}'.`);
    resolved[declaration.id] = value;
  }
  return { inputs: resolved, hash: validateTaskInputs(task, resolved) };
};

export const makeGeneralTaskRun = (input: {
  readonly task: GeneralTaskDefinition;
  readonly revision: string;
  readonly candidateId?: string;
  readonly mode: "verification" | "run";
  readonly sessionId: string;
  readonly inputsHash: string;
  readonly now?: Date;
}): GeneralTaskRun => {
  const timestamp = (input.now ?? new Date()).toISOString();
  return Parse(GeneralTaskRunSchema, {
    format: "ziggy-general-task-run",
    formatVersion: 1,
    id: crypto.randomUUID(),
    taskId: input.task.id,
    ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
    revision: input.revision,
    mode: input.mode,
    sessionId: input.sessionId,
    inputsHash: input.inputsHash,
    startedAt: timestamp,
    updatedAt: timestamp,
    state: "active",
    calls: [],
    criteria: [],
  });
};

type CriterionSubmission = {
  readonly criterionId: string;
  readonly outcome: "passed" | "failed";
  readonly toolCallIds?: readonly string[];
  readonly artifactPaths?: readonly string[];
  readonly assessment?: string;
};

const verifyArtifact = async (cwd: string, path: string, startedAt: string) => {
  const absolute = resolve(cwd, path);
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Artifact '${path}' is not a regular file.`);
    if (before.size > 512 * 1024 * 1024)
      throw new Error(`Artifact '${path}' exceeds the 512 MiB evidence limit.`);
    if (before.mtimeMs < Date.parse(startedAt))
      throw new Error(`Artifact '${path}' predates this run.`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    )
      throw new Error(`Artifact '${path}' changed while evidence was collected.`);
    return {
      path: absolute,
      size: before.size,
      sha256: hash.digest("hex"),
      modifiedAt: before.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
};

export const finishGeneralTaskRun = async (input: {
  readonly cwd: string;
  readonly task: GeneralTaskDefinition;
  readonly run: GeneralTaskRun;
  readonly criteria: readonly CriterionSubmission[];
  readonly now?: Date;
}): Promise<GeneralTaskRun> => {
  if (input.run.state !== "active") throw new Error("Only an active task run can finish.");
  const expectedIds = input.task.completionCriteria.map(({ id }) => id).toSorted();
  const submittedIds = input.criteria.map(({ criterionId }) => criterionId).toSorted();
  if (stableJson(expectedIds) !== stableJson(submittedIds)) {
    throw new Error("Every completion criterion must be covered exactly once.");
  }
  const successfulCalls = new Set(
    input.run.calls
      .filter(({ status }) => status === "succeeded")
      .map(({ toolCallId }) => toolCallId),
  );
  const observedCalls = new Set(input.run.calls.map(({ toolCallId }) => toolCallId));
  const evidence = [];
  for (const criterion of input.task.completionCriteria) {
    const submission = input.criteria.find(({ criterionId }) => criterionId === criterion.id);
    if (submission === undefined) throw new Error(`Missing criterion '${criterion.id}'.`);
    const toolCallIds = [...(submission.toolCallIds ?? [])];
    if (toolCallIds.some((id) => !observedCalls.has(id))) {
      throw new Error(`Criterion '${criterion.id}' references a tool call outside this run.`);
    }
    if (criterion.evidence === "tool-result") {
      if (submission.assessment === undefined)
        throw new Error(
          `Criterion '${criterion.id}' requires an assessment of what the tool result establishes.`,
        );
      if (
        toolCallIds.length === 0 ||
        (submission.outcome === "passed" && toolCallIds.some((id) => !successfulCalls.has(id)))
      ) {
        throw new Error(
          `Criterion '${criterion.id}' requires observed tool results from this run.`,
        );
      }
      evidence.push({ ...submission, toolCallIds, evidenceLabel: "observed-tool-result" as const });
    } else if (criterion.evidence === "artifact") {
      const paths = submission.artifactPaths ?? [];
      if (submission.assessment === undefined) {
        throw new Error(
          `Criterion '${criterion.id}' requires an agent assessment of artifact semantics.`,
        );
      }
      if (submission.outcome === "failed") {
        evidence.push({
          ...submission,
          toolCallIds,
          artifactPaths: paths,
          artifacts: [],
          evidenceLabel: "agent-assessed" as const,
        });
        continue;
      }
      if (paths.length === 0) throw new Error(`Criterion '${criterion.id}' requires an artifact.`);
      const artifacts = await Promise.all(
        paths.map(async (path) => await verifyArtifact(input.cwd, path, input.run.startedAt)),
      );
      evidence.push({
        ...submission,
        toolCallIds,
        artifactPaths: paths,
        artifacts,
        evidenceLabel: "verified-artifact" as const,
      });
    } else {
      if (submission.assessment === undefined) {
        throw new Error(`Criterion '${criterion.id}' requires an explicit agent assessment.`);
      }
      evidence.push({ ...submission, toolCallIds, evidenceLabel: "agent-assessed" as const });
    }
  }
  const unresolved = input.run.calls.some(
    ({ status }) => status === "pending" || status === "unknown",
  );
  const failed = evidence.some(({ outcome }) => outcome === "failed");
  return Parse(GeneralTaskRunSchema, {
    ...input.run,
    updatedAt: (input.now ?? new Date()).toISOString(),
    state: unresolved ? "incomplete" : failed ? "failed" : "passed",
    criteria: evidence,
  });
};

export const cancelGeneralTaskRun = (run: GeneralTaskRun, now = new Date()): GeneralTaskRun =>
  Parse(GeneralTaskRunSchema, {
    ...run,
    updatedAt: now.toISOString(),
    state: "cancelled",
    calls: run.calls.map((call) =>
      call.status === "pending" ? { ...call, status: "unknown" as const } : call,
    ),
  });
