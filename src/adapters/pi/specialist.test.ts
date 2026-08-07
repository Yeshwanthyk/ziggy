import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Value } from "typebox/value";
import { SpecialistModelUnsupported } from "../../domain/agent";
import {
  agentRunParameters,
  createAgentRunTool,
  renderAgentRunCall,
  renderAgentRunResult,
  type SpecialistRunResult,
  type SpecialistRunner,
} from "./specialist";

const result: SpecialistRunResult = {
  answer: "delegated answer",
  agent: "research-helper",
  provider: "anthropic",
  model: "claude-sonnet",
  thinking: "high",
  tools: ["read"],
  usage: {
    input: 12,
    output: 8,
    cacheRead: 2,
    cacheWrite: 0,
    total: 20,
    cost: 0.001,
  },
};

const invoke = async (
  tool: ReturnType<typeof createAgentRunTool>,
  input: unknown,
  signal?: AbortSignal,
) => tool.execute("call-1", input, signal);

describe("agent_run TUI tool", () => {
  test("passes strict input to a fake runner and returns exact metadata", async () => {
    const calls: Array<unknown> = [];
    const runner: SpecialistRunner = {
      run: (input) => {
        calls.push(input);
        return Effect.succeed(result);
      },
    };
    const tool = createAgentRunTool(runner);

    const response = await invoke(tool, {
      agent: "research-helper",
      prompt: "Find the answer",
      thinking: "high",
      tools: ["read"],
    });

    expect(calls).toEqual([
      {
        agent: "research-helper",
        prompt: "Find the answer",
        thinking: "high",
        tools: ["read"],
      },
    ]);
    expect(response).toEqual({
      content: [{ type: "text", text: "delegated answer" }],
      details: { result },
    });
  });

  test("rejects extra fields before invoking the runner", async () => {
    let calls = 0;
    const runner: SpecialistRunner = {
      run: () => {
        calls += 1;
        return Effect.succeed(result);
      },
    };

    const response = await invoke(createAgentRunTool(runner), {
      agent: "research-helper",
      prompt: "Find the answer",
      unexpected: true,
    });

    expect(calls).toBe(0);
    expect(response).toEqual({
      content: [{ type: "text", text: "ERROR: invalid agent_run input" }],
      details: { error: "invalid input" },
    });
  });

  test("returns typed runner failures as tool errors", async () => {
    const runner: SpecialistRunner = {
      run: () =>
        Effect.fail(
          new SpecialistModelUnsupported({
            profilePath: "/profile",
            providerId: "anthropic",
            modelId: "missing",
            message: "model is not configured",
          }),
        ),
    };

    const response = await invoke(createAgentRunTool(runner), {
      agent: "research-helper",
      prompt: "Find the answer",
    });

    expect(response).toEqual({
      content: [{ type: "text", text: "ERROR: model is not configured" }],
      details: { error: "model is not configured" },
    });
  });

  test("renders compact and expanded result details", () => {
    expect(renderAgentRunCall({ agent: "research-helper", prompt: "Find the answer" })).toBe(
      "agent_run → research-helper: Find the answer",
    );
    expect(renderAgentRunResult({ result }, false)).toBe(
      "agent_run ← research-helper · anthropic/claude-sonnet · high · 20 tok · $0.0010",
    );
    expect(renderAgentRunResult({ result }, true)).toBe(
      [
        "agent_run ← research-helper",
        "model: anthropic/claude-sonnet",
        "thinking: high",
        "tools: read",
        "usage: 12 in · 8 out · 20 tok · $0.0010",
        "",
        "delegated answer",
      ].join("\\n"),
    );
  });

  test("publishes a strict TypeBox schema", () => {
    expect(
      Value.Check(agentRunParameters, {
        agent: "research-helper",
        prompt: "Find the answer",
        unexpected: true,
      }),
    ).toBe(false);
  });
});
