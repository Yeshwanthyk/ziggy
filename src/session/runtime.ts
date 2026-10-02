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
import {
  createPersonaInlineExtensions,
  createProfileCoreInlineExtensions,
} from "../adapters/pi/profile-core-inline-extensions";
import {
  composeProfileSystemPrompt,
  loadProfileAgentsPrompt,
  loadProfileSystemPrompt,
} from "../adapters/pi/profile-prompt";
import type { SpecialistVoiceHub } from "../adapters/pi/prompt-turn";
import { piPromise, providerError } from "../adapters/pi/provider-failure";
import type { ChatModelOverride, ZiggyAgentError } from "../domain/agent";
import {
  isMcpToolName,
  loadServices,
  profileResources,
  type ExtensionLoadFailed,
  type PiResources,
  type ProfileMcpOptions,
  type SkippedPackage,
} from "../extensions";
import { runCallback } from "../platform/callback";
import { fileSystemCauseDetails } from "../platform/cause";
import { ProfileNotInitialized, ProviderConfigError, selectSessionModel } from "../profile";
import type { SessionPrompt, SessionTools } from "./tools";
import type { ChatContext, SessionPersona } from "./types";

/** Per-turn context that reaches the provider but never the transcript. */
export interface EphemeralPromptContext {
  generation: number;
  value?: string;
}

export interface ProfileRuntime extends AgentSessionRuntime {
  readonly resources: PiResources;
  readonly skippedPackages: ReadonlyArray<SkippedPackage>;
  readonly ephemeralPromptContext: EphemeralPromptContext;
  readonly voiceHub: SpecialistVoiceHub;
}

export interface ProfileRuntimeOptions {
  readonly tools?: ReadonlyArray<SessionTools>;
  readonly prompts?: ReadonlyArray<SessionPrompt>;
  readonly model?: ChatModelOverride | undefined;
  readonly runtimeFactory?: typeof createAgentSessionRuntime;
  /** Runs before Pi builds a session on `manager`; throwing refuses the build. */
  readonly beforeServices?: (manager: SessionManager) => void;
  /** Run as this Profile agent: its body replaces SOUL.md and only its tools are active. */
  readonly persona?: SessionPersona | undefined;
  /** An automation without a Profile agent: it runs without the MCP stack (A5). */
  readonly automation?: boolean | undefined;
  /** MCP servers for sessions that load the MCP stack. */
  readonly mcp?: ProfileMcpOptions | undefined;
}

/**
 * Main sessions load Pi's MCP stack. A persona session loads it only when its allowlist names
 * `codemode` or an `mcp__` tool; an untagged automation never does (A5).
 */
const loadsMcp = (options: ProfileRuntimeOptions): boolean =>
  options.persona === undefined
    ? options.automation !== true
    : options.persona.tools.some((name) => name === "codemode" || isMcpToolName(name));

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

/**
 * Build the Pi runtime for a Profile: its prompt, resources, contributed tools and model. A
 * persona session gets none of the contributed tools or prompts, only its declared tools.
 */
export const createProfileRuntime = (
  profilePath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  options: ProfileRuntimeOptions = {},
): Effect.Effect<ProfileRuntime, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(profilePath);
    const resources = yield* profileResources(profilePath);
    const persona = options.persona;

    const systemPrompt =
      persona === undefined
        ? yield* loadProfileSystemPrompt(profilePath, soulPath)
        : composeProfileSystemPrompt(yield* loadProfileAgentsPrompt(profilePath), persona.body);

    let current: ProfileRuntime | undefined;
    const ephemeralPromptContext: EphemeralPromptContext = { generation: 0 };
    const voiceHub = makeVoiceHub();

    const toolContext = {
      profilePath,
      context,
      session: () => current?.session,
      voice: voiceHub.emit,
    };

    const customTools =
      persona === undefined
        ? (yield* Effect.forEach(options.tools ?? [], (contribute) =>
            contribute(toolContext),
          )).flat()
        : [];

    const contributedPrompt = Effect.forEach(options.prompts ?? [], (prompt) =>
      prompt({ profilePath, context }),
    ).pipe(Effect.map((parts) => parts.filter((part) => part !== undefined)));

    const inlineExtensions =
      persona === undefined
        ? createProfileCoreInlineExtensions({
            contributedPrompt: () => runCallback(contributedPrompt),
            ephemeralPromptContext: () => ephemeralPromptContext.value,
          })
        : createPersonaInlineExtensions();

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
              mcp: loadsMcp(options) ? (options.mcp ?? {}) : undefined,
            });

            const services = loaded.services;
            acceptedResources = loaded.resources;
            skippedPackages = [...skippedPackages, ...loaded.skipped];

            const sessionOptions: CreateAgentSessionFromServicesOptions =
              persona === undefined
                ? { services, sessionManager: nextManager, customTools: [...customTools] }
                : {
                    services,
                    sessionManager: nextManager,
                    tools: [...persona.tools],
                    noTools: "all",
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
      ephemeralPromptContext,
      voiceHub,
    });

    current = profileRuntime;

    return profileRuntime;
  });
