import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionFromServicesOptions,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Result } from "effect";
import { hasPendingExtensionUpdates } from "../adapters/fs/extension-update";
import { discoverProfileAgents } from "../adapters/fs/profile-agents";
import { createProfileCoreInlineExtensions } from "../adapters/pi/profile-core-inline-extensions";
import {
  assertNoPiResourceDiagnostics,
  collectPiResourceDiagnostics,
  partitionPiResourceDiagnostics,
  piResourceDiagnosticFailure,
  type SkippedPiPackage,
} from "../adapters/pi/profile-extension-diagnostics";
import { loadProfileSystemPrompt } from "../adapters/pi/profile-prompt";
import { profileResourceLoaderOptions } from "../adapters/pi/profile-resource-loader";
import type { SpecialistVoiceHub } from "../adapters/pi/prompt-turn";
import { piPromise, providerError } from "../adapters/pi/provider-failure";
import {
  composePiResources,
  discoverPiResources,
  type PiResources,
} from "../adapters/pi/resources";
import type { ChatModelOverride, ZiggyAgentError } from "../domain/agent";
import { memoryFilePaths, type ChatContext } from "../domain/memory";
import type { ProfileAgent } from "../domain/profile";
import {
  ProfileExtensionLockFailed,
  ProfileExtensionRollbackFailed,
  type ProfileExtensionPreflightFailed,
  type ProfileExtensionsApi,
} from "../domain/profile-extension";
import { fileSystemCauseDetails } from "../platform/cause";
import { ProfileNotInitialized, ProviderConfigError, selectSessionModel } from "../profile";
import type { SessionTools } from "./tools";

/** Per-turn context that reaches the provider but never the transcript. */
export interface EphemeralPromptContext {
  generation: number;
  value?: string;
}

export interface ProfileRuntime extends AgentSessionRuntime {
  readonly resources: PiResources;
  readonly skippedPackages: ReadonlyArray<SkippedPiPackage>;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly ephemeralPromptContext: EphemeralPromptContext;
  readonly voiceHub: SpecialistVoiceHub;
}

export interface ProfileRuntimeOptions {
  readonly agents?: ReadonlyArray<ProfileAgent>;
  readonly extensions?: ProfileExtensionsApi;
  readonly tools?: ReadonlyArray<SessionTools>;
  readonly model?: ChatModelOverride;
  readonly runtimeFactory?: typeof createAgentSessionRuntime;
  /** Runs before Pi builds a session on `manager`; throwing refuses the build. */
  readonly beforeServices?: (manager: SessionManager) => void;
}

const notInitialized = (profilePath: string) =>
  new ProfileNotInitialized({
    profilePath,
    message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
  });

export const requireSoul = (profilePath: string) => {
  const soulPath = join(profilePath, "SOUL.md");

  return Effect.tryPromise({
    try: () => stat(soulPath),
    catch: (cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? notInitialized(profilePath)
        : new ProviderConfigError({
            profilePath,
            operation: "read system prompt",
            message: `could not read ${soulPath}`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile() ? Effect.succeed(soulPath) : Effect.fail(notInitialized(profilePath)),
    ),
  );
};

/** An interrupted extension update leaves package paths half-swapped; refuse to load them. */
const requireNoPendingUpdate = (profilePath: string) =>
  hasPendingExtensionUpdates(profilePath).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileExtensionLockFailed({
          profilePath,
          operation: "acquire",
          message: "could not inspect pending extension updates",
          cause,
        }),
    ),
    Effect.flatMap((pending) =>
      pending
        ? Effect.fail(
            new ProfileExtensionLockFailed({
              profilePath,
              operation: "acquire",
              message:
                "Profile has an unfinished extension update; recover it before starting a runtime",
              cause: undefined,
            }),
          )
        : Effect.void,
    ),
  );

const makeVoiceHub = (): SpecialistVoiceHub => {
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

const isPreflightFailure = (cause: unknown): cause is ProfileExtensionPreflightFailed =>
  Predicate.isTagged(cause, "ProfileExtensionPreflightFailed");

/** Abort any turn, then let Pi shut the session and its extensions down. */
export const disposeRuntime = (
  profilePath: string,
  runtime: Pick<AgentSessionRuntime, "dispose"> & { readonly session: Pick<AgentSession, "abort"> },
) =>
  piPromise(profilePath, "dispose agent runtime", async () => {
    await runtime.session.abort();
    await runtime.dispose();
  });

/** Build the Pi runtime for a Profile: its prompt, resources, contributed tools and model. */
export const createProfileRuntime = (
  profilePath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  options: ProfileRuntimeOptions = {},
): Effect.Effect<ProfileRuntime, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(profilePath);
    const paths = memoryFilePaths(profilePath, context);

    if (!paths.ok) return yield* paths.error;

    yield* requireNoPendingUpdate(profilePath);
    const agents = options.agents ?? (yield* discoverProfileAgents(profilePath));

    const preparation =
      options.extensions === undefined
        ? undefined
        : yield* options.extensions.prepareRuntime(profilePath);

    const resources =
      preparation === undefined
        ? yield* discoverPiResources(profilePath)
        : yield* composePiResources(profilePath, preparation.selected);

    const systemPrompt = yield* loadProfileSystemPrompt(profilePath, soulPath);
    let current: ProfileRuntime | undefined;
    const ephemeralPromptContext: EphemeralPromptContext = { generation: 0 };
    const voiceHub = makeVoiceHub();

    const inlineExtensions = createProfileCoreInlineExtensions({
      profilePath,
      agents,
      memoryDocuments: paths.documents,
      ephemeralPromptContext: () => ephemeralPromptContext.value,
    });

    const runtimeFactory = options.runtimeFactory ?? createAgentSessionRuntime;
    let acceptedResources = resources;
    let skippedPackages: ReadonlyArray<SkippedPiPackage> = [];

    const runtime = yield* Effect.tryPromise({
      try: () =>
        runtimeFactory(
          async ({ cwd, agentDir, sessionManager: nextManager, sessionStartEvent }) => {
            options.beforeServices?.(nextManager);

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
                current === undefined
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

            const toolContext = {
              profilePath,
              context,
              agents,
              services,
              resources: acceptedResources,
              session: () => current?.session,
              voice: voiceHub.emit,
            };

            const sessionOptions: CreateAgentSessionFromServicesOptions = {
              services,
              sessionManager: nextManager,
              customTools: (options.tools ?? []).flatMap((contribute) => contribute(toolContext)),
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
              options.model,
            );

            if (Result.isFailure(selection)) throw selection.failure;

            if (selection.success.model !== undefined)
              sessionOptions.model = selection.success.model;

            if (selection.success.thinking !== undefined)
              sessionOptions.thinkingLevel = selection.success.thinking;

            const created = await createAgentSessionFromServices(sessionOptions);

            return { ...created, services, diagnostics: services.diagnostics };
          },
          { cwd: profilePath, agentDir: profilePath, sessionManager },
        ),
      catch: (cause) =>
        isPreflightFailure(cause)
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

    if (preparation !== undefined && options.extensions !== undefined) {
      yield* options.extensions
        .activateRuntime(
          profilePath,
          preparation,
          (acceptedResources.optionalPackages ?? []).map((item) => item.id),
        )
        .pipe(
          Effect.catch((failure) =>
            Effect.gen(function* () {
              const disposed = yield* disposeRuntime(profilePath, runtime).pipe(Effect.result);

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

    current = profileRuntime;

    return profileRuntime;
  });
