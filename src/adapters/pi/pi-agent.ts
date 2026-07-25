import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  runPrintMode,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  type ZiggyAgentError,
} from "../../domain/agent";
import type { ProfileTarget } from "../../domain/profile";

export interface PiAgentShape {
  readonly askOnce: (
    target: ProfileTarget,
    prompt: string,
  ) => Effect.Effect<number, ZiggyAgentError>;
}

export class PiAgent extends Context.Service<PiAgent, PiAgentShape>()("ziggy/PiAgent") {}

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
  run: () => Promise<A>,
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

export const askOnce = (
  target: ProfileTarget,
  prompt: string,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const sessionManager = SessionManager.inMemory(target.path);

    const services = yield* piPromise(target.path, "load provider configuration", () =>
      createAgentSessionServices({
        cwd: target.path,
        agentDir: target.path,
        resourceLoaderOptions: {
          systemPrompt: soulPath,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      }),
    );

    const created = yield* piPromise(target.path, "create agent session", () =>
      createAgentSessionFromServices({
        services,
        sessionManager,
        noTools: "all",
      }),
    );

    if (created.modelFallbackMessage !== undefined) {
      return yield* new ProviderConfigError({
        profilePath: target.path,
        operation: "select model",
        message: `no configured model is available; place credentials in ${join(target.path, "auth.json")} and model configuration in ${join(target.path, "models.json")}`,
        cause: new Error(created.modelFallbackMessage),
      });
    }

    const runtime = yield* piPromise(target.path, "create agent runtime", () =>
      createAgentSessionRuntime(
        () =>
          Promise.resolve({
            ...created,
            services,
            diagnostics: services.diagnostics,
          }),
        {
          cwd: target.path,
          agentDir: target.path,
          sessionManager,
        },
      ),
    );

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

export const PiAgentLive = Layer.succeed(PiAgent, { askOnce });
