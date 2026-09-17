/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tools and event handlers are this package's async boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Pi surfaces bounded rejected tool Promises as failures. */
/* oxlint-disable ziggy-effect/no-instanceof-error -- Pi rejects native Errors at this extension boundary. */
/* oxlint-disable ziggy/no-unknown-parameters -- Tool results serialize boundary-owned payloads only. */
/* oxlint-disable ziggy/require-readable-spacing -- Tool registrations keep each bounded operation together. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import {
  BrowserJobDefinitionSchema,
  GeneralTaskDefinitionSchema,
  WorkflowDefinitionSchema,
  WorkflowIdSchema,
  type RunRecord,
  type GeneralTaskDefinition,
  type GeneralTaskRun,
} from "./src/schema.ts";
import {
  finishRecording,
  observeToolCall,
  observeToolResult,
  startRecording,
  snapshotRecording,
  type ActiveRecording,
} from "./src/recorder.ts";
import {
  listWorkflows,
  readDraft,
  readWorkflow,
  readWorkflowIfPresent,
  writeDraft,
  writeDraftSnapshot,
  writeRunRecord,
  writeRunSummary,
  listBrowserJobs,
  readBrowserJob,
  readBrowserJobIfPresent,
  readBrowserJobBaseline,
  withBrowserJobLock,
  writeBrowserJobBaseline,
  writeBrowserJobRunReport,
  promoteVerifiedBrowserJob,
  writeSaveCandidate,
  readSaveCandidate,
  writeSaveProof,
  promoteVerifiedWorkflow,
  writeGeneralTaskCandidate,
  readGeneralTaskCandidate,
  writeGeneralTaskRun,
  readGeneralTaskRun,
  claimGeneralTaskRun,
  readGeneralTask,
  readGeneralTaskRevision,
  readGeneralTaskIfPresent,
  listGeneralTasks,
  promoteGeneralTask,
} from "./src/storage.ts";
import { resolveWorkflowTemplates } from "./src/workflows.ts";
import { compileExecutionPlan } from "./src/execution-plan.ts";
import {
  finishActiveRun,
  observeRunToolCall,
  observeRunToolResult,
  observeInterveningVerificationTool,
  startActiveRun,
  type ActiveWorkflowRun,
} from "./src/run-tracker.ts";
import { makeWorkflowSaveCandidate, proveWorkflowSaveCandidate } from "./src/save-pipeline.ts";
import {
  makeSavedBrowserJob,
  runSavedBrowserJob,
  validateBrowserJobDefinition,
} from "./src/browser-jobs.ts";
import { makeBrowserJobBridge } from "./src/browser-job-bridge.ts";
import {
  cancelGeneralTaskRun,
  finishGeneralTaskRun,
  makeGeneralTaskCandidate,
  makeGeneralTaskRun,
  resolveTaskInputs,
} from "./src/general-task.ts";

const OUTPUT_LIMIT = 32 * 1024;

const NonEmptyText = Type.String({ minLength: 1, maxLength: 1_024 });

const EmptyParameters = Type.Object({}, { additionalProperties: false });

const RecordStartParameters = Type.Object(
  { name: NonEmptyText, goal: NonEmptyText },
  { additionalProperties: false },
);

const DraftParameters = Type.Object({ draftId: WorkflowIdSchema }, { additionalProperties: false });

const PreparePublishParameters = Type.Object(
  {
    draftId: WorkflowIdSchema,
    workflow: WorkflowDefinitionSchema,
    bindings: Type.Record(WorkflowIdSchema, Type.String({ minLength: 1, maxLength: 1_024 })),
    replayMode: Type.Union([Type.Literal("read-only"), Type.Literal("reversible-test")]),
  },
  { additionalProperties: false },
);

const PublishParameters = Type.Object(
  { candidateId: WorkflowIdSchema },
  { additionalProperties: false },
);

const WorkflowParameters = Type.Object(
  {
    workflowId: WorkflowIdSchema,
    bindings: Type.Optional(
      Type.Record(WorkflowIdSchema, Type.String({ minLength: 1, maxLength: 1_024 })),
    ),
  },
  { additionalProperties: false },
);

const SaveBrowserWorkflowParameters = Type.Object(
  { workflow: BrowserJobDefinitionSchema },
  { additionalProperties: false },
);

const FinishRunParameters = Type.Object(
  { runId: WorkflowIdSchema },
  { additionalProperties: false },
);

const TaskPrepareParameters = Type.Object(
  { draftId: WorkflowIdSchema, task: GeneralTaskDefinitionSchema },
  { additionalProperties: false },
);

const TaskRunStartParameters = Type.Object(
  {
    taskId: Type.Optional(WorkflowIdSchema),
    candidateId: Type.Optional(WorkflowIdSchema),
    mode: Type.Union([Type.Literal("verification"), Type.Literal("run")]),
    inputs: Type.Record(WorkflowIdSchema, Type.String({ minLength: 1, maxLength: 8_192 })),
  },
  { additionalProperties: false },
);

const TaskRunParameters = Type.Object(
  {
    runId: WorkflowIdSchema,
    reconciliations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
            status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
            assessment: NonEmptyText,
            evidenceToolCallIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
              minItems: 1,
              maxItems: 20,
            }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
  },
  { additionalProperties: false },
);

const TaskRunResumeParameters = Type.Object(
  {
    runId: WorkflowIdSchema,
    inputs: Type.Record(WorkflowIdSchema, Type.String({ minLength: 1, maxLength: 8_192 })),
  },
  { additionalProperties: false },
);

const TaskFinishParameters = Type.Object(
  {
    runId: WorkflowIdSchema,
    criteria: Type.Array(
      Type.Object(
        {
          criterionId: WorkflowIdSchema,
          outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
          toolCallIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
          ),
          artifactPaths: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 8_192 }), { maxItems: 100 }),
          ),
          assessment: Type.Optional(NonEmptyText),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 50 },
    ),
  },
  { additionalProperties: false },
);

const TaskSaveParameters = Type.Object(
  { candidateId: WorkflowIdSchema, verificationRunId: WorkflowIdSchema },
  { additionalProperties: false },
);

const bounded = (text: string): string =>
  text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n… ${text.length - OUTPUT_LIMIT} characters omitted`;

const result = (payload: unknown) => ({
  content: [{ type: "text" as const, text: bounded(JSON.stringify(payload, null, 2)) }],
  details: payload,
});

const sessionKey = (ctx: {
  readonly cwd: string;
  readonly sessionManager: { readonly getSessionId: () => string };
}): string => `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;

const boundedFailure = (cause: unknown): Error =>
  new Error(bounded(cause instanceof Error ? cause.message : String(cause)));

export default function computerWorkflows(pi: ExtensionAPI): void {
  const active = new Map<string, ActiveRecording>();
  const rolling = new Map<string, ActiveRecording>();
  const activeRuns = new Map<string, ActiveWorkflowRun>();
  const activeSaveCandidates = new Map<string, string>();
  const taskRecordings = new Map<
    string,
    { recording: ActiveRecording; writeChain: Promise<void>; persistenceFailed: boolean }
  >();
  const activeTaskRuns = new Map<
    string,
    {
      run: GeneralTaskRun;
      task: GeneralTaskDefinition;
      recording: ActiveRecording;
      inputs: Readonly<Record<string, string>>;
      priorCalls: GeneralTaskRun["calls"];
      persistenceFailed: boolean;
      writeChain: Promise<void>;
    }
  >();

  const persistActiveTaskRun = async (
    profilePath: string,
    activeRun: typeof activeTaskRuns extends Map<string, infer Entry> ? Entry : never,
  ): Promise<void> => {
    const snapshot = activeRun.run;
    activeRun.writeChain = activeRun.writeChain.then(async () => {
      await writeGeneralTaskRun(profilePath, snapshot);
    });
    try {
      await activeRun.writeChain;
    } catch (cause) {
      activeRun.persistenceFailed = true;
      throw cause;
    }
  };

  const currentTaskCalls = (
    activeRun: typeof activeTaskRuns extends Map<string, infer Entry> ? Entry : never,
  ): GeneralTaskRun["calls"] => {
    const existing = new Map(activeRun.run.calls.map((call) => [call.toolCallId, call]));
    return [...activeRun.priorCalls, ...snapshotRecording(activeRun.recording)]
      .map((call) => {
        const prior = existing.get(call.toolCallId);
        if (prior === undefined) return call;
        if (prior.resultDigest !== undefined && prior.reconciliation !== undefined)
          return {
            ...call,
            resultDigest: prior.resultDigest,
            reconciliation: prior.reconciliation,
          };
        if (prior.resultDigest !== undefined) return { ...call, resultDigest: prior.resultDigest };
        if (prior.reconciliation !== undefined)
          return { ...call, reconciliation: prior.reconciliation };
        return call;
      })
      .toSorted((left, right) => left.sequence - right.sequence);
  };

  const clearProfileRecording = (profilePath: string): void => {
    for (const key of active.keys()) {
      if (key.startsWith(`${profilePath}\0`)) active.delete(key);
    }
    for (const key of rolling.keys()) {
      if (key.startsWith(`${profilePath}\0`)) rolling.delete(key);
    }
  };

  const clearProfileRuns = (profilePath: string): void => {
    for (const key of activeRuns.keys()) {
      if (key.startsWith(`${profilePath}\0`)) activeRuns.delete(key);
    }
    for (const key of activeSaveCandidates.keys()) {
      if (key.startsWith(`${profilePath}\0`)) activeSaveCandidates.delete(key);
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    const key = sessionKey(ctx);
    let recent = rolling.get(key);
    if (recent === undefined) {
      recent = startRecording(
        "Recent task",
        "Recent successful computer task",
        ctx.sessionManager.getSessionId(),
      );
      rolling.set(key, recent);
    }
    observeToolCall(recent, event);
    const recording = active.get(sessionKey(ctx));

    if (recording !== undefined) observeToolCall(recording, event);
    const run = activeRuns.get(sessionKey(ctx));

    if (run !== undefined) {
      if (event.toolName === "run_ui_segment") observeRunToolCall(run, event);
      else observeInterveningVerificationTool(run, event.toolName);
    }
    const scoped = taskRecordings.get(key);
    if (scoped !== undefined) {
      observeToolCall(scoped.recording, event, new Date(), true);
      scoped.writeChain = scoped.writeChain.then(async () => {
        await writeDraftSnapshot(ctx.cwd, finishRecording(scoped.recording));
      });
      try {
        await scoped.writeChain;
      } catch (cause) {
        scoped.persistenceFailed = true;
        throw cause;
      }
    }
    const taskRun = activeTaskRuns.get(key);
    if (taskRun !== undefined) {
      observeToolCall(taskRun.recording, event, new Date(), true);
      taskRun.run = {
        ...taskRun.run,
        updatedAt: new Date().toISOString(),
        calls: currentTaskCalls(taskRun),
      };
      await persistActiveTaskRun(ctx.cwd, taskRun);
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    const recent = rolling.get(sessionKey(ctx));
    if (recent !== undefined) {
      observeToolResult(recent, { ...event, input: event.input });
      if (recent.completed.length > 500) recent.completed.splice(0, recent.completed.length - 500);
    }
    const recording = active.get(sessionKey(ctx));

    if (recording !== undefined) observeToolResult(recording, { ...event, input: event.input });
    const run = activeRuns.get(sessionKey(ctx));

    if (run !== undefined) {
      observeRunToolResult(run, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        details: event.details,
      });
    }
    const scoped = taskRecordings.get(sessionKey(ctx));
    if (scoped !== undefined) {
      observeToolResult(scoped.recording, { ...event, input: event.input });
      scoped.writeChain = scoped.writeChain.then(async () => {
        await writeDraftSnapshot(ctx.cwd, finishRecording(scoped.recording));
      });
      try {
        await scoped.writeChain;
      } catch (cause) {
        scoped.persistenceFailed = true;
        throw cause;
      }
    }
    const taskRun = activeTaskRuns.get(sessionKey(ctx));
    if (taskRun !== undefined) {
      observeToolResult(taskRun.recording, { ...event, input: event.input });
      const calls = currentTaskCalls(taskRun);
      const completedCall = calls.find(({ toolCallId }) => toolCallId === event.toolCallId);
      if (completedCall !== undefined) {
        completedCall.resultDigest = createHash("sha256")
          .update(JSON.stringify(event.details ?? null))
          .digest("hex");
      }
      taskRun.run = {
        ...taskRun.run,
        updatedAt: new Date().toISOString(),
        calls,
      };
      await persistActiveTaskRun(ctx.cwd, taskRun);
    }
  });
  pi.on("session_start", (_event, ctx) => {
    clearProfileRecording(ctx.cwd);
    clearProfileRuns(ctx.cwd);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    clearProfileRecording(ctx.cwd);
    clearProfileRuns(ctx.cwd);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    clearProfileRecording(ctx.cwd);
    clearProfileRuns(ctx.cwd);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearProfileRecording(ctx.cwd);
    clearProfileRuns(ctx.cwd);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const taskRun = activeTaskRuns.get(key);
    if (taskRun !== undefined) {
      await taskRun.writeChain;
      const current = {
        ...taskRun.run,
        updatedAt: new Date().toISOString(),
        state: "incomplete" as const,
        calls: currentTaskCalls(taskRun)
          .map((call) =>
            call.status === "pending" ? { ...call, status: "unknown" as const } : call,
          )
          .toSorted((left, right) => left.sequence - right.sequence),
      };
      await writeGeneralTaskRun(ctx.cwd, current);
      activeTaskRuns.delete(key);
    }
    const scoped = taskRecordings.get(key);
    if (scoped !== undefined) {
      await scoped.writeChain;
      await writeDraftSnapshot(ctx.cwd, finishRecording(scoped.recording));
      taskRecordings.delete(key);
    }
  });

  pi.registerTool({
    name: "workflow_task_record_begin",
    label: "Begin General Task Recording",
    description:
      "Begin the full record-perform-improve-verify-save lifecycle for a general computer task executed by this agent with its normal tools.",
    parameters: RecordStartParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const key = sessionKey(ctx);
      if (taskRecordings.has(key)) throw new Error("A general task recording is already active.");
      const recording = startRecording(
        parameters.name,
        parameters.goal,
        ctx.sessionManager.getSessionId(),
      );
      const path = await writeDraftSnapshot(ctx.cwd, finishRecording(recording));
      taskRecordings.set(key, {
        recording,
        writeChain: Promise.resolve(),
        persistenceFailed: false,
      });
      return result({
        status: "recording",
        recordingId: recording.id,
        path,
        next: "Perform the task with normal tools, then call workflow_task_record_finish.",
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_record_finish",
    label: "Finish General Task Recording",
    description:
      "Finish the scoped general-task recording and persist its redacted draft, including unresolved calls.",
    parameters: EmptyParameters,
    executionMode: "sequential",
    async execute(_id, _parameters, _signal, _update, ctx) {
      const key = sessionKey(ctx);
      const activeRecording = taskRecordings.get(key);
      if (activeRecording === undefined) throw new Error("No general task recording is active.");
      if (activeRecording.persistenceFailed)
        throw new Error("General task recording persistence failed.");
      taskRecordings.delete(key);
      await activeRecording.writeChain;
      const draft = finishRecording(activeRecording.recording);
      const path = await writeDraftSnapshot(ctx.cwd, draft);
      return result({
        status: "drafted",
        draftId: draft.id,
        calls: draft.calls.length,
        issues: draft.issues,
        path,
        next: "Prepare the improved task candidate with workflow_task_prepare.",
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_prepare",
    label: "Prepare General Task",
    description:
      "Validate and hash an improved general task candidate from a redacted recent or scoped recording draft.",
    parameters: TaskPrepareParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const draft = await readDraft(ctx.cwd, parameters.draftId);
      const current = await readGeneralTaskIfPresent(ctx.cwd, parameters.task.id);
      const candidateInput = {
        task: parameters.task,
        sourceDraftId: draft.id,
      };
      const candidate = makeGeneralTaskCandidate(
        current === undefined
          ? candidateInput
          : { ...candidateInput, baseRevision: current.revision },
      );
      const path = await writeGeneralTaskCandidate(ctx.cwd, candidate);
      return result({
        status: "prepared",
        candidate,
        path,
        next: "Start a verification run with workflow_task_run_start.",
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_run_start",
    label: "Start General Task Run",
    description:
      "Start a verification or ordinary run of a pinned general task using this agent's normal tool loop.",
    parameters: TaskRunStartParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const key = sessionKey(ctx);
      if (activeTaskRuns.has(key))
        throw new Error("This session already owns an active general task run.");
      if ((parameters.taskId === undefined) === (parameters.candidateId === undefined))
        throw new Error("Specify exactly one taskId or candidateId.");
      let task: GeneralTaskDefinition;
      let revision: string;
      let candidateId: string | undefined;
      if (parameters.candidateId !== undefined) {
        if (parameters.mode !== "verification")
          throw new Error("A candidate can only start a verification run.");
        const candidate = await readGeneralTaskCandidate(ctx.cwd, parameters.candidateId);
        task = candidate.task;
        revision = candidate.candidateHash;
        candidateId = candidate.id;
      } else {
        if (parameters.mode !== "run") throw new Error("A saved task starts in run mode.");
        const taskId = parameters.taskId;
        if (taskId === undefined) throw new Error("A saved task run requires taskId.");
        const published = await readGeneralTask(ctx.cwd, taskId);
        task = published.task;
        revision = published.revision;
      }
      const resolved = resolveTaskInputs(task, parameters.inputs);
      const runInput = {
        task,
        revision,
        mode: parameters.mode,
        sessionId: ctx.sessionManager.getSessionId(),
        inputsHash: resolved.hash,
      };
      const run = makeGeneralTaskRun(
        candidateId === undefined ? runInput : { ...runInput, candidateId },
      );
      const path = await writeGeneralTaskRun(ctx.cwd, run);
      const recording = startRecording(task.name, task.goal, ctx.sessionManager.getSessionId());
      activeTaskRuns.set(key, {
        run,
        task,
        recording,
        inputs: resolved.inputs,
        priorCalls: [],
        persistenceFailed: false,
        writeChain: Promise.resolve(),
      });
      return result({
        status: "active",
        runId: run.id,
        task,
        inputs: resolved.inputs,
        revision,
        path,
        instruction:
          "Execute the flexible procedure with normal tools. Unknown or interrupted actions must be inspected before any retry. Use workflow_task_run_status for evidence IDs, then finish every criterion.",
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_run_status",
    label: "General Task Run Status",
    description:
      "Show compact observed call IDs, outcomes, and unresolved actions for a general task run.",
    parameters: TaskRunParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const activeRun = activeTaskRuns.get(sessionKey(ctx));
      let run =
        activeRun?.run.id === parameters.runId
          ? activeRun.run
          : await readGeneralTaskRun(ctx.cwd, parameters.runId);
      if ((parameters.reconciliations?.length ?? 0) > 0) {
        if (activeRun === undefined || activeRun.run.id !== run.id)
          throw new Error("Reconciliation requires the active resumed run in this session.");
        const observationTools = new Set([
          "find_roots",
          "observe_ui",
          "search_ui",
          "inspect_ui",
          "read_text",
          "wait_for",
        ]);
        for (const reconciliation of parameters.reconciliations ?? []) {
          const target = run.calls.find(
            ({ toolCallId }) => toolCallId === reconciliation.toolCallId,
          );
          if (target?.status !== "unknown")
            throw new Error(`Call '${reconciliation.toolCallId}' is not unresolved.`);
          const eligibleEvidence = new Set(
            run.calls
              .filter(
                (call) =>
                  call.status === "succeeded" &&
                  call.sequence > target.sequence &&
                  !activeRun.priorCalls.some((prior) => prior.toolCallId === call.toolCallId) &&
                  observationTools.has(call.toolName),
              )
              .map(({ toolCallId }) => toolCallId),
          );
          if (reconciliation.evidenceToolCallIds.some((id) => !eligibleEvidence.has(id)))
            throw new Error(
              `Reconciliation for '${reconciliation.toolCallId}' requires fresh successful observation calls.`,
            );
          target.status = reconciliation.status;
          target.reconciliation = {
            assessment: reconciliation.assessment,
            evidenceToolCallIds: reconciliation.evidenceToolCallIds,
          };
        }
        run = { ...run, updatedAt: new Date().toISOString() };
        activeRun.run = run;
        await persistActiveTaskRun(ctx.cwd, activeRun);
      }
      return result({
        runId: run.id,
        state: run.state,
        revision: run.revision,
        calls: run.calls.map(
          ({ toolCallId, toolName, status, resultDigest, reconciliation, issues }) => ({
            toolCallId,
            toolName,
            status,
            resultDigest,
            reconciliation,
            issues,
          }),
        ),
        criteria: run.criteria,
        persistenceFailed: activeRun?.run.id === run.id ? activeRun.persistenceFailed : undefined,
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_run_finish",
    label: "Finish General Task Run",
    description:
      "Finish all explicit criteria using evidence IDs from this exact run; semantic judgments remain labeled agent-assessed.",
    parameters: TaskFinishParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const key = sessionKey(ctx);
      const activeRun = activeTaskRuns.get(key);
      if (activeRun === undefined || activeRun.run.id !== parameters.runId)
        throw new Error("This session does not own that active task run.");
      if (activeRun.persistenceFailed)
        throw new Error("Task evidence persistence failed; this run is unverifiable.");
      activeRun.run = {
        ...activeRun.run,
        calls: currentTaskCalls(activeRun),
      };
      const finished = await finishGeneralTaskRun({
        cwd: ctx.cwd,
        task: activeRun.task,
        run: activeRun.run,
        criteria: parameters.criteria,
      });
      const path = await writeGeneralTaskRun(ctx.cwd, finished);
      activeTaskRuns.delete(key);
      return result({
        status: finished.state,
        run: finished,
        path,
        next:
          finished.mode === "verification" && finished.state === "passed"
            ? "Save this exact candidate with workflow_task_save."
            : undefined,
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_run_cancel",
    label: "Cancel General Task Run",
    description:
      "Cancel an active run while retaining pending actions as unknown so they are never blindly retried.",
    parameters: TaskRunParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const key = sessionKey(ctx);
      const activeRun = activeTaskRuns.get(key);
      if (activeRun === undefined || activeRun.run.id !== parameters.runId)
        throw new Error("This session does not own that active task run.");
      const current = {
        ...activeRun.run,
        calls: currentTaskCalls(activeRun),
      };
      const cancelled = cancelGeneralTaskRun(current);
      const path = await writeGeneralTaskRun(ctx.cwd, cancelled);
      activeTaskRuns.delete(key);
      return result({ status: "cancelled", run: cancelled, path });
    },
  });

  pi.registerTool({
    name: "workflow_task_run_resume",
    label: "Resume General Task Run",
    description:
      "Resume a cancelled or incomplete task run with the same inputs, retaining unknown actions for inspection rather than retry.",
    parameters: TaskRunResumeParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const key = sessionKey(ctx);
      if (activeTaskRuns.has(key))
        throw new Error("This session already owns an active general task run.");
      const priorSnapshot = await readGeneralTaskRun(ctx.cwd, parameters.runId);
      const task =
        priorSnapshot.candidateId === undefined
          ? (await readGeneralTaskRevision(ctx.cwd, priorSnapshot.taskId, priorSnapshot.revision))
              .task
          : (await readGeneralTaskCandidate(ctx.cwd, priorSnapshot.candidateId)).task;
      const resolved = resolveTaskInputs(task, parameters.inputs);
      if (resolved.hash !== priorSnapshot.inputsHash)
        throw new Error("Resume inputs do not match the original run.");
      const run = await claimGeneralTaskRun(
        ctx.cwd,
        parameters.runId,
        ctx.sessionManager.getSessionId(),
      );
      const recording = startRecording(task.name, task.goal, ctx.sessionManager.getSessionId());
      recording.nextSequence = Math.max(0, ...run.calls.map(({ sequence }) => sequence)) + 1;
      activeTaskRuns.set(key, {
        run,
        task,
        recording,
        inputs: resolved.inputs,
        priorCalls: run.calls,
        persistenceFailed: false,
        writeChain: Promise.resolve(),
      });
      return result({
        status: "active",
        runId: run.id,
        task,
        inputs: resolved.inputs,
        unknownCalls: run.calls.filter(({ status }) => status === "unknown"),
        instruction:
          "Inspect and reconcile unknown effects before continuing; do not retry them automatically.",
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_save",
    label: "Save Verified General Task",
    description:
      "Atomically save the exact candidate after its exact verification run passed every criterion.",
    parameters: TaskSaveParameters,
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      const candidate = await readGeneralTaskCandidate(ctx.cwd, parameters.candidateId);
      const verification = await readGeneralTaskRun(ctx.cwd, parameters.verificationRunId);
      const paths = await promoteGeneralTask(ctx.cwd, candidate, verification);
      return result({
        status: "saved",
        taskId: candidate.task.id,
        revision: candidate.candidateHash,
        ...paths,
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_list",
    label: "List General Tasks",
    description: "List saved general tasks available for fresh-session replay.",
    parameters: EmptyParameters,
    executionMode: "sequential",
    async execute(_id, _parameters, _signal, _update, ctx) {
      const tasks = await listGeneralTasks(ctx.cwd);
      return result({
        tasks: tasks.map(({ task, revision, savedAt }) => ({
          id: task.id,
          name: task.name,
          goal: task.goal,
          revision,
          savedAt,
          inputs: task.inputs,
        })),
      });
    },
  });

  pi.registerTool({
    name: "workflow_task_show",
    label: "Show General Task",
    description: "Load one saved general task definition and pinned revision.",
    parameters: Type.Object({ taskId: WorkflowIdSchema }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, parameters, _signal, _update, ctx) {
      return result({ task: await readGeneralTask(ctx.cwd, parameters.taskId) });
    },
  });

  pi.registerTool({
    name: "workflow_draft_recent",
    label: "Draft Recent Workflow",
    description:
      "Snapshot the bounded session-local redacted capture of recent computer-use calls after the user asks to save a task.",
    parameters: RecordStartParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const recent =
        rolling.get(key) ??
        startRecording(parameters.name, parameters.goal, ctx.sessionManager.getSessionId());
      const draft = finishRecording({ ...recent, name: parameters.name, goal: parameters.goal });
      const path = await writeDraft(ctx.cwd, draft);
      rolling.set(
        key,
        startRecording(
          "Recent task",
          "Recent successful computer task",
          ctx.sessionManager.getSessionId(),
        ),
      );
      return result({
        ok: true,
        status: draft.status,
        draftId: draft.id,
        callCount: draft.calls.length,
        issueCount: draft.issues.length,
        path,
      });
    },
  });

  pi.registerTool({
    name: "browser_workflow_save",
    label: "Save Browser Workflow",
    description:
      "Optional fixed-recipe accelerator: validate, verify, and save a bounded read-only browser monitor. Use workflow_task_* for normal adaptable tasks.",
    parameters: SaveBrowserWorkflowParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const workflow = validateBrowserJobDefinition(parameters.workflow);
        const current = await readBrowserJobIfPresent(ctx.cwd, workflow.id);
        const saved = makeSavedBrowserJob(workflow);
        const runSignal = _signal ?? new AbortController().signal;
        const completed = await withBrowserJobLock(
          ctx.cwd,
          workflow.id,
          runSignal,
          async () =>
            await runSavedBrowserJob({
              saved,
              bridge: makeBrowserJobBridge(pi, ctx),
              store: {
                readBaseline: async () => undefined,
                writeBaseline: async () => undefined,
                writeReport: async (report) => await writeBrowserJobRunReport(ctx.cwd, report),
              },
              signal: runSignal,
            }),
        );
        if (completed.report.status !== "passed" || completed.report.revision !== saved.revision) {
          throw new Error(
            `Browser workflow verification ${completed.report.status}; current saved revision was preserved.`,
          );
        }
        const paths = await promoteVerifiedBrowserJob(ctx.cwd, saved, current?.revision ?? null);

        return result({
          ok: true,
          status: "saved",
          workflowId: workflow.id,
          revision: saved.revision,
          sourceFingerprint: saved.sourceFingerprint,
          proofReportPath: completed.reportPath,
          ...paths,
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "browser_workflow_list",
    label: "List Browser Workflows",
    description: "List saved bounded browser monitoring workflows in this Profile.",
    parameters: EmptyParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
      try {
        const workflows = await listBrowserJobs(ctx.cwd);

        return result({
          workflows: workflows.map((entry) => ({
            id: entry.workflow.id,
            name: entry.workflow.name,
            revision: entry.revision,
            savedAt: entry.savedAt,
            browserProfile: entry.workflow.browserProfile,
            pageCount: entry.workflow.pages.length,
          })),
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "browser_workflow_show",
    label: "Show Browser Workflow",
    description: "Load the current saved revision of one browser monitoring workflow.",
    parameters: WorkflowParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        return result({ workflow: await readBrowserJob(ctx.cwd, parameters.workflowId) });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "browser_workflow_run",
    label: "Run Browser Workflow",
    description:
      "Run a saved browser workflow directly once through the existing computer-use bridge and update its stable-ID baseline only after full success.",
    parameters: WorkflowParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      try {
        const saved = await readBrowserJob(ctx.cwd, parameters.workflowId);
        const runSignal = signal ?? new AbortController().signal;

        const completed = await withBrowserJobLock(
          ctx.cwd,
          saved.workflow.id,
          runSignal,
          async () =>
            await runSavedBrowserJob({
              saved,
              bridge: makeBrowserJobBridge(pi, ctx),
              store: {
                readBaseline: async (workflowId) =>
                  await readBrowserJobBaseline(ctx.cwd, workflowId),
                writeBaseline: async (baseline) => await writeBrowserJobBaseline(ctx.cwd, baseline),
                writeReport: async (report) => await writeBrowserJobRunReport(ctx.cwd, report),
              },
              signal: runSignal,
            }),
        );

        const report = completed.report;

        return result({
          reportPath: completed.reportPath,
          status: report.status,
          workflowId: report.workflowId,
          itemCount: report.itemCount,
          newItemCount: report.newItems.length,
          baselineEstablished: report.baselineEstablished,
          baselineReset: report.baselineReset,
          pagesCompleted: report.pagesCompleted,
          resultPagesCompleted: report.resultPagesCompleted,
          detailItemsCompleted: report.detailItemsCompleted,
          failure: report.failure,
          newItemPreview: report.newItems.slice(0, 20).map(({ details, ...item }) => ({
            ...item,
            detailFields: details === undefined ? undefined : Object.keys(details),
          })),
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_record_start",
    label: "Start Workflow Recording",
    description:
      "Start an agent-assisted recording of successful computer-use tool calls in this session. Typed text, URLs, arbitrary code, state ids, coordinates, and transient refs are not retained.",
    parameters: RecordStartParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);

      if (active.has(key))
        throw new Error("This session already has an active workflow recording.");

      const recording = startRecording(
        parameters.name,
        parameters.goal,
        ctx.sessionManager.getSessionId(),
      );

      active.set(key, recording);

      return result({ ok: true, recordingId: recording.id, status: "recording" });
    },
  });

  pi.registerTool({
    name: "workflow_record_stop",
    label: "Stop Workflow Recording",
    description:
      "Stop this session's recording and save a redacted runtime draft for review. This does not save a runnable workflow.",
    parameters: EmptyParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const recording = active.get(key);

      if (recording === undefined)
        throw new Error("This session has no active workflow recording.");
      active.delete(key);

      try {
        const draft = finishRecording(recording);
        const path = await writeDraft(ctx.cwd, draft);

        return result({
          ok: true,
          status: draft.status,
          draftId: draft.id,
          callCount: draft.calls.length,
          issueCount: draft.issues.length,
          path,
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_record_cancel",
    label: "Cancel Workflow Recording",
    description: "Cancel this session's active workflow recording without writing a draft.",
    parameters: EmptyParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
      const cancelled = active.delete(sessionKey(ctx));

      if (!cancelled) throw new Error("This session has no active workflow recording.");

      return result({ ok: true, status: "cancelled", persisted: false });
    },
  });

  pi.registerTool({
    name: "workflow_draft_show",
    label: "Show Workflow Draft",
    description: "Load a redacted workflow recording draft for review before saving.",
    parameters: DraftParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        return result({ draft: await readDraft(ctx.cwd, parameters.draftId) });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_save_prepare",
    label: "Prepare Workflow Save",
    description:
      "Optional compiled-segment accelerator: stage a strict semantic run_ui_segment workflow. Use workflow_task_* for normal adaptable tasks.",
    parameters: PreparePublishParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const key = sessionKey(ctx);
        if (activeRuns.has(key))
          throw new Error("This session already has an active workflow run.");
        const draft = await readDraft(ctx.cwd, parameters.draftId);
        const current = await readWorkflowIfPresent(ctx.cwd, parameters.workflow.id);
        const candidateInput = {
          workflow: parameters.workflow,
          sourceDraftId: draft.id,
          draft,
          bindings: parameters.bindings,
        };
        const candidate = makeWorkflowSaveCandidate(
          current === undefined
            ? candidateInput
            : { ...candidateInput, baseRevision: current.revision },
        );
        const resolved = resolveWorkflowTemplates(candidate.workflow, parameters.bindings);
        const compiled = compileExecutionPlan(resolved);
        const hasActions = compiled.segments.some((segment) =>
          segment.input.steps.some((step) => "actions" in step),
        );
        if (hasActions && parameters.replayMode !== "reversible-test") {
          throw new Error(
            "Action verification requires replayMode='reversible-test' after the agent establishes an isolated or reversible test context.",
          );
        }
        const candidatePath = await writeSaveCandidate(ctx.cwd, candidate);
        const run: RunRecord = {
          format: "ziggy-computer-workflow-run",
          formatVersion: 1,
          id: crypto.randomUUID(),
          workflowId: candidate.workflow.id,
          revision: candidate.candidateHash,
          sessionId: ctx.sessionManager.getSessionId(),
          preparedAt: new Date().toISOString(),
          status: "planned",
          plannedSegmentCount: compiled.segments.length,
          manualStepCount: compiled.manual.length,
        };
        await writeRunRecord(ctx.cwd, run);
        activeRuns.set(key, startActiveRun(run, compiled));
        activeSaveCandidates.set(key, candidate.id);

        return result({
          ok: true,
          status: compiled.manual.length === 0 ? "verification-ready" : "verification-blocked",
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          workflowId: candidate.workflow.id,
          workflow: candidate.workflow,
          optimization: candidate.optimization,
          candidatePath,
          verification: { runId: run.id, segments: compiled.segments, manual: compiled.manual },
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_save",
    label: "Save Workflow Revision",
    description:
      "Promote the exact staged candidate only after this session observed every planned run_ui_segment and its driver-verified checkpoints pass.",
    parameters: PublishParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const key = sessionKey(ctx);
        const activeRun = activeRuns.get(key);
        const candidate = await readSaveCandidate(ctx.cwd, parameters.candidateId);
        if (
          activeRun === undefined ||
          activeSaveCandidates.get(key) !== candidate.id ||
          activeRun.record.revision !== candidate.candidateHash
        ) {
          throw new Error(
            "No active verification exists for this exact candidate in this session.",
          );
        }
        const summary = finishActiveRun(activeRun);
        const summaryPath = await writeRunSummary(ctx.cwd, summary);
        activeRuns.delete(key);
        activeSaveCandidates.delete(key);
        const proof = proveWorkflowSaveCandidate({ candidate, summary });
        const proofPath = await writeSaveProof(ctx.cwd, proof);
        const paths = await promoteVerifiedWorkflow(ctx.cwd, candidate, proof);
        return result({
          ok: true,
          status: "saved",
          workflowId: candidate.workflow.id,
          revision: candidate.candidateHash,
          summaryPath,
          proofPath,
          ...paths,
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_list",
    label: "List Workflows",
    description: "List the current saved semantic workflow revisions in this Profile.",
    parameters: EmptyParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
      try {
        const workflows = await listWorkflows(ctx.cwd);

        return result({
          workflows: workflows.map((entry) => ({
            id: entry.workflow.id,
            name: entry.workflow.name,
            revision: entry.revision,
            savedAt: entry.publishedAt,
            stepCount: entry.workflow.steps.length,
          })),
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_show",
    label: "Show Workflow",
    description: "Load the current saved revision of one semantic workflow.",
    parameters: WorkflowParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        return result({ workflow: await readWorkflow(ctx.cwd, parameters.workflowId) });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_plan",
    label: "Plan Workflow Replay",
    description:
      "Prepare a bounded semantic replay plan for the agent to carry out through computer-use. This does not execute another extension or accept secret values.",
    parameters: WorkflowParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const key = sessionKey(ctx);

        if (activeRuns.has(key)) {
          throw new Error("This session already has an active workflow run; finish it first.");
        }

        const published = await readWorkflow(ctx.cwd, parameters.workflowId);
        const compiled = compileExecutionPlan(
          resolveWorkflowTemplates(published.workflow, parameters.bindings ?? {}),
        );

        const run: RunRecord = {
          format: "ziggy-computer-workflow-run",
          formatVersion: 1,
          id: crypto.randomUUID(),
          workflowId: published.workflow.id,
          revision: published.revision,
          sessionId: ctx.sessionManager.getSessionId(),
          preparedAt: new Date().toISOString(),
          status: "planned",
          plannedSegmentCount: compiled.segments.length,
          manualStepCount: compiled.manual.length,
        };

        const runPath = await writeRunRecord(ctx.cwd, run);
        activeRuns.set(key, startActiveRun(run, compiled));

        return result({
          runId: run.id,
          run,
          execution: {
            mode: "agent-mediated-compact-segments",
            executesTools: false,
            segments: compiled.segments,
            manual: compiled.manual,
            variables: published.workflow.variables,
            rule: "Call each run_ui_segment input as one model tool call. The driver resolves fresh state for every target and stops on ambiguity, cancellation, unknown state, or a failed checkpoint. Enter all text and secret variables directly in the target app.",
          },
          runPath,
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_run_finish",
    label: "Finish Workflow Run",
    description:
      "Finish this session's exact active workflow run and persist a compact evidence summary derived only from observed planned run_ui_segment calls and results.",
    parameters: FinishRunParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const key = sessionKey(ctx);
        const run = activeRuns.get(key);

        if (run === undefined || run.record.id !== parameters.runId) {
          throw new Error("No matching active workflow run exists in this session.");
        }

        const summary = finishActiveRun(run);
        const summaryPath = await writeRunSummary(ctx.cwd, summary);
        activeRuns.delete(key);
        activeSaveCandidates.delete(key);

        return result({ summary, summaryPath });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });
}

export type WorkflowRecordStartParameters = Static<typeof RecordStartParameters>;
