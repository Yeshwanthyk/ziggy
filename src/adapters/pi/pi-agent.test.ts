/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentSessionEventListener,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { Effect, Fiber } from "effect";
import { ProviderCallError } from "../../domain/agent";
import { memoryFilePaths, type ChatContext } from "../../domain/memory";
import {
  createLocalSessionManager,
  createProfileMemoryExtension,
  localMainSessionDirectory,
  promptForAssistantText,
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

    expect({ promptStarted, listenerPresent: listener !== undefined, unsubscribes, aborts }).toEqual({
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
