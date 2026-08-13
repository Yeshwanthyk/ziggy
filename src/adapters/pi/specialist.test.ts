/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { Value } from "typebox/value";
import { SpecialistModelUnsupported } from "../../domain/agent";
import type { ProfileAgent } from "../../domain/profile";
import { Type } from "typebox";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  DISCUSSION_ANSWER_MAX_CODE_POINTS,
  DISCUSSION_PROMPT_MAX_CODE_POINTS,
  addUsage,
  agentRunParameters,
  createAgentDiscussTool,
  createAgentRunTool,
  discussionParameters,
  discussionToolDetailsSchema,
  renderAgentDiscussCall,
  renderAgentDiscussResult,
  renderAgentRunCall,
  renderAgentRunResult,
  selectSpecialist,
  usageFromMessages,
  useSpecialistChild,
  type AgentRunInput,
  type MakeSpecialistRunnerOptions,
  type SpecialistSelectionParent,
  type SpecialistChildRuntime,
  type SpecialistRunResult,
  type SpecialistRunner,
} from "./specialist";

const childSession = { id: "child-session", file: "/profile/sessions/child.jsonl" };

const result: SpecialistRunResult = {
  answer: "delegated answer",
  session: childSession,
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
  input: AgentRunInput,
  signal?: AbortSignal,
) => tool.execute("call-1", input, signal);

const discussionUsage = (value: number) => ({
  input: value,
  output: value + 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: value + value + 1,
  cost: {
    input: value / 1000,
    output: (value + 1) / 1000,
    cacheRead: 0,
    cacheWrite: 0,
    total: (value * 2 + 1) / 1000,
  },
});

const discussionChildResult = (
  agent: string,
  answer: string,
  value: number,
): SpecialistRunResult => ({
  answer,
  session: { id: `${agent}-session`, file: `/profile/sessions/${agent}.jsonl` },
  agent,
  provider: "test-provider",
  model: "test-model",
  thinking: "off",
  tools: [],
  usage: discussionUsage(value),
});

const makeModel = (
  provider: string,
  id: string,
  reasoning: boolean,
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"],
): Model<Api> => {
  const model: Model<Api> = {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  if (thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = thinkingLevelMap;
  }
  return model;
};

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
  const tools: ReadonlyArray<ToolInfo> = ["read", "memory_write", "agent_run", "agent_discuss"].map(
    (name) => ({
      name,
      description: "",
      parameters: Type.Object({}),
      sourceInfo: { path: "", source: "", scope: "user", origin: "top-level" },
    }),
  );
  const parent: SpecialistSelectionParent = {
    session: {
      model: parentModel,
      thinkingLevel: "off",
      getAllTools: () => [...tools],
      sessionManager: SessionManager.inMemory("/profile"),
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

    const tool = createAgentRunTool(runner);
    const response = await tool.execute("call-1", {
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
        "child session: child-session",
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
      reference: childSession,
      session: {
        model,
        thinkingLevel: "off",
        getActiveToolNames: () => [],
        messages: [],
        abort: async () => undefined,
        isIdle: false,
        prompt: async () => undefined,
        subscribe: () => () => undefined,
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

describe("agent_discuss TUI tool", () => {
  test("publishes a strict bounded schema and rejects duplicates", async () => {
    const calls: unknown[] = [];
    const runner: SpecialistRunner = {
      run: (request) => {
        calls.push(request);
        return Effect.succeed(discussionChildResult(request.agent, "answer", 1));
      },
    };
    expect(
      Value.Check(discussionParameters, {
        topic: "topic",
        agents: ["one", "two"],
        rounds: 1,
        extra: true,
      }),
    ).toBe(false);
    const response = await createAgentDiscussTool(runner).execute("call", {
      topic: "topic",
      agents: ["one", "one"],
    });
    expect(calls).toHaveLength(0);
    expect(response).toEqual({
      content: [{ type: "text", text: "ERROR: agent_discuss requires unique Profile agent ids" }],
      details: { error: "agent ids must be unique" },
    });
  });

  test("runs sorted participants in one round with no child tools", async () => {
    const calls: Array<{ agent: string; prompt: string; allowedTools?: ReadonlyArray<string> }> =
      [];
    const runner: SpecialistRunner = {
      run: (request) => {
        calls.push(request);
        return Effect.succeed(discussionChildResult(request.agent, `${request.agent} says yes`, 2));
      },
    };
    const response = await createAgentDiscussTool(runner).execute("call", {
      topic: "Should we choose tea?",
      agents: ["zeta", "alpha"],
    });
    expect(calls.map((call) => call.agent)).toEqual(["alpha", "zeta"]);
    expect(calls.every((call) => call.allowedTools?.length === 0)).toBe(true);
    expect(
      calls.every(
        (call) => call.prompt.includes("Role:") && call.prompt.includes("Should we choose tea?"),
      ),
    ).toBe(true);
    expect(response.usage).toEqual({
      input: 4,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    });
    const content = response.content[0];
    expect(content?.type === "text" ? content.text : "").toContain("Synthesize the final answer");
  });

  test("runs two bounded rounds and wires the same bounded prior transcript to every second turn", async () => {
    const calls: Array<{ agent: string; prompt: string; allowedTools?: ReadonlyArray<string> }> =
      [];
    const longAnswer = "🙂".repeat(DISCUSSION_ANSWER_MAX_CODE_POINTS + 100);
    const runner: SpecialistRunner = {
      run: (request) => {
        calls.push(request);
        return Effect.succeed(discussionChildResult(request.agent, longAnswer, 1));
      },
    };
    const response = await createAgentDiscussTool(runner).execute("call", {
      topic: "x".repeat(5_000),
      agents: ["beta", "alpha"],
      rounds: 2,
    });
    expect(calls.map((call) => call.agent)).toEqual(["alpha", "beta", "alpha", "beta"]);
    expect(
      calls.every((call) => Array.from(call.prompt).length <= DISCUSSION_PROMPT_MAX_CODE_POINTS),
    ).toBe(true);
    expect(calls[2]?.prompt).toContain("[alpha]");
    expect(calls[2]?.prompt).toContain("[beta]");
    expect(calls[2]?.prompt.split("Bounded first-round answers from the group:\n")[1]).toBe(
      calls[3]?.prompt.split("Bounded first-round answers from the group:\n")[1],
    );
    expect(Value.Check(discussionToolDetailsSchema, response.details)).toBe(true);
    if (!Value.Check(discussionToolDetailsSchema, response.details)) {
      throw new Error("expected discussion details");
    }
    expect(response.details.result?.rounds).toHaveLength(2);
    expect(
      response.details.result?.rounds
        .flatMap((round) => round.participants)
        .every(
          (participant) =>
            Array.from(participant.answer).length <= DISCUSSION_ANSWER_MAX_CODE_POINTS,
        ),
    ).toBe(true);
    expect(response.usage?.totalTokens).toBe(12);
    const content = response.content[0];
    expect(content?.type === "text" ? Array.from(content.text).length : 0).toBeLessThanOrEqual(
      8_000,
    );
  });

  test("stops on the first typed runner failure", async () => {
    let calls = 0;
    const runner: SpecialistRunner = {
      run: (request) => {
        calls += 1;
        return request.agent === "alpha"
          ? Effect.fail(
              new SpecialistModelUnsupported({
                profilePath: "/profile",
                providerId: "test",
                modelId: "missing",
                message: "model failed",
              }),
            )
          : Effect.succeed(discussionChildResult(request.agent, "answer", 1));
      },
    };
    const response = await createAgentDiscussTool(runner).execute("call", {
      topic: "topic",
      agents: ["alpha", "beta"],
      rounds: 2,
    });
    expect(calls).toBe(1);
    expect(response).toEqual({
      content: [{ type: "text", text: "ERROR: model failed" }],
      details: { error: "model failed" },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  });

  test("keeps exact usage from completed children when a later child fails", async () => {
    const runner: SpecialistRunner = {
      run: (request) =>
        request.agent === "beta"
          ? Effect.fail(
              new SpecialistModelUnsupported({
                profilePath: "/profile",
                providerId: "test",
                modelId: "missing",
                message: "later model failed",
              }),
            )
          : Effect.succeed(discussionChildResult(request.agent, "answer", 3)),
    };
    const response = await createAgentDiscussTool(runner).execute("call", {
      topic: "topic",
      agents: ["alpha", "beta"],
    });
    expect(response).toEqual({
      content: [{ type: "text", text: "ERROR: later model failed" }],
      details: { error: "later model failed" },
      usage: discussionUsage(3),
    });
  });

  test("rejects a whitespace-only topic before invoking a child", async () => {
    let calls = 0;
    const runner: SpecialistRunner = {
      run: () => {
        calls += 1;
        return Effect.succeed(discussionChildResult("alpha", "answer", 1));
      },
    };
    const response = await createAgentDiscussTool(runner).execute("call", {
      topic: " \t\n ",
      agents: ["alpha", "beta"],
    });
    expect(calls).toBe(0);
    expect(response).toEqual({
      content: [
        { type: "text", text: "ERROR: agent_discuss topic must contain non-whitespace characters" },
      ],
      details: { error: "topic must contain non-whitespace characters" },
    });
  });

  test("propagates cancellation to every child runner", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runner: SpecialistRunner = {
      run: (_request, signal) => {
        receivedSignal = signal;
        return Effect.never;
      },
    };
    const promise = createAgentDiscussTool(runner).execute(
      "call",
      { topic: "topic", agents: ["alpha", "beta"] },
      controller.signal,
    );
    controller.abort();
    await expect(promise).rejects.toBeDefined();
    expect(receivedSignal).toBe(controller.signal);
  });

  test("renders participants, rounds, model calls, usage, and a newline transcript", () => {
    const details = {
      result: {
        topic: "topic",
        rounds: [
          {
            round: 1 as const,
            participants: [discussionChildResult("alpha", "first\nline", 2)],
          },
        ],
        usage: discussionUsage(2),
      },
    };
    expect(renderAgentDiscussCall({ topic: "topic", agents: ["beta", "alpha"] })).toContain(
      "alpha, beta",
    );
    expect(renderAgentDiscussResult(details, false)).toContain("1 model calls");
    expect(renderAgentDiscussResult(details, true)).toContain("first\nline");
    expect(addUsage(discussionUsage(1), discussionUsage(2))).toEqual({
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0.003, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.008 },
    });
  });
});
