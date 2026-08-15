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
  type CreateAgentSessionFromServicesOptions,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Database } from "bun:sqlite";
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect";
import { Type } from "typebox";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  SpecialistAgentNotFound,
  type ChatModelOverride,
  type OpenTuiError,
  type ProfileAgentRunContext,
  type ProfileAgentRunResult,
  type ProfileSpecialistError,
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
import {
  prepareProfileAgentPrompt,
  ProfileAgentMentionInvalid,
  ProfileExtensionInvalid,
  type ProfileAgent,
  type ProfileTarget,
} from "../../domain/profile";
import type { ChatHandle, ChatPromptOptions } from "../../application/agent";
import { fileSystemCauseDetails } from "../fs/cause";
import { discoverProfileAgents } from "../fs/profile-agents";
import { discoverPiResources, type PiResources } from "./resources";
import {
  createAgentDiscussTool,
  createAgentRunTool,
  makeSpecialistRunner,
  selectSpecialist,
  specialistRuntime,
  useSpecialistChild,
  type SpecialistParent,
} from "./specialist";
import { sessionReference } from "./session-lineage";
import {
  makeAutomationTuiDispatch,
  type AutomationTuiDispatch,
  type AutomationTuiHandler,
} from "./automation-tui";
import {
  createProfileExtensionSelectionRunner,
  type ProfileExtensionCatalogOperations,
} from "./profile-extension-selection";
import { leaseCompiledPiTuiAssets } from "./tui-themes";
import { loadProfileSystemPrompt } from "./profile-prompt";
import {
  createProfileAgentGuidanceExtension,
  createZiggyTuiExtension,
} from "./ziggy-tui-extension";

export interface PiAgentApi {
  readonly runSpecialist: (
    target: ProfileTarget,
    agentId: string,
    task: string,
    context: ProfileAgentRunContext,
  ) => Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError>;
  readonly askOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openTui: (
    target: ProfileTarget,
    context: ChatContext,
    automationHandler?: AutomationTuiHandler,
  ) => Effect.Effect<number, OpenTuiError>;
  readonly openChat: (
    target: ProfileTarget,
    context: ChatContext,
    sessionDirectory: string,
    sessionMode?: ChatSessionMode,
    modelOverride?: ChatModelOverride,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError>;
}

export class PiAgent extends Context.Service<PiAgent, PiAgentApi>()("ziggy/PiAgent") {}

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

  if (operation === "call provider") {
    return new ProviderCallError({
      profilePath,
      operation,
      message: "provider request failed",
      cause,
    });
  }

  if (operation === "select model") {
    return new ProviderConfigError({
      profilePath,
      operation,
      message: `provider configuration failed; place credentials in ${join(profilePath, "auth.json")} and model configuration in ${join(profilePath, "models.json")}`,
      cause,
    });
  }

  return new ProviderConfigError({
    profilePath,
    operation,
    message: `${operation} failed: ${causeMessage(cause)}`,
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
    catch: (cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? new ProfileNotInitialized({
            profilePath,
            message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
          })
        : new ProviderConfigError({
            profilePath,
            operation: "read system prompt",
            message: `could not read ${soulPath}`,
            cause,
          }),
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

interface AgentSessionRuntimeRef {
  current?: AgentSessionRuntime;
}

interface ProfileRuntimeResourceLoaderOptions {
  systemPrompt: string;
  noExtensions: true;
  noSkills: true;
  noPromptTemplates: true;
  noThemes: true;
  noContextFiles: true;
  extensionFactories: InlineExtension[];
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
}

interface NavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

const AssistantTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const decodeAssistantTextContent = Schema.decodeUnknownOption(AssistantTextContent);

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

const logMemoryCleanupFailure = (operation: string, path: string, cause: unknown) =>
  Effect.logWarning("Pi memory cleanup failed", { operation, path, cause });

const removeTemporaryMemoryFile = (path: string): Effect.Effect<void> =>
  memoryIo("write", path, () => rm(path)).pipe(
    Effect.catch((failure) =>
      fileSystemCauseDetails(failure.cause).code === "ENOENT"
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
              if (
                fileSystemCauseDetails(acquired.failure.cause).code?.startsWith("SQLITE_BUSY") !==
                true
              )
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
      fileSystemCauseDetails(failure.cause).code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(failure),
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

interface EphemeralPromptContextState {
  generation: number;
  value?: string;
}

export const appendEphemeralPromptContext = (
  event: Pick<BeforeAgentStartEvent, "systemPrompt">,
  context: string,
): BeforeAgentStartEventResult => ({
  systemPrompt: `${event.systemPrompt}\n\n${context}`,
});

export const createEphemeralPromptContextExtension = (
  current: () => string | undefined,
): InlineExtension => ({
  name: "ziggy-ephemeral-prompt-context",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      const context = current();
      return context === undefined ? undefined : appendEphemeralPromptContext(event, context);
    });
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
    const prepared = prepareProfileAgentPrompt(prompt, runtime.agents);
    if (!prepared.ok) {
      yield* piPromise(target.path, "dispose agent runtime", () => runtime.dispose()).pipe(
        Effect.catch((failure) => Effect.logWarning("Pi runtime cleanup failed", { failure })),
      );
      return yield* new ProfileAgentMentionInvalid({
        profilePath: target.path,
        message: prepared.message,
      });
    }

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
        initialMessage: prepared.text,
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

interface ProfileRuntime extends AgentSessionRuntime {
  readonly resources: PiResources;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly ephemeralPromptContext: EphemeralPromptContextState;
}

interface ProfileRuntimeOptions {
  admittedAgents?: ReadonlyArray<ProfileAgent>;
  automationDispatch?: AutomationTuiDispatch;
  extensionCatalog?: ProfileExtensionCatalogOperations;
  modelOverride?: ChatModelOverride;
}

const configuredSessionModelError = (profilePath: string, message: string) =>
  new ProviderConfigError({
    profilePath,
    operation: "select model",
    message,
    cause: undefined,
  });

const applyConfiguredSessionModel = (
  profilePath: string,
  services: {
    readonly settingsManager: {
      readonly getDefaultProvider: () => string | undefined;
      readonly getDefaultModel: () => string | undefined;
      readonly getDefaultThinkingLevel: () => ThinkingLevel | undefined;
    };
    readonly modelRuntime: {
      readonly getProvider: (providerId: string) => object | undefined;
      readonly getModel: (providerId: string, modelId: string) => Model<Api> | undefined;
      readonly hasConfiguredAuth: (providerId: string) => boolean;
    };
  },
  sessionOptions: CreateAgentSessionFromServicesOptions,
  override: ChatModelOverride | undefined,
): void => {
  const overrideProvider = override?.provider;
  const overrideModel = override?.model;
  if ((overrideProvider === undefined) !== (overrideModel === undefined)) {
    throw configuredSessionModelError(profilePath, "provider and model must be provided together");
  }

  const providerId = overrideProvider ?? services.settingsManager.getDefaultProvider();
  const modelId = overrideModel ?? services.settingsManager.getDefaultModel();
  const thinking = override?.thinking ?? services.settingsManager.getDefaultThinkingLevel();
  const model =
    providerId === undefined || modelId === undefined
      ? undefined
      : services.modelRuntime.getModel(providerId, modelId);

  if (overrideProvider !== undefined) {
    if (services.modelRuntime.getProvider(overrideProvider) === undefined) {
      throw configuredSessionModelError(
        profilePath,
        `provider is not configured in the Profile model registry: ${overrideProvider}`,
      );
    }
    if (model === undefined) {
      throw configuredSessionModelError(
        profilePath,
        `model is not configured in the Profile model registry: ${overrideProvider}/${overrideModel}`,
      );
    }
    if (!services.modelRuntime.hasConfiguredAuth(overrideProvider)) {
      throw configuredSessionModelError(
        profilePath,
        `provider auth is not configured in the Profile: ${overrideProvider}`,
      );
    }
  } else if (override?.thinking !== undefined && model === undefined) {
    throw configuredSessionModelError(
      profilePath,
      "thinking override requires a configured Profile model",
    );
  }

  const overridePresent = overrideProvider !== undefined || override?.thinking !== undefined;
  if (
    overridePresent &&
    model !== undefined &&
    thinking !== undefined &&
    !getSupportedThinkingLevels(model).some((level) => level === thinking)
  ) {
    throw configuredSessionModelError(
      profilePath,
      `thinking level is not supported by ${providerId}/${modelId}: ${thinking}`,
    );
  }

  if (model !== undefined) sessionOptions.model = model;
  if (thinking !== undefined) sessionOptions.thinkingLevel = thinking;
};

const createProfileRuntime = (
  profilePath: string,
  repositoryRoot: string,
  soulPath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  runtimeOptions: ProfileRuntimeOptions = {},
): Effect.Effect<ProfileRuntime, ZiggyAgentError> =>
  Effect.gen(function* () {
    const paths = memoryFilePaths(profilePath, context);
    if (!paths.ok) {
      return yield* paths.error;
    }
    const agents = runtimeOptions.admittedAgents ?? (yield* discoverProfileAgents(profilePath));
    if (runtimeOptions.extensionCatalog?.materialize !== undefined) {
      yield* runtimeOptions.extensionCatalog.materialize(profilePath, repositoryRoot).pipe(
        Effect.mapError(
          (cause) =>
            new ProfileExtensionInvalid({
              path: profilePath,
              message: "could not install selected Profile extensions onto disk",
              cause,
            }),
        ),
      );
    }
    const resources = yield* discoverPiResources(profilePath, repositoryRoot);
    const systemPrompt = yield* loadProfileSystemPrompt(profilePath, soulPath);

    const runtimeRef: AgentSessionRuntimeRef = {};
    const ephemeralPromptContext: EphemeralPromptContextState = { generation: 0 };

    const runtime = yield* piPromise(profilePath, "create agent runtime", async () => {
      const runtime = await createAgentSessionRuntime(
        async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir,
            resourceLoaderOptions: (() => {
              const options: ProfileRuntimeResourceLoaderOptions = {
                systemPrompt,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                extensionFactories: [
                  createZiggyTuiExtension(
                    profilePath,
                    agents,
                    runtimeOptions.extensionCatalog === undefined
                      ? undefined
                      : createProfileExtensionSelectionRunner(
                          profilePath,
                          repositoryRoot,
                          runtimeOptions.extensionCatalog,
                        ),
                    runtimeOptions.automationDispatch,
                  ),
                  ...(agents.length === 0 ? [] : [createProfileAgentGuidanceExtension(agents)]),
                  createProfileMemoryExtension(profilePath, paths.documents),
                  createEphemeralPromptContextExtension(() => ephemeralPromptContext.value),
                  ...resources.extensionFactories,
                ],
              };
              if (resources.extensionPaths.length > 0) {
                options.additionalExtensionPaths = [...resources.extensionPaths];
              }
              if (resources.skillPaths.length > 0) {
                options.additionalSkillPaths = [...resources.skillPaths];
              }
              return options;
            })(),
          });
          const specialistRunner =
            agents.length === 0
              ? undefined
              : makeSpecialistRunner({
                  profilePath,
                  agents,
                  parent: () => {
                    const current = runtimeRef.current;
                    if (current === undefined) return undefined;
                    const parent: SpecialistParent = {
                      session: current.session,
                      services,
                      resources,
                    };
                    return parent;
                  },
                });
          const customTools: Array<ToolDefinition> = [
            createMemoryWriteTool(profilePath, context),
            ...(specialistRunner === undefined
              ? []
              : [createAgentRunTool(specialistRunner), createAgentDiscussTool(specialistRunner)]),
          ];
          const sessionOptions: CreateAgentSessionFromServicesOptions = {
            services,
            sessionManager: runtimeSessionManager,
            customTools,
          };
          if (sessionStartEvent !== undefined) sessionOptions.sessionStartEvent = sessionStartEvent;
          applyConfiguredSessionModel(
            profilePath,
            services,
            sessionOptions,
            runtimeOptions.modelOverride,
          );
          const created = await createAgentSessionFromServices(sessionOptions);
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
      );
      return runtime;
    });
    // AgentSessionRuntime owns `services` through a getter. Attach only Ziggy's
    // additional resource bundle; assigning `services` would throw at runtime.
    const profileRuntime: ProfileRuntime = Object.assign(runtime, {
      resources,
      agents,
      ephemeralPromptContext,
    });
    runtimeRef.current = profileRuntime;
    return profileRuntime;
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
          if (
            options?.summarize === undefined &&
            options?.customInstructions === undefined &&
            options?.replaceInstructions === undefined &&
            options?.label === undefined
          ) {
            const result = await session.navigateTree(targetId);
            return { cancelled: result.cancelled };
          }
          const navigateOptions: NavigateTreeOptions = {};
          if (options?.summarize !== undefined) navigateOptions.summarize = options.summarize;
          if (options?.customInstructions !== undefined) {
            navigateOptions.customInstructions = options.customInstructions;
          }
          if (options?.replaceInstructions !== undefined) {
            navigateOptions.replaceInstructions = options.replaceInstructions;
          }
          if (options?.label !== undefined) navigateOptions.label = options.label;
          const result = await session.navigateTree(targetId, navigateOptions);
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

const MAX_PROGRESS_TEXT_CODE_POINTS = 3_800;
const MAX_PROGRESS_DELTA_CODE_POINTS = 512;
const MAX_PROGRESS_TOOL_NAME_CODE_POINTS = 48;
const MAX_PROGRESS_TOOL_ID_CODE_POINTS = 128;
const MAX_PROGRESS_TOOL_DETAIL_CODE_POINTS = 120;
const ProgressToolArgs = Schema.Struct({
  command: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  list: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
const decodeProgressToolArgs = Schema.decodeUnknownOption(ProgressToolArgs);
const PROGRESS_TOOL_DETAIL_KEYS = [
  "command",
  "cmd",
  "path",
  "filePath",
  "file",
  "query",
  "list",
  "name",
] as const;

const boundedCodePoints = (value: string, maximum: number): string =>
  [...value].slice(0, maximum).join("");

export const safeProgressToolName = (value: string): string => {
  const normalized = value
    .replace(/[^\p{L}\p{N}_.:/-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return boundedCodePoints(
    normalized.length === 0 ? "tool" : normalized,
    MAX_PROGRESS_TOOL_NAME_CODE_POINTS,
  );
};

export const progressToolDetail = (args: typeof ProgressToolArgs.Type): string | undefined => {
  for (const key of PROGRESS_TOOL_DETAIL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    const normalized = value.replace(/\s+/gu, " ").trim();
    if (normalized.length === 0) continue;
    return boundedCodePoints(normalized, MAX_PROGRESS_TOOL_DETAIL_CODE_POINTS);
  }
  return undefined;
};

const assistantTextSnapshot = (content: ReadonlyArray<{ readonly type: string }>): string =>
  boundedCodePoints(
    content
      .flatMap((item) =>
        Option.match(decodeAssistantTextContent(item), {
          onNone: () => [],
          onSome: ({ text }) => [text],
        }),
      )
      .join(""),
    MAX_PROGRESS_TEXT_CODE_POINTS,
  );

export const promptForAssistantText = (
  profilePath: string,
  session: PromptSession,
  text: string,
  options?: ChatPromptOptions,
): Effect.Effect<string, ProviderConfigError | ProviderCallError> =>
  Effect.callback((resume) => {
    let assistantText = "";
    let assistantError: string | undefined;
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    const lastToolDetail = new Map<string, string>();

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
      if (event.type === "message_update" && event.message.role === "assistant") {
        const delta =
          event.assistantMessageEvent.type === "text_delta"
            ? boundedCodePoints(event.assistantMessageEvent.delta, MAX_PROGRESS_DELTA_CODE_POINTS)
            : "";
        const snapshot = assistantTextSnapshot(event.message.content);
        if ((snapshot.length > 0 || delta.length > 0) && options?.onProgress !== undefined) {
          options.onProgress({ kind: "assistant-text", delta, snapshot });
        }
      }
      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        const fromArgs = Option.match(
          decodeProgressToolArgs(event.type === "tool_execution_end" ? undefined : event.args, {
            onExcessProperty: "ignore",
          }),
          {
            onNone: () => undefined,
            onSome: progressToolDetail,
          },
        );
        if (fromArgs !== undefined) lastToolDetail.set(event.toolCallId, fromArgs);
        const detail = fromArgs ?? lastToolDetail.get(event.toolCallId);
        if (event.type === "tool_execution_end") lastToolDetail.delete(event.toolCallId);
        options?.onProgress?.({
          kind: "tool",
          phase:
            event.type === "tool_execution_start"
              ? "start"
              : event.type === "tool_execution_update"
                ? "update"
                : "end",
          toolCallId: boundedCodePoints(event.toolCallId, MAX_PROGRESS_TOOL_ID_CODE_POINTS),
          toolName: safeProgressToolName(event.toolName),
          failed: event.type === "tool_execution_end" && event.isError,
          ...Object.fromEntries(detail === undefined ? [] : ([["detail", detail]] as const)),
        });
      }
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

    const promptOptions = options?.images === undefined ? undefined : { images: options.images };
    void session.prompt(text, promptOptions).then(
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
  modelOverride?: ChatModelOverride,
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
      modelOverride === undefined ? undefined : { modelOverride },
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
      prompt: (text, options) =>
        Effect.suspend(() => {
          const generation = runtime.ephemeralPromptContext.generation + 1;
          runtime.ephemeralPromptContext.generation = generation;
          if (options?.ephemeralContext === undefined) {
            delete runtime.ephemeralPromptContext.value;
          } else {
            runtime.ephemeralPromptContext.value = options.ephemeralContext;
          }
          const prepared = prepareProfileAgentPrompt(text, runtime.agents);
          const prompted: Effect.Effect<string, ZiggyAgentError> = prepared.ok
            ? promptForAssistantText(target.path, runtime.session, prepared.text, options)
            : Effect.fail(
                new ProfileAgentMentionInvalid({
                  profilePath: target.path,
                  message: prepared.message,
                }),
              );
          return prompted.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (runtime.ephemeralPromptContext.generation === generation) {
                  delete runtime.ephemeralPromptContext.value;
                }
              }),
            ),
          );
        }),
      dispose,
    };
  });

export const runSpecialist = (
  target: ProfileTarget,
  agentId: string,
  task: string,
  context: ProfileAgentRunContext,
  repositoryRoot: string,
): Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const agents = yield* discoverProfileAgents(target.path);
    if (!agents.some((agent) => agent.id === agentId)) {
      return yield* new SpecialistAgentNotFound({
        profilePath: target.path,
        agentId,
        message: `unknown Profile agent: ${agentId}`,
      });
    }
    const rootManager = SessionManager.create(target.path, context.sessionDirectory);
    const rootReference = sessionReference(rootManager);
    if (rootReference === undefined) {
      return yield* new ProviderConfigError({
        profilePath: target.path,
        operation: "create Profile agent session",
        message: "Pi did not create a persistent Profile agent session",
        cause: undefined,
      });
    }

    const selectedEnvironment = yield* Effect.acquireUseRelease(
      createProfileRuntime(
        target.path,
        repositoryRoot,
        soulPath,
        rootManager,
        { kind: "local" },
        { admittedAgents: agents },
      ),
      (runtime) =>
        selectSpecialist(
          { profilePath: target.path, agents },
          { agent: agentId, prompt: task },
          runtime,
        ).pipe(
          Effect.map((selected) => ({
            selected,
            environment: { services: runtime.services, resources: runtime.resources },
          })),
        ),
      (runtime) =>
        piPromise(target.path, "dispose specialist selection runtime", () =>
          runtime.dispose(),
        ).pipe(
          Effect.catch((failure) =>
            Effect.logWarning("Pi specialist selection cleanup failed", { failure }),
          ),
        ),
    );

    const { selected, environment } = selectedEnvironment;
    const result = yield* useSpecialistChild(
      target.path,
      specialistRuntime(
        target.path,
        environment,
        selected.agent,
        selected.model,
        selected.thinking,
        selected.tools,
        rootManager,
      ).pipe(
        Effect.map((runtime) => ({
          session: runtime.session,
          reference: rootReference,
          dispose: () => runtime.dispose(),
        })),
      ),
      selected,
      (runtime) => promptForAssistantText(target.path, runtime.session, task),
    );
    return { answer: result.answer, session: result.session };
  });

export const openTui = (
  target: ProfileTarget,
  context: ChatContext,
  repositoryRoot: string,
  automationHandler?: AutomationTuiHandler,
  extensionCatalog?: ProfileExtensionCatalogOperations,
): Effect.Effect<number, OpenTuiError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const soulPath = yield* requireSoul(target.path);
      const assets = yield* piPromise(target.path, "prepare Pi package assets", () =>
        leaseCompiledPiTuiAssets(),
      );
      yield* Effect.addFinalizer(() =>
        piPromise(target.path, "remove Pi package assets", assets.release).pipe(
          Effect.catch((failure) => Effect.logWarning("Pi asset cleanup failed", { failure })),
        ),
      );
      const sessionManager = createLocalSessionManager(target.path, "main");
      const automationDispatch =
        automationHandler === undefined
          ? undefined
          : yield* makeAutomationTuiDispatch(automationHandler);
      const runtimeOptions: ProfileRuntimeOptions = {};
      if (automationDispatch !== undefined) runtimeOptions.automationDispatch = automationDispatch;
      if (extensionCatalog !== undefined) runtimeOptions.extensionCatalog = extensionCatalog;
      const runtime = yield* createProfileRuntime(
        target.path,
        repositoryRoot,
        soulPath,
        sessionManager,
        context,
        runtimeOptions,
      );

      yield* piPromise(target.path, "open interactive mode", async () => {
        initTheme();
        const interactiveMode = new InteractiveMode(runtime, {});
        await interactiveMode.run();
      });

      return 0;
    }),
  );

export const makePiAgent = (
  repositoryRoot: string,
  extensionCatalog?: ProfileExtensionCatalogOperations,
): PiAgentApi => ({
  runSpecialist: (target, agentId, task, context) =>
    runSpecialist(target, agentId, task, context, repositoryRoot),
  askOnce: (target, prompt, continueSession, context) =>
    askOnce(target, prompt, continueSession, context, repositoryRoot),
  openTui: (target, context, automationHandler) =>
    openTui(target, context, repositoryRoot, automationHandler, extensionCatalog),
  openChat: (target, context, sessionDirectory, sessionMode, modelOverride) =>
    openChat(target, context, sessionDirectory, repositoryRoot, sessionMode, modelOverride),
});

export const makePiAgentLive = (
  repositoryRoot: string,
  extensionCatalog?: ProfileExtensionCatalogOperations,
) => Layer.succeed(PiAgent, makePiAgent(repositoryRoot, extensionCatalog));
