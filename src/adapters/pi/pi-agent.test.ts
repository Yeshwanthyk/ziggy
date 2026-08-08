/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  type AgentSessionEventListener,
  type BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Predicate } from "effect";
import { ProviderCallError } from "../../domain/agent";
import { memoryFilePaths, type ChatContext } from "../../domain/memory";
import { createProfileAgentChildSession } from "./session-lineage";
import {
  askOnce,
  createLocalSessionManager,
  createProfileMemoryExtension,
  localMainSessionDirectory,
  openChat,
  openTui,
  promptForAssistantText,
  runSpecialist,
  providerError,
  refreshProfileMemory,
} from "./pi-agent";

const temporaryPaths: Array<string> = [];

const temporaryProfile = async (): Promise<string> => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-pi-agent-"));
  temporaryPaths.push(profilePath);
  return profilePath;
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

const invokeMemoryHandler = async (
  profilePath: string,
  context: ChatContext,
): Promise<(systemPrompt: string) => Promise<BeforeAgentStartEventResult | undefined>> => {
  const paths = memoryFilePaths(profilePath, context);
  if (!paths.ok) {
    throw paths.error;
  }

  const extension = createProfileMemoryExtension(profilePath, paths.documents);
  if (typeof extension === "function") {
    throw new Error("expected named inline extension");
  }
  expect(extension.hidden).toBe(true);

  return (systemPrompt) => refreshProfileMemory(profilePath, paths.documents, { systemPrompt });
};

describe("Pi provider failure classification", () => {
  test("misleading vendor wording remains a provider call failure with stable copy", () => {
    const cause = new Error("authentication failed because auth.json has no credential");

    expect(providerError("/profile", "call provider", cause)).toEqual(
      new ProviderCallError({
        profilePath: "/profile",
        operation: "call provider",
        message: "provider request failed",
        cause,
      }),
    );
  });
});

describe("Pi prompt cancellation", () => {
  test("interruption aborts the prompt and removes its session listener", async () => {
    let listener: AgentSessionEventListener | undefined;
    let promptStarted = false;
    let unsubscribes = 0;
    let aborts = 0;
    const session: Parameters<typeof promptForAssistantText>[1] = {
      isIdle: false,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
          unsubscribes += 1;
        };
      },
      prompt: () => {
        promptStarted = true;
        return new Promise(() => undefined);
      },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    };
    const fiber = Effect.runFork(promptForAssistantText("/profile", session, "hello"));
    await Effect.runPromise(Effect.yieldNow);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect({
      promptStarted,
      listenerPresent: listener !== undefined,
      unsubscribes,
      aborts,
    }).toEqual({
      promptStarted: true,
      listenerPresent: false,
      unsubscribes: 1,
      aborts: 1,
    });
  });
});

describe("Profile memory refresh", () => {
  test("the same handler observes disk changes on successive turns", async () => {
    const profilePath = await temporaryProfile();
    await mkdir(join(profilePath, "memory", "users"), { recursive: true });
    await writeFile(join(profilePath, "MEMORY.md"), "shared-one\n", "utf8");
    await writeFile(join(profilePath, "memory", "users", "owner.md"), "owner-only\n", "utf8");
    const invoke = await invokeMemoryHandler(profilePath, { kind: "local" });

    const first = await invoke("SOUL");
    await writeFile(join(profilePath, "MEMORY.md"), "shared-two\n", "utf8");
    const second = await invoke("SOUL");

    expect(first).toEqual({
      systemPrompt:
        "SOUL\n\n## Memory (shared)\nshared-one\n\n## Memory (this person)\nowner-only\n\nDurable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
    });
    expect(second).toEqual({
      systemPrompt:
        "SOUL\n\n## Memory (shared)\nshared-two\n\n## Memory (this person)\nowner-only\n\nDurable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
    });
  });

  test("local, user, and group handlers admit only their scoped memory", async () => {
    const profilePath = await temporaryProfile();
    await mkdir(join(profilePath, "memory", "users"), { recursive: true });
    await mkdir(join(profilePath, "memory", "groups"), { recursive: true });
    await writeFile(join(profilePath, "MEMORY.md"), "shared\n", "utf8");
    await writeFile(join(profilePath, "memory", "users", "owner.md"), "local-person\n", "utf8");
    await writeFile(join(profilePath, "memory", "users", "alice.md"), "alice-person\n", "utf8");
    await writeFile(join(profilePath, "memory", "groups", "team.md"), "team-group\n", "utf8");

    const local = await (await invokeMemoryHandler(profilePath, { kind: "local" }))("SOUL");
    const user = await (
      await invokeMemoryHandler(profilePath, { kind: "user", userId: "alice" })
    )("SOUL");
    const group = await (
      await invokeMemoryHandler(profilePath, { kind: "group", groupId: "team" })
    )("SOUL");

    expect(local?.systemPrompt).toContain("shared");
    expect(local?.systemPrompt).toContain("local-person");
    expect(local?.systemPrompt).not.toContain("alice-person");
    expect(local?.systemPrompt).not.toContain("team-group");
    expect(user?.systemPrompt).toContain("shared");
    expect(user?.systemPrompt).toContain("alice-person");
    expect(user?.systemPrompt).not.toContain("local-person");
    expect(user?.systemPrompt).not.toContain("team-group");
    expect(group?.systemPrompt).toContain("shared");
    expect(group?.systemPrompt).toContain("team-group");
    expect(group?.systemPrompt).not.toContain("local-person");
    expect(group?.systemPrompt).not.toContain("alice-person");
  });

  test("a read failure is explicit in the turn prompt", async () => {
    const profilePath = await temporaryProfile();
    await mkdir(join(profilePath, "MEMORY.md"));
    const result = await (await invokeMemoryHandler(profilePath, { kind: "local" }))("SOUL");

    expect(result?.systemPrompt).toContain("PROFILE MEMORY UNAVAILABLE FOR THIS TURN.");
    expect(result?.systemPrompt).toContain("Do not claim to remember Profile facts");
    expect(result?.systemPrompt).not.toContain("Durable facts should be saved");
  });
});

describe("Profile specialist runtime integration", () => {
  test("rejects an unknown direct agent before creating a root session", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    const result = await Effect.runPromise(
      runSpecialist(
        { path: profilePath, name: "Profile" },
        "missing",
        "task",
        { sessionDirectory: join(profilePath, "sessions", "direct") },
        process.cwd(),
      ).pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SpecialistAgentNotFound", agentId: "missing" },
    });
    expect(await readdir(profilePath)).not.toContain("sessions");
  });

  test("a direct Profile agent uses one useful saved Pi root without an in-memory host", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          [
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"saved root answer"},"finish_reason":null}]}',
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const profilePath = await temporaryProfile();
      const sessionDirectory = join(profilePath, "sessions", "direct");
      await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
      await mkdir(join(profilePath, "agents"), { recursive: true });
      await writeFile(
        join(profilePath, "agents", "fixture.md"),
        "---\nversion: 1\ndescription: Fixture\nprovider: fixture\nmodel: fixture-model\nthinking: off\n---\n\nAnswer briefly.\n",
        "utf8",
      );
      await writeFile(
        join(profilePath, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              api: "openai-completions",
              apiKey: "fixture-key",
              models: [{ id: "fixture-model" }],
            },
          },
        }),
        "utf8",
      );

      const result = await Effect.runPromise(
        runSpecialist(
          { path: profilePath, name: "Profile" },
          "fixture",
          "root task",
          { sessionDirectory },
          process.cwd(),
        ),
      );
      const files = (await readdir(sessionDirectory, { recursive: true })).filter((path) =>
        path.endsWith(".jsonl"),
      );
      expect(result.answer).toBe("saved root answer");
      expect(files).toHaveLength(1);
      expect(result.session.file).toBe(join(sessionDirectory, files[0] ?? ""));
      const manager = SessionManager.open(result.session.file, sessionDirectory);
      expect(manager.isPersisted()).toBe(true);
      expect(manager.getHeader()?.parentSession).toBeUndefined();
      const jsonl = await readFile(result.session.file, "utf8");
      expect(jsonl).toContain("root task");
      expect(jsonl).toContain("saved root answer");
    } finally {
      server.stop(true);
    }
  });

  test("the real Pi SDK persists a child header and isolated transcript under its parent", async () => {
    const profilePath = await temporaryProfile();
    const parent = SessionManager.create(profilePath, join(profilePath, "sessions", "parent"));
    parent.appendMessage({
      role: "user",
      content: [{ type: "text", text: "parent prompt" }],
      timestamp: Date.now(),
    });
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "parent answer" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const child = createProfileAgentChildSession(profilePath, parent);
    if (child === undefined) throw new Error("expected persistent child session");
    child.manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "isolated child prompt" }],
      timestamp: Date.now(),
    });
    child.manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "isolated child answer" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    expect(child.manager.isPersisted()).toBe(true);
    expect(child.manager.getHeader()?.parentSession).toBe(parent.getSessionFile());
    expect(child.reference.id).toBe(child.manager.getSessionId());
    expect(child.manager.getSessionFile()).toBe(child.reference.file);
    const childJsonl = await readFile(child.reference.file, "utf8");
    const parentJsonl = await readFile(parent.getSessionFile() ?? "", "utf8");
    expect(childJsonl).toContain("isolated child prompt");
    expect(childJsonl).toContain("isolated child answer");
    expect(parentJsonl).not.toContain("isolated child prompt");
    expect(parentJsonl).not.toContain("isolated child answer");
  });
});

describe("Profile agent admission across faces", () => {
  test("TUI, print, and gateway chat reject the same invalid agent before Pi opens", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    await mkdir(join(profilePath, "agents"), { recursive: true });
    await writeFile(
      join(profilePath, "agents", "broken.md"),
      "---\nversion: 1\ndescription: Broken\n---\n",
      "utf8",
    );

    const target = { path: profilePath, name: "Profile" };
    const results = await Promise.all([
      Effect.runPromise(openTui(target, { kind: "local" }, process.cwd()).pipe(Effect.result)),
      Effect.runPromise(
        askOnce(target, "prompt", false, { kind: "local" }, process.cwd()).pipe(Effect.result),
      ),
      Effect.runPromise(
        openChat(
          target,
          { kind: "local" },
          join(profilePath, "sessions", "gateway"),
          process.cwd(),
        ).pipe(Effect.result),
      ),
    ]);

    expect(
      results.every(
        (result) =>
          result._tag === "Failure" &&
          Predicate.isTagged(result.failure, "ProfileAgentInvalid") &&
          result.failure.path === join(profilePath, "agents", "broken.md"),
      ),
    ).toBe(true);
  });
});

describe("local session routing", () => {
  test("main continuation is isolated while a plain run stays fresh at the root", async () => {
    const profilePath = await temporaryProfile();
    const mainDirectory = localMainSessionDirectory(profilePath);
    const tui = createLocalSessionManager(profilePath, "main");
    tui.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first main turn" }],
      timestamp: Date.now(),
    });
    tui.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first main reply" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const continuedRun = createLocalSessionManager(profilePath, "main");
    const plainRun = createLocalSessionManager(profilePath, "fresh");
    const nextPlainRun = createLocalSessionManager(profilePath, "fresh");

    expect(tui.getSessionDir()).toBe(mainDirectory);
    expect(continuedRun.getSessionDir()).toBe(mainDirectory);
    expect(continuedRun.getSessionFile()).toBe(tui.getSessionFile());
    expect(plainRun.getSessionDir()).toBe(join(profilePath, "sessions"));
    expect(nextPlainRun.getSessionDir()).toBe(join(profilePath, "sessions"));
    expect(nextPlainRun.getSessionFile()).not.toBe(plainRun.getSessionFile());
  });
});
