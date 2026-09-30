import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionFromServicesOptions,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Result } from "effect";
import { discoverProfileAgents } from "../adapters/fs/profile-agents";
import { createProfileCoreInlineExtensions } from "../adapters/pi/profile-core-inline-extensions";
import { loadProfileSystemPrompt } from "../adapters/pi/profile-prompt";
import type { SpecialistVoiceHub } from "../adapters/pi/prompt-turn";
import { piPromise, providerError } from "../adapters/pi/provider-failure";
import type { ChatModelOverride, ZiggyAgentError } from "../domain/agent";
import { memoryFilePaths, type ChatContext } from "../domain/memory";
import type { ProfileAgent } from "../domain/profile";
import {
  loadServices,
  profileResources,
  type ExtensionLoadFailed,
  type PiResources,
  type SkippedPackage,
} from "../extensions";
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
  readonly skippedPackages: ReadonlyArray<SkippedPackage>;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly ephemeralPromptContext: EphemeralPromptContext;
  readonly voiceHub: SpecialistVoiceHub;
}

export interface ProfileRuntimeOptions {
  readonly agents?: ReadonlyArray<ProfileAgent>;
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

const isLoadFailed = (cause: unknown): cause is ExtensionLoadFailed =>
  Predicate.isTagged(cause, "ExtensionLoadFailed");

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

    const agents = options.agents ?? (yield* discoverProfileAgents(profilePath));
    const resources = yield* profileResources(profilePath);

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
    let skippedPackages: ReadonlyArray<SkippedPackage> = [];

    const runtime = yield* Effect.tryPromise({
      try: () =>
        runtimeFactory(
          async ({ cwd, agentDir, sessionManager: nextManager, sessionStartEvent }) => {
            options.beforeServices?.(nextManager);

            // Rebuilds start from the accepted set. A package that breaks mid-lifetime is
            // skipped the same way as at startup and stays out until the runtime is recreated.
            const loaded = await loadServices({
              profilePath,
              cwd,
              agentDir,
              systemPrompt,
              resources: acceptedResources,
              inline: inlineExtensions,
            });

            const services = loaded.services;
            acceptedResources = loaded.resources;
            skippedPackages = [...skippedPackages, ...loaded.skipped];

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
        isLoadFailed(cause) ? cause : providerError(profilePath, "create agent runtime", cause),
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

    current = profileRuntime;

    return profileRuntime;
  });
