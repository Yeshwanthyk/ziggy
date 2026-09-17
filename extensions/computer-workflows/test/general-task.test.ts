/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are the task filesystem boundary. */
/* oxlint-disable ziggy/require-readable-spacing -- Fixtures keep task lifecycle evidence together. */
import { describe, expect, test } from "bun:test";
import {
  cancelGeneralTaskRun,
  finishGeneralTaskRun,
  makeGeneralTaskCandidate,
  makeGeneralTaskRun,
  resolveTaskInputs,
} from "../src/general-task.ts";

const task = {
  version: 1 as const,
  id: "search-jobs",
  name: "Search jobs",
  goal: "Find matching jobs",
  inputs: [
    {
      id: "search-url",
      description: "Exact filtered search URL",
      default: "https://example.test/jobs?q=effect",
    },
  ],
  startContext: { kind: "browser" as const, browserProfile: "jobs", urlInput: "search-url" },
  procedure: [
    "Open the exact filtered search URL.",
    "Inspect the result set with normal computer-use tools.",
  ],
  output: { format: "text" as const, description: "A concise result summary." },
  completionCriteria: [
    {
      id: "results-observed",
      description: "The result set was observed.",
      evidence: "tool-result" as const,
    },
  ],
};

describe("general task lifecycle", () => {
  test("resolves reusable defaults and hashes the exact candidate", () => {
    const candidate = makeGeneralTaskCandidate({ task, sourceDraftId: "draft-1" });
    const resolved = resolveTaskInputs(candidate.task, {});
    expect(resolved.inputs).toEqual({ "search-url": "https://example.test/jobs?q=effect" });
    expect(resolved.hash).toHaveLength(64);
    expect(() => resolveTaskInputs(candidate.task, { extra: "no" })).toThrow("Unknown task input");
  });

  test("requires every semantic criterion and labels observed facts separately", async () => {
    const candidate = makeGeneralTaskCandidate({ task, sourceDraftId: "draft-1" });
    const run = makeGeneralTaskRun({
      task: candidate.task,
      revision: candidate.candidateHash,
      candidateId: candidate.id,
      mode: "verification",
      sessionId: "session-1",
      inputsHash: resolveTaskInputs(candidate.task, {}).hash,
      now: new Date("2026-09-16T10:00:00.000Z"),
    });
    run.calls.push({
      sequence: 1,
      toolCallId: "observe-1",
      toolName: "observe_ui",
      startedAt: "2026-09-16T10:00:01.000Z",
      completedAt: "2026-09-16T10:00:02.000Z",
      status: "succeeded",
      input: { kind: "observe_ui", mode: "semantic" },
      issues: [],
    });
    await expect(
      finishGeneralTaskRun({ cwd: "/tmp", task: candidate.task, run, criteria: [] }),
    ).rejects.toThrow("Every completion criterion");
    const finished = await finishGeneralTaskRun({
      cwd: "/tmp",
      task: candidate.task,
      run,
      criteria: [
        {
          criterionId: "results-observed",
          outcome: "passed",
          toolCallIds: ["observe-1"],
          assessment: "The successful observation showed the expected result list.",
        },
      ],
    });
    expect(finished.state).toBe("passed");
    expect(finished.criteria[0]?.evidenceLabel).toBe("observed-tool-result");
  });

  test("cancellation retains pending calls as unknown", () => {
    const run = makeGeneralTaskRun({
      task,
      revision: "revision-1",
      mode: "run",
      sessionId: "session-1",
      inputsHash: resolveTaskInputs(task, {}).hash,
    });
    run.calls.push({
      sequence: 1,
      toolCallId: "action-1",
      toolName: "act_ui",
      startedAt: new Date().toISOString(),
      status: "pending",
      input: { kind: "withheld", reason: "unsupported-input" },
      issues: [],
    });
    expect(cancelGeneralTaskRun(run).calls[0]?.status).toBe("unknown");
  });
});
