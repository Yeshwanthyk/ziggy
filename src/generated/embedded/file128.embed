/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Save validation failures become Pi tool failures. */
/* oxlint-disable ziggy/no-unknown-parameters, ziggy/no-runtime-typeof, ziggy/no-known-value-widening -- Stable canonical JSON is an internal hash serializer over already schema-decoded domain values. */
/* oxlint-disable ziggy/require-readable-spacing -- Hash and proof predicates remain adjacent for auditability. */
import { createHash } from "node:crypto";
import { Parse } from "typebox/value";
import {
  WorkflowSaveCandidateSchema,
  WorkflowSaveProofSchema,
  type RunSummary,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowSaveCandidate,
  type WorkflowSaveProof,
} from "./schema.ts";
import { compileExecutionPlan } from "./execution-plan.ts";
import { resolveWorkflowTemplates, validateWorkflowDefinition } from "./workflows.ts";

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

const workflowHash = (workflow: WorkflowDefinition): string =>
  createHash("sha256").update(stableJson(workflow)).digest("hex");

const same = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);

const optimizeWorkflow = (
  source: WorkflowDefinition,
): {
  readonly workflow: WorkflowDefinition;
  readonly removedRedundantObservations: number;
  readonly removedRedundantRootLookups: number;
} => {
  const steps: WorkflowDefinition["steps"][number][] = [];
  let removedRedundantObservations = 0;
  let removedRedundantRootLookups = 0;

  for (const step of source.steps) {
    const prior = steps.at(-1);
    if (step.kind === "observe" && prior?.kind === "observe" && same(step, prior)) {
      removedRedundantObservations += 1;
      continue;
    }
    if (step.kind === "find_roots" && prior?.kind === "find_roots" && same(step, prior)) {
      removedRedundantRootLookups += 1;
      continue;
    }
    steps.push(step);
  }

  return {
    workflow: validateWorkflowDefinition({ ...source, steps }),
    removedRedundantObservations,
    removedRedundantRootLookups,
  };
};

const observableSteps = (workflow: WorkflowDefinition): readonly unknown[] => {
  const normalized: unknown[] = [];
  for (const step of workflow.steps) {
    if (step.kind === "observe") continue;
    const prior = normalized.at(-1);
    if (step.kind === "find_roots" && prior !== undefined && same(step, prior)) continue;
    normalized.push(step);
  }
  return normalized;
};

export const makeWorkflowSaveCandidate = (input: {
  readonly workflow: unknown;
  readonly sourceDraftId: string;
  readonly baseRevision?: string;
  readonly bindings: Readonly<Record<string, string>>;
  readonly draft: WorkflowDraft;
  readonly now?: Date;
}): WorkflowSaveCandidate => {
  const source = validateWorkflowDefinition(input.workflow);
  const optimized = optimizeWorkflow(source);
  const sourceObservable = observableSteps(source);
  const candidateObservable = observableSteps(optimized.workflow);

  if (!same(sourceObservable, candidateObservable)) {
    throw new Error("Workflow optimization changed an action, checkpoint, or durable root lookup.");
  }

  const compiled = compileExecutionPlan(optimized.workflow);
  const resolved = resolveWorkflowTemplates(optimized.workflow, input.bindings);
  const finalCheckpoint = resolved.steps
    .toReversed()
    .map((step) =>
      step.kind === "wait" ? step.condition : "checkpoint" in step ? step.checkpoint : undefined,
    )
    .find((checkpoint) => checkpoint !== undefined);
  if (finalCheckpoint === undefined)
    throw new Error("A saved workflow requires a final observable checkpoint.");

  const sameCondition = (condition: {
    readonly text?: string;
    readonly role?: string;
    readonly until?: "present" | "absent";
  }) =>
    condition.text === finalCheckpoint.text &&
    condition.role === finalCheckpoint.role &&
    (condition.until ?? "present") === finalCheckpoint.until;
  const finalRecordedOutcome = input.draft.calls
    .toReversed()
    .find(
      (call) =>
        call.input.kind === "wait_for" ||
        call.input.kind === "semantic_segment" ||
        (call.input.kind === "safe_actions" && call.input.expect !== undefined),
    );
  const trailingCalls =
    finalRecordedOutcome === undefined
      ? input.draft.calls
      : input.draft.calls.filter((call) => call.sequence > finalRecordedOutcome.sequence);
  const safeAfterTerminalOutcome = trailingCalls.every(
    (call) =>
      call.outcome === "success" &&
      (call.input.kind === "find_roots" ||
        call.input.kind === "observe_ui" ||
        call.input.kind === "search_ui" ||
        call.toolName === "expand_ui" ||
        call.toolName === "inspect_ui" ||
        call.toolName === "read_text" ||
        call.toolName === "close_browser"),
  );
  const hasPendingSourceCall = input.draft.issues.some((issue) =>
    issue.includes("had not completed when recording stopped"),
  );
  const recordedFinalPassed = (() => {
    if (finalRecordedOutcome?.outcome !== "success") return false;
    if (finalRecordedOutcome.input.kind === "wait_for")
      return sameCondition(finalRecordedOutcome.input);
    if (
      finalRecordedOutcome.input.kind === "safe_actions" &&
      finalRecordedOutcome.input.expect !== undefined
    )
      return sameCondition(finalRecordedOutcome.input.expect);
    if (finalRecordedOutcome.input.kind === "semantic_segment") {
      const final = finalRecordedOutcome.input.steps.at(-1);
      return final !== undefined && sameCondition("assert" in final ? final.assert : final.expect);
    }
    return false;
  })();
  if (!recordedFinalPassed || !safeAfterTerminalOutcome || hasPendingSourceCall) {
    throw new Error(
      "The candidate final checkpoint is not the terminal successful recorded task outcome.",
    );
  }
  return Parse(WorkflowSaveCandidateSchema, {
    format: "ziggy-workflow-save-candidate",
    formatVersion: 1,
    id: crypto.randomUUID(),
    candidateHash: workflowHash(optimized.workflow),
    sourceHash: workflowHash(source),
    verificationBindingsHash: createHash("sha256").update(stableJson(input.bindings)).digest("hex"),
    sourceDraftId: input.sourceDraftId,
    baseRevision: input.baseRevision ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
    workflow: optimized.workflow,
    optimization: {
      removedRedundantObservations: optimized.removedRedundantObservations,
      removedRedundantRootLookups: optimized.removedRedundantRootLookups,
      segmentCount: compiled.segments.length,
    },
  });
};

export const proveWorkflowSaveCandidate = (input: {
  readonly candidate: WorkflowSaveCandidate;
  readonly summary: RunSummary;
  readonly now?: Date;
}): WorkflowSaveProof => {
  if (workflowHash(input.candidate.workflow) !== input.candidate.candidateHash) {
    throw new Error("Workflow save candidate content no longer matches its hash.");
  }
  if (
    input.summary.workflowId !== input.candidate.workflow.id ||
    input.summary.revision !== input.candidate.candidateHash
  ) {
    throw new Error("Workflow verification evidence belongs to a different candidate revision.");
  }
  if (input.summary.overall !== "passed" || input.summary.stopReason !== "completed") {
    throw new Error("Workflow verification did not pass every planned segment and checkpoint.");
  }
  if (
    input.summary.segments.planned === 0 ||
    input.summary.segments.passed !== input.summary.segments.planned ||
    input.summary.checks.length === 0 ||
    input.summary.checks.some((check) => check.outcome !== "passed")
  ) {
    throw new Error("Workflow verification evidence is incomplete.");
  }

  return Parse(WorkflowSaveProofSchema, {
    format: "ziggy-workflow-save-proof",
    formatVersion: 1,
    id: crypto.randomUUID(),
    candidateId: input.candidate.id,
    candidateHash: input.candidate.candidateHash,
    runSummaryId: input.summary.id,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    outcome: "passed",
  });
};
