import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  createMemoryTool,
  openSession,
  resumeFilesystemSession,
  type FilesystemWorld,
  type SessionRuntime,
  type SessionTool,
} from "../../packages/core/src/index.ts";
import type {
  FrozenSessionSnapshot,
  FrozenTool,
  JsonObject,
  JsonValue,
  SessionEnvelope,
} from "../../packages/protocol/src/index.ts";
import { SequenceIds } from "../testkit/boundaries.ts";
import { Barrier } from "../testkit/barrier.ts";
import {
  ScriptedProvider,
  textStep,
  toolStep,
  type ScriptedStep,
} from "../testkit/provider/scripted.ts";

const profiles: string[] = [];
const BASE_PROMPT = "You are Ziggy.";

interface RuntimeFixture {
  readonly profile: string;
  readonly world: FilesystemWorld;
  readonly provider: ScriptedProvider;
  readonly runtime: SessionRuntime;
}

describe("S1 filesystem production composition", () => {
  test("runs one full text Turn against the filesystem with exact durable envelopes and replay", async () => {
    const fixture = await createRuntimeFixture("text-session", [textStep("Hello.", 100)]);

    expect(await fixture.runtime.startTurn({ message: "hello" })).toEqual({
      turnId: "turn-1",
      disposition: "started",
    });
    await fixture.runtime.waitForIdle();

    const replay = await fixture.world.readSession("text-session", 0);
    const snapshot = requireStartedSnapshot(replay);
    expect(replay).toEqual(expectedTextTurn(snapshot));
    expect(await readFile(sessionPath(fixture.profile, "text-session"), "utf8")).toBe(
      replay.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n",
    );
    expect(await fixture.world.readSession("text-session", 0)).toEqual(replay);
    expect(await fixture.world.readSession("text-session", replay.length)).toEqual([]);
  });

  test("atomically starts one Session across concurrent openSession and runtime creation", async () => {
    const profile = await createProfile("atomic-start");
    const firstWorld = deterministicWorld(profile);
    const secondWorld = deterministicWorld(profile);
    const memory = createMemoryTool(firstWorld);
    const frozenTools = freezeTools([memory]);
    const directSnapshot: FrozenSessionSnapshot = {
      systemPrompt: "first persisted snapshot",
      tools: frozenTools,
    };
    expect(await firstWorld.startSession("direct-session", directSnapshot)).toEqual({
      snapshot: directSnapshot,
      created: true,
    });
    expect(
      await secondWorld.startSession("direct-session", {
        systemPrompt: "must lose",
        tools: [],
      }),
    ).toEqual({ snapshot: directSnapshot, created: false });
    const provider = new ScriptedProvider([]);

    const opened = openSession({
      world: firstWorld,
      sessionId: "shared-session",
      baseSystemPrompt: BASE_PROMPT,
      tools: frozenTools,
    });
    const created = createFilesystemSessionRuntime({
      world: secondWorld,
      sessionId: "shared-session",
      baseSystemPrompt: BASE_PROMPT,
      tools: [],
      model: provider.model,
      streamSimple: provider.streamSimple,
      cacheRetention: "long",
      nextTurnId: sequence(["turn-runtime"]),
      nextStepId: sequence(["step-runtime"]),
    });
    const [snapshot, runtime] = await Promise.all([opened, created]);

    const replay = await firstWorld.readSession("shared-session", 0);
    expect(replay.filter((envelope) => envelope.event.type === "session-started")).toHaveLength(1);
    expect(requireStartedSnapshot(replay)).toEqual(snapshot);
    await runtime.close();
  });

  test("the actual Memory tool updates Memory while Session snapshots remain frozen", async () => {
    const profile = await createProfile("memory-freeze");
    const world = deterministicWorld(profile);
    await world.replaceMemoryBatch([{ document: "MEMORY.md", content: "original fact" }]);
    const currentProvider = new ScriptedProvider([
      toolStep(
        [
          {
            id: "memory-call",
            name: "memory",
            arguments: {
              operations: [
                {
                  action: "replace",
                  target: "memory",
                  oldText: "original fact",
                  content: "updated fact",
                },
              ],
            },
          },
        ],
        100,
      ),
      textStep("remembered", 200),
    ]);
    const current = await composedRuntime(
      world,
      "current-session",
      currentProvider,
      ["turn-current"],
      ["step-tool", "step-text"],
    );

    await current.startTurn({ message: "update Memory" });
    await current.waitForIdle();
    expect(await world.readMemory("MEMORY.md")).toBe("updated fact");
    expect(
      (await world.readSession("current-session", 0))
        .filter((envelope) => envelope.event.type === "tool-result")
        .map((envelope) => envelope.event),
    ).toContainEqual(
      expect.objectContaining({
        isError: false,
        output: expect.objectContaining({ success: true }),
      }),
    );
    expect(currentProvider.calls.map((call) => call.context.systemPrompt)).toEqual([
      expect.stringContaining("original fact"),
      expect.stringContaining("original fact"),
    ]);
    expect(currentProvider.calls[1]?.context.systemPrompt).not.toContain("updated fact");
    await current.close();

    const nextProvider = new ScriptedProvider([textStep("fresh", 300)]);
    const next = await composedRuntime(
      deterministicWorld(profile),
      "next-session",
      nextProvider,
      ["turn-next"],
      ["step-next"],
    );
    await next.startTurn({ message: "new Session" });
    await next.waitForIdle();
    expect(nextProvider.calls[0]?.context.systemPrompt).toContain("updated fact");
    await next.close();

    const resumedProvider = new ScriptedProvider([textStep("resumed", 400)]);
    const resumed = await composedRuntime(
      deterministicWorld(profile),
      "current-session",
      resumedProvider,
      ["turn-resumed"],
      ["step-resumed"],
      "changed base prompt must be ignored",
    );
    await resumed.startTurn({ message: "resume" });
    await resumed.waitForIdle();
    expect(resumedProvider.calls[0]?.context.systemPrompt).toContain("original fact");
    expect(resumedProvider.calls[0]?.context.systemPrompt).not.toContain("updated fact");
    await resumed.close();
  });

  test("freezes the actual executable Memory tool and enforces an order-insensitive tool bijection", async () => {
    const profile = await createProfile("tool-bijection");
    const world = deterministicWorld(profile);
    const provider = new ScriptedProvider([]);
    const alpha = fixtureTool("alpha", false);
    const beta = fixtureTool("beta", false);
    const runtime = await createFilesystemSessionRuntime({
      world,
      sessionId: "tools-session",
      baseSystemPrompt: BASE_PROMPT,
      tools: [alpha, beta],
      model: provider.model,
      streamSimple: provider.streamSimple,
      cacheRetention: "long",
      nextTurnId: sequence(["turn-initial"]),
      nextStepId: sequence(["step-initial"]),
    });
    await runtime.close();

    const snapshot = requireStartedSnapshot(await world.readSession("tools-session", 0));
    const memory = createMemoryTool(world);
    const expectedMemory = freezeTools([memory])[0];
    expect(snapshot.tools.find((tool) => tool.name === "memory")).toEqual(expectedMemory);
    expect(canonicalToolSet(snapshot.tools)).toEqual(
      canonicalToolSet(freezeTools([memory, alpha, beta])),
    );

    const reordered = await createFilesystemSessionRuntime({
      world: deterministicWorld(profile),
      sessionId: "tools-session",
      baseSystemPrompt: "ignored on resume",
      tools: [fixtureTool("beta", true), fixtureTool("alpha", true)],
      model: provider.model,
      streamSimple: provider.streamSimple,
      cacheRetention: "long",
      nextTurnId: sequence(["turn-reordered"]),
      nextStepId: sequence(["step-reordered"]),
    });
    await reordered.close();

    await expect(
      createFilesystemSessionRuntime({
        world: deterministicWorld(profile),
        sessionId: "tools-session",
        baseSystemPrompt: BASE_PROMPT,
        tools: [alpha],
        model: provider.model,
        streamSimple: provider.streamSimple,
        cacheRetention: "long",
        nextTurnId: sequence(["turn-missing"]),
        nextStepId: sequence(["step-missing"]),
      }),
    ).rejects.toThrow(/tool|snapshot|bijection/i);
    await expect(
      createFilesystemSessionRuntime({
        world: deterministicWorld(profile),
        sessionId: "tools-session",
        baseSystemPrompt: BASE_PROMPT,
        tools: [alpha, beta, fixtureTool("extra", false)],
        model: provider.model,
        streamSimple: provider.streamSimple,
        cacheRetention: "long",
        nextTurnId: sequence(["turn-extra"]),
        nextStepId: sequence(["step-extra"]),
      }),
    ).rejects.toThrow(/tool|snapshot|bijection/i);
  });

  test("resume registers replay and live delivery before returning with the durable replay tail", async () => {
    const profile = await createProfile("resume-subscribe");
    const initialProvider = new ScriptedProvider([]);
    const initial = await composedRuntime(
      deterministicWorld(profile),
      "resume-session",
      initialProvider,
      ["turn-unused"],
      ["step-unused"],
    );
    await initial.close();

    const providerBarrier = new Barrier();
    const liveStep = textStep("live", 100);
    if (liveStep.kind !== "events") {
      throw new Error("Expected text event step");
    }
    const provider = new ScriptedProvider([{ ...liveStep, barrier: providerBarrier }]);
    const received: SessionEnvelope[] = [];
    const resumed = await resumeFilesystemSession({
      world: deterministicWorld(profile),
      sessionId: "resume-session",
      baseSystemPrompt: "ignored on resume",
      tools: [],
      model: provider.model,
      streamSimple: provider.streamSimple,
      cacheRetention: "long",
      nextTurnId: sequence(["turn-live"]),
      nextStepId: sequence(["step-live"]),
      sinceSeq: 0,
      onEnvelope(envelope: SessionEnvelope) {
        received.push(envelope);
      },
    });

    const durableAtReturn = await deterministicWorld(profile).readSession("resume-session", 0);
    const durableTail = durableAtReturn.at(-1);
    if (durableTail === undefined) {
      throw new Error("Resumed Session has no durable start event");
    }
    expect(resumed.subscription.replayThroughSeq).toBe(durableTail.seq);
    const starting = resumed.runtime.startTurn({ message: "immediately live" });
    await provider.waitForCalls(1);
    providerBarrier.release();
    await starting;
    await resumed.runtime.waitForIdle();
    resumed.subscription.unsubscribe();

    const durable = await deterministicWorld(profile).readSession("resume-session", 0);
    expect([...received]).toEqual([...durable]);
    expect(received.map((envelope) => envelope.seq)).toEqual(
      Array.from({ length: durable.length }, (_, index) => index + 1),
    );
    expect(new Set(received.map((envelope) => envelope.seq)).size).toBe(durable.length);
    await resumed.runtime.close();
  });

  test("core agent code has no real Provider imports and calls only the supplied streamSimple", async () => {
    const sources = await sourceFiles(join(import.meta.dir, "../../packages/core/src/agent"));
    const forbidden =
      /@earendil-works\/pi-ai\/(?:api|apis|auth|network|provider|providers)(?:\/|$)/;
    for (const source of sources) {
      const contents = await readFile(source, "utf8");
      const specifiers = [...contents.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => specifier !== undefined);
      expect(specifiers.filter((specifier) => forbidden.test(specifier))).toEqual([]);
      const piAiImports =
        contents.match(/import(?:.|\n)*?from\s+["']@earendil-works\/pi-ai["'];/g) ?? [];
      expect(piAiImports.every((statement) => statement.startsWith("import type"))).toBe(true);
    }

    const fixture = await createRuntimeFixture("injected-provider", [textStep("only", 100)]);
    await fixture.runtime.startTurn({ message: "call supplied Provider" });
    await fixture.runtime.waitForIdle();
    expect(fixture.provider.calls).toHaveLength(1);
    expect(fixture.provider.pendingSteps()).toBe(0);
    await fixture.runtime.close();
  });
});

afterAll(async () => {
  await Promise.all(profiles.map((profile) => rm(profile, { force: true, recursive: true })));
});

async function createRuntimeFixture(
  sessionId: string,
  steps: ReadonlyArray<ScriptedStep>,
): Promise<RuntimeFixture> {
  const profile = await createProfile(sessionId);
  const world = deterministicWorld(profile);
  const provider = new ScriptedProvider(steps);
  const runtime = await composedRuntime(
    world,
    sessionId,
    provider,
    ["turn-1", "turn-2"],
    ["step-1", "step-2"],
  );
  return { profile, world, provider, runtime };
}

function composedRuntime(
  world: FilesystemWorld,
  sessionId: string,
  provider: ScriptedProvider,
  turnIds: ReadonlyArray<string>,
  stepIds: ReadonlyArray<string>,
  baseSystemPrompt = BASE_PROMPT,
): Promise<SessionRuntime> {
  return createFilesystemSessionRuntime({
    world,
    sessionId,
    baseSystemPrompt,
    tools: [],
    model: provider.model,
    streamSimple: provider.streamSimple,
    cacheRetention: "long",
    nextTurnId: sequence(turnIds),
    nextStepId: sequence(stepIds),
  });
}

function deterministicWorld(profilePath: string): FilesystemWorld {
  let milliseconds = Date.parse("2026-07-19T00:00:00.000Z");
  return createFilesystemWorld({
    profilePath,
    now() {
      const value = new Date(milliseconds);
      milliseconds += 1;
      return value;
    },
  });
}

async function createProfile(label: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-s1-${label}-`));
  profiles.push(profile);
  return profile;
}

function sequence(values: ReadonlyArray<string>): () => string {
  const ids = new SequenceIds(values);
  return () => ids.next();
}

function freezeTools(tools: ReadonlyArray<SessionTool>): ReadonlyArray<FrozenTool> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
  }));
}

function fixtureTool(name: string, reverseSchema: boolean): SessionTool {
  const properties: JsonObject = reverseSchema
    ? { count: { type: "number" }, value: { type: "string" } }
    : { value: { type: "string" }, count: { type: "number" } };
  const inputSchema: JsonObject = reverseSchema
    ? { required: ["value"], properties, type: "object" }
    : { type: "object", properties, required: ["value"] };
  return {
    name,
    description: `Run ${name}.`,
    inputSchema,
    async execute() {
      return { tool: name };
    },
  };
}

function canonicalToolSet(tools: ReadonlyArray<FrozenTool>): ReadonlyArray<string> {
  return tools
    .map((tool) => `${tool.name}\u0000${tool.description}\u0000${canonicalJson(tool.inputSchema)}`)
    .sort();
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function requireStartedSnapshot(envelopes: ReadonlyArray<SessionEnvelope>): FrozenSessionSnapshot {
  const first = envelopes[0];
  if (first === undefined || first.event.type !== "session-started") {
    throw new Error("Session did not start with session-started");
  }
  return first.event.snapshot;
}

function expectedTextTurn(snapshot: FrozenSessionSnapshot): ReadonlyArray<SessionEnvelope> {
  const events: ReadonlyArray<SessionEnvelope["event"]> = [
    { type: "session-started", sessionId: "text-session", snapshot },
    {
      type: "turn-started",
      sessionId: "text-session",
      turnId: "turn-1",
      message: "hello",
      origin: "user",
    },
    {
      type: "step-started",
      sessionId: "text-session",
      turnId: "turn-1",
      stepId: "step-1",
      provider: "scripted",
      model: "scripted-model",
    },
    {
      type: "model-chunk",
      sessionId: "text-session",
      turnId: "turn-1",
      stepId: "step-1",
      contentIndex: 0,
      kind: "text",
      delta: "Hello.",
    },
    {
      type: "model-response",
      sessionId: "text-session",
      turnId: "turn-1",
      stepId: "step-1",
      response: {
        api: "scripted",
        provider: "scripted",
        model: "scripted-model",
        content: [{ type: "text", text: "Hello." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: 100,
      },
    },
    {
      type: "step-ended",
      sessionId: "text-session",
      turnId: "turn-1",
      stepId: "step-1",
      status: "completed",
    },
    {
      type: "turn-ended",
      sessionId: "text-session",
      turnId: "turn-1",
      status: "completed",
    },
  ];
  return events.map((event, index) => ({
    schemaVersion: 1,
    seq: index + 1,
    emittedAt: new Date(Date.parse("2026-07-19T00:00:00.000Z") + index).toISOString(),
    event,
  }));
}

function sessionPath(profile: string, sessionId: string): string {
  return join(profile, "sessions", `${sessionId}.ndjson`);
}

async function sourceFiles(root: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry): Promise<ReadonlyArray<string>> => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(entry.isFile() && path.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat().sort();
}
