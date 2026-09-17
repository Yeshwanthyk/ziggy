/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are the filesystem proof boundary. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread, ziggy/require-readable-spacing -- Fixture builders keep optional setup and assertions compact. */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileExecutionPlan } from "../src/execution-plan.ts";
import { makeWorkflowSaveCandidate, proveWorkflowSaveCandidate } from "../src/save-pipeline.ts";
import { promoteVerifiedWorkflow, readWorkflow } from "../src/storage.ts";
import { resolveWorkflowTemplates } from "../src/workflows.ts";
import type { RunSummary, WorkflowDraft, WorkflowSaveCandidate } from "../src/schema.ts";

const draft = (text: string): WorkflowDraft => ({
  format: "ziggy-computer-workflow-draft",
  formatVersion: 1,
  id: crypto.randomUUID(),
  name: "Source task",
  goal: "Complete the demonstrated task",
  sessionId: "session-source",
  startedAt: "2026-09-16T10:00:00.000Z",
  stoppedAt: "2026-09-16T10:01:00.000Z",
  status: "review-required",
  calls: [
    {
      sequence: 1,
      toolCallId: "source-segment",
      toolName: "run_ui_segment",
      startedAt: "2026-09-16T10:00:10.000Z",
      completedAt: "2026-09-16T10:00:11.000Z",
      outcome: "success",
      input: {
        kind: "semantic_segment",
        rootQuery: { text: "Workflow lab", kind: "browser_page" },
        steps: [
          {
            target: { text: "Show Alpha", role: "button" },
            actions: [{ action: "click" }],
            expect: { text, until: "present" },
          },
        ],
      },
      issues: [],
    },
  ],
  issues: [],
});

const inventoryCandidate = (
  item: string,
  baseRevision?: string,
  name = "Inventory details",
): WorkflowSaveCandidate => {
  const source = draft(`${item}: 12 available`);
  return makeWorkflowSaveCandidate({
    sourceDraftId: source.id,
    draft: source,
    bindings: { item },
    ...(baseRevision === undefined ? {} : { baseRevision }),
    workflow: {
      version: 1,
      id: "inventory-details",
      name,
      variables: [{ id: "item", description: "Inventory item", secret: false, source: "user" }],
      steps: [
        { kind: "find_roots", text: "Workflow lab", rootKind: "browser_page" },
        { kind: "find_roots", text: "Workflow lab", rootKind: "browser_page" },
        { kind: "observe", mode: "semantic" },
        { kind: "observe", mode: "semantic" },
        {
          kind: "click",
          target: { text: "Show {{item}}", role: "button" },
          checkpoint: { text: "{{item}}: 12 available", until: "present" },
        },
      ],
    },
  });
};

const passedSummary = (
  candidate: WorkflowSaveCandidate,
  bindings: Readonly<Record<string, string>> = { item: "Alpha" },
): RunSummary => {
  const plan = compileExecutionPlan(resolveWorkflowTemplates(candidate.workflow, bindings));
  return {
    format: "ziggy-computer-workflow-run-summary",
    formatVersion: 1,
    id: crypto.randomUUID(),
    workflowId: candidate.workflow.id,
    revision: candidate.candidateHash,
    sessionId: "session-verify",
    preparedAt: "2026-09-16T10:02:00.000Z",
    finishedAt: "2026-09-16T10:03:00.000Z",
    overall: "passed",
    checks: plan.segments.flatMap((segment) =>
      segment.input.steps.map((step, index) => ({
        sourceStep: segment.sourceSteps[index] ?? 1,
        expected: "assert" in step ? step.assert : step.expect,
        outcome: "passed" as const,
      })),
    ),
    segments: {
      planned: plan.segments.length,
      matched: plan.segments.length,
      passed: plan.segments.length,
      failed: 0,
    },
    stopReason: "completed",
  };
};

describe("verified workflow save pipeline", () => {
  test("rejects an earlier checkpoint followed by an unchecked mutation or pending call", () => {
    const source = draft("Draft ready");
    const initialCall = source.calls[0];
    expect(initialCall).toBeDefined();
    if (initialCall === undefined) return;
    source.calls[0] = {
      ...initialCall,
      toolName: "wait_for",
      input: { kind: "wait_for", text: "Draft ready", until: "present" },
    };
    source.calls.push({
      sequence: 2,
      toolCallId: "unchecked-click",
      toolName: "act_ui",
      startedAt: "2026-09-16T10:00:12.000Z",
      completedAt: "2026-09-16T10:00:13.000Z",
      outcome: "success",
      input: {
        kind: "safe_actions",
        actions: [{ action: "requires-review", reason: "transient-target" }],
      },
      issues: ["Replace the transient UI ref with a semantic target."],
    });
    const make = () =>
      makeWorkflowSaveCandidate({
        sourceDraftId: source.id,
        draft: source,
        bindings: {},
        workflow: {
          version: 1,
          id: "unsafe-terminal-state",
          name: "Unsafe terminal state",
          variables: [],
          steps: [
            { kind: "find_roots", text: "Workflow lab", rootKind: "browser_page" },
            { kind: "wait", condition: { text: "Draft ready", until: "present" } },
          ],
        },
      });
    expect(make).toThrow("terminal successful recorded task outcome");

    source.calls.pop();
    source.issues.push("Tool call 2 had not completed when recording stopped and was omitted.");
    expect(make).toThrow("terminal successful recorded task outcome");
  });

  test("optimizes only redundant observations and roots while retaining input templates", () => {
    const inventory = inventoryCandidate("Alpha");
    expect(inventory.optimization).toMatchObject({
      removedRedundantObservations: 1,
      removedRedundantRootLookups: 1,
      segmentCount: 1,
    });
    expect(JSON.stringify(inventory.workflow)).toContain("{{item}}");
    expect(
      compileExecutionPlan(resolveWorkflowTemplates(inventory.workflow, { item: "Beta" }))
        .segments[0]?.input.steps,
    ).toEqual([
      {
        target: { text: "Show Beta", role: "button" },
        actions: [{ action: "click" }],
        expect: { text: "Beta: 12 available", until: "present" },
      },
    ]);

    const previewSource = draft("Preview: Basic");
    const preview = makeWorkflowSaveCandidate({
      sourceDraftId: previewSource.id,
      draft: previewSource,
      bindings: { plan: "Basic" },
      workflow: {
        version: 1,
        id: "order-preview",
        name: "Order preview",
        variables: [{ id: "plan", description: "Plan", secret: false, source: "user" }],
        steps: [
          { kind: "find_roots", text: "Workflow lab", rootKind: "browser_page" },
          { kind: "wait", condition: { text: "Preview: {{plan}}", until: "present" } },
        ],
      },
    });
    expect(
      compileExecutionPlan(resolveWorkflowTemplates(preview.workflow, { plan: "Premium" }))
        .segments[0]?.input.steps,
    ).toEqual([{ assert: { text: "Preview: Premium", until: "present" } }]);
  });

  test("rejects forged, stale, mismatched, and failed proof without replacing known-good", async () => {
    const profile = await mkdtemp(join(tmpdir(), "ziggy-save-pipeline-"));
    const good = inventoryCandidate("Alpha");
    const stale = inventoryCandidate("Beta", undefined, "Updated inventory details");
    const goodProof = proveWorkflowSaveCandidate({ candidate: good, summary: passedSummary(good) });
    await promoteVerifiedWorkflow(profile, good, goodProof);

    await expect(
      promoteVerifiedWorkflow(profile, stale, {
        ...proveWorkflowSaveCandidate({
          candidate: stale,
          summary: passedSummary(stale, { item: "Beta" }),
        }),
      }),
    ).rejects.toThrow("changed after");
    expect((await readWorkflow(profile, good.workflow.id)).revision).toBe(good.candidateHash);

    expect(() =>
      proveWorkflowSaveCandidate({
        candidate: good,
        summary: { ...passedSummary(good), revision: "wrong-revision" },
      }),
    ).toThrow("different candidate revision");
    expect(() =>
      proveWorkflowSaveCandidate({
        candidate: good,
        summary: { ...passedSummary(good), overall: "failed", stopReason: "tool-error" },
      }),
    ).toThrow("did not pass");
    await expect(
      promoteVerifiedWorkflow(profile, good, { ...goodProof, candidateHash: "0".repeat(64) }),
    ).rejects.toThrow("does not authorize");
    expect((await readWorkflow(profile, good.workflow.id)).revision).toBe(good.candidateHash);
  });
});
