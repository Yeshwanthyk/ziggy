/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  createAgentSessionServices,
  createAgentSessionRuntime,
  type AgentSessionEventListener,
  type AgentSessionRuntime,
  type BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Cause, Effect, Exit, Fiber, Predicate, Result } from "effect";
import {
  ChatNotStreaming,
  ProviderCallError,
  ProviderConfigError,
  SpecialistAgentNotFound,
} from "ziggy/domain/agent";
import {
  ProfileExtensionPreflightFailed,
  ProfileExtensionRollbackFailed,
  type ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";
import { memoryFilePaths, type ChatContext } from "ziggy/domain/memory";
import type { ChatEvent, ChatProgressEvent } from "ziggy/application/agent";
import { createProfileAgentChildSession } from "ziggy/adapters/pi/session-lineage";
import { profileResourceLoaderOptions } from "ziggy/adapters/pi/profile-resource-loader";
import { specialistRuntime } from "ziggy/adapters/pi/specialist";
import type { PiResources } from "ziggy/adapters/pi/resources";
import {
  appendEphemeralPromptContext,
  askOnce,
  createChatEventProjector,
  createLocalSessionManager,
  createProfileMemoryExtension,
  localMainSessionDirectory,
  localSpecialistSessionDirectory,
  makeSessionChatHandle,
  openChat,
  openSpecialistChat,
  openTui,
  promptForAssistantText,
  progressToolDetail,
  runSpecialist,
  providerError,
  refreshProfileMemory,
} from "ziggy/adapters/pi/pi-agent";

const assistantMessage = (
  text: string,
  extras?: Pick<AssistantMessage, "errorMessage" | "stopReason">,
): AssistantMessage => ({
  role: "assistant",
  content: text.length === 0 ? [] : [{ type: "text", text }],
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
  stopReason: extras?.stopReason ?? "stop",
  timestamp: 0,
  ...Object.fromEntries(
    extras?.errorMessage === undefined ? [] : ([["errorMessage", extras.errorMessage]] as const),
  ),
});

const temporaryPaths: Array<string> = [];

const temporaryProfile = async (): Promise<string> => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-pi-agent-"));
  temporaryPaths.push(profilePath);
  return profilePath;
};

const makeProfileExtensionsForRuntime = (): ProfileExtensionsApi => {
  const unused = (): Effect.Effect<never, ProfileExtensionPreflightFailed> =>
    Effect.fail(
      new ProfileExtensionPreflightFailed({
        profilePath: "/unused",
        stage: "resources",
        message: "unused test operation",
        diagnostics: [],
        cause: undefined,
      }),
    );
  return {
    list: unused,
    show: unused,
    listForProfile: unused,
    add: unused,
    remove: unused,
    setSelected: unused,
    validate: unused,
    prepareRuntime: () => Effect.succeed({ selected: [], generation: "fixture-generation" }),
    activateRuntime: () => Effect.void,
  };
};

const fixtureModel = (): Model<Api> => ({
  id: "fixture-model",
  name: "Fixture model",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
});

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
  if (!("hidden" in extension)) {
    throw new Error("expected named inline extension");
  }
  expect(extension.hidden).toBe(true);

  return (systemPrompt) => refreshProfileMemory(profilePath, paths.documents, { systemPrompt });
};

describe("Pi provider failure classification", () => {
  test("extracts a bounded command or path from tool args", () => {
    expect(progressToolDetail({ command: "  osascript -e tell Reminders  " })).toBe(
      "osascript -e tell Reminders",
    );
    expect(progressToolDetail({ path: "SOUL.md" })).toBe("SOUL.md");
    expect(progressToolDetail({})).toBeUndefined();
  });

  test("finished tool events keep the start command detail", async () => {
    let listener: AgentSessionEventListener | undefined;
    const progress: Array<ChatProgressEvent> = [];
    const session: Parameters<typeof promptForAssistantText>[1] = {
      isIdle: false,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      prompt: () => new Promise(() => undefined),
      abort: () => Promise.resolve(),
    };
    const fiber = Effect.runFork(
      promptForAssistantText("/profile", session, "hello", {
        onProgress: (event) => progress.push(event),
      }),
    );
    await Effect.runPromise(Effect.yieldNow);
    listener?.({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "osascript -e tell Reminders", extra: 1 },
    });
    listener?.({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [], details: undefined },
      isError: true,
    });
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(progress).toEqual([
      {
        kind: "tool",
        phase: "start",
        toolCallId: "tool-1",
        toolName: "bash",
        failed: false,
        detail: "osascript -e tell Reminders",
      },
      {
        kind: "tool",
        phase: "end",
        toolCallId: "tool-1",
        toolName: "bash",
        failed: true,
        detail: "osascript -e tell Reminders",
      },
    ]);
  });

  test("thinking deltas stay off onProgress and abort stops the in-flight prompt", async () => {
    let listener: AgentSessionEventListener | undefined;
    let aborted = 0;
    const progress: Array<ChatProgressEvent> = [];
    const session: Parameters<typeof promptForAssistantText>[1] = {
      isIdle: false,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      prompt: () => new Promise(() => undefined),
      abort: async () => {
        aborted += 1;
      },
    };
    const fiber = Effect.runFork(
      promptForAssistantText("/profile", session, "hello", {
        onProgress: (event) => progress.push(event),
      }),
    );
    await Effect.runPromise(Effect.yieldNow);
    const thinking = assistantMessage("");
    listener?.({
      type: "message_update",
      message: thinking,
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "hmm",
        contentIndex: 0,
        partial: thinking,
      },
    });
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(progress).toEqual([]);
    expect(aborted).toBe(1);
  });

  test("chat events stay a small Ziggy union and steer fails closed while idle", async () => {
    const project = createChatEventProjector();
    const thinking = assistantMessage("hi");
    expect(
      project({
        type: "message_update",
        message: thinking,
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "hmm",
          contentIndex: 0,
          partial: thinking,
        },
      }),
    ).toEqual([{ kind: "thinking", delta: "hmm" }]);
    expect(
      project({
        type: "message_end",
        message: assistantMessage("nope", {
          stopReason: "aborted",
          errorMessage: "Request aborted",
        }),
      }),
    ).toEqual([{ kind: "error", message: "Request aborted" }]);
    expect(project({ type: "agent_settled" })).toEqual([{ kind: "settled" }]);

    let idle = true;
    let aborted = 0;
    let releaseAbort: (() => void) | undefined;
    const listeners = new Set<AgentSessionEventListener>();
    const events: Array<ChatEvent> = [];
    const handle = makeSessionChatHandle(
      "/profile",
      {
        get isIdle() {
          return idle;
        },
        prompt: () => Promise.resolve(),
        abort: () => {
          aborted += 1;
          return new Promise<void>((resolve) => {
            releaseAbort = resolve;
          });
        },
        steer: () => Promise.resolve(),
        followUp: () => Promise.resolve(),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      {
        prompt: () => Effect.succeed("unused"),
        dispose: Effect.void,
      },
    );
    const unsubscribe = handle.subscribe((event) => events.push(event));

    expect(await Effect.runPromiseExit(handle.steer("nudge"))).toEqual(
      Exit.fail(
        new ChatNotStreaming({
          profilePath: "/profile",
          operation: "steer",
          message: "no live turn to steer",
        }),
      ),
    );
    expect(await Effect.runPromiseExit(handle.followUp("later"))).toEqual(
      Exit.fail(
        new ChatNotStreaming({
          profilePath: "/profile",
          operation: "followUp",
          message: "no live turn to follow up",
        }),
      ),
    );

    idle = false;
    expect(handle.isIdle).toBe(false);
    const firstAbort = Effect.runPromise(handle.abort);
    const secondAbort = Effect.runPromise(handle.abort);
    await Effect.runPromise(Effect.yieldNow);
    expect(aborted).toBe(1);
    releaseAbort?.();
    await Promise.all([firstAbort, secondAbort]);

    for (const listener of listeners) {
      listener({ type: "agent_settled" });
    }
    expect(events).toEqual([{ kind: "settled" }]);
    unsubscribe();
    await Effect.runPromise(handle.dispose);
  });
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

  test("open interactive mode reports the cause without inventing models.json copy", () => {
    const cause = new Error("ENOENT: no such file or directory, open '/commands/theme/dark.json'");

    expect(providerError("/profile", "open interactive mode", cause)).toEqual(
      new ProviderConfigError({
        profilePath: "/profile",
        operation: "open interactive mode",
        message:
          "open interactive mode failed: ENOENT: no such file or directory, open '/commands/theme/dark.json'",
        cause,
      }),
    );
  });

  test("select model still uses the canned auth/models.json configuration copy", () => {
    const cause = new Error("no default model");

    expect(providerError("/profile", "select model", cause)).toEqual(
      new ProviderConfigError({
        profilePath: "/profile",
        operation: "select model",
        message: `provider configuration failed; place credentials in ${join("/profile", "auth.json")} and model configuration in ${join("/profile", "models.json")}`,
        cause,
      }),
    );
  });
});

describe("Pi ephemeral prompt context", () => {
  test("appends turn-only context to the provider system prompt", () => {
    expect(
      appendEphemeralPromptContext(
        { systemPrompt: "SOUL" },
        "[Slack thread context]\nquoted history\n[/Slack thread context]",
      ),
    ).toEqual({
      systemPrompt: "SOUL\n\n[Slack thread context]\nquoted history\n[/Slack thread context]",
    });
  });

  test("uses context for one real provider turn without persisting or replaying it", async () => {
    const requestBodies: Array<string> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestBodies.push(JSON.stringify(await request.json()));
        return new Response(
          [
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":null}]}',
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const profilePath = await temporaryProfile();
      const sessionDirectory = join(profilePath, "sessions", "slack-thread");
      await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
      await writeFile(
        join(profilePath, "settings.json"),
        JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }),
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

      const handle = await Effect.runPromise(
        openChat(
          { path: profilePath, name: "Profile" },
          { kind: "group", groupId: "slC123" },
          sessionDirectory,
          process.cwd(),
          "fresh",
        ),
      );
      try {
        await Effect.runPromise(
          handle.prompt("first current message", {
            ephemeralContext: "SLACK_THREAD_CONTEXT_ONLY_90210",
          }),
        );
        await Effect.runPromise(handle.prompt("second current message"));
      } finally {
        await Effect.runPromise(handle.dispose);
      }

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toContain("SLACK_THREAD_CONTEXT_ONLY_90210");
      expect(requestBodies[1]).not.toContain("SLACK_THREAD_CONTEXT_ONLY_90210");
      const files = (await readdir(sessionDirectory, { recursive: true })).filter((path) =>
        path.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const transcript = await readFile(join(sessionDirectory, files[0] ?? ""), "utf8");
      expect(transcript).toContain("first current message");
      expect(transcript).toContain("second current message");
      expect(transcript).not.toContain("SLACK_THREAD_CONTEXT_ONLY_90210");
    } finally {
      server.stop(true);
    }
  });
});

describe("Profile-authoritative model selection", () => {
  test("a resumed session uses the Profile model instead of its historical model", async () => {
    const oldRequests: Array<string> = [];
    const newRequests: Array<string> = [];
    const serveModel = (requests: Array<string>, model: string) =>
      Bun.serve({
        port: 0,
        fetch: async (request) => {
          requests.push(JSON.stringify(await request.json()));
          return new Response(
            [
              `data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":null}]}`,
              `data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
    const oldServer = serveModel(oldRequests, "old-model");
    const newServer = serveModel(newRequests, "new-model");

    try {
      const profilePath = await temporaryProfile();
      const sessionDirectory = join(profilePath, "sessions", "slack-thread");
      await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
      await writeFile(
        join(profilePath, "models.json"),
        JSON.stringify({
          providers: {
            old: {
              baseUrl: `http://127.0.0.1:${oldServer.port}/v1`,
              api: "openai-completions",
              apiKey: "old-key",
              models: [{ id: "old-model" }],
            },
            current: {
              baseUrl: `http://127.0.0.1:${newServer.port}/v1`,
              api: "openai-completions",
              apiKey: "current-key",
              models: [{ id: "new-model" }],
            },
          },
        }),
        "utf8",
      );

      const historical = SessionManager.create(profilePath, sessionDirectory);
      historical.appendMessage({
        role: "user",
        content: [{ type: "text", text: "historical request" }],
        timestamp: Date.now(),
      });
      historical.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "historical answer" }],
        api: "openai-completions",
        provider: "old",
        model: "old-model",
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
      historical.appendModelChange("old", "old-model");
      const sessionFile = historical.getSessionFile();
      if (sessionFile === undefined) throw new Error("expected a persisted historical session");

      await writeFile(
        join(profilePath, "settings.json"),
        JSON.stringify({
          defaultProvider: "current",
          defaultModel: "new-model",
          defaultThinkingLevel: "medium",
        }),
        "utf8",
      );

      const handle = await Effect.runPromise(
        openChat(
          { path: profilePath, name: "Profile" },
          { kind: "group", groupId: "slC123" },
          sessionDirectory,
          process.cwd(),
          "continue",
        ),
      );
      try {
        expect(await Effect.runPromise(handle.prompt("current request"))).toBe("answer");
      } finally {
        await Effect.runPromise(handle.dispose);
      }

      expect({ oldRequests: oldRequests.length, newRequests: newRequests.length }).toEqual({
        oldRequests: 0,
        newRequests: 1,
      });
      expect(SessionManager.open(sessionFile).buildSessionContext().model).toEqual({
        provider: "current",
        modelId: "new-model",
      });
    } finally {
      oldServer.stop(true);
      newServer.stop(true);
    }
  });
});

describe("Pi prompt cancellation", () => {
  test("interruption aborts the prompt and removes its session listener", async () => {
    let listener: AgentSessionEventListener | undefined;
    let promptStarted = false;
    let promptOptions: Parameters<Parameters<typeof promptForAssistantText>[1]["prompt"]>[1];
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
      prompt: (_text, options) => {
        promptStarted = true;
        promptOptions = options;
        return new Promise(() => undefined);
      },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    };
    const images = [{ type: "image" as const, data: "AQID", mimeType: "image/png" }];
    const fiber = Effect.runFork(promptForAssistantText("/profile", session, "hello", { images }));
    await Effect.runPromise(Effect.yieldNow);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect({
      promptStarted,
      promptOptions,
      listenerPresent: listener !== undefined,
      unsubscribes,
      aborts,
    }).toEqual({
      promptStarted: true,
      promptOptions: { images },
      listenerPresent: false,
      unsubscribes: 1,
      aborts: 1,
    });
  });

  test("maps bounded assistant and tool progress without leaking the callback to Pi", async () => {
    let listener: AgentSessionEventListener | undefined;
    let promptOptions: Parameters<Parameters<typeof promptForAssistantText>[1]["prompt"]>[1];
    const progress: Array<ChatProgressEvent> = [];
    const session: Parameters<typeof promptForAssistantText>[1] = {
      isIdle: false,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      prompt: (_text, options) => {
        promptOptions = options;
        return new Promise(() => undefined);
      },
      abort: () => Promise.resolve(),
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "a".repeat(4_200) }],
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
      timestamp: 0,
    };
    const fiber = Effect.runFork(
      promptForAssistantText("/profile", session, "hello", {
        images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
        onProgress: (event) => progress.push(event),
      }),
    );
    await Effect.runPromise(Effect.yieldNow);
    const emit = (event: Parameters<AgentSessionEventListener>[0]) => listener?.(event);

    emit({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "b".repeat(700),
        partial: assistant,
      },
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "id".repeat(100),
      toolName: "<unsafe>\nread 🔥".repeat(20),
      args: {},
    });
    emit({
      type: "tool_execution_update",
      toolCallId: "id".repeat(100),
      toolName: "<unsafe>\nread 🔥".repeat(20),
      args: {},
      partialResult: { content: [], details: undefined },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "id".repeat(100),
      toolName: "<unsafe>\nread 🔥".repeat(20),
      result: { content: [], details: undefined },
      isError: false,
    });

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(
      progress.map((event) =>
        event.kind === "assistant-text"
          ? {
              kind: event.kind,
              deltaLength: [...event.delta].length,
              snapshotLength: [...event.snapshot].length,
            }
          : event.kind === "tool"
            ? {
                kind: event.kind,
                phase: event.phase,
                failed: event.failed,
                toolCallIdLength: [...event.toolCallId].length,
                toolNameLength: [...event.toolName].length,
                toolNameSafe: !event.toolName.includes("<") && !event.toolName.includes("🔥"),
              }
            : { kind: event.kind },
      ),
    ).toEqual([
      { kind: "assistant-text", deltaLength: 512, snapshotLength: 3_800 },
      {
        kind: "tool",
        phase: "start",
        failed: false,
        toolCallIdLength: 128,
        toolNameLength: 48,
        toolNameSafe: true,
      },
      {
        kind: "tool",
        phase: "update",
        failed: false,
        toolCallIdLength: 128,
        toolNameLength: 48,
        toolNameSafe: true,
      },
      {
        kind: "tool",
        phase: "end",
        failed: false,
        toolCallIdLength: 128,
        toolNameLength: 48,
        toolNameSafe: true,
      },
    ]);
    expect(promptOptions).toEqual({
      images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
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

describe("Profile runtime activation rollback", () => {
  test("disposes the actual runtime once before activation failure escapes", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    const activationFailure = new ProfileExtensionPreflightFailed({
      profilePath,
      stage: "services",
      message: "injected activation failure",
      diagnostics: [],
      cause: "injected",
    });
    const events: Array<string> = [];
    const unused = (): Effect.Effect<never, ProfileExtensionPreflightFailed> =>
      Effect.fail(activationFailure);
    const profileExtensions: ProfileExtensionsApi = {
      list: unused,
      show: unused,
      listForProfile: unused,
      add: unused,
      remove: unused,
      setSelected: unused,
      validate: unused,
      prepareRuntime: () =>
        Effect.succeed({
          selected: [],
          generation: "fixture-generation",
        }),
      activateRuntime: () => {
        events.push("activate");
        return Effect.fail(activationFailure);
      },
    };
    let constructedRuntime: AgentSessionRuntime | undefined;
    let disposedRuntime: AgentSessionRuntime | undefined;
    let disposeCalls = 0;
    const runtimeFactory: typeof createAgentSessionRuntime = async (createRuntime, options) => {
      const runtime = await createAgentSessionRuntime(createRuntime, options);
      constructedRuntime = runtime;
      events.push("constructed");
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        disposeCalls += 1;
        disposedRuntime = runtime;
        events.push("dispose");
        return dispose();
      };
      return runtime;
    };

    const exit = await Effect.runPromiseExit(
      openChat(
        { path: profilePath, name: "Profile" },
        { kind: "local" },
        join(profilePath, "sessions"),
        process.cwd(),
        "fresh",
        undefined,
        profileExtensions,
        runtimeFactory,
      ),
    );

    expect(exit).toEqual(Exit.fail(activationFailure));
    expect({
      constructed: constructedRuntime !== undefined,
      disposed: disposedRuntime === constructedRuntime,
      disposeCalls,
      events,
    }).toEqual({
      constructed: true,
      disposed: true,
      disposeCalls: 1,
      events: ["constructed", "activate", "dispose"],
    });
  });

  test("propagates a typed rollback failure when runtime disposal also fails", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    const activationFailure = new ProfileExtensionPreflightFailed({
      profilePath,
      stage: "services",
      message: "injected activation failure",
      diagnostics: [],
      cause: "injected",
    });
    const disposalFailure = new Error("injected disposal failure");
    const events: Array<string> = [];
    const unused = (): Effect.Effect<never, ProfileExtensionPreflightFailed> =>
      Effect.fail(activationFailure);
    const profileExtensions: ProfileExtensionsApi = {
      list: unused,
      show: unused,
      listForProfile: unused,
      add: unused,
      remove: unused,
      setSelected: unused,
      validate: unused,
      prepareRuntime: () =>
        Effect.succeed({
          selected: [],
          generation: "fixture-generation",
        }),
      activateRuntime: () => {
        events.push("activate");
        return Effect.fail(activationFailure);
      },
    };
    let disposeCalls = 0;
    const runtimeFactory: typeof createAgentSessionRuntime = async (createRuntime, options) => {
      const runtime = await createAgentSessionRuntime(createRuntime, options);
      events.push("constructed");
      runtime.dispose = async () => {
        disposeCalls += 1;
        events.push("dispose");
        throw disposalFailure;
      };
      return runtime;
    };

    const exit = await Effect.runPromiseExit(
      openChat(
        { path: profilePath, name: "Profile" },
        { kind: "local" },
        join(profilePath, "sessions"),
        process.cwd(),
        "fresh",
        undefined,
        profileExtensions,
        runtimeFactory,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected activation rollback to fail");
    const failureResult = Cause.findError(exit.cause);
    expect(Result.isSuccess(failureResult)).toBe(true);
    if (!Result.isSuccess(failureResult)) throw new Error("expected a typed rollback failure");
    expect(failureResult.success).toBeInstanceOf(ProfileExtensionRollbackFailed);
    if (!(failureResult.success instanceof ProfileExtensionRollbackFailed)) {
      throw new Error("expected ProfileExtensionRollbackFailed");
    }
    expect({
      operation: failureResult.success.operation,
      message: failureResult.success.message,
      originalFailure: failureResult.success.originalFailure,
      rollbackFailures: failureResult.success.rollbackFailures,
      cause: failureResult.success.cause,
      disposeCalls,
      events,
    }).toEqual({
      operation: "activate-runtime",
      message:
        "Profile extension activation failed and the newly created runtime could not be disposed; Profile state may have changed",
      originalFailure: activationFailure,
      rollbackFailures: [
        {
          operation: "dispose runtime",
          path: profilePath,
          message: "could not dispose the newly created Pi runtime",
        },
      ],
      cause: activationFailure,
      disposeCalls: 1,
      events: ["constructed", "activate", "dispose"],
    });
    expect(failureResult.success.message.length).toBeLessThanOrEqual(360);
    expect(
      failureResult.success.rollbackFailures.every(
        ({ operation, path, message }) =>
          operation.length <= 96 && path.length <= 240 && message.length <= 360,
      ),
    ).toBe(true);
  });
});

describe("Profile extension tool admission", () => {
  test("registers the tool on a parent runtime but not a specialist child", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    const profileExtensions = makeProfileExtensionsForRuntime();
    let parentRuntime: AgentSessionRuntime | undefined;
    const runtimeFactory: typeof createAgentSessionRuntime = async (createRuntime, options) => {
      const runtime = await createAgentSessionRuntime(createRuntime, options);
      parentRuntime = runtime;
      return runtime;
    };

    const parentExit = await Effect.runPromiseExit(
      openChat(
        { path: profilePath, name: "Profile" },
        { kind: "local" },
        join(profilePath, "sessions", "parent"),
        process.cwd(),
        "fresh",
        undefined,
        profileExtensions,
        runtimeFactory,
      ),
    );

    if (Exit.isSuccess(parentExit)) await Effect.runPromise(parentExit.value.dispose);
    expect(parentRuntime).toBeDefined();
    if (parentRuntime === undefined) throw new Error("expected parent runtime");
    expect(parentRuntime.session.getAllTools().map((tool) => tool.name)).toContain(
      "profile_extensions",
    );

    const resources: PiResources = {
      extensionPaths: [],
      skillPaths: [],
      extensionFactories: [],
    };
    const services = await createAgentSessionServices({
      cwd: profilePath,
      agentDir: profilePath,
      resourceLoaderOptions: profileResourceLoaderOptions("Profile", resources, []),
    });
    const child = await Effect.runPromise(
      specialistRuntime(
        profilePath,
        { services, resources },
        {
          id: "fixture-specialist",
          version: 1,
          description: "Fixture specialist",
          provider: "fixture",
          model: "fixture-model",
          thinking: "off",
          tools: ["profile_extensions"],
          body: "Answer briefly.",
        },
        fixtureModel(),
        "off",
        ["profile_extensions"],
        SessionManager.inMemory(profilePath),
      ),
    );
    try {
      expect(child.session.getAllTools().map((tool) => tool.name)).not.toContain(
        "profile_extensions",
      );
    } finally {
      await child.dispose();
    }
  });
});

describe("Profile specialist runtime integration", () => {
  test("Pi persistent mode allocates a lazy path before any JSONL exists", async () => {
    const profilePath = await temporaryProfile();
    const manager = SessionManager.create(profilePath, join(profilePath, "sessions", "lazy"));
    const file = manager.getSessionFile();
    expect(manager.isPersisted()).toBe(true);
    expect(file).toBeDefined();
    if (file === undefined) throw new Error("expected a persistent target path");
    expect(await Bun.file(file).exists()).toBe(false);

    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "not enough to materialize JSONL" }],
      timestamp: Date.now(),
    });

    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("rejects an unknown direct agent before creating a root session", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    expect(
      await Effect.runPromiseExit(
        runSpecialist(
          { path: profilePath, name: "Profile" },
          "missing",
          "task",
          { sessionDirectory: join(profilePath, "sessions", "direct") },
          process.cwd(),
        ),
      ),
    ).toEqual(
      Exit.fail(
        new SpecialistAgentNotFound({
          profilePath,
          agentId: "missing",
          message: "unknown Profile agent: missing",
        }),
      ),
    );
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

describe("specialist chat rails", () => {
  test("rejects an unknown specialist before creating a local rail session", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    expect(
      await Effect.runPromiseExit(
        openSpecialistChat({ path: profilePath, name: "Profile" }, "missing", process.cwd()),
      ),
    ).toEqual(
      Exit.fail(
        new SpecialistAgentNotFound({
          profilePath,
          agentId: "missing",
          message: "unknown Profile agent: missing",
        }),
      ),
    );
    expect(await readdir(profilePath)).not.toContain("sessions");
  });

  test("continues a specialist rail under sessions/local/agents/<id>/", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          [
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"rail answer"},"finish_reason":null}]}',
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const profilePath = await temporaryProfile();
      await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
      await mkdir(join(profilePath, "agents"), { recursive: true });
      await writeFile(
        join(profilePath, "agents", "reviewer.md"),
        "---\nversion: 1\ndescription: Reviewer\nprovider: fixture\nmodel: fixture-model\nthinking: off\n---\n\nAnswer briefly.\n",
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

      const target = { path: profilePath, name: "Profile" };
      const handle = await Effect.runPromise(openSpecialistChat(target, "reviewer", process.cwd()));
      try {
        await Effect.runPromise(handle.prompt("first rail turn"));
        await Effect.runPromise(handle.prompt("second rail turn"));
      } finally {
        await Effect.runPromise(handle.dispose);
      }

      const sessionDirectory = localSpecialistSessionDirectory(profilePath, "reviewer");
      const files = (await readdir(sessionDirectory, { recursive: true })).filter((path) =>
        path.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const transcript = await readFile(join(sessionDirectory, files[0] ?? ""), "utf8");
      expect(transcript).toContain("first rail turn");
      expect(transcript).toContain("second rail turn");
      expect(await readdir(join(profilePath, "sessions")).catch(() => [])).not.toContain("slack");
    } finally {
      server.stop(true);
    }
  });
});
