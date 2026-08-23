/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are the package filesystem proof boundary. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishRecording,
  observeToolCall,
  observeToolResult,
  startRecording,
} from "../src/recorder.ts";
import { assertPublishApproval, makePublishApproval } from "../src/approval.ts";
import {
  decodePublishedWorkflow,
  listWorkflows,
  publishWorkflow,
  readDraft,
  readPublishApproval,
  readWorkflow,
  writeDraft,
  writePublishApproval,
  writeRunSummary,
} from "../src/storage.ts";
import { makePublishedWorkflow, validateWorkflowDefinition } from "../src/workflows.ts";
import { compileExecutionPlan } from "../src/execution-plan.ts";
import {
  finishActiveRun,
  observeRunToolCall,
  observeRunToolResult,
  startActiveRun,
} from "../src/run-tracker.ts";
import type { RunRecord } from "../src/schema.ts";

const roots: string[] = [];
const makeProfile = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-computer-workflows-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = () =>
  validateWorkflowDefinition({
    version: 1,
    id: "submit-note",
    name: "Submit note",
    variables: [
      {
        id: "note-body",
        description: "The note body entered by the user",
        secret: false,
        source: "user",
      },
    ],
    steps: [
      { kind: "observe", mode: "semantic" },
      {
        kind: "type",
        target: { text: "Note", role: "textbox" },
        value: { variable: "note-body" },
        checkpoint: { text: "Note", role: "textbox", until: "present" },
      },
      {
        kind: "click",
        target: { text: "Save", role: "button", capability: "press" },
        checkpoint: { text: "Saved", until: "present", timeoutMs: 10_000 },
      },
    ],
  });

describe("computer workflow recording", () => {
  test("correlates parallel results by call id and never persists typed text or transient refs", async () => {
    const profile = await makeProfile();
    const recording = startRecording(
      "Submit note",
      "Enter and save a note",
      "session-1",
      new Date("2026-08-23T10:00:00.000Z"),
    );
    observeToolCall(
      recording,
      {
        toolCallId: "call-type",
        toolName: "act_ui",
        input: {
          stateId: "state-secret",
          actions: [{ action: "setText", ref: "@e12", text: "never-persist-this" }],
        },
      },
      new Date("2026-08-23T10:00:01.000Z"),
    );
    observeToolCall(
      recording,
      {
        toolCallId: "call-wait",
        toolName: "wait_for",
        input: { stateId: "state-2", text: "Saved", until: "present" },
      },
      new Date("2026-08-23T10:00:02.000Z"),
    );
    observeToolResult(
      recording,
      { toolCallId: "call-wait", toolName: "wait_for", isError: false },
      new Date("2026-08-23T10:00:03.000Z"),
    );
    observeToolResult(
      recording,
      { toolCallId: "call-type", toolName: "act_ui", isError: false },
      new Date("2026-08-23T10:00:04.000Z"),
    );

    const draft = finishRecording(recording, new Date("2026-08-23T10:00:05.000Z"));
    expect(draft.calls.map((call) => call.toolCallId)).toEqual(["call-type", "call-wait"]);
    expect(draft.calls[0]?.input).toEqual({
      kind: "safe_actions",
      actions: [{ action: "variable-input", variable: "input-1-1", target: "requires-review" }],
    });
    const path = await writeDraft(profile, draft);
    expect(await readDraft(profile, draft.id)).toEqual(draft);
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("never-persist-this");
    expect(persisted).not.toContain("state-secret");
    expect(persisted).not.toContain("@e12");
  });

  test("omits pending calls and records the omission for review", () => {
    const recording = startRecording("Pending", "Show pending behavior", "session-2");
    observeToolCall(recording, {
      toolCallId: "pending",
      toolName: "observe_ui",
      input: { root: "@r1", mode: "semantic" },
    });
    const draft = finishRecording(recording);
    expect(draft.calls).toEqual([]);
    expect(draft.issues).toEqual([
      "Tool call 1 had not completed when recording stopped and was omitted.",
    ]);
  });

  test("withholds character sequences while normalizing explicit modifier chords", () => {
    const recording = startRecording("Keys", "Record safe keyboard controls", "session-keys");
    observeToolCall(recording, {
      toolCallId: "password-keys",
      toolName: "act_ui",
      input: {
        stateId: "state-password",
        actions: [{ action: "keypress", keys: ["p", "a", "s", "s"] }],
      },
    });
    observeToolResult(recording, {
      toolCallId: "password-keys",
      toolName: "act_ui",
      isError: false,
    });
    observeToolCall(recording, {
      toolCallId: "select-all",
      toolName: "act_ui",
      input: { stateId: "state-chord", actions: [{ action: "keypress", keys: ["cmd", "a"] }] },
    });
    observeToolResult(recording, {
      toolCallId: "select-all",
      toolName: "act_ui",
      isError: false,
    });

    const draft = finishRecording(recording);
    expect(draft.calls[0]?.input).toEqual({
      kind: "safe_actions",
      actions: [{ action: "requires-review", reason: "unsupported-action" }],
    });
    expect(draft.calls[1]?.input).toEqual({
      kind: "safe_actions",
      actions: [{ action: "keypress", keys: ["CMD", "A"], target: "focused" }],
    });
    expect(JSON.stringify(draft)).not.toContain('["p","a","s","s"]');
  });
});

describe("computer workflow publication", () => {
  test("rejects same-turn model publication and accepts a later user turn in the same session", async () => {
    const profile = await makeProfile();
    const approval = makePublishApproval({
      workflow: definition(),
      sourceDraftId: "draft-1",
      sessionId: "session-a",
      cwd: profile,
      preparedAtUserInput: 3,
      now: new Date("2026-08-23T10:30:00.000Z"),
    });
    await writePublishApproval(profile, approval);
    const durable = await readPublishApproval(profile, approval.id);

    expect(() =>
      assertPublishApproval(durable, {
        sessionId: "session-a",
        cwd: profile,
        userInput: 3,
      }),
    ).toThrow("newer user response");
    expect(() =>
      assertPublishApproval(durable, {
        sessionId: "session-a",
        cwd: profile,
        userInput: 4,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishApproval(durable, {
        sessionId: "session-b",
        cwd: profile,
        userInput: 4,
      }),
    ).toThrow("different session");
  });

  test("writes visible immutable revisions and a current manifest with collision-safe creation", async () => {
    const profile = await makeProfile();
    const published = makePublishedWorkflow(
      definition(),
      "draft-1",
      new Date("2026-08-23T11:00:00.000Z"),
    );
    const paths = await publishWorkflow(profile, published);
    expect(paths.manifestPath).toBe(join(profile, "workflows/submit-note/workflow.json"));
    expect(paths.revisionPath).toContain("/workflows/submit-note/revisions/");
    expect(await readWorkflow(profile, "submit-note")).toEqual(published);
    expect((await listWorkflows(profile)).map((entry) => entry.workflow.id)).toEqual([
      "submit-note",
    ]);
    await expect(publishWorkflow(profile, published)).rejects.toThrow();
  });

  test("rejects unknown nested fields, transient refs, unresolved variables, and unmarked secrets", () => {
    const published = makePublishedWorkflow(definition(), "draft-1");
    expect(() =>
      decodePublishedWorkflow({
        ...published,
        workflow: {
          ...published.workflow,
          steps: [{ kind: "click", target: { text: "Save", unexpected: true } }],
        },
      }),
    ).toThrow();
    expect(() =>
      validateWorkflowDefinition({
        version: 1,
        id: "bad-ref",
        name: "Bad ref",
        variables: [],
        steps: [{ kind: "click", target: { text: "@e12" } }],
      }),
    ).toThrow("transient");
    expect(() =>
      validateWorkflowDefinition({
        version: 1,
        id: "missing-variable",
        name: "Missing variable",
        variables: [],
        steps: [{ kind: "type", value: { variable: "missing" } }],
      }),
    ).toThrow("unknown variable");
    expect(() =>
      validateWorkflowDefinition({
        version: 1,
        id: "unsafe-secret",
        name: "Unsafe secret",
        variables: [{ id: "api-token", description: "API token", secret: false, source: "user" }],
        steps: [{ kind: "type", value: { variable: "api-token" } }],
      }),
    ).toThrow("secret=true");
  });
});

describe("computer workflow execution planning", () => {
  test("carries Calculator root ownership into the segment without manual setup residue", () => {
    const calculator = validateWorkflowDefinition({
      version: 1,
      id: "calculator-seven",
      name: "Enter seven in Calculator",
      variables: [],
      steps: [
        { kind: "find_roots", app: "Calculator", rootKind: "window" },
        { kind: "observe", mode: "semantic" },
        {
          kind: "click",
          target: { text: "7", role: "button", capability: "press" },
          checkpoint: { text: "7", until: "present" },
        },
      ],
    });

    const plan = compileExecutionPlan(calculator);

    expect(plan).toEqual({
      segments: [
        {
          tool: "run_ui_segment",
          input: {
            rootQuery: { app: "Calculator", kind: "window" },
            steps: [
              {
                target: { text: "7", role: "button", capability: "press" },
                actions: [{ action: "click" }],
                expect: { text: "7", until: "present" },
              },
            ],
          },
          sourceSteps: [3],
        },
      ],
      manual: [],
    });
    expect(JSON.stringify(plan)).not.toContain("find_roots");
    expect(JSON.stringify(plan)).not.toContain('"observe"');
  });

  test("keeps rootless actions manual and withholds text values", () => {
    const plan = compileExecutionPlan(definition());

    expect(plan.segments).toEqual([]);
    expect(plan.manual).toContainEqual({
      sourceStep: 2,
      reason:
        "Text and secret values are never accepted by run_ui_segment; the user must enter the value directly.",
    });
    expect(plan.manual).toContainEqual({
      sourceStep: 3,
      reason: "This action has no active durable find_roots query.",
    });
    expect(JSON.stringify(plan)).not.toContain("note-body");
  });

  test("does not compile app-only targets as empty semantic controls", () => {
    const workflow = validateWorkflowDefinition({
      version: 1,
      id: "app-only-target",
      name: "App-only target",
      variables: [],
      steps: [
        { kind: "find_roots", app: "Notes" },
        {
          kind: "click",
          target: { app: "Notes" },
          checkpoint: { text: "Saved", until: "present" },
        },
      ],
    });

    expect(compileExecutionPlan(workflow)).toEqual({
      segments: [],
      manual: [
        {
          sourceStep: 2,
          reason:
            "An app-only action target is not a semantic control target; use app in find_roots.",
        },
      ],
    });
  });

  test("rejects text-producing key arrays and preserves explicit control chords", () => {
    expect(() =>
      validateWorkflowDefinition({
        version: 1,
        id: "unsafe-keys",
        name: "Unsafe keys",
        variables: [],
        steps: [
          { kind: "find_roots", app: "TextEdit" },
          {
            kind: "keypress",
            target: { role: "textbox" },
            keys: ["P", "A", "S", "S"],
            checkpoint: { role: "textbox", until: "present" },
          },
        ],
      }),
    ).toThrow();

    const chord = validateWorkflowDefinition({
      version: 1,
      id: "safe-chord",
      name: "Safe chord",
      variables: [],
      steps: [
        { kind: "find_roots", app: "TextEdit" },
        {
          kind: "keypress",
          target: { role: "textbox" },
          keys: ["CMD", "A"],
          checkpoint: { role: "textbox", until: "present" },
        },
      ],
    });
    expect(compileExecutionPlan(chord).segments[0]?.input.steps).toEqual([
      {
        target: { role: "textbox" },
        actions: [{ action: "keypress", keys: ["CMD", "A"] }],
        expect: { role: "textbox", until: "present" },
      },
    ]);
  });

  test("compiles wait checks as driver-owned assertions with the current durable root", () => {
    const workflow = validateWorkflowDefinition({
      version: 1,
      id: "browser-acceptance",
      name: "Browser acceptance",
      variables: [],
      steps: [
        { kind: "find_roots", app: "Google Chrome", rootKind: "window" },
        { kind: "observe", mode: "semantic" },
        {
          kind: "wait",
          condition: { text: "Signed in as", role: "static_text", until: "present" },
        },
      ],
    });

    expect(compileExecutionPlan(workflow)).toEqual({
      segments: [
        {
          tool: "run_ui_segment",
          input: {
            rootQuery: { app: "Google Chrome", kind: "window" },
            steps: [{ assert: { text: "Signed in as", role: "static_text", until: "present" } }],
          },
          sourceSteps: [3],
        },
      ],
      manual: [],
    });
  });
});

const acceptancePlan = () =>
  compileExecutionPlan(
    validateWorkflowDefinition({
      version: 1,
      id: "browser-acceptance",
      name: "Browser acceptance",
      variables: [],
      steps: [
        { kind: "find_roots", app: "Google Chrome", rootKind: "window" },
        { kind: "observe", mode: "semantic" },
        { kind: "wait", condition: { text: "Signed in as", until: "present" } },
        {
          kind: "click",
          target: { text: "Account", role: "button" },
          checkpoint: { text: "Account settings", until: "present" },
        },
      ],
    }),
  );

const runRecord = (): RunRecord => ({
  format: "ziggy-computer-workflow-run",
  formatVersion: 1,
  id: "run-1",
  workflowId: "browser-acceptance",
  revision: "revision-1",
  sessionId: "session-1",
  preparedAt: "2026-08-23T12:00:00.000Z",
  status: "planned",
  plannedSegmentCount: 1,
  manualStepCount: 0,
});

describe("computer workflow run evidence", () => {
  test("marks exact matched segment checks passed", () => {
    const plan = acceptancePlan();
    const run = startActiveRun(runRecord(), plan);
    observeRunToolCall(run, {
      toolCallId: "segment-1",
      toolName: "run_ui_segment",
      input: plan.segments[0]?.input ?? { steps: [] },
    });
    observeRunToolResult(run, {
      toolCallId: "segment-1",
      toolName: "run_ui_segment",
      isError: false,
      details: {
        tool: "run_ui_segment",
        status: "completed",
        completed: [
          { step: 1, stateId: "state-1", kind: "assert", actionCount: 0 },
          { step: 2, stateId: "state-2", ref: "@e4", actionCount: 1 },
        ],
      },
    });

    expect(finishActiveRun(run, new Date("2026-08-23T12:01:00.000Z"))).toMatchObject({
      overall: "passed",
      stopReason: "completed",
      segments: { planned: 1, matched: 1, passed: 1, failed: 0 },
      checks: [
        { sourceStep: 3, expected: { text: "Signed in as", until: "present" }, outcome: "passed" },
        {
          sourceStep: 4,
          expected: { text: "Account settings", until: "present" },
          outcome: "passed",
        },
      ],
    });
  });

  test("classifies a matched tool error as failed without retaining its result body", async () => {
    const profile = await makeProfile();
    const plan = acceptancePlan();
    const run = startActiveRun(runRecord(), plan);
    observeRunToolCall(run, {
      toolCallId: "segment-error",
      toolName: "run_ui_segment",
      input: plan.segments[0]?.input ?? { steps: [] },
    });
    const resultEvent = {
      toolCallId: "segment-error",
      toolName: "run_ui_segment",
      isError: true,
      details: { cookie: "cookie-secret" },
      content: [{ type: "text", text: "private page result body" }],
    };
    observeRunToolResult(run, resultEvent);
    const summary = finishActiveRun(run);
    const path = await writeRunSummary(profile, summary);
    const persisted = await readFile(path, "utf8");

    expect(summary).toMatchObject({
      overall: "failed",
      stopReason: "tool-error",
      segments: { matched: 1, passed: 0, failed: 1 },
    });
    expect(persisted).not.toContain("cookie-secret");
    expect(persisted).not.toContain("private page result body");
    expect(persisted).not.toContain("@e");
    expect(persisted).not.toContain("state-");
  });

  test("classifies mismatched or manually untracked plans as incomplete", () => {
    const plan = acceptancePlan();
    const mismatched = startActiveRun(runRecord(), plan);
    observeRunToolCall(mismatched, {
      toolCallId: "wrong",
      toolName: "run_ui_segment",
      input: { rootQuery: { app: "Safari" }, steps: plan.segments[0]?.input.steps ?? [] },
    });
    expect(finishActiveRun(mismatched)).toMatchObject({
      overall: "incomplete",
      stopReason: "input-mismatch",
      segments: { matched: 0, passed: 0, failed: 0 },
    });

    const manualPlan = compileExecutionPlan(definition());
    const manualRecord = {
      ...runRecord(),
      id: "run-manual",
      plannedSegmentCount: manualPlan.segments.length,
      manualStepCount: manualPlan.manual.length,
    };
    const manual = startActiveRun(manualRecord, manualPlan);
    expect(finishActiveRun(manual)).toMatchObject({
      overall: "incomplete",
      stopReason: "manual-steps",
    });
  });
});
