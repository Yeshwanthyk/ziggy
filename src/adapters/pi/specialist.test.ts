/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { Value } from "typebox/value";
import { SpecialistModelUnsupported } from "../../domain/agent";
import type { ProfileAgent } from "../../domain/profile";
import { Type } from "typebox";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  agentRunParameters,
  createAgentRunTool,
  renderAgentRunCall,
  renderAgentRunResult,
  selectSpecialist,
  usageFromMessages,
  useSpecialistChild,
  type MakeSpecialistRunnerOptions,
  type SpecialistSelectionParent,
  type SpecialistChildRuntime,
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
    totalTokens: 20,
    cost: {
      input: 0.0008,
      output: 0.0002,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.001,
    },
  },
};

const invoke = async (
  tool: ReturnType<typeof createAgentRunTool>,
  input: unknown,
  signal?: AbortSignal,
) => tool.execute("call-1", input, signal);

const makeModel = (
  provider: string,
  id: string,
  reasoning: boolean,
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"],
): Model<Api> => ({
  id,
  name: id,
  api: "openai-completions",
  provider,
  baseUrl: "https://example.test",
  reasoning,
  ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const failure = Cause.findError(exit.cause);
  expect(Result.isSuccess(failure)).toBe(true);
  if (!Result.isSuccess(failure)) throw new Error("expected a typed failure");
  return failure.success;
};

type ToolInfo = ReturnType<AgentSession["getAllTools"]>[number];

const makeSelectionHarness = (agent: ProfileAgent, parentModel: Model<Api>, model: Model<Api>) => {
  const tools: ReadonlyArray<ToolInfo> = [
    {
      name: "read",
      description: "",
      parameters: Type.Object({}),
      sourceInfo: { path: "", source: "", scope: "user", origin: "top-level" },
    },
  ];
  const parent: SpecialistSelectionParent = {
    session: {
      model: parentModel,
      thinkingLevel: "off",
      getAllTools: () => [...tools],
    },
    services: {
      modelRuntime: {
        getProvider: (id: string) => (id.length === 0 ? undefined : { id }),
        getModel: (provider: string, id: string) =>
          provider === model.provider && id === model.id ? model : undefined,
        hasConfiguredAuth: () => true,
      },
    },
  };
  const options: Pick<MakeSpecialistRunnerOptions, "profilePath" | "agents"> = {
    profilePath: "/profile",
    agents: [agent],
  };
  return { options, parent };
};

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
    });

    expect(calls).toEqual([
      {
        agent: "research-helper",
        prompt: "Find the answer",
      },
    ]);
    expect(response).toEqual({
      content: [{ type: "text", text: "delegated answer" }],
      details: { result },
      usage: result.usage,
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
      ].join("\n"),
    );
  });

  test("publishes a strict TypeBox schema", () => {
    expect(
      Value.Check(agentRunParameters, {
        agent: "research-helper",
        prompt: "Find the answer",
        provider: "not-public",
      }),
    ).toBe(false);
  });

  test("inherits omitted Profile policy and keeps omitted tools empty", async () => {
    const parentModel = makeModel("parent", "parent-model", false);
    const { options, parent } = makeSelectionHarness(
      {
        id: "research-helper",
        version: 1,
        description: "Researches carefully",
        body: "Research instructions",
      },
      parentModel,
      parentModel,
    );

    const selected = await Effect.runPromise(
      selectSpecialist(options, { agent: "research-helper", prompt: "Find" }, parent),
    );
    expect(selected).toMatchObject({
      agent: { id: "research-helper" },
      model: { provider: "parent", id: "parent-model" },
      thinking: "off",
      tools: [],
    });
  });

  test("uses authoritative provider, model, thinking, and tool policy from the Profile file", async () => {
    const parentModel = makeModel("parent", "parent-model", false);
    const specialistModel = makeModel("specialist", "specialist-model", true);
    const { options, parent } = makeSelectionHarness(
      {
        id: "research-helper",
        version: 1,
        description: "Researches carefully",
        provider: "specialist",
        model: "specialist-model",
        thinking: "high",
        tools: ["read"],
        body: "Research instructions",
      },
      parentModel,
      specialistModel,
    );

    const selected = await Effect.runPromise(
      selectSpecialist(options, { agent: "research-helper", prompt: "Find" }, parent),
    );
    expect(selected).toMatchObject({
      model: { provider: "specialist", id: "specialist-model" },
      thinking: "high",
      tools: ["read"],
    });
  });

  test("lets internal callers disable all tools but never expand the Profile allowlist", async () => {
    const model = makeModel("parent", "parent-model", false);
    const { options, parent } = makeSelectionHarness(
      {
        id: "research-helper",
        version: 1,
        description: "Researches carefully",
        tools: ["read"],
        body: "Research instructions",
      },
      model,
      model,
    );

    const narrowed = await Effect.runPromise(
      selectSpecialist(
        options,
        { agent: "research-helper", prompt: "Find", allowedTools: [] },
        parent,
      ),
    );
    expect(narrowed.tools).toEqual([]);

    const expanded = await Effect.runPromiseExit(
      selectSpecialist(
        options,
        { agent: "research-helper", prompt: "Find", allowedTools: ["write"] },
        parent,
      ),
    );
    expect(failureOf(expanded)).toMatchObject({
      _tag: "SpecialistToolUnsupported",
      toolName: "write",
    });
  });

  test("fails every blocked or unavailable declared tool instead of dropping it", async () => {
    const model = makeModel("parent", "parent-model", false);
    for (const toolName of ["memory_write", "agent_run", "discussion_start", "missing"]) {
      const { options, parent } = makeSelectionHarness(
        {
          id: "research-helper",
          version: 1,
          description: "Researches carefully",
          tools: [toolName],
          body: "Research instructions",
        },
        model,
        model,
      );
      const selected = await Effect.runPromiseExit(
        selectSpecialist(options, { agent: "research-helper", prompt: "Find" }, parent),
      );
      expect(failureOf(selected)).toMatchObject({ _tag: "SpecialistToolUnsupported", toolName });
    }
  });

  test("validates thinking with Pi's supported-level API", async () => {
    const model = makeModel("parent", "parent-model", false);
    const { options, parent } = makeSelectionHarness(
      {
        id: "research-helper",
        version: 1,
        description: "Researches carefully",
        thinking: "high",
        body: "Research instructions",
      },
      model,
      model,
    );
    const selected = await Effect.runPromiseExit(
      selectSpecialist(options, { agent: "research-helper", prompt: "Find" }, parent),
    );
    expect(failureOf(selected)).toMatchObject({
      _tag: "SpecialistThinkingUnsupported",
      thinking: "high",
    });
  });

  test("interruption disposes the child runtime through the runner lifecycle", async () => {
    let disposals = 0;
    const model = makeModel("parent", "parent-model", false);
    const runtime: SpecialistChildRuntime = {
      session: {
        model,
        thinkingLevel: "off",
        getActiveToolNames: () => [],
        messages: [],
      },
      dispose: async () => {
        disposals += 1;
      },
    };
    const fiber = Effect.runFork(
      useSpecialistChild(
        "/profile",
        Effect.succeed(runtime),
        {
          agent: {
            id: "research-helper",
            version: 1,
            description: "Researches carefully",
            body: "Research instructions",
          },
          model,
        },
        () => Effect.never,
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(disposals).toBe(1);
  });

  test("aggregates assistant and nested tool-result Pi usage without changing its shape", () => {
    const assistantUsage = {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      totalTokens: 14,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const toolUsage = {
      input: 6,
      output: 7,
      cacheRead: 8,
      cacheWrite: 9,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 30,
      cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
    };
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: assistantUsage,
      stopReason: "stop",
      timestamp: 0,
    };
    const toolResultMessage: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [],
      usage: toolUsage,
      isError: false,
      timestamp: 0,
    };
    expect(usageFromMessages([assistantMessage, toolResultMessage])).toEqual({
      input: 8,
      output: 10,
      cacheRead: 12,
      cacheWrite: 14,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 44,
      cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
    });
  });
});
