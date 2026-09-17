/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tools and event handlers are this package's async boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Pi surfaces bounded rejected tool Promises as failures. */
/* oxlint-disable ziggy-effect/no-instanceof-error -- Pi rejects native Errors at this extension boundary. */
/* oxlint-disable ziggy/no-unknown-parameters -- Tool results serialize boundary-owned payloads only. */
/* oxlint-disable ziggy/require-readable-spacing -- Tool registrations keep each bounded operation together. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  BrowserJobDefinitionSchema,
  WorkflowDefinitionSchema,
  WorkflowIdSchema,
  type RunRecord,
} from "./src/schema.ts";
import {
  finishRecording,
  observeToolCall,
  observeToolResult,
  startRecording,
  type ActiveRecording,
} from "./src/recorder.ts";
import {
  listWorkflows,
  readDraft,
  readWorkflow,
  readWorkflowIfPresent,
  writeDraft,
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

  pi.on("tool_call", (event, ctx) => {
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
  });
  pi.on("tool_result", (event, ctx) => {
    const recent = rolling.get(sessionKey(ctx));
    if (recent !== undefined) {
      observeToolResult(recent, event);
      if (recent.completed.length > 500) recent.completed.splice(0, recent.completed.length - 500);
    }
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
      "Validate and save a bounded read-only browser monitoring workflow using a persistent named browser profile.",
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
      "Validate, conservatively optimize, hash, and durably stage a reviewed semantic workflow for exact observed verification. The user's save request authorizes promotion after proof.",
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
