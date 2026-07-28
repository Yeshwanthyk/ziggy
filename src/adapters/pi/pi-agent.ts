import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  InteractiveMode,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  runPrintMode,
  type AgentSessionRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { Type } from "typebox";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  type ZiggyAgentError,
} from "../../domain/agent";
import {
  applyMemoryOperations,
  codePointLength,
  memoryFilePaths,
  renderMemoryForPrompt,
  type ChatContext,
  type MemoryDocument,
  type MemoryScope,
} from "../../domain/memory";
import type { ProfileTarget } from "../../domain/profile";

export interface PiAgentShape {
  readonly askOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openTui: (
    target: ProfileTarget,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openChat: (
    target: ProfileTarget,
    context: ChatContext,
    sessionDirectory: string,
    sessionMode?: ChatSessionMode,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError>;
}

export class PiAgent extends Context.Service<PiAgent, PiAgentShape>()("ziggy/PiAgent") {}

export interface ChatHandle {
  readonly prompt: (text: string) => Effect.Effect<string, ZiggyAgentError>;
  readonly dispose: Effect.Effect<void, ZiggyAgentError>;
}

export type ChatSessionMode = "continue" | "fresh";

const causeMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").trim();

const isProviderConfigFailure = (cause: unknown): boolean => {
  const message = causeMessage(cause).toLowerCase();
  return [
    "no model",
    "no api key",
    "no authentication method",
    "provider is not configured",
    "auth.json",
    "models.json",
    "settings.json",
    "credential",
    "authentication failed",
  ].some((fragment) => message.includes(fragment));
};

const providerError = (
  profilePath: string,
  operation: string,
  cause: unknown,
): ProviderConfigError | ProviderCallError => {
  if (cause instanceof ProviderConfigError || cause instanceof ProviderCallError) {
    return cause;
  }

  if (operation !== "call provider" || isProviderConfigFailure(cause)) {
    return new ProviderConfigError({
      profilePath,
      operation,
      message: `provider configuration failed; place credentials in ${join(profilePath, "auth.json")} and model configuration in ${join(profilePath, "models.json")}`,
      cause,
    });
  }

  return new ProviderCallError({
    profilePath,
    operation,
    message: `provider request failed: ${causeMessage(cause)}`,
    cause,
  });
};

const piPromise = <A>(
  profilePath: string,
  operation: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ProviderConfigError | ProviderCallError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => providerError(profilePath, operation, cause),
  });

const existingDirectory = (path: string): Promise<string | undefined> =>
  stat(path).then(
    (status) => (status.isDirectory() ? path : undefined),
    (cause: unknown) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      if (code === "ENOENT") {
        return undefined;
      }
      throw cause;
    },
  );

const requireSoul = (profilePath: string) => {
  const soulPath = join(profilePath, "SOUL.md");
  return Effect.tryPromise({
    try: () => stat(soulPath),
    catch: (cause) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      return code === "ENOENT"
        ? new ProfileNotInitialized({
            profilePath,
            message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
          })
        : new ProviderConfigError({
            profilePath,
            operation: "read system prompt",
            message: `could not read ${soulPath}`,
            cause,
          });
    },
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.succeed(soulPath)
        : Effect.fail(
            new ProfileNotInitialized({
              profilePath,
              message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
            }),
          ),
    ),
  );
};

const memoryOperationParameters = Type.Union([
  Type.Object({
    action: Type.Literal("add"),
    content: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("replace"),
    oldText: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    oldText: Type.String(),
  }),
]);

const memoryWriteParameters = Type.Object({
  scope: Type.Union([Type.Literal("shared"), Type.Literal("person"), Type.Literal("group")]),
  operations: Type.Array(memoryOperationParameters),
});

const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

const toolError = (message: string) => toolResult(`ERROR: ${message}`);

const atomicReplace = async (
  document: MemoryDocument,
  content: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }> => {
  const temporaryPath = join(dirname(document.absolutePath), `.${randomUUID()}.memory-write.tmp`);
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(dirname(document.absolutePath), { recursive: true });
    temporaryFile = await open(temporaryPath, "wx");
    await temporaryFile.writeFile(content, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, document.absolutePath);
    return { ok: true };
  } catch (cause: unknown) {
    await temporaryFile?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return { ok: false, cause };
  }
};

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const acquireMemoryLock = async (document: MemoryDocument): Promise<string> => {
  const lockPath = `${document.absolutePath}.lock`;
  const deadline = Date.now() + 2_000;
  await mkdir(dirname(document.absolutePath), { recursive: true });

  while (true) {
    let createdLock = false;
    try {
      const lockFile = await open(lockPath, "wx");
      createdLock = true;
      try {
        await lockFile.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await lockFile.close();
      }
      return lockPath;
    } catch (cause: unknown) {
      if (createdLock) {
        await unlink(lockPath).catch(() => undefined);
        throw cause;
      }
      if (errorCode(cause) !== "EEXIST") {
        throw cause;
      }

      const lockStatus = await stat(lockPath).then(
        (status) => ({ ok: true as const, status }),
        (statCause: unknown) => ({ ok: false as const, cause: statCause }),
      );
      if (!lockStatus.ok) {
        if (errorCode(lockStatus.cause) === "ENOENT") {
          continue;
        }
        throw lockStatus.cause;
      }
      if (Date.now() - lockStatus.status.mtimeMs > 10_000) {
        await unlink(lockPath).catch((unlinkCause: unknown) => {
          if (errorCode(unlinkCause) !== "ENOENT") {
            throw unlinkCause;
          }
        });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("memory lock timed out after 2 seconds");
      }
      await delay(50);
    }
  }
};

const writableMemoryDocument = (
  profilePath: string,
  context: ChatContext,
  scope: MemoryScope,
):
  | { readonly ok: true; readonly document: MemoryDocument }
  | { readonly ok: false; readonly message: string } => {
  const paths = memoryFilePaths(profilePath, context);
  if (!paths.ok) {
    return { ok: false, message: paths.error.message };
  }

  if (scope === "person" && context.kind === "group") {
    return { ok: false, message: "person memory is not writable in group chats" };
  }

  if (scope === "group" && context.kind !== "group") {
    return { ok: false, message: "group memory is not writable in 1:1 chats" };
  }

  const document = paths.documents.find((candidate) => candidate.scope === scope);
  if (document === undefined) {
    return { ok: false, message: `${scope} memory is not available in this chat` };
  }

  return { ok: true, document };
};

export const createMemoryWriteTool = (
  profilePath: string,
  context: ChatContext,
): ToolDefinition<typeof memoryWriteParameters> => ({
  name: "memory_write",
  label: "memory_write",
  description:
    "Apply an all-or-nothing batch of entry-based add, replace, or remove operations to curated memory. Use shared for assistant-wide facts (2200 code points), person for the current 1:1 person (1375), or group for the current group (1375). Add is idempotent; replace/remove oldText must match exactly one entry. Person memory is unavailable in groups; group memory is unavailable in 1:1 chats.",
  parameters: memoryWriteParameters,
  async execute(_toolCallId, { scope, operations }) {
    const target = writableMemoryDocument(profilePath, context, scope);
    if (!target.ok) {
      return toolError(target.message);
    }

    let lockPath: string | undefined;
    try {
      lockPath = await acquireMemoryLock(target.document);
      const loaded = await readMemoryDocument(target.document);
      if (!loaded.ok) {
        return toolError(`memory read failed: ${causeMessage(loaded.cause)}`);
      }

      const applied = applyMemoryOperations(loaded.content ?? "", operations, target.document.cap);
      if (!applied.ok) {
        return toolError(applied.message);
      }
      if (!applied.changed) {
        return toolResult("no change");
      }

      const write = await atomicReplace(target.document, applied.content);
      if (!write.ok) {
        return toolError(`memory write failed: ${causeMessage(write.cause)}`);
      }

      return toolResult(
        `applied ${operations.length} operation(s); ${codePointLength(applied.content)}/${target.document.cap} code points in ${target.document.relativePath}`,
      );
    } catch (cause: unknown) {
      return toolError(`memory write failed: ${causeMessage(cause)}`);
    } finally {
      if (lockPath !== undefined) {
        await unlink(lockPath).catch((cause: unknown) => {
          if (errorCode(cause) !== "ENOENT") {
            throw cause;
          }
        });
      }
    }
  },
});

const readMemoryDocument = (
  document: MemoryDocument,
): Promise<
  | { readonly ok: true; readonly content: string | undefined }
  | { readonly ok: false; readonly cause: unknown }
> =>
  readFile(document.absolutePath, "utf8").then(
    (content) => ({ ok: true, content: content.trim().length === 0 ? undefined : content }),
    (cause: unknown) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      return code === "ENOENT" ? { ok: true, content: undefined } : { ok: false, cause };
    },
  );

const buildMemoryPrompt = async (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
): Promise<string> => {
  const loaded = await Promise.all(documents.map(readMemoryDocument));
  const sections: Array<string> = [];

  for (const [index, result] of loaded.entries()) {
    if (!result.ok) {
      const document = documents[index];
      throw new ProviderConfigError({
        profilePath,
        operation: "read memory",
        message: `could not read ${document?.absolutePath ?? profilePath}`,
        cause: result.cause,
      });
    }

    const document = documents[index];
    if (result.content !== undefined && document !== undefined) {
      sections.push(`${document.heading}\n${renderMemoryForPrompt(result.content)}`);
    }
  }

  sections.push(
    "Durable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
  );
  return sections.join("\n\n");
};

export const askOnce = (
  target: ProfileTarget,
  prompt: string,
  continueSession: boolean,
  context: ChatContext,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const sessionDirectory = join(target.path, "sessions");
    const sessionManager = continueSession
      ? SessionManager.continueRecent(target.path, sessionDirectory)
      : SessionManager.create(target.path, sessionDirectory);
    const runtime = yield* createProfileRuntime(
      target.path,
      soulPath,
      sessionManager,
      context,
      "memory-only",
    );

    if (runtime.modelFallbackMessage !== undefined) {
      return yield* new ProviderConfigError({
        profilePath: target.path,
        operation: "select model",
        message: `no configured model is available; place credentials in ${join(target.path, "auth.json")} and model configuration in ${join(target.path, "models.json")}`,
        cause: new Error(runtime.modelFallbackMessage),
      });
    }

    let printError: string | undefined;
    const originalConsoleError = console.error;
    console.error = (...values: ReadonlyArray<unknown>) => {
      printError = values.map(String).join(" ");
    };

    const exitCode = yield* piPromise(target.path, "call provider", () =>
      runPrintMode(runtime, {
        mode: "text",
        initialMessage: prompt,
      }).finally(() => {
        console.error = originalConsoleError;
      }),
    );

    if (exitCode !== 0) {
      return yield* providerError(
        target.path,
        "call provider",
        new Error(printError ?? `provider returned exit code ${exitCode}`),
      );
    }

    return exitCode;
  });

const createProfileRuntime = (
  profilePath: string,
  soulPath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  toolMode: "default" | "memory-only",
) => {
  const paths = memoryFilePaths(profilePath, context);
  if (!paths.ok) {
    return Effect.fail(paths.error);
  }

  return piPromise(profilePath, "create agent runtime", () =>
    createAgentSessionRuntime(
      async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
        const memoryPrompt = await buildMemoryPrompt(profilePath, paths.documents);
        const [skillPath, extensionPath] = await Promise.all([
          existingDirectory(join(profilePath, "skills")),
          existingDirectory(join(profilePath, "extensions")),
        ]);
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          resourceLoaderOptions: {
            systemPrompt: soulPath,
            noExtensions: true,
            noSkills: true,
            ...(skillPath === undefined ? {} : { additionalSkillPaths: [skillPath] }),
            ...(extensionPath === undefined ? {} : { additionalExtensionPaths: [extensionPath] }),
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            appendSystemPrompt: [memoryPrompt],
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: runtimeSessionManager,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          customTools: [createMemoryWriteTool(profilePath, context)],
          ...(toolMode === "memory-only" ? { tools: ["memory_write"] } : {}),
        });
        return {
          ...created,
          services,
          diagnostics: services.diagnostics,
        };
      },
      {
        cwd: profilePath,
        agentDir: profilePath,
        sessionManager,
      },
    ),
  );
};

const bindChatRuntime = async (runtime: AgentSessionRuntime): Promise<void> => {
  const bindSession = async (): Promise<void> => {
    const session = runtime.session;
    await session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => runtime.newSession(options),
        fork: async (entryId, options) => {
          const result = await runtime.fork(entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            ...(options?.summarize === undefined ? {} : { summarize: options.summarize }),
            ...(options?.customInstructions === undefined
              ? {}
              : { customInstructions: options.customInstructions }),
            ...(options?.replaceInstructions === undefined
              ? {}
              : { replaceInstructions: options.replaceInstructions }),
            ...(options?.label === undefined ? {} : { label: options.label }),
          });
          return { cancelled: result.cancelled };
        },
        switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: () => session.reload(),
      },
      onError: (error) => {
        console.error(`Extension error (${error.extensionPath}): ${error.error}`);
      },
    });
  };

  runtime.setRebindSession(bindSession);
  await bindSession();
};

const promptForAssistantText = (runtime: AgentSessionRuntime, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const session = runtime.session;
    let assistantText = "";
    let assistantError: string | undefined;
    let finished = false;

    const completeAssistant = () => {
      if (assistantError !== undefined) {
        reject(new Error(assistantError));
      } else {
        resolve(assistantText);
      }
    };

    const finish = (complete: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      unsubscribe();
      complete();
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantText = event.message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("");
        assistantError =
          event.message.stopReason === "error" || event.message.stopReason === "aborted"
            ? (event.message.errorMessage ?? `Request ${event.message.stopReason}`)
            : undefined;
      }

      if (event.type === "agent_settled") {
        finish(completeAssistant);
      }
    });

    void session.prompt(text).then(
      () => {
        if (session.isIdle) {
          finish(completeAssistant);
        }
      },
      (cause: unknown) => {
        finish(() => reject(cause));
      },
    );
  });

export const openChat = (
  target: ProfileTarget,
  context: ChatContext,
  sessionDirectory: string,
  sessionMode: ChatSessionMode = "continue",
): Effect.Effect<ChatHandle, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const runtime = yield* createProfileRuntime(
      target.path,
      soulPath,
      sessionMode === "continue"
        ? SessionManager.continueRecent(target.path, sessionDirectory)
        : SessionManager.create(target.path, sessionDirectory),
      context,
      "memory-only",
    );
    const dispose = piPromise(target.path, "dispose agent runtime", () => runtime.dispose());

    if (runtime.modelFallbackMessage !== undefined) {
      yield* dispose.pipe(Effect.catch(() => Effect.void));
      return yield* new ProviderConfigError({
        profilePath: target.path,
        operation: "select model",
        message: `no configured model is available; place credentials in ${join(target.path, "auth.json")} and model configuration in ${join(target.path, "models.json")}`,
        cause: new Error(runtime.modelFallbackMessage),
      });
    }

    yield* piPromise(target.path, "bind agent runtime", () => bindChatRuntime(runtime)).pipe(
      Effect.tapError(() => dispose.pipe(Effect.catch(() => Effect.void))),
    );

    return {
      prompt: (text) =>
        piPromise(target.path, "call provider", () => promptForAssistantText(runtime, text)),
      dispose,
    };
  });

export const openTui = (
  target: ProfileTarget,
  context: ChatContext,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const sessionManager = SessionManager.create(target.path, join(target.path, "sessions"));
    const runtime = yield* createProfileRuntime(
      target.path,
      soulPath,
      sessionManager,
      context,
      "default",
    );

    yield* piPromise(target.path, "open interactive mode", async () => {
      initTheme();
      const interactiveMode = new InteractiveMode(runtime, {});
      await interactiveMode.run();
    });

    return 0;
  });

export const PiAgentLive = Layer.succeed(PiAgent, { askOnce, openTui, openChat });
