import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

const causeCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const requireSoul = async (profilePath: string): Promise<void> => {
  const soulPath = join(profilePath, "SOUL.md");
  let soulStatus;

  try {
    soulStatus = await stat(soulPath);
  } catch (cause: unknown) {
    if (causeCode(cause) === "ENOENT") {
      throw new ProfileNotInitialized({
        profilePath,
        message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
      });
    }

    throw new ProviderConfigError({
      profilePath,
      operation: "inspect provider auth",
      message: `could not read ${soulPath}`,
      cause,
    });
  }

  if (!soulStatus.isFile()) {
    throw new ProfileNotInitialized({
      profilePath,
      message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
    });
  }
};

const createRuntime = (profilePath: string) =>
  ModelRuntime.create({
    authPath: join(profilePath, "auth.json"),
    modelsPath: join(profilePath, "models.json"),
    modelsStorePath: join(profilePath, "models-store.json"),
  });

export const listAuthStatus = async (
  profilePath: string,
): Promise<ReadonlyArray<ProviderAuthStatus>> => {
  await requireSoul(profilePath);

  let runtime;
  try {
    runtime = await createRuntime(profilePath);
  } catch (cause: unknown) {
    throw new ProviderConfigError({
      profilePath,
      operation: "load provider auth",
      message: `could not load provider auth for ${profilePath}`,
      cause,
    });
  }

  return Promise.all(
    runtime.getProviders().map(async (provider): Promise<ProviderAuthStatus> => {
      try {
        const configured = await runtime.checkAuth(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          supportsApiKeyLogin: provider.auth.apiKey?.login !== undefined,
          ambientOnly:
            provider.auth.apiKey !== undefined && provider.auth.apiKey.login === undefined,
          supportsOauth: provider.auth.oauth !== undefined,
          configured,
        };
      } catch (cause: unknown) {
        throw new ProviderConfigError({
          profilePath,
          operation: `check ${provider.id} auth`,
          message: `could not check provider auth for ${provider.id}`,
          cause,
        });
      }
    }),
  );
};

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

export const loginProvider = async (
  profilePath: string,
  providerId: string,
  type: ProviderAuthType,
  interaction: AuthInteraction,
): Promise<ProviderLoginResult> => {
  await requireSoul(profilePath);

  let runtime;
  try {
    runtime = await createRuntime(profilePath);
  } catch (cause: unknown) {
    throw new AuthFlowFailed({
      providerId,
      message: `authentication failed for ${providerId}`,
      cause,
    });
  }

  const provider = runtime.getProviders().find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    throw new AuthProviderUnknown({
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
    throw new AuthTypeUnsupported({
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

  try {
    if (type === "oauth") {
      registerOAuthFlows();
    }
    await runtime.login(providerId, type, interaction);
    const configured = await runtime.checkAuth(providerId);
    return {
      providerId,
      type,
      source: configured?.source,
    };
  } catch (cause: unknown) {
    throw new AuthFlowFailed({
      providerId,
      message: `authentication failed for ${providerId}`,
      cause,
    });
  }
};
