/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  createAgentSessionRuntime,
  type AgentSessionEventListener,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Effect, Exit, Fiber, Result } from "effect";
import { ChatNotStreaming, ProviderCallError } from "ziggy/domain/agent";
import type { ChatEvent, ChatProgressEvent } from "ziggy/application/agent";
import { ensurePiSessionName } from "ziggy/adapters/pi/session-name";
import { Extensions, extensionTools } from "ziggy/extensions/index";
import {
  isSessionHeld,
  openSession,
  takeSessionLease,
  type OpenSession,
} from "ziggy/session/index";
import { makeChatHandle } from "ziggy/session/handle";
import { makeSessionLeaseSet } from "ziggy/session/lease";
import { fakePiRuntime } from "../harness/pi-runtime";
import {
  createChatEventProjector,
  progressToolDetail,
} from "ziggy/adapters/pi/chat-event-projector";
import { promptForAssistantText } from "ziggy/adapters/pi/prompt-turn";
import { providerError } from "ziggy/adapters/pi/provider-failure";
import { ProviderConfigError } from "ziggy/profile/index";

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

test("Pi session names prefer semantic identity, bound fallback text, and never overwrite", () => {
  const semantic = SessionManager.inMemory("/profile");
  ensurePiSessionName(semantic, "Agent · Ada", "Review the gateway");
  expect(semantic.getSessionName()).toBe("Agent · Ada · Review the gateway");

  ensurePiSessionName(semantic, "Agent · Reviewer", "Replace the existing identity");
  expect(semantic.getSessionName()).toBe("Agent · Ada · Review the gateway");

  const fallback = SessionManager.inMemory("/profile");
  ensurePiSessionName(fallback, undefined, `  ${"x".repeat(120)}\nignored  `);
  expect(fallback.getSessionName()).toBe("x".repeat(80));

  const cleared = SessionManager.inMemory("/profile");
  cleared.appendSessionInfo("");
  ensurePiSessionName(cleared, "Local · Main", "Do not restore a cleared name");
  expect(cleared.getSessionName()).toBeUndefined();

  const longRoute = SessionManager.inMemory("/profile");
  ensurePiSessionName(longRoute, "x".repeat(100), "Distinct task");
  expect(longRoute.getSessionName()).toBe(`${"x".repeat(40)} · Distinct task`);
});

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

const heldTranscript = async (id: string) => {
  const profilePath = await temporaryProfile();
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n");
  const directory = join(profilePath, "sessions", "chat");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, cwd: profilePath, timestamp: new Date().toISOString() })}\n`,
  );

  return { profilePath, directory, file };
};

const openRequest = (profilePath: string, directory: string): OpenSession => ({
  target: { path: profilePath, name: "Profile" },
  context: { kind: "local" },
  directory,
  session: "continue",
});

test("a failed chat runtime build releases the transcript lease", async () => {
  const { profilePath, directory } = await heldTranscript("reopen-chat");

  const failed = await Effect.runPromiseExit(
    openSession(openRequest(profilePath, directory), {
      runtimeFactory: async () => {
        throw new Error("injected runtime build failure");
      },
    }),
  );

  expect(Exit.isFailure(failed)).toBe(true);
  expect(Result.getOrThrow(isSessionHeld(profilePath, "reopen-chat"))).toBe(false);
});

test("a held chat refuses before calling Pi's runtime factory", async () => {
  const { profilePath, directory, file } = await heldTranscript("held-chat");
  const before = await readFile(file);
  const lease = Result.getOrThrow(takeSessionLease(profilePath, "held-chat"));
  let factoryCalls = 0;

  try {
    const exit = await Effect.runPromiseExit(
      openSession(openRequest(profilePath, directory), {
        runtimeFactory: (...args) => {
          factoryCalls += 1;

          return createAgentSessionRuntime(...args);
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(await readFile(file)).toEqual(before);
  } finally {
    lease.release();
  }
});

test("an uninitialized Profile is refused before any lease or session directory exists", async () => {
  const profilePath = await temporaryProfile();

  const exit = await Effect.runPromiseExit(
    openSession(openRequest(profilePath, join(profilePath, "sessions", "chat"))),
  );

  expect(exit).toMatchObject({
    cause: { reasons: [{ error: { _tag: "ProfileNotInitialized" } }] },
  });
  expect(await readdir(profilePath)).toEqual([]);
});

test("a second prompt is refused as busy instead of queueing behind the first", async () => {
  const sessionManager = SessionManager.inMemory("/profile");

  const runtime = fakePiRuntime({
    sessionManager,
    prompt: () => new Promise<void>(() => undefined),
  });

  const handle = await Effect.runPromise(
    makeChatHandle({ profilePath: "/profile", runtime, leases: makeSessionLeaseSet("/profile") }),
  );

  const first = Effect.runFork(handle.prompt("first"));
  await Effect.runPromise(Effect.yieldNow);

  const second = await Effect.runPromiseExit(handle.prompt("second"));
  expect(second).toMatchObject({ cause: { reasons: [{ error: { _tag: "SessionBusy" } }] } });

  await Effect.runPromise(Fiber.interrupt(first));
  await Effect.runPromise(handle.dispose);
});

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
    const sessionManager = SessionManager.inMemory("/profile");

    const runtime = fakePiRuntime({
      get isIdle() {
        return idle;
      },
      abort: () => {
        aborted += 1;

        if (aborted > 1) return Promise.resolve();

        return new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
      },
      steer: () => Promise.resolve("queued" as const),
      followUp: () => Promise.resolve("queued" as const),
      sessionManager,
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    });

    const handle = await Effect.runPromise(
      makeChatHandle({ profilePath: "/profile", runtime, leases: makeSessionLeaseSet("/profile") }),
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
        openSession({
          target: { path: profilePath, name: "Profile" },
          context: { kind: "group", groupId: "slC123" },
          directory: sessionDirectory,
          session: "new",
        }),
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
        openSession({
          target: { path: profilePath, name: "Profile" },
          context: { kind: "group", groupId: "slC123" },
          directory: sessionDirectory,
          session: "continue",
        }),
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

describe("Profile extension tool admission", () => {
  test("registers the extension tool on a Profile session", async () => {
    const profilePath = await temporaryProfile();
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    const profileExtensions = Effect.runSync(Extensions.make);
    let parentRuntime: AgentSessionRuntime | undefined;

    const runtimeFactory: typeof createAgentSessionRuntime = async (createRuntime, options) => {
      const runtime = await createAgentSessionRuntime(createRuntime, options);
      parentRuntime = runtime;

      return runtime;
    };

    const parentExit = await Effect.runPromiseExit(
      openSession(
        {
          target: { path: profilePath, name: "Profile" },
          context: { kind: "local" },
          directory: join(profilePath, "sessions", "parent"),
          session: "new",
        },
        {
          tools: [extensionTools(profileExtensions)],
          runtimeFactory,
        },
      ),
    );

    if (Exit.isSuccess(parentExit)) await Effect.runPromise(parentExit.value.dispose);
    expect(parentRuntime).toBeDefined();

    if (parentRuntime === undefined) throw new Error("expected parent runtime");
    expect(parentRuntime.session.getAllTools().map((tool) => tool.name)).toContain(
      "profile_extensions",
    );
  });
});

describe("Pi transcripts", () => {
  test("Pi persistent mode allocates a lazy path and writes JSONL on the first user message", async () => {
    const profilePath = await temporaryProfile();
    const manager = SessionManager.create(profilePath, join(profilePath, "sessions", "lazy"));
    const file = manager.getSessionFile();
    expect(manager.isPersisted()).toBe(true);
    expect(file).toBeDefined();

    if (file === undefined) throw new Error("expected a persistent target path");
    expect(await Bun.file(file).exists()).toBe(false);

    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "materializes JSONL before any assistant reply" }],
      timestamp: Date.now(),
    });

    expect(await Bun.file(file).exists()).toBe(true);
  });
});
