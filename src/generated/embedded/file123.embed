/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tools and event handlers are this package's async boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Pi surfaces bounded rejected tool Promises as failures. */
/* oxlint-disable ziggy-effect/no-instanceof-error -- Pi rejects native Errors at this extension boundary. */
/* oxlint-disable ziggy/no-unknown-parameters -- Tool results serialize boundary-owned payloads only. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { WorkflowDefinitionSchema, WorkflowIdSchema, type RunRecord } from "./src/schema.ts";
import {
  finishRecording,
  observeToolCall,
  observeToolResult,
  startRecording,
  type ActiveRecording,
} from "./src/recorder.ts";
import { assertPublishApproval, makePublishApproval } from "./src/approval.ts";
import {
  listWorkflows,
  publishWorkflow,
  readDraft,
  readPublishApproval,
  readWorkflow,
  writeDraft,
  writePublishApproval,
  writeRunRecord,
  writeRunSummary,
} from "./src/storage.ts";
import { makePublishedWorkflow, validateWorkflowDefinition } from "./src/workflows.ts";
import { compileExecutionPlan } from "./src/execution-plan.ts";
import {
  finishActiveRun,
  observeRunToolCall,
  observeRunToolResult,
  startActiveRun,
  type ActiveWorkflowRun,
} from "./src/run-tracker.ts";

const OUTPUT_LIMIT = 32 * 1024;
const NonEmptyText = Type.String({ minLength: 1, maxLength: 1_024 });
const EmptyParameters = Type.Object({}, { additionalProperties: false });
const RecordStartParameters = Type.Object(
  { name: NonEmptyText, goal: NonEmptyText },
  { additionalProperties: false },
);
const DraftParameters = Type.Object({ draftId: WorkflowIdSchema }, { additionalProperties: false });
const PreparePublishParameters = Type.Object(
  { draftId: WorkflowIdSchema, workflow: WorkflowDefinitionSchema },
  { additionalProperties: false },
);
const PublishParameters = Type.Object(
  { approvalId: WorkflowIdSchema },
  { additionalProperties: false },
);
const WorkflowParameters = Type.Object(
  { workflowId: WorkflowIdSchema },
  { additionalProperties: false },
);
const FinishRunParameters = Type.Object(
  { runId: WorkflowIdSchema },
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

const userInputRevision = (ctx: Pick<ExtensionContext, "sessionManager">): number =>
  ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user").length;

export default function computerWorkflows(pi: ExtensionAPI): void {
  const active = new Map<string, ActiveRecording>();
  const activeRuns = new Map<string, ActiveWorkflowRun>();
  const clearProfileRecording = (profilePath: string): void => {
    for (const key of active.keys()) {
      if (key.startsWith(`${profilePath}\0`)) active.delete(key);
    }
  };
  const clearProfileRuns = (profilePath: string): void => {
    for (const key of activeRuns.keys()) {
      if (key.startsWith(`${profilePath}\0`)) activeRuns.delete(key);
    }
  };

  pi.on("tool_call", (event, ctx) => {
    const recording = active.get(sessionKey(ctx));
    if (recording !== undefined) observeToolCall(recording, event);
    const run = activeRuns.get(sessionKey(ctx));
    if (run !== undefined) observeRunToolCall(run, event);
  });
  pi.on("tool_result", (event, ctx) => {
    const recording = active.get(sessionKey(ctx));
    if (recording !== undefined) observeToolResult(recording, event);
    const run = activeRuns.get(sessionKey(ctx));
    if (run !== undefined) {
      observeRunToolResult(run, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        details: event.details,
      });
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
      "Stop this session's recording and save a redacted runtime draft for review. This never publishes a workflow.",
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
    description: "Load a redacted workflow recording draft for review before publishing.",
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
    name: "workflow_publish_prepare",
    label: "Prepare Workflow Publication",
    description:
      "Validate and durably prepare a reviewed semantic workflow for publication. A later explicit user turn must approve publication; this call never publishes.",
    parameters: PreparePublishParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const draft = await readDraft(ctx.cwd, parameters.draftId);
        const workflow = validateWorkflowDefinition(parameters.workflow);
        const approval = makePublishApproval({
          workflow,
          sourceDraftId: draft.id,
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          preparedAtUserInput: userInputRevision(ctx),
        });
        const approvalPath = await writePublishApproval(ctx.cwd, approval);
        return result({
          ok: true,
          status: "awaiting-user-approval",
          approvalId: approval.id,
          workflowId: workflow.id,
          stepCount: workflow.steps.length,
          workflow,
          approvalPath,
          instruction:
            "Show this exact workflow summary to the user. Only a later user response can authorize workflow_publish.",
        });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });

  pi.registerTool({
    name: "workflow_publish",
    label: "Publish Workflow Revision",
    description:
      "Publish one prepared semantic workflow after a newer user response in the same Profile session. This works in TUI, RPC, gateway, print, and automation faces without a dialog.",
    parameters: PublishParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const approval = await readPublishApproval(ctx.cwd, parameters.approvalId);
        assertPublishApproval(approval, {
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          userInput: userInputRevision(ctx),
        });
        const published = makePublishedWorkflow(approval.workflow, approval.sourceDraftId);
        const paths = await publishWorkflow(ctx.cwd, published);
        return result({
          ok: true,
          status: "published",
          workflowId: approval.workflow.id,
          revision: published.revision,
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
    description: "List the current published semantic workflow revisions in this Profile.",
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
            publishedAt: entry.publishedAt,
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
    description: "Load the current published revision of one semantic workflow.",
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
        const compiled = compileExecutionPlan(published.workflow);
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
        return result({ summary, summaryPath });
      } catch (cause) {
        throw boundedFailure(cause);
      }
    },
  });
}

export type WorkflowRecordStartParameters = Static<typeof RecordStartParameters>;
