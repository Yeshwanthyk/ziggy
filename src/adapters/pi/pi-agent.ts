import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createMemoryWriteTool } from "./memory-write-tool";
import { createChatEventProjector } from "./chat-event-projector";
import { bindChatRuntime, type ChatRuntimeBinding } from "./chat-runtime-binding";
import { providerError, piPromise } from "./provider-failure";
import { promptForAssistantText, type PromptSession, type SpecialistVoiceHub } from "./prompt-turn";

import { selectSessionModel } from "../../application/models";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import {
  AutomationConversationDeliveryFailed,
  type AutomationConversationResult,
} from "../../domain/automation";
import {
  SessionManager,
  createAgentSessionFromServices,
  defineTool,
  createAgentSessionRuntime,
  createAgentSessionServices,
  runPrintMode,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionFromServicesOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Exit, Predicate, Result } from "effect";
import {
  ChatNotStreaming,
  ProfileNotInitialized,
  ProviderConfigError,
  SessionBusy,
  SessionHeld,
  SpecialistAgentNotFound,
  type ChatModelOverride,
  type ProfileAgentRunContext,
  type ProfileAgentRunResult,
  type ProfileSpecialistError,
  type SessionReference,
  type ZiggyAgentError,
} from "../../domain/agent";
import { memoryFilePaths, type ChatContext } from "../../domain/memory";
import {
  prepareProfileAgentPrompt,
  ProfileAgentMentionInvalid,
  type ProfileAgentThinking,
  type ProfileAgent,
  type ProfileTarget,
} from "../../domain/profile";
import type {
  ChatEvent,
  ChatHandle,
  ChatSessionModelState,
  RunOnceOptions,
} from "../../application/agent";
import { fileSystemCauseDetails } from "../fs/cause";
import { discoverProfileAgents } from "../fs/profile-agents";
import { composePiResources, discoverPiResources, type PiResources } from "./resources";
import {
  assertNoPiResourceDiagnostics,
  collectPiResourceDiagnostics,
  partitionPiResourceDiagnostics,
  piResourceDiagnosticFailure,
  type SkippedPiPackage,
} from "./profile-extension-diagnostics";
import { profileResourceLoaderOptions } from "./profile-resource-loader";
import { leaseProfileRuntime } from "./profile-runtime-lease";
import { withProfileRuntimeLock } from "../bun/profile-runtime-lock";
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
import { showProfileSession } from "./sessions";
import {
  ProfileExtensionRollbackFailed,
  type ProfileExtensionPreflightFailed,
  type ProfileExtensionsApi,
} from "../../domain/profile-extension";
import { loadProfileSystemPrompt } from "./profile-prompt";
import { createProfileCoreInlineExtensions } from "./profile-core-inline-extensions";
import { ensurePiSessionName } from "./session-name";
import { findRecentSessionFile, readSessionHeaderOnly } from "./session-discovery";
import {
  acquireSessionLease,
  makeSessionLeaseTransitions,
  scopedSessionLease,
  type SessionLeaseTransitions,
  SessionLeaseHeld,
  SessionLeaseFailed,
} from "./session-lease";
import { createProfileExtensionTool } from "./profile-extension-tool";
import {
  AUTOMATION_RESULT_CUSTOM_TYPE,
  automationResultContent,
  isAutomationReceipt,
} from "./automation-result";

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
    options?: RunOnceOptions,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openChat: (
    target: ProfileTarget,
    context: ChatContext,
    sessionDirectory: string,
    sessionMode?: ChatSessionMode,
    modelOverride?: ChatModelOverride,
    sessionName?: string,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError>;
  readonly openSpecialistChat: (
    target: ProfileTarget,
    agentId: string,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError | ProfileSpecialistError>;
}

export class PiAgent extends Context.Service<PiAgent, PiAgentApi>()("ziggy/PiAgent") {}

export type ChatSessionMode = "continue" | "fresh";

const sessionLeaseError = (
  profilePath: string,
  cause: unknown,
): ProviderConfigError | SessionHeld =>
  cause instanceof SessionLeaseHeld
    ? new SessionHeld({ profilePath, message: cause.message, pid: cause.pid })
    : new ProviderConfigError({
        profilePath,
        operation: "open session",
        message: "could not acquire session lease",
        cause,
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

const isProfileExtensionPreflightFailure = (
  cause: unknown,
): cause is ProfileExtensionPreflightFailed =>
  Predicate.isTagged(cause, "ProfileExtensionPreflightFailed");

interface AgentSessionRuntimeRef {
  current?: AgentSessionRuntime;
}

interface EphemeralPromptContextState {
  generation: number;
  value?: string;
}

export const localMainSessionDirectory = (profilePath: string): string =>
  join(profilePath, "sessions", "local", "main");

export const localSpecialistSessionDirectory = (profilePath: string, agentId: string): string =>
  join(profilePath, "sessions", "local", "agents", agentId);

export const createLocalSessionManager = (
  profilePath: string,
  mode: "fresh" | "main",
): SessionManager =>
  mode === "main"
    ? SessionManager.continueRecent(profilePath, localMainSessionDirectory(profilePath))
    : SessionManager.create(profilePath, join(profilePath, "sessions"));

const prepareLeasedSession = (
  profilePath: string,
  directory: string,
  mode: "continue" | "fresh",
  explicitFile?: string,
) =>
  Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      const file =
        explicitFile ??
        (mode === "continue" ? yield* findRecentSessionFile(profilePath, directory) : undefined);

      const header = file === undefined ? undefined : yield* readSessionHeaderOnly(file);
      const fresh = file === undefined ? SessionManager.create(profilePath, directory) : undefined;
      const id = header?.id ?? fresh?.getSessionId();

      if (id === undefined)
        return yield* sessionLeaseError(profilePath, new Error("session has no id"));

      const release = yield* acquireSessionLease(profilePath, id).pipe(
        Effect.mapError((cause) => sessionLeaseError(profilePath, cause)),
      );

      const manager = yield* Effect.try({
        try: () => (file === undefined ? fresh : SessionManager.open(file, directory, profilePath)),
        catch: (cause) => providerError(profilePath, "open session", cause),
      }).pipe(
        Effect.flatMap((opened) =>
          opened === undefined || opened.getSessionId() !== id
            ? Effect.fail(
                sessionLeaseError(profilePath, new Error("session header changed while opening")),
              )
            : Effect.succeed(opened),
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? release.pipe(
                Effect.catch((failure) =>
                  Effect.logWarning("Session lease release failed", { failure }),
                ),
              )
            : Effect.void,
        ),
      );

      return { manager, release };
    }),
  );

export const askOnce = (
  target: ProfileTarget,
  prompt: string,
  continueSession: boolean,
  context: ChatContext,
  repositoryRoot: string,
  options?: RunOnceOptions,
  profileExtensions?: ProfileExtensionsApi,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const soulPath = yield* requireSoul(target.path);

      const { manager: sessionManager, lease } = yield* Effect.acquireRelease(
        prepareLeasedSession(
          target.path,
          options?.sessionPath === undefined
            ? continueSession
              ? localMainSessionDirectory(target.path)
              : join(target.path, "sessions")
            : dirname(options.sessionPath),
          continueSession ? "continue" : "fresh",
          options?.sessionPath,
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof SessionLeaseFailed ? sessionLeaseError(target.path, cause) : cause,
          ),
          Effect.map(({ manager, release }) => ({
            manager,
            lease: makeSessionLeaseTransitions(target.path, manager.getSessionId(), release),
          })),
        ),
        ({ lease }) =>
          lease.close.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Session lease release failed", { failure }),
            ),
          ),
      );

      const runtimeOptions: ProfileRuntimeOptions = {
        beforeServices: async (nextManager) => {
          if (!lease.owns(nextManager.getSessionId())) {
            // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi Promise factory bridge.
            await Effect.runPromise(lease.reserve(nextManager.getSessionId()));
          }
        },
      };

      if (profileExtensions !== undefined) runtimeOptions.profileExtensions = profileExtensions;

      const runtime = yield* createProfileRuntime(
        target.path,
        repositoryRoot,
        soulPath,
        sessionManager,
        context,
        runtimeOptions,
      );

      // Pi print mode replaces command handlers itself. Fail closed rather than allow
      // an extension command to change the transcript without transferring its lease.
      const rejectReplacement = async (): Promise<never> => {
        throw new Error("session replacement is unavailable in ziggy run; use the resident UI");
      };

      runtime.newSession = rejectReplacement;
      runtime.fork = rejectReplacement;
      runtime.switchSession = rejectReplacement;

      yield* Effect.addFinalizer(() =>
        piPromise(target.path, "dispose agent runtime", () => runtime.dispose()).pipe(
          Effect.catch((failure) => Effect.logWarning("Pi runtime cleanup failed", { failure })),
        ),
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
          mode: options?.mode ?? "text",
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
    }),
  );

const createSpecialistVoiceHub = (): SpecialistVoiceHub => {
  const listeners = new Set<(agentId: string, text: string) => void>();

  return {
    emit: (agentId, text) => {
      for (const listener of listeners) listener(agentId, text);
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

interface ProfileRuntime extends AgentSessionRuntime {
  readonly resources: PiResources;
  readonly skippedPackages: ReadonlyArray<SkippedPiPackage>;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly ephemeralPromptContext: EphemeralPromptContextState;
  readonly voiceHub: SpecialistVoiceHub;
}

interface ProfileRuntimeOptions {
  admittedAgents?: ReadonlyArray<ProfileAgent>;
  profileExtensions?: ProfileExtensionsApi;
  modelOverride?: ChatModelOverride;
  runtimeFactory?: typeof createAgentSessionRuntime;
  beforeServices?: (sessionManager: SessionManager) => Promise<void>;
}

const createProfileRuntime = (
  profilePath: string,
  repositoryRoot: string,
  soulPath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  runtimeOptions: ProfileRuntimeOptions = {},
): Effect.Effect<ProfileRuntime, ZiggyAgentError> =>
  leaseProfileRuntime(
    profilePath,
    Effect.gen(function* () {
      const paths = memoryFilePaths(profilePath, context);

      if (!paths.ok) {
        return yield* paths.error;
      }

      const agents = runtimeOptions.admittedAgents ?? (yield* discoverProfileAgents(profilePath));

      const preparation =
        runtimeOptions.profileExtensions === undefined
          ? undefined
          : yield* runtimeOptions.profileExtensions.prepareRuntime(profilePath, repositoryRoot);

      const resources =
        preparation === undefined
          ? yield* discoverPiResources(profilePath, repositoryRoot)
          : yield* composePiResources(profilePath, preparation.selected);

      const systemPrompt = yield* loadProfileSystemPrompt(profilePath, soulPath);

      const runtimeRef: AgentSessionRuntimeRef = {};
      const ephemeralPromptContext: EphemeralPromptContextState = { generation: 0 };
      const voiceHub = createSpecialistVoiceHub();

      const inlineExtensions = createProfileCoreInlineExtensions({
        profilePath,
        agents,
        memoryDocuments: paths.documents,
        ephemeralPromptContext: () => ephemeralPromptContext.value,
      });

      const runtimeFactory = runtimeOptions.runtimeFactory ?? createAgentSessionRuntime;
      let acceptedResources = resources;
      let skippedPackages: ReadonlyArray<SkippedPiPackage> = [];

      const runtime = yield* Effect.tryPromise({
        try: async () => {
          const runtime = await runtimeFactory(
            async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
              await runtimeOptions.beforeServices?.(runtimeSessionManager);

              let services = await createAgentSessionServices({
                cwd,
                agentDir,
                resourceLoaderOptions: profileResourceLoaderOptions(
                  systemPrompt,
                  acceptedResources,
                  inlineExtensions,
                ),
              });

              // Rebuilds start from the accepted set, so a healthy rebuild runs each factory once.
              // A package that breaks mid-lifetime is quarantined the same way as at startup; a
              // quarantined package stays excluded until the runtime is recreated (no hot reload).
              const partition = partitionPiResourceDiagnostics(
                acceptedResources,
                collectPiResourceDiagnostics(services),
              );

              const fatal = piResourceDiagnosticFailure(profilePath, services, partition.fatal);

              if (fatal !== undefined) throw fatal;

              if (partition.skipped.length > 0) {
                // Pi services have no dispose method; invalidate the discarded loader's
                // extension runtime to release its event-bus subscriptions and stale API.
                services.resourceLoader.getExtensions().runtime.invalidate();
                services = await createAgentSessionServices({
                  cwd,
                  agentDir,
                  resourceLoaderOptions: profileResourceLoaderOptions(
                    systemPrompt,
                    partition.resources,
                    inlineExtensions,
                  ),
                });
                assertNoPiResourceDiagnostics(profilePath, services);
                acceptedResources = partition.resources;

                // Automation activation runs once at startup, so only a startup quarantine pauses
                // package-owned automations; a later one takes effect on the next restart.
                const automations =
                  runtimeRef.current === undefined
                    ? "Package-owned automations are disabled while quarantined; stored definitions are retained"
                    : "Quarantined after startup; package-owned automations keep their state until the Profile restarts";

                skippedPackages = [
                  ...skippedPackages,
                  ...partition.skipped.map((item) => ({
                    ...item,
                    diagnostics: [
                      ...item.diagnostics.slice(0, 11),
                      { source: item.id, message: automations },
                    ],
                  })),
                ];
              }

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
                          resources: acceptedResources,
                        };

                        return parent;
                      },
                    });

              const customTools: Array<ToolDefinition> = [
                createMemoryWriteTool(profilePath, context),
                ...(runtimeOptions.profileExtensions === undefined
                  ? []
                  : [
                      defineTool(
                        createProfileExtensionTool(
                          profilePath,
                          repositoryRoot,
                          runtimeOptions.profileExtensions,
                        ),
                      ),
                    ]),
                ...(specialistRunner === undefined
                  ? []
                  : [
                      createAgentRunTool(specialistRunner, voiceHub.emit),
                      createAgentDiscussTool(specialistRunner, voiceHub.emit),
                    ]),
              ];

              const sessionOptions: CreateAgentSessionFromServicesOptions = {
                services,
                sessionManager: runtimeSessionManager,
                customTools,
              };

              if (sessionStartEvent !== undefined)
                sessionOptions.sessionStartEvent = sessionStartEvent;

              const selection = selectSessionModel(
                profilePath,
                {
                  settingsManager: services.settingsManager,
                  modelRuntime: {
                    getProvider: (id) => services.modelRuntime.getProvider(id),
                    getModel: (provider, id) => services.modelRuntime.getModel(provider, id),
                    hasConfiguredAuth: (id) => services.modelRuntime.hasConfiguredAuth(id),
                    supportedThinkingLevels: (model) => getSupportedThinkingLevels(model),
                  },
                },
                runtimeOptions.modelOverride,
              );

              if (Result.isFailure(selection)) throw selection.failure;

              if (selection.success.model !== undefined)
                sessionOptions.model = selection.success.model;

              if (selection.success.thinking !== undefined)
                sessionOptions.thinkingLevel = selection.success.thinking;

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
        },
        catch: (cause) =>
          isProfileExtensionPreflightFailure(cause)
            ? cause
            : providerError(profilePath, "create agent runtime", cause),
      });

      for (const skipped of skippedPackages) {
        yield* Effect.logWarning("Skipped broken Profile extension package", {
          profilePath,
          packageId: skipped.id,
          diagnostics: skipped.diagnostics,
        });
      }

      // AgentSessionRuntime owns `services` through a getter. Attach only Ziggy's
      // additional resource bundle; assigning `services` would throw at runtime.
      const profileRuntime: ProfileRuntime = Object.assign(runtime, {
        resources: acceptedResources,
        skippedPackages,
        agents,
        ephemeralPromptContext,
        voiceHub,
      });

      if (preparation !== undefined && runtimeOptions.profileExtensions !== undefined) {
        yield* runtimeOptions.profileExtensions
          .activateRuntime(
            profilePath,
            repositoryRoot,
            preparation,
            (acceptedResources.optionalPackages ?? []).map((item) => item.id),
          )
          .pipe(
            Effect.catch((failure) =>
              Effect.gen(function* () {
                const disposed = yield* piPromise(profilePath, "dispose agent runtime", () =>
                  runtime.dispose(),
                ).pipe(Effect.result);

                if (Result.isFailure(disposed)) {
                  return yield* new ProfileExtensionRollbackFailed({
                    profilePath,
                    operation: "activate-runtime",
                    message:
                      "Profile extension activation failed and the newly created runtime could not be disposed; Profile state may have changed",
                    originalFailure: failure,
                    rollbackFailures: [
                      {
                        operation: "dispose runtime",
                        path: profilePath,
                        message: "could not dispose the newly created Pi runtime",
                      },
                    ],
                    cause: failure,
                  });
                }

                return yield* failure;
              }),
            ),
          );
      }

      runtimeRef.current = profileRuntime;

      return profileRuntime;
    }),
  );

type ChatSession = Pick<
  AgentSessionRuntime["session"],
  | "abort"
  | "followUp"
  | "isIdle"
  | "prompt"
  | "sendCustomMessage"
  | "sessionManager"
  | "steer"
  | "subscribe"
>;

const sharePiAbort = (abort: () => Promise<void>): (() => Promise<void>) => {
  let inFlight: Promise<void> | undefined;

  return () => {
    if (inFlight === undefined) {
      inFlight = abort().finally(() => {
        inFlight = undefined;
      });
    }

    return inFlight;
  };
};

const chatNotStreaming = (profilePath: string, operation: "steer" | "followUp"): ChatNotStreaming =>
  new ChatNotStreaming({
    profilePath,
    operation,
    message: operation === "steer" ? "no live turn to steer" : "no live turn to follow up",
  });

export const makeLiveChatControls = (
  profilePath: string,
  runtime: AgentSessionRuntime,
  lease: SessionLeaseTransitions,
  binding: Awaited<ReturnType<typeof bindChatRuntime>>,
): Pick<ChatHandle, "modelState" | "setModel" | "setThinkingLevel" | "resume"> => {
  const modelState = (): ChatSessionModelState => {
    const session = runtime.session;
    const model = session.model;

    return model === undefined
      ? { thinking: session.thinkingLevel }
      : { providerId: model.provider, modelId: model.id, thinking: session.thinkingLevel };
  };

  const requireWriter = () =>
    lease.owns(runtime.session.sessionManager.getSessionId())
      ? Effect.void
      : Effect.fail(
          sessionLeaseError(
            profilePath,
            new Error("live session no longer holds its writer lease"),
          ),
        );

  const requireIdle = () =>
    runtime.session.isIdle
      ? Effect.void
      : Effect.fail(
          new SessionBusy({
            profilePath,
            message: "session is busy; wait for the current turn to finish",
          }),
        );

  const withIdleControl = <A, E>(effect: Effect.Effect<A, E>, switchSession = false) => {
    const guarded = Effect.suspend(() =>
      requireWriter().pipe(Effect.andThen(requireIdle()), Effect.andThen(effect)),
    );

    return switchSession ? binding.withSessionSwitch(guarded) : binding.withControl(guarded);
  };

  return {
    modelState: Effect.sync(modelState),
    setModel: (providerId, modelId) =>
      withIdleControl(
        Effect.void.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const model = runtime.services.modelRuntime.getModel(providerId, modelId);

              return model === undefined
                ? Effect.fail(
                    new ProviderConfigError({
                      profilePath,
                      operation: "set session model",
                      message: `model ${providerId}/${modelId} is not available in this Profile`,
                      cause: undefined,
                    }),
                  )
                : Effect.tryPromise({
                    try: () => runtime.session.setModel(model, { persist: false }),
                    catch: (cause) =>
                      cause instanceof Error && cause.message.startsWith("No API key for ")
                        ? new ProviderConfigError({
                            profilePath,
                            operation: "set session model",
                            message: `no API key configured for ${providerId}/${modelId}`,
                            cause: undefined,
                          })
                        : providerError(profilePath, "set session model", cause),
                  }).pipe(Effect.asVoid);
            }),
          ),
          Effect.andThen(Effect.sync(modelState)),
        ),
      ),
    setThinkingLevel: (level: ProfileAgentThinking) =>
      withIdleControl(
        Effect.void.pipe(
          Effect.andThen(
            piPromise(profilePath, "set session thinking", () =>
              Promise.resolve(runtime.session.setThinkingLevel(level, { persist: false })),
            ),
          ),
          Effect.andThen(Effect.sync(modelState)),
        ),
      ),
    resume: (reference) =>
      withIdleControl(
        Effect.void.pipe(
          Effect.andThen(showProfileSession(profilePath, reference)),
          Effect.flatMap((metadata) =>
            Effect.tryPromise({
              try: () =>
                binding.switchSessionUnderControl(join(profilePath, "sessions", metadata.path)),
              catch: (cause) =>
                cause instanceof SessionLeaseHeld || cause instanceof SessionLeaseFailed
                  ? sessionLeaseError(profilePath, cause)
                  : providerError(profilePath, "resume session", cause),
            }),
          ),
        ),
        true,
      ),
  };
};

export const makeSessionChatHandle = (
  profilePath: string,
  liveSession: () => ChatSession,
  methods: Pick<ChatHandle, "prompt" | "dispose"> &
    Partial<
      Pick<ChatHandle, "currentSession" | "modelState" | "setModel" | "setThinkingLevel" | "resume">
    >,
  abortSession: () => Promise<void> = sharePiAbort(() => liveSession().abort()),
  voiceHub?: SpecialistVoiceHub,
  lease?: SessionLeaseTransitions,
  binding?: Pick<ChatRuntimeBinding, "onRebind" | "isSwitching">,
): ChatHandle => {
  const listeners = new Set<(event: ChatEvent) => void>();
  const project = createChatEventProjector();

  const forwardSessionEvent = (event: AgentSessionEvent) => {
    for (const chatEvent of project(event)) {
      for (const listener of listeners) listener(chatEvent);
    }
  };

  let unsubscribeSession = liveSession().subscribe(forwardSessionEvent);

  const unsubscribeRebind = binding?.onRebind(() => {
    unsubscribeSession();
    unsubscribeSession = liveSession().subscribe(forwardSessionEvent);
  });

  const unsubscribeVoice =
    voiceHub === undefined
      ? () => undefined
      : voiceHub.subscribe((agentId, text) => {
          const event: ChatEvent = { kind: "voice", agentId, text };

          for (const listener of listeners) listener(event);
        });

  const currentSession =
    methods.currentSession === undefined ? {} : { currentSession: methods.currentSession };

  let automationAppendPoisoned = false;

  const durableAutomationReceipt = (result: AutomationConversationResult): boolean => {
    const file = liveSession().sessionManager.getSessionFile();

    if (file === undefined) return false;

    const persisted = SessionManager.open(file, dirname(file), profilePath);

    return persisted.getEntries().some((entry) => isAutomationReceipt(entry, result));
  };

  const deliveryFailure = (
    category: AutomationConversationDeliveryFailed["category"],
    retriable: boolean,
    message: string,
    cause?: unknown,
  ): AutomationConversationDeliveryFailed =>
    cause === undefined
      ? new AutomationConversationDeliveryFailed({ category, retriable, message })
      : new AutomationConversationDeliveryFailed({ category, retriable, message, cause });

  const whileNotSwitching = <A, E>(
    effect: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | SessionBusy> =>
    Effect.suspend(
      (): Effect.Effect<A, E | SessionBusy> =>
        binding?.isSwitching()
          ? Effect.fail(
              new SessionBusy({
                profilePath,
                message: "session is switching; wait for the resume to finish",
              }),
            )
          : effect(),
    );

  return {
    get isIdle() {
      return liveSession().isIdle;
    },
    modelState:
      methods.modelState ??
      Effect.fail(
        providerError(profilePath, "read session model", new Error("session controls unavailable")),
      ),
    setModel:
      methods.setModel ??
      (() =>
        Effect.fail(
          providerError(
            profilePath,
            "set session model",
            new Error("session controls unavailable"),
          ),
        )),
    setThinkingLevel:
      methods.setThinkingLevel ??
      (() =>
        Effect.fail(
          providerError(
            profilePath,
            "set session thinking",
            new Error("session controls unavailable"),
          ),
        )),
    resume:
      methods.resume ??
      (() =>
        Effect.fail(
          providerError(profilePath, "resume session", new Error("session controls unavailable")),
        )),
    prompt: (text, options) => whileNotSwitching(() => methods.prompt(text, options)),
    ...currentSession,
    appendAutomationResult: (result) =>
      Effect.gen(function* () {
        if (lease !== undefined && !lease.owns(result.targetSessionId)) {
          return yield* deliveryFailure(
            "session-held",
            true,
            "live session no longer holds its writer lease",
          );
        }

        const alreadyDelivered = yield* Effect.try({
          try: () => {
            if (liveSession().sessionManager.getSessionId() !== result.targetSessionId) {
              throw deliveryFailure(
                "destination-missing",
                false,
                `live session no longer owns ${result.targetSessionId}`,
              );
            }

            if (durableAutomationReceipt(result)) return true;

            if (automationAppendPoisoned) {
              throw deliveryFailure(
                "write",
                true,
                "automation result delivery previously failed; restart the session owner before retrying",
              );
            }

            return false;
          },
          catch: (cause) =>
            cause instanceof AutomationConversationDeliveryFailed
              ? cause
              : deliveryFailure(
                  "write",
                  true,
                  "could not inspect the conversation transcript for automation delivery",
                  cause,
                ),
        });

        if (alreadyDelivered) return false;

        yield* Effect.tryPromise({
          try: () => {
            if (lease !== undefined && !lease.owns(result.targetSessionId)) {
              throw deliveryFailure(
                "session-held",
                true,
                "live session no longer holds its writer lease",
              );
            }

            if (liveSession().sessionManager.getSessionId() !== result.targetSessionId) {
              throw deliveryFailure(
                "destination-missing",
                false,
                `live session no longer owns ${result.targetSessionId}`,
              );
            }

            if (!liveSession().isIdle) {
              throw deliveryFailure("session-busy", true, "conversation has an active turn");
            }

            return liveSession().sendCustomMessage(
              {
                customType: AUTOMATION_RESULT_CUSTOM_TYPE,
                content: automationResultContent(result),
                display: true,
                details: {
                  automationId: result.automationId,
                  runId: result.runId,
                  targetSessionId: result.targetSessionId,
                },
              },
              { triggerTurn: false },
            );
          },
          catch: (cause) =>
            cause instanceof AutomationConversationDeliveryFailed
              ? cause
              : deliveryFailure(
                  "write",
                  true,
                  "could not durably append automation result to the conversation",
                  cause,
                ),
        }).pipe(
          Effect.catch((failure) => {
            if (failure.category !== "write") return Effect.fail(failure);

            return Effect.try({
              try: () => durableAutomationReceipt(result),
              catch: (cause) =>
                deliveryFailure(
                  "write",
                  true,
                  "could not reconcile the automation result after append failure",
                  cause,
                ),
            }).pipe(
              Effect.flatMap((persisted) => (persisted ? Effect.void : Effect.fail(failure))),
            );
          }),
          Effect.andThen(
            Effect.try({
              try: () => {
                if (!durableAutomationReceipt(result)) {
                  throw new Error("Pi transcript did not contain the appended automation receipt");
                }
              },
              catch: (cause) =>
                deliveryFailure(
                  "write",
                  true,
                  "could not verify the automation result in the conversation transcript",
                  cause,
                ),
            }),
          ),
          Effect.tapError((failure) =>
            failure.category === "write"
              ? Effect.sync(() => {
                  automationAppendPoisoned = true;
                })
              : Effect.void,
          ),
        );

        return true;
      }),
    abort: piPromise(profilePath, "abort agent session", abortSession),
    steer: (text) =>
      whileNotSwitching(
        (): Effect.Effect<void, ZiggyAgentError | ChatNotStreaming> =>
          lease !== undefined && !lease.owns(liveSession().sessionManager.getSessionId())
            ? Effect.fail(
                sessionLeaseError(
                  profilePath,
                  new Error("live session no longer holds its writer lease"),
                ),
              )
            : liveSession().isIdle
              ? Effect.fail(chatNotStreaming(profilePath, "steer"))
              : piPromise(profilePath, "steer agent session", () => liveSession().steer(text)),
      ),
    followUp: (text) =>
      whileNotSwitching(
        (): Effect.Effect<void, ZiggyAgentError | ChatNotStreaming> =>
          lease !== undefined && !lease.owns(liveSession().sessionManager.getSessionId())
            ? Effect.fail(
                sessionLeaseError(
                  profilePath,
                  new Error("live session no longer holds its writer lease"),
                ),
              )
            : liveSession().isIdle
              ? Effect.fail(chatNotStreaming(profilePath, "followUp"))
              : piPromise(profilePath, "follow up agent session", () =>
                  liveSession().followUp(text),
                ),
      ),
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    dispose: Effect.sync(() => {
      unsubscribeRebind?.();
      unsubscribeSession();
      unsubscribeVoice();
    }).pipe(Effect.andThen(methods.dispose)),
  };
};

export const currentPiSessionReference = (
  profilePath: string,
  manager: SessionManager,
): Effect.Effect<SessionReference | undefined, ZiggyAgentError> =>
  Effect.suspend(() => {
    const reference = sessionReference(manager);

    if (reference === undefined) return Effect.succeed(undefined);

    return Effect.tryPromise({
      try: () => stat(reference.file),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((metadata) =>
        metadata.isFile()
          ? Effect.succeed(reference)
          : Effect.fail(
              providerError(
                profilePath,
                "inspect agent session transcript",
                new Error("Pi session transcript is not a file"),
              ),
            ),
      ),
      Effect.catch((cause) =>
        fileSystemCauseDetails(cause).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(providerError(profilePath, "inspect agent session transcript", cause)),
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
  profileExtensions?: ProfileExtensionsApi,
  runtimeFactory?: typeof createAgentSessionRuntime,
  sessionName?: string,
): Effect.Effect<ChatHandle, ZiggyAgentError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const soulPath = yield* requireSoul(target.path);
      const runtimeOptions: ProfileRuntimeOptions = {};

      if (modelOverride !== undefined) runtimeOptions.modelOverride = modelOverride;

      if (profileExtensions !== undefined) runtimeOptions.profileExtensions = profileExtensions;

      if (runtimeFactory !== undefined) runtimeOptions.runtimeFactory = runtimeFactory;

      const { manager: sessionManager, release: releaseLease } = yield* prepareLeasedSession(
        target.path,
        sessionDirectory,
        sessionMode,
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionLeaseFailed ? sessionLeaseError(target.path, cause) : cause,
        ),
      );

      const lease = makeSessionLeaseTransitions(
        target.path,
        sessionManager.getSessionId(),
        releaseLease,
      );

      runtimeOptions.beforeServices = async (nextManager) => {
        if (!lease.owns(nextManager.getSessionId())) {
          // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi Promise factory bridge; lease before Pi builds a replacement session.
          await Effect.runPromise(lease.reserve(nextManager.getSessionId()));
        }
      };

      const runtime = yield* restore(
        createProfileRuntime(
          target.path,
          repositoryRoot,
          soulPath,
          sessionManager,
          context,
          runtimeOptions,
        ),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? lease.close.pipe(
                Effect.catch((failure) =>
                  Effect.logWarning("Session lease release failed", { failure }),
                ),
              )
            : Effect.void,
        ),
      );

      const dispose = piPromise(target.path, "dispose agent runtime", () => runtime.dispose()).pipe(
        Effect.ensuring(
          lease.close.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Session lease release failed", { failure }),
            ),
          ),
        ),
      );

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

      const binding = yield* piPromise(target.path, "bind agent runtime", () =>
        bindChatRuntime(runtime, lease),
      ).pipe(Effect.tapError(() => disposeBestEffort));

      const abortSession = sharePiAbort(() => runtime.session.abort());

      const promptSession: PromptSession = {
        abort: abortSession,
        prompt: (text, options) => runtime.session.prompt(text, options),
        subscribe: (listener) => runtime.session.subscribe(listener),
        get isIdle() {
          return runtime.session.isIdle;
        },
      };

      return makeSessionChatHandle(
        target.path,
        () => runtime.session,
        {
          ...makeLiveChatControls(target.path, runtime, lease, binding),
          currentSession: Effect.suspend(() =>
            currentPiSessionReference(target.path, runtime.session.sessionManager),
          ),
          prompt: (text, options) =>
            Effect.suspend(() => {
              if (!lease.owns(runtime.session.sessionManager.getSessionId())) {
                return Effect.fail(
                  sessionLeaseError(
                    target.path,
                    new Error(
                      "Pi session changed without a writer lease; close and reopen this session",
                    ),
                  ),
                );
              }

              const generation = runtime.ephemeralPromptContext.generation + 1;
              runtime.ephemeralPromptContext.generation = generation;

              if (options?.ephemeralContext === undefined) {
                delete runtime.ephemeralPromptContext.value;
              } else {
                runtime.ephemeralPromptContext.value = options.ephemeralContext;
              }

              const prepared = prepareProfileAgentPrompt(text, runtime.agents);

              if (prepared.ok) {
                ensurePiSessionName(runtime.session.sessionManager, sessionName, text);
              }

              const prompted: Effect.Effect<string, ZiggyAgentError> = prepared.ok
                ? promptForAssistantText(
                    target.path,
                    promptSession,
                    prepared.text,
                    options,
                    runtime.voiceHub,
                  )
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
        },
        abortSession,
        runtime.voiceHub,
        lease,
        binding,
      );
    }),
  );

export const openSpecialistChat = (
  target: ProfileTarget,
  agentId: string,
  repositoryRoot: string,
  profileExtensions?: ProfileExtensionsApi,
): Effect.Effect<ChatHandle, ZiggyAgentError | ProfileSpecialistError> =>
  withProfileRuntimeLock(
    target.path,
    Effect.uninterruptibleMask((restore) =>
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

        const runtimeOptions: ProfileRuntimeOptions = { admittedAgents: agents };

        if (profileExtensions !== undefined) runtimeOptions.profileExtensions = profileExtensions;

        const selectedEnvironment = yield* restore(
          Effect.acquireUseRelease(
            createProfileRuntime(
              target.path,
              repositoryRoot,
              soulPath,
              SessionManager.inMemory(target.path),
              { kind: "local" },
              runtimeOptions,
            ),
            (runtime) =>
              selectSpecialist(
                { profilePath: target.path, agents },
                { agent: agentId, prompt: agentId },
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
          ),
        );

        const { selected, environment } = selectedEnvironment;

        const { manager: specialistManager, release: releaseSpecialist } =
          yield* prepareLeasedSession(
            target.path,
            localSpecialistSessionDirectory(target.path, agentId),
            "continue",
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof SessionLeaseFailed ? sessionLeaseError(target.path, cause) : cause,
            ),
          );

        const specialistLease = makeSessionLeaseTransitions(
          target.path,
          specialistManager.getSessionId(),
          releaseSpecialist,
        );

        const releaseBestEffort = specialistLease.close.pipe(
          Effect.catch((failure) => Effect.logWarning("Session lease release failed", { failure })),
        );

        const liveRuntime = yield* restore(
          specialistRuntime(
            target.path,
            environment,
            selected.agent,
            selected.model,
            selected.thinking,
            selected.tools,
            specialistManager,
            async (nextManager) => {
              if (!specialistLease.owns(nextManager.getSessionId())) {
                // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi Promise factory bridge.
                await Effect.runPromise(specialistLease.reserve(nextManager.getSessionId()));
              }
            },
          ),
        ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseBestEffort : Effect.void)));

        const disposeLive = piPromise(target.path, "dispose agent runtime", () =>
          liveRuntime.dispose(),
        ).pipe(Effect.ensuring(releaseBestEffort));

        const disposeLiveBestEffort = disposeLive.pipe(
          Effect.catch((failure) => Effect.logWarning("Pi runtime cleanup failed", { failure })),
        );

        const binding = yield* piPromise(target.path, "bind agent runtime", () =>
          bindChatRuntime(liveRuntime, specialistLease),
        ).pipe(Effect.tapError(() => disposeLiveBestEffort));

        const abortSession = sharePiAbort(() => liveRuntime.session.abort());

        const promptSession: PromptSession = {
          abort: abortSession,
          prompt: (text, options) => liveRuntime.session.prompt(text, options),
          subscribe: (listener) => liveRuntime.session.subscribe(listener),
          get isIdle() {
            return liveRuntime.session.isIdle;
          },
        };

        return makeSessionChatHandle(
          target.path,
          () => liveRuntime.session,
          {
            ...makeLiveChatControls(target.path, liveRuntime, specialistLease, binding),
            currentSession: Effect.suspend(() =>
              currentPiSessionReference(target.path, liveRuntime.session.sessionManager),
            ),
            prompt: (text, options) =>
              Effect.suspend(() =>
                specialistLease.owns(liveRuntime.session.sessionManager.getSessionId())
                  ? Effect.sync(() =>
                      ensurePiSessionName(
                        liveRuntime.session.sessionManager,
                        `Agent · ${agentId}`,
                        text,
                      ),
                    )
                  : Effect.fail(
                      sessionLeaseError(
                        target.path,
                        new Error(
                          "Pi session changed without a writer lease; close and reopen this session",
                        ),
                      ),
                    ),
              ).pipe(
                Effect.andThen(promptForAssistantText(target.path, promptSession, text, options)),
              ),
            dispose: disposeLive,
          },
          abortSession,
          undefined,
          specialistLease,
          binding,
        );
      }),
    ),
  );

export const runSpecialist = (
  target: ProfileTarget,
  agentId: string,
  task: string,
  context: ProfileAgentRunContext,
  repositoryRoot: string,
  profileExtensions?: ProfileExtensionsApi,
): Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError> =>
  withProfileRuntimeLock(
    target.path,
    Effect.scoped(
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
        ensurePiSessionName(rootManager, `Agent · ${agentId}`, task);
        const rootReference = sessionReference(rootManager);

        if (rootReference === undefined) {
          return yield* new ProviderConfigError({
            profilePath: target.path,
            operation: "create Profile agent session",
            message: "Pi did not create a persistent Profile agent session",
            cause: undefined,
          });
        }

        yield* scopedSessionLease(target.path, rootReference.id).pipe(
          Effect.mapError((failure) => sessionLeaseError(target.path, failure)),
        );

        const runtimeOptions: ProfileRuntimeOptions = { admittedAgents: agents };

        if (profileExtensions !== undefined) runtimeOptions.profileExtensions = profileExtensions;

        const selectedEnvironment = yield* Effect.acquireUseRelease(
          createProfileRuntime(
            target.path,
            repositoryRoot,
            soulPath,
            rootManager,
            { kind: "local" },
            runtimeOptions,
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
      }),
    ),
  );

export const makePiAgent = (
  repositoryRoot: string,
  profileExtensions: ProfileExtensionsApi,
): PiAgentApi => ({
  runSpecialist: (target, agentId, task, context) =>
    runSpecialist(target, agentId, task, context, repositoryRoot, profileExtensions),
  askOnce: (target, prompt, continueSession, context, options) =>
    askOnce(target, prompt, continueSession, context, repositoryRoot, options, profileExtensions),
  openChat: (target, context, sessionDirectory, sessionMode, modelOverride, sessionName) =>
    openChat(
      target,
      context,
      sessionDirectory,
      repositoryRoot,
      sessionMode,
      modelOverride,
      profileExtensions,
      undefined,
      sessionName,
    ),
  openSpecialistChat: (target, agentId) =>
    openSpecialistChat(target, agentId, repositoryRoot, profileExtensions),
});
