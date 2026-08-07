import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Database } from "bun:sqlite";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { Type } from "typebox";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  type OpenTuiError,
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
import type { ProfileAgent, ProfileTarget } from "../../domain/profile";
import { discoverProfileAgents } from "../fs/profile-agents";
import { discoverPiResources } from "./resources";
import { createZiggyTuiExtension } from "./ziggy-tui-extension";

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
  ) => Effect.Effect<number, OpenTuiError>;
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

export const providerError = (
  profilePath: string,
  operation: string,
  cause: unknown,
): ProviderConfigError | ProviderCallError => {
  if (cause instanceof ProviderConfigError || cause instanceof ProviderCallError) {
    return cause;
  }

  if (operation !== "call provider") {
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
    message: "provider request failed",
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

class MemoryWriteIoError extends Schema.TaggedErrorClass<MemoryWriteIoError>()(
  "MemoryWriteIoError",
  {
    operation: Schema.Literals(["lock", "read", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const memoryIo = <A>(
  operation: MemoryWriteIoError["operation"],
  path: string,
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, MemoryWriteIoError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MemoryWriteIoError({ operation, path, cause }),
  });

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const logMemoryCleanupFailure = (operation: string, path: string, cause: unknown) =>
  Effect.logWarning("Pi memory cleanup failed", { operation, path, cause });

const removeTemporaryMemoryFile = (path: string): Effect.Effect<void> =>
  memoryIo("write", path, () => rm(path)).pipe(
    Effect.catch((failure) =>
      errorCode(failure.cause) === "ENOENT"
        ? Effect.void
        : logMemoryCleanupFailure("remove temporary file", path, failure.cause),
    ),
  );

const atomicReplace = (
  document: MemoryDocument,
  content: string,
): Effect.Effect<void, MemoryWriteIoError> => {
  const temporaryPath = join(dirname(document.absolutePath), `.${randomUUID()}.memory-write.tmp`);
  const publish = Effect.gen(function* () {
    yield* memoryIo("write", dirname(document.absolutePath), () =>
      mkdir(dirname(document.absolutePath), { recursive: true }),
    );
    yield* Effect.acquireUseRelease(
      memoryIo("write", temporaryPath, () => open(temporaryPath, "wx")),
      (temporaryFile) =>
        memoryIo("write", temporaryPath, async () => {
          await temporaryFile.writeFile(content, "utf8");
          await temporaryFile.sync();
        }),
      (temporaryFile) =>
        memoryIo("write", temporaryPath, () => temporaryFile.close()).pipe(
          Effect.catch((failure) =>
            logMemoryCleanupFailure("close temporary file", temporaryPath, failure.cause),
          ),
        ),
    );
    yield* memoryIo("write", document.absolutePath, () =>
      rename(temporaryPath, document.absolutePath),
    );
  });
  return publish.pipe(Effect.ensuring(removeTemporaryMemoryFile(temporaryPath)));
};

const memoryLockPath = (profilePath: string, document: MemoryDocument): string =>
  join(
    profilePath,
    ".runtime",
    "memory-locks",
    `${encodeURIComponent(document.relativePath)}.sqlite`,
  );

const releaseMemoryDatabase = (database: Database, path: string): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      if (database.inTransaction) database.exec("ROLLBACK");
      database.close();
    },
    catch: (cause) => new MemoryWriteIoError({ operation: "lock", path, cause }),
  }).pipe(Effect.catch((failure) => logMemoryCleanupFailure("release lock", path, failure.cause)));

const withMemoryLock = <A, E>(
  profilePath: string,
  document: MemoryDocument,
  use: Effect.Effect<A, E>,
): Effect.Effect<A, E | MemoryWriteIoError> => {
  const lockPath = memoryLockPath(profilePath, document);
  return memoryIo("lock", dirname(lockPath), () =>
    mkdir(dirname(lockPath), { recursive: true }),
  ).pipe(
    Effect.andThen(
      Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const database = new Database(lockPath, { create: true });
            database.exec("PRAGMA busy_timeout = 0");
            return database;
          },
          catch: (cause) => new MemoryWriteIoError({ operation: "lock", path: lockPath, cause }),
        }),
        (database) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 2_000;
            while (true) {
              const acquired = yield* Effect.try({
                try: () => database.exec("BEGIN IMMEDIATE"),
                catch: (cause) =>
                  new MemoryWriteIoError({ operation: "lock", path: lockPath, cause }),
              }).pipe(Effect.result);
              if (Result.isSuccess(acquired)) break;
              if (errorCode(acquired.failure.cause)?.startsWith("SQLITE_BUSY") !== true)
                return yield* acquired.failure;
              if ((yield* Clock.currentTimeMillis) >= deadline)
                return yield* new MemoryWriteIoError({
                  operation: "lock",
                  path: lockPath,
                  cause: "memory lock timed out after 2 seconds",
                });
              yield* Effect.sleep("50 millis");
            }
            return yield* use;
          }),
        (database) => releaseMemoryDatabase(database, lockPath),
      ),
    ),
  );
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
  execute(_toolCallId, { scope, operations }, signal) {
    const target = writableMemoryDocument(profilePath, context, scope);
    if (!target.ok) return Promise.resolve(toolError(target.message));

    const program = withMemoryLock(
      profilePath,
      target.document,
      Effect.gen(function* () {
        const loaded = yield* readMemoryDocument(target.document);
        const applied = applyMemoryOperations(loaded ?? "", operations, target.document.cap);
        if (!applied.ok) return toolError(applied.message);
        if (!applied.changed) return toolResult("no change");
        yield* atomicReplace(target.document, applied.content);
        return toolResult(
          `applied ${operations.length} operation(s); ${codePointLength(applied.content)}/${target.document.cap} code points in ${target.document.relativePath}`,
        );
      }),
    ).pipe(
      Effect.catch((failure) =>
        Effect.succeed(
          toolError(failure.operation === "read" ? "memory read failed" : "memory write failed"),
        ),
      ),
    );
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning tool callback; this is the single adapter bridge.
    return Effect.runPromise(program, { signal });
  },
});

const readMemoryDocument = (
  document: MemoryDocument,
): Effect.Effect<string | undefined, MemoryWriteIoError> =>
  memoryIo("read", document.absolutePath, (signal) =>
    readFile(document.absolutePath, { encoding: "utf8", signal }),
  ).pipe(
    Effect.map((content) => (content.trim().length === 0 ? undefined : content)),
    Effect.catch((failure) =>
      errorCode(failure.cause) === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(failure),
    ),
  );

const buildMemoryPrompt = (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
): Effect.Effect<string, ProviderConfigError> =>
  Effect.forEach(documents, (document) =>
    readMemoryDocument(document).pipe(
      Effect.mapError(
        (failure) =>
          new ProviderConfigError({
            profilePath,
            operation: "read memory",
            message: `could not read ${document.absolutePath}`,
            cause: failure.cause,
          }),
      ),
      Effect.map((content) => ({ document, content })),
    ),
  ).pipe(
    Effect.map((loaded) => {
      const sections = loaded.flatMap(({ document, content }) =>
        content === undefined ? [] : [`${document.heading}\n${renderMemoryForPrompt(content)}`],
      );
      sections.push(
        "Durable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
      );
      return sections.join("\n\n");
    }),
  );

const memoryReadFailurePrompt = (profilePath: string, cause: unknown): string =>
  [
    "PROFILE MEMORY UNAVAILABLE FOR THIS TURN.",
    `Ziggy could not read the admitted Profile memory under ${profilePath}: ${causeMessage(cause)}`,
    "Do not claim to remember Profile facts or call memory_write this turn. Tell the user that Profile memory is unavailable.",
  ].join("\n");

export const refreshProfileMemory = (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
  event: Pick<BeforeAgentStartEvent, "systemPrompt">,
): Promise<BeforeAgentStartEventResult> => {
  const program = buildMemoryPrompt(profilePath, documents).pipe(
    Effect.match({
      onFailure: (cause) => ({
        systemPrompt: `${event.systemPrompt}\n\n${memoryReadFailurePrompt(profilePath, cause)}`,
      }),
      onSuccess: (memoryPrompt) => ({
        systemPrompt: `${event.systemPrompt}\n\n${memoryPrompt}`,
      }),
    }),
  );
  // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi permits a Promise-returning before_agent_start callback; this is the single adapter bridge.
  return Effect.runPromise(program);
};

export const createProfileMemoryExtension = (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
): InlineExtension => ({
  name: "ziggy-profile-memory",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event) => refreshProfileMemory(profilePath, documents, event));
  },
});

export const localMainSessionDirectory = (profilePath: string): string =>
  join(profilePath, "sessions", "local", "main");

export const createLocalSessionManager = (
  profilePath: string,
  mode: "fresh" | "main",
): SessionManager =>
  mode === "main"
    ? SessionManager.continueRecent(profilePath, localMainSessionDirectory(profilePath))
    : SessionManager.create(profilePath, join(profilePath, "sessions"));

export const askOnce = (
  target: ProfileTarget,
  prompt: string,
  continueSession: boolean,
  context: ChatContext,
  repositoryRoot: string,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const sessionManager = createLocalSessionManager(
      target.path,
      continueSession ? "main" : "fresh",
    );
    const runtime = yield* createProfileRuntime(
      target.path,
      repositoryRoot,
      soulPath,
      sessionManager,
      context,
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
  repositoryRoot: string,
  soulPath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  tuiAgents: ReadonlyArray<ProfileAgent> = [],
) =>
  Effect.gen(function* () {
    const paths = memoryFilePaths(profilePath, context);
    if (!paths.ok) {
      return yield* paths.error;
    }
    const resources = yield* discoverPiResources(profilePath, repositoryRoot);

    return yield* piPromise(profilePath, "create agent runtime", () =>
      createAgentSessionRuntime(
        async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir,
            resourceLoaderOptions: {
              systemPrompt: soulPath,
              noExtensions: true,
              noSkills: true,
              ...(resources.extensionPaths.length === 0
                ? {}
                : { additionalExtensionPaths: [...resources.extensionPaths] }),
              ...(resources.skillPaths.length === 0
                ? {}
                : { additionalSkillPaths: [...resources.skillPaths] }),
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              extensionFactories: [
                createZiggyTuiExtension(profilePath, tuiAgents),
                createProfileMemoryExtension(profilePath, paths.documents),
              ],
            },
          });
          const created = await createAgentSessionFromServices({
            services,
            sessionManager: runtimeSessionManager,
            ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
            customTools: [createMemoryWriteTool(profilePath, context)],
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
  });

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

type PromptSession = Pick<
  AgentSessionRuntime["session"],
  "abort" | "isIdle" | "prompt" | "subscribe"
>;

export const promptForAssistantText = (
  profilePath: string,
  session: PromptSession,
  text: string,
): Effect.Effect<string, ProviderConfigError | ProviderCallError> =>
  Effect.callback((resume) => {
    let assistantText = "";
    let assistantError: string | undefined;
    let finished = false;
    let unsubscribe: () => void = () => undefined;

    const finish = (result: Effect.Effect<string, ProviderConfigError | ProviderCallError>) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      resume(result);
    };
    const completeAssistant = () =>
      assistantError === undefined
        ? Effect.succeed(assistantText)
        : Effect.fail(providerError(profilePath, "call provider", new Error(assistantError)));

    unsubscribe = session.subscribe((event) => {
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
      if (event.type === "agent_settled") finish(completeAssistant());
    });

    void session.prompt(text).then(
      () => {
        if (session.isIdle) finish(completeAssistant());
      },
      (cause: unknown) => finish(Effect.fail(providerError(profilePath, "call provider", cause))),
    );

    return Effect.sync(() => {
      if (finished) return false;
      finished = true;
      unsubscribe();
      return true;
    }).pipe(
      Effect.flatMap((shouldAbort) =>
        shouldAbort
          ? piPromise(profilePath, "abort agent session", () => session.abort()).pipe(
              Effect.catch((failure) =>
                Effect.logWarning("Pi prompt interruption cleanup failed", { failure }),
              ),
            )
          : Effect.void,
      ),
    );
  });

export const openChat = (
  target: ProfileTarget,
  context: ChatContext,
  sessionDirectory: string,
  repositoryRoot: string,
  sessionMode: ChatSessionMode = "continue",
): Effect.Effect<ChatHandle, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const runtime = yield* createProfileRuntime(
      target.path,
      repositoryRoot,
      soulPath,
      sessionMode === "continue"
        ? SessionManager.continueRecent(target.path, sessionDirectory)
        : SessionManager.create(target.path, sessionDirectory),
      context,
    );
    const dispose = piPromise(target.path, "dispose agent runtime", () => runtime.dispose());
    const disposeBestEffort = dispose.pipe(
      Effect.catch((failure) => Effect.logWarning("Pi runtime cleanup failed", { failure })),
    );

    if (runtime.modelFallbackMessage !== undefined) {
      yield* disposeBestEffort;
      return yield* new ProviderConfigError({
        profilePath: target.path,
        operation: "select model",
        message: `no configured model is available; place credentials in ${join(target.path, "auth.json")} and model configuration in ${join(target.path, "models.json")}`,
        cause: new Error(runtime.modelFallbackMessage),
      });
    }

    yield* piPromise(target.path, "bind agent runtime", () => bindChatRuntime(runtime)).pipe(
      Effect.tapError(() => disposeBestEffort),
    );

    return {
      prompt: (text) => promptForAssistantText(target.path, runtime.session, text),
      dispose,
    };
  });

export const openTui = (
  target: ProfileTarget,
  context: ChatContext,
  repositoryRoot: string,
): Effect.Effect<number, OpenTuiError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const tuiAgents = yield* discoverProfileAgents(target.path);
    const sessionManager = createLocalSessionManager(target.path, "main");
    const runtime = yield* createProfileRuntime(
      target.path,
      repositoryRoot,
      soulPath,
      sessionManager,
      context,
      tuiAgents,
    );

    yield* piPromise(target.path, "open interactive mode", async () => {
      initTheme();
      const interactiveMode = new InteractiveMode(runtime, {});
      await interactiveMode.run();
    });

    return 0;
  });

export const makePiAgentLive = (repositoryRoot: string) =>
  Layer.succeed(PiAgent, {
    askOnce: (target, prompt, continueSession, context) =>
      askOnce(target, prompt, continueSession, context, repositoryRoot),
    openTui: (target, context) => openTui(target, context, repositoryRoot),
    openChat: (target, context, sessionDirectory, sessionMode) =>
      openChat(target, context, sessionDirectory, repositoryRoot, sessionMode),
  });
