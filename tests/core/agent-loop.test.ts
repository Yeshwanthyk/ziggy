import { describe, expect, test } from "bun:test";
import type {
  JsonObject,
  JsonValue,
  SessionEnvelope,
  SessionEvent,
} from "../../packages/protocol/src/index.ts";
import type { Context } from "../../packages/core/node_modules/@earendil-works/pi-ai";
import { createSessionRuntime } from "../../packages/core/src/index.ts";
import { SequenceIds } from "../testkit/boundaries.ts";
import { Barrier } from "../testkit/barrier.ts";
import {
  awaitingAbortStep,
  ScriptedProvider,
  terminalDefectStep,
  textStep,
  toolStep,
  type ScriptedStep,
} from "../testkit/provider/scripted.ts";
import { RecordingSessionWorld } from "../testkit/provider/session-world.ts";
import { ToolScheduler } from "../testkit/tool-scheduler.ts";

interface ToolExecutionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonObject;
  readonly signal: AbortSignal;
}

interface ToolExecutionResult {
  readonly output: JsonValue;
  readonly isError: boolean;
}

interface SessionTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  execute(input: ToolExecutionInput): Promise<JsonValue>;
}

interface ToolHookInput extends ToolExecutionInput {}

interface AfterToolHookInput extends ToolExecutionInput {
  readonly result: ToolExecutionResult;
}

interface SessionWorld {
  appendSession(sessionId: string, event: SessionEvent): Promise<SessionEnvelope>;
  readSession(sessionId: string, afterSeq: number): Promise<ReadonlyArray<SessionEnvelope>>;
}

const SNAPSHOT = {
  systemPrompt: "You are Ziggy.\n\n<memory>fixed fact</memory>",
  tools: [
    {
      name: "alpha",
      description: "Run alpha.",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    },
    {
      name: "beta",
      description: "Run beta.",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    },
  ],
};

function createTool(
  name: string,
  execute: (input: ToolExecutionInput) => Promise<JsonValue> = async () => ({ ok: true }),
): SessionTool {
  const frozen = SNAPSHOT.tools.find((tool) => tool.name === name);
  if (frozen === undefined) {
    throw new Error(`Missing frozen tool ${name}`);
  }
  return { ...frozen, execute };
}

async function createHarness(
  steps: ReadonlyArray<ScriptedStep>,
  options: {
    readonly world?: SessionWorld;
    readonly tools?: ReadonlyArray<SessionTool>;
    readonly beforeToolCall?: (input: ToolHookInput) => Promise<void>;
    readonly afterToolCall?: (
      input: AfterToolHookInput,
    ) => Promise<ToolExecutionResult | undefined>;
    readonly turnIds?: ReadonlyArray<string>;
    readonly stepIds?: ReadonlyArray<string>;
  } = {},
) {
  const provider = new ScriptedProvider(steps);
  const world = options.world ?? new RecordingSessionWorld();
  const turnIds = new SequenceIds(options.turnIds ?? ["turn-1", "turn-2", "turn-3"]);
  const stepIds = new SequenceIds(
    options.stepIds ?? ["step-1", "step-2", "step-3", "step-4", "step-5"],
  );
  const runtime = await createSessionRuntime({
    sessionId: "session-a",
    snapshot: SNAPSHOT,
    world,
    model: provider.model,
    streamSimple: provider.streamSimple,
    cacheRetention: "long",
    nextTurnId: () => turnIds.next(),
    nextStepId: () => stepIds.next(),
    tools: options.tools ?? [createTool("alpha"), createTool("beta")],
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
  });
  return { runtime, provider, world };
}

async function events(world: SessionWorld): Promise<ReadonlyArray<SessionEvent>> {
  return (await world.readSession("session-a", 0)).map((envelope) => envelope.event);
}

function messages(context: Context): ReadonlyArray<{
  readonly role: string;
  readonly text: string;
}> {
  return context.messages.map((message) => {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("");
      return { role: message.role, text };
    }
    if (message.role === "assistant") {
      return {
        role: message.role,
        text: message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join(""),
      };
    }
    return {
      role: message.role,
      text: message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join(""),
    };
  });
}

describe("public Session runtime agent loop", () => {
  test("records one text Turn as the canonical append-only event trace", async () => {
    const world = new RecordingSessionWorld();
    const { runtime } = await createHarness([textStep("Hello.", 100)], { world });

    expect(await runtime.startTurn({ message: "hello" })).toEqual({
      turnId: "turn-1",
      disposition: "started",
    });
    await runtime.waitForIdle();

    const envelopes = await world.readSession("session-a", 0);
    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(envelopes.map((envelope) => envelope.emittedAt)).toEqual([
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.001Z",
      "2026-07-19T00:00:00.002Z",
      "2026-07-19T00:00:00.003Z",
      "2026-07-19T00:00:00.004Z",
      "2026-07-19T00:00:00.005Z",
      "2026-07-19T00:00:00.006Z",
    ]);
    expect(envelopes.map((envelope) => envelope.event.type)).toEqual([
      "session-started",
      "turn-started",
      "step-started",
      "model-chunk",
      "model-response",
      "step-ended",
      "turn-ended",
    ]);
    expect(envelopes[3]?.event).toEqual({
      type: "model-chunk",
      sessionId: "session-a",
      turnId: "turn-1",
      stepId: "step-1",
      contentIndex: 0,
      kind: "text",
      delta: "Hello.",
    });
    expect(envelopes[4]?.event).toEqual({
      type: "model-response",
      sessionId: "session-a",
      turnId: "turn-1",
      stepId: "step-1",
      response: {
        api: "scripted",
        provider: "scripted",
        model: "scripted-model",
        content: [{ type: "text", text: "Hello." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "stop",
        timestamp: 100,
      },
    });
    expect(envelopes[5]?.event).toEqual({
      type: "step-ended",
      sessionId: "session-a",
      turnId: "turn-1",
      stepId: "step-1",
      status: "completed",
    });
    expect(envelopes[6]?.event).toEqual({
      type: "turn-ended",
      sessionId: "session-a",
      turnId: "turn-1",
      status: "completed",
    });
  });

  test("passes explicit cache identity and stable prompt/tool order with log-projected history", async () => {
    const { runtime, provider } = await createHarness([
      textStep("first answer", 100),
      textStep("second answer", 200),
    ]);

    await runtime.startTurn({ message: "first question" });
    await runtime.waitForIdle();
    await runtime.startTurn({ message: "second question" });
    await runtime.waitForIdle();

    expect(provider.calls.map((call) => call.options)).toEqual([
      { sessionId: "session-a", cacheRetention: "long" },
      { sessionId: "session-a", cacheRetention: "long" },
    ]);
    expect(provider.calls.map((call) => call.context.systemPrompt)).toEqual([
      SNAPSHOT.systemPrompt,
      SNAPSHOT.systemPrompt,
    ]);
    expect(provider.calls.map((call) => call.context.tools)).toEqual([
      SNAPSHOT.tools.map(({ inputSchema, ...tool }) => ({ ...tool, parameters: inputSchema })),
      SNAPSHOT.tools.map(({ inputSchema, ...tool }) => ({ ...tool, parameters: inputSchema })),
    ]);
    expect(provider.calls.map((call) => messages(call.context))).toEqual([
      [{ role: "user", text: "first question" }],
      [
        { role: "user", text: "first question" },
        { role: "assistant", text: "first answer" },
        { role: "user", text: "second question" },
      ],
    ]);
  });

  test.each([
    ["missing terminal", terminalDefectStep("missing-terminal", 100)],
    ["iterator throw", terminalDefectStep("iterator-throw", 100)],
    ["stream throw", { kind: "throw", error: new Error("stream exploded") } satisfies ScriptedStep],
  ])("closes a Turn as failed after a Provider %s", async (_name, step) => {
    const { runtime, world } = await createHarness([step]);

    await runtime.startTurn({ message: "fail safely" });
    await runtime.waitForIdle();

    const recorded = await events(world);
    expect(recorded.filter((event) => event.type === "step-ended")).toEqual([
      {
        type: "step-ended",
        sessionId: "session-a",
        turnId: "turn-1",
        stepId: "step-1",
        status: "failed",
      },
    ]);
    expect(recorded.filter((event) => event.type === "turn-ended")).toEqual([
      {
        type: "turn-ended",
        sessionId: "session-a",
        turnId: "turn-1",
        status: "failed",
      },
    ]);
  });

  test("executes tools concurrently but durably appends results in source order", async () => {
    const scheduler = new ToolScheduler();
    const calls = [
      { id: "call-a", name: "alpha", arguments: { value: "A" } },
      { id: "call-b", name: "beta", arguments: { value: "B" } },
    ];
    const { runtime, world } = await createHarness([toolStep(calls, 100), textStep("done", 200)], {
      tools: [
        createTool("alpha", async () => {
          await scheduler.run("alpha");
          return { value: "A" };
        }),
        createTool("beta", async () => {
          await scheduler.run("beta");
          return { value: "B" };
        }),
      ],
    });

    await runtime.startTurn({ message: "run both" });
    await scheduler.waitForStarted(["alpha", "beta"]);
    scheduler.complete("beta");
    await Promise.resolve();
    scheduler.complete("alpha");
    await runtime.waitForIdle();

    expect(scheduler.completionOrder).toEqual(["beta", "alpha"]);
    expect(
      (await events(world))
        .filter((event) => event.type === "tool-result")
        .map((event) => ({ toolCallId: event.toolCallId, sourceIndex: event.sourceIndex })),
    ).toEqual([
      { toolCallId: "call-a", sourceIndex: 0 },
      { toolCallId: "call-b", sourceIndex: 1 },
    ]);
  });

  test("runs before/after tool hooks around execution and persists the finalized result", async () => {
    const hookTrace: string[] = [];
    const { runtime, world } = await createHarness(
      [
        toolStep([{ id: "call-a", name: "alpha", arguments: { value: "A" } }], 100),
        textStep("done", 200),
      ],
      {
        tools: [
          createTool("alpha", async () => {
            hookTrace.push("execute");
            return { raw: true };
          }),
          createTool("beta"),
        ],
        beforeToolCall: async (input) => {
          hookTrace.push(`before:${input.toolCallId}`);
        },
        afterToolCall: async (input) => {
          hookTrace.push(`after:${input.toolCallId}:${String(input.result.isError)}`);
          return { output: { finalized: true }, isError: false };
        },
      },
    );

    await runtime.startTurn({ message: "hook it" });
    await runtime.waitForIdle();

    expect(hookTrace).toEqual(["before:call-a", "execute", "after:call-a:false"]);
    expect((await events(world)).filter((event) => event.type === "tool-result")).toEqual([
      {
        type: "tool-result",
        sessionId: "session-a",
        turnId: "turn-1",
        stepId: "step-1",
        toolCallId: "call-a",
        output: { finalized: true },
        isError: false,
        sourceIndex: 0,
      },
    ]);
  });

  test("accepts steer during a tool barrier for the next model call and rejects stale Turn ids silently", async () => {
    const scheduler = new ToolScheduler();
    const { runtime, provider, world } = await createHarness(
      [toolStep([{ id: "call-a", name: "alpha", arguments: {} }], 100), textStep("steered", 200)],
      {
        tools: [
          createTool("alpha", async () => {
            await scheduler.run("alpha");
            return { ok: true };
          }),
          createTool("beta"),
        ],
      },
    );

    await runtime.startTurn({ message: "begin" });
    await scheduler.waitForStarted(["alpha"]);
    expect(await runtime.steer({ expectedTurnId: "turn-1", message: "change direction" })).toEqual({
      turnId: "turn-1",
    });
    const beforeStale = (await world.readSession("session-a", 0)).length;
    await expect(
      runtime.steer({ expectedTurnId: "turn-stale", message: "wrong Turn" }),
    ).rejects.toThrow();
    expect((await world.readSession("session-a", 0)).length).toBe(beforeStale);
    scheduler.complete("alpha");
    await runtime.waitForIdle();

    expect(messages(provider.calls[1]?.context ?? { messages: [] })).toContainEqual({
      role: "user",
      text: "change direction",
    });
    expect((await events(world)).filter((event) => event.type === "steer-received")).toEqual([
      {
        type: "steer-received",
        sessionId: "session-a",
        turnId: "turn-1",
        message: "change direction",
      },
    ]);
  });

  test("queues one-at-a-time follow-ups and auto-starts each after the previous Turn", async () => {
    const firstCall = new Barrier();
    const first = textStep("one", 100);
    if (first.kind !== "events") {
      throw new Error("Expected text event step");
    }
    const { runtime, provider, world } = await createHarness(
      [{ ...first, barrier: firstCall }, textStep("two", 200), textStep("three", 300)],
      { turnIds: ["turn-1", "turn-2", "turn-3"] },
    );

    const active = await runtime.startTurn({ message: "first" });
    await provider.waitForCalls(1);
    const second = await runtime.startTurn({ message: "second" });
    const third = await runtime.startTurn({ message: "third" });
    expect([active.disposition, second.disposition, third.disposition]).toEqual([
      "started",
      "queued",
      "queued",
    ]);
    firstCall.release();
    await runtime.waitForIdle();

    expect(provider.calls.map((call) => messages(call.context).at(-1))).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "second" },
      { role: "user", text: "third" },
    ]);
    const recorded = await events(world);
    expect(
      recorded
        .filter((event) => event.type === "follow-up-received")
        .map((event) => ({ turnId: event.turnId, message: event.message })),
    ).toEqual([
      { turnId: "turn-1", message: "second" },
      { turnId: "turn-1", message: "third" },
    ]);
    expect(
      recorded
        .filter((event) => event.type === "turn-started")
        .map((event) => ({ turnId: event.turnId, message: event.message, origin: event.origin })),
    ).toEqual([
      { turnId: "turn-1", message: "first", origin: "user" },
      { turnId: "turn-2", message: "second", origin: "follow-up" },
      { turnId: "turn-3", message: "third", origin: "follow-up" },
    ]);
  });

  test("interrupts only the expected active Turn and closes it as interrupted", async () => {
    const { runtime, provider, world } = await createHarness([awaitingAbortStep(100)]);

    await runtime.startTurn({ message: "keep going" });
    await provider.waitForCalls(1);
    expect(await runtime.interrupt({ expectedTurnId: "turn-1" })).toEqual({ turnId: "turn-1" });
    await runtime.waitForIdle();

    const recorded = await events(world);
    expect(recorded.filter((event) => event.type === "interrupt-received")).toEqual([
      { type: "interrupt-received", sessionId: "session-a", turnId: "turn-1" },
    ]);
    expect(recorded.filter((event) => event.type === "step-ended").at(-1)).toMatchObject({
      status: "interrupted",
    });
    expect(recorded.filter((event) => event.type === "turn-ended").at(-1)).toMatchObject({
      status: "interrupted",
    });
  });

  test("atomically bridges replay into live subscription without a gap or duplicate", async () => {
    const replayBarrier = new Barrier();
    const stored = new RecordingSessionWorld();
    let firstRead = true;
    const world: SessionWorld = {
      appendSession: (sessionId, event) => stored.appendSession(sessionId, event),
      async readSession(sessionId, afterSeq) {
        const replay = await stored.readSession(sessionId, afterSeq);
        if (firstRead) {
          firstRead = false;
          await replayBarrier.wait();
        }
        return replay;
      },
    };
    const responseBarrier = new Barrier();
    const response = textStep("live", 100);
    if (response.kind !== "events") {
      throw new Error("Expected text event step");
    }
    const { runtime } = await createHarness([{ ...response, barrier: responseBarrier }], { world });
    const received: SessionEnvelope[] = [];

    const subscribing = runtime.subscribe({
      sinceSeq: 0,
      onEnvelope: (envelope: SessionEnvelope) => {
        received.push(envelope);
      },
    });
    await replayBarrier.entered;
    const starting = runtime.startTurn({ message: "during replay" });
    replayBarrier.release();
    const [subscription] = await Promise.all([subscribing, starting]);
    responseBarrier.release();
    await runtime.waitForIdle();
    subscription.unsubscribe();

    const durable = await stored.readSession("session-a", 0);
    expect(subscription.replayThroughSeq).toBe(1);
    expect([...received]).toEqual([...durable]);
    expect(received.map((envelope) => envelope.seq)).toEqual(
      durable.map((envelope) => envelope.seq),
    );
    expect(new Set(received.map((envelope) => envelope.seq)).size).toBe(received.length);
  });
});
