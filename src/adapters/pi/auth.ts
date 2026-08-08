import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialStore,
  ModelsStore,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  AuthFlowFailed,
  AuthProviderUnknown,
  AuthTypeUnsupported,
  ProfileNotInitialized,
  ProviderConfigError,
} from "../../domain/agent";

export type ProviderAuthType = "api_key" | "oauth";
export type { AuthEvent, AuthInteraction, AuthPrompt };

export interface ProviderAuthStatus {
  readonly id: string;
  readonly name: string;
  readonly supportsApiKeyLogin: boolean;
  readonly ambientOnly: boolean;
  readonly supportsOauth: boolean;
  readonly configured:
    | {
        readonly type: ProviderAuthType;
        readonly source?: string;
      }
    | undefined;
}

export interface ProviderLoginResult {
  readonly providerId: string;
  readonly type: ProviderAuthType;
  readonly source: string | undefined;
}

let bunOAuthFlowsRegistered = false;

export interface PiAuthRuntime {
  readonly getProviders: () => ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly auth: {
      readonly apiKey?: { readonly login?: unknown };
      readonly oauth?: unknown;
    };
  }>;
  readonly checkAuth: (
    providerId: string,
  ) => Promise<{ readonly type: ProviderAuthType; readonly source?: string } | undefined>;
  readonly login: (
    providerId: string,
    type: ProviderAuthType,
    interaction: AuthInteraction,
  ) => Promise<unknown>;
}

export type PiAuthRuntimeFactory = (profilePath: string) => Promise<PiAuthRuntime>;

const causeCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const requireSoul = (
  profilePath: string,
): Effect.Effect<void, ProfileNotInitialized | ProviderConfigError> => {
  const soulPath = join(profilePath, "SOUL.md");
  return Effect.tryPromise({
    try: () => stat(soulPath),
    catch: (cause) =>
      causeCode(cause) === "ENOENT"
        ? new ProfileNotInitialized({
            profilePath,
            message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
          })
        : new ProviderConfigError({
            profilePath,
            operation: "inspect provider auth",
            message: `could not read ${soulPath}`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((soulStatus) =>
      soulStatus.isFile()
        ? Effect.void
        : Effect.fail(
            new ProfileNotInitialized({
              profilePath,
              message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
            }),
          ),
    ),
  );
};

const createModelRuntime: PiAuthRuntimeFactory = (profilePath) =>
  ModelRuntime.create({
    authPath: join(profilePath, "auth.json"),
    modelsPath: join(profilePath, "models.json"),
    modelsStorePath: join(profilePath, "models-store.json"),
  });

const readOnlyCredentials = (profilePath: string): CredentialStore => ({
  read: (providerId) =>
    Promise.resolve(readStoredCredential(providerId, join(profilePath, "auth.json"))),
  list: () => Promise.resolve([]),
  modify: (providerId, update) =>
    update(readStoredCredential(providerId, join(profilePath, "auth.json"))),
  delete: () => Promise.resolve(),
});

const readOnlyModelsStore: ModelsStore = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const createReadOnlyModelRuntime: PiAuthRuntimeFactory = (profilePath) =>
  ModelRuntime.create({
    credentials: readOnlyCredentials(profilePath),
    modelsPath: join(profilePath, "models.json"),
    modelsStore: readOnlyModelsStore,
  });

const unsupportedMessage = (
  providerId: string,
  requested: ProviderAuthType,
  supportsApiKeyLogin: boolean,
  ambientOnly: boolean,
  supportsOauth: boolean,
): string => {
  if (requested === "api_key" && ambientOnly) {
    return `provider ${providerId} does not support api_key login; ambient only — set the provider env var${supportsOauth ? "; supported interactive login: oauth" : ""}`;
  }

  const supported = [
    ...(supportsApiKeyLogin ? ["api_key"] : []),
    ...(supportsOauth ? ["oauth"] : []),
  ];
  const supportDescription =
    supported.length > 0
      ? `supported: ${supported.join(", ")}`
      : ambientOnly
        ? "ambient only — set the provider env var"
        : "no interactive login is available";
  return `provider ${providerId} does not support ${requested} login; ${supportDescription}`;
};

const registerOAuthFlows = (): void => {
  if (bunOAuthFlowsRegistered) {
    return;
  }

  registerBunOAuthFlows();
  bunOAuthFlowsRegistered = true;
};

export const makePiAuth = (createRuntime: PiAuthRuntimeFactory = createModelRuntime) => {
  const listAuthStatus = (
    profilePath: string,
  ): Effect.Effect<
    ReadonlyArray<ProviderAuthStatus>,
    ProfileNotInitialized | ProviderConfigError
  > =>
    Effect.gen(function* () {
      yield* requireSoul(profilePath);
      const runtime = yield* Effect.tryPromise({
        try: () => createRuntime(profilePath),
        catch: (cause) =>
          new ProviderConfigError({
            profilePath,
            operation: "load provider auth",
            message: `could not load provider auth for ${profilePath}`,
            cause,
          }),
      });
      return yield* Effect.forEach(
        runtime.getProviders(),
        (provider): Effect.Effect<ProviderAuthStatus, ProviderConfigError> =>
          Effect.tryPromise({
            try: () => runtime.checkAuth(provider.id),
            catch: (cause) =>
              new ProviderConfigError({
                profilePath,
                operation: `check ${provider.id} auth`,
                message: `could not check provider auth for ${provider.id}`,
                cause,
              }),
          }).pipe(
            Effect.map((configured) => ({
              id: provider.id,
              name: provider.name,
              supportsApiKeyLogin: provider.auth.apiKey?.login !== undefined,
              ambientOnly:
                provider.auth.apiKey !== undefined && provider.auth.apiKey.login === undefined,
              supportsOauth: provider.auth.oauth !== undefined,
              configured,
            })),
          ),
        { concurrency: "unbounded" },
      );
    });

  const loginProvider = (
    profilePath: string,
    providerId: string,
    type: ProviderAuthType,
    interaction: AuthInteraction,
  ): Effect.Effect<
    ProviderLoginResult,
    | ProfileNotInitialized
    | ProviderConfigError
    | AuthProviderUnknown
    | AuthTypeUnsupported
    | AuthFlowFailed
  > =>
    Effect.gen(function* () {
      yield* requireSoul(profilePath);
      const runtime = yield* Effect.tryPromise({
        try: () => createRuntime(profilePath),
        catch: (cause) =>
          new AuthFlowFailed({
            providerId,
            message: `authentication failed for ${providerId}`,
            cause,
          }),
      });
      const provider = runtime.getProviders().find((candidate) => candidate.id === providerId);
      if (provider === undefined) {
        return yield* new AuthProviderUnknown({
          profilePath,
          providerId,
          message: `unknown auth provider ${providerId}`,
        });
      }

      const supportsApiKeyLogin = provider.auth.apiKey?.login !== undefined;
      const ambientOnly =
        provider.auth.apiKey !== undefined && provider.auth.apiKey.login === undefined;
      const supportsOauth = provider.auth.oauth !== undefined;
      if ((type === "api_key" && !supportsApiKeyLogin) || (type === "oauth" && !supportsOauth)) {
        return yield* new AuthTypeUnsupported({
          providerId,
          requested: type,
          message: unsupportedMessage(
            providerId,
            type,
            supportsApiKeyLogin,
            ambientOnly,
            supportsOauth,
          ),
        });
      }

      yield* Effect.tryPromise({
        try: (signal) => {
          if (type === "oauth") registerOAuthFlows();
          const loginSignal =
            interaction.signal === undefined
              ? signal
              : AbortSignal.any([interaction.signal, signal]);
          return runtime.login(providerId, type, { ...interaction, signal: loginSignal });
        },
        catch: (cause) =>
          new AuthFlowFailed({
            providerId,
            message: `authentication failed for ${providerId}`,
            cause,
          }),
      });
      const configured = yield* Effect.tryPromise({
        try: () => runtime.checkAuth(providerId),
        catch: (cause) =>
          new AuthFlowFailed({
            providerId,
            message: `authentication failed for ${providerId}`,
            cause,
          }),
      });
      return { providerId, type, source: configured?.source };
    });

  return { listAuthStatus, loginProvider } as const;
};

const piAuth = makePiAuth();
const piReadOnlyAuth = makePiAuth(createReadOnlyModelRuntime);
export const listAuthStatus = piAuth.listAuthStatus;
export const listAuthStatusReadOnly = piReadOnlyAuth.listAuthStatus;
export const loginProvider = piAuth.loginProvider;
