/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Invalid observed tool events fail the active evidence run closed. */
/* oxlint-disable ziggy/no-unsafe-dictionary-type, ziggy/no-unknown-parameters -- Pi custom-tool inputs and result details are unknown at the event boundary and are immediately strictly decoded. */
import { Type } from "typebox";
import { Equal, Parse } from "typebox/value";
import type { CompiledWorkflowExecution, WorkflowExecutionPlan } from "./execution-plan.ts";
import type { RunRecord, RunSummary } from "./schema.ts";

const RootQuerySchema = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    app: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    kind: Type.Optional(
      Type.Union([
        Type.Literal("window"),
        Type.Literal("menu"),
        Type.Literal("sheet"),
        Type.Literal("popover"),
        Type.Literal("dialog"),
        Type.Literal("browser_page"),
      ]),
    ),
  },
  { additionalProperties: false },
);
const TargetSchema = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
const ConditionSchema = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    until: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
  },
  { additionalProperties: false },
);
const ActionSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("click"),
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]),
      ),
      clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("keypress"),
      keys: Type.Array(Type.String({ pattern: "^[A-Za-z0-9+_-]{1,32}$" }), {
        minItems: 1,
        maxItems: 20,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("scroll"),
      scrollX: Type.Optional(Type.Number({ minimum: -20_000, maximum: 20_000 })),
      scrollY: Type.Optional(Type.Number({ minimum: -20_000, maximum: 20_000 })),
    },
    { additionalProperties: false },
  ),
]);
const SegmentStepSchema = Type.Union([
  Type.Object(
    {
      target: TargetSchema,
      actions: Type.Array(ActionSchema, { minItems: 1, maxItems: 20 }),
      expect: ConditionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object({ assert: ConditionSchema }, { additionalProperties: false }),
]);
const SegmentInputSchema = Type.Object(
  {
    rootQuery: Type.Optional(RootQuerySchema),
    steps: Type.Array(SegmentStepSchema, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);
const SegmentResultDetailsSchema = Type.Object(
  {
    tool: Type.Literal("run_ui_segment"),
    status: Type.Literal("completed"),
    completed: Type.Array(
      Type.Union([
        Type.Object(
          {
            step: Type.Integer({ minimum: 1, maximum: 20 }),
            stateId: Type.String({ minLength: 1, maxLength: 256 }),
            ref: Type.String({ minLength: 1, maxLength: 128 }),
            actionCount: Type.Integer({ minimum: 1, maximum: 20 }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            step: Type.Integer({ minimum: 1, maximum: 20 }),
            stateId: Type.String({ minLength: 1, maxLength: 256 }),
            kind: Type.Literal("assert"),
            actionCount: Type.Literal(0),
          },
          { additionalProperties: false },
        ),
      ]),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

type SegmentOutcome = "passed" | "failed";

export interface ActiveWorkflowRun {
  readonly record: RunRecord;
  readonly plan: CompiledWorkflowExecution;
  readonly pending: Map<string, number>;
  readonly outcomes: Map<number, SegmentOutcome>;
  nextSegment: number;
  mismatch: boolean;
  failure: "tool-error" | "invalid-result" | undefined;
}

export const startActiveRun = (
  record: RunRecord,
  plan: CompiledWorkflowExecution,
): ActiveWorkflowRun => ({
  record,
  plan,
  pending: new Map(),
  outcomes: new Map(),
  nextSegment: 0,
  mismatch: false,
  failure: undefined,
});

export const observeRunToolCall = (
  run: ActiveWorkflowRun,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
  },
): void => {
  if (event.toolName !== "run_ui_segment") return;
  const planned = run.plan.segments[run.nextSegment];
  if (planned === undefined || run.pending.has(event.toolCallId)) {
    run.mismatch = true;
    return;
  }
  try {
    const actual = Parse(SegmentInputSchema, event.input);
    const expected = Parse(SegmentInputSchema, planned.input);
    if (!Equal(actual, expected)) {
      run.mismatch = true;
      return;
    }
  } catch {
    run.mismatch = true;
    return;
  }
  run.pending.set(event.toolCallId, run.nextSegment);
  run.nextSegment += 1;
};

const validCompletedSteps = (details: unknown, planned: WorkflowExecutionPlan): boolean => {
  try {
    const decoded = Parse(SegmentResultDetailsSchema, details);
    return (
      decoded.completed.length === planned.input.steps.length &&
      decoded.completed.every((entry, index) => entry.step === index + 1)
    );
  } catch {
    return false;
  }
};

export const observeRunToolResult = (
  run: ActiveWorkflowRun,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly details: unknown;
  },
): void => {
  if (event.toolName !== "run_ui_segment") return;
  const segmentIndex = run.pending.get(event.toolCallId);
  if (segmentIndex === undefined) return;
  run.pending.delete(event.toolCallId);
  const planned = run.plan.segments[segmentIndex];
  if (planned === undefined) {
    run.mismatch = true;
    return;
  }
  if (event.isError) {
    run.outcomes.set(segmentIndex, "failed");
    run.failure ??= "tool-error";
    return;
  }
  if (!validCompletedSteps(event.details, planned)) {
    run.outcomes.set(segmentIndex, "failed");
    run.failure ??= "invalid-result";
    return;
  }
  run.outcomes.set(segmentIndex, "passed");
};

const expectedCondition = (step: WorkflowExecutionPlan["input"]["steps"][number]) =>
  "assert" in step ? step.assert : step.expect;

export const finishActiveRun = (run: ActiveWorkflowRun, now = new Date()): RunSummary => {
  const checks = run.plan.segments.flatMap((segment, segmentIndex) => {
    const segmentOutcome = run.outcomes.get(segmentIndex);
    return segment.input.steps.map((step, stepIndex) => ({
      sourceStep: segment.sourceSteps[stepIndex] ?? 1,
      expected: expectedCondition(step),
      outcome:
        segmentOutcome === "passed"
          ? ("passed" as const)
          : segmentOutcome === "failed"
            ? ("failed" as const)
            : ("not-run" as const),
    }));
  });
  const passed = [...run.outcomes.values()].filter((outcome) => outcome === "passed").length;
  const failed = [...run.outcomes.values()].filter((outcome) => outcome === "failed").length;
  let overall: RunSummary["overall"];
  let stopReason: RunSummary["stopReason"];
  if (run.failure !== undefined) {
    overall = "failed";
    stopReason = run.failure;
  } else if (run.mismatch) {
    overall = "incomplete";
    stopReason = "input-mismatch";
  } else if (run.plan.manual.length > 0) {
    overall = "incomplete";
    stopReason = "manual-steps";
  } else if (
    run.nextSegment < run.plan.segments.length ||
    run.pending.size > 0 ||
    run.outcomes.size < run.plan.segments.length
  ) {
    overall = "incomplete";
    stopReason = "unfinished-segments";
  } else {
    overall = "passed";
    stopReason = "completed";
  }
  return {
    format: "ziggy-computer-workflow-run-summary",
    formatVersion: 1,
    id: run.record.id,
    workflowId: run.record.workflowId,
    revision: run.record.revision,
    sessionId: run.record.sessionId,
    preparedAt: run.record.preparedAt,
    finishedAt: now.toISOString(),
    overall,
    checks,
    segments: {
      planned: run.plan.segments.length,
      matched: run.nextSegment,
      passed,
      failed,
    },
    stopReason,
  };
};
