import { Context, Effect, Layer, Result } from "effect";
import {
  listAuthStatusReadOnly,
  loginProvider,
  type AuthInteraction,
  type ProviderAuthStatus,
  type ProviderAuthType,
} from "./pi-auth";
import {
  getModelStatusReadOnly,
  listAvailableModels,
  listModelsReadOnly,
  setModel,
} from "./pi-models";
import {
  AuthProviderUnknown,
  ProviderConfigError,
  type AuthFlowFailed,
  type AuthTypeUnsupported,
  type ModelOperationFailed,
  type ModelProviderUnknown,
  type ModelSettingsWriteFailed,
  type ModelThinkingUnsupported,
  type ModelUnknown,
  type ProfileNotInitialized,
  type ProfileTarget,
} from "./types";

export type ModelsError =
  | ProfileNotInitialized
  | ModelOperationFailed
  | ModelProviderUnknown
  | ModelUnknown
  | ModelThinkingUnsupported
  | ModelSettingsWriteFailed;

export type AuthError =
  | ProfileNotInitialized
  | ProviderConfigError
  | AuthProviderUnknown
  | AuthTypeUnsupported
  | AuthFlowFailed;

/** A Profile's model selection, read without writing Pi's settings or model cache. */
export class Models extends Context.Service<Models>()("ziggy/Models", {
  make: Effect.succeed({
    status: Effect.fn("Models.status")((target: ProfileTarget) =>
      getModelStatusReadOnly(target.path),
    ),
    list: Effect.fn("Models.list")((target: ProfileTarget, providerId?: string) =>
      listModelsReadOnly(target.path, providerId),
    ),
    available: Effect.fn("Models.available")((target: ProfileTarget) =>
      listAvailableModels(target.path),
    ),
    set: Effect.fn("Models.set")(
      (target: ProfileTarget, providerId: string, modelId: string, thinking?: string) =>
        setModel(target.path, providerId, modelId, thinking),
    ),
  } as const),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type ModelsApi = (typeof Models)["Service"];

export const defaultAuthType = (provider: ProviderAuthStatus): ProviderAuthType =>
  provider.supportsOauth && !provider.supportsApiKeyLogin ? "oauth" : "api_key";

/** Provider credentials stored in a Profile. `status` never writes. */
export class Auth extends Context.Service<Auth>()("ziggy/Auth", {
  make: Effect.sync(() => {
    const status = Effect.fn("Auth.status")((target: ProfileTarget) =>
      listAuthStatusReadOnly(target.path),
    );

    /** Log in with `type`, or with the provider's default login type when it is omitted. */
    const login = Effect.fn("Auth.login")(function* (
      target: ProfileTarget,
      providerId: string,
      type: ProviderAuthType | undefined,
      interaction: AuthInteraction,
    ) {
      if (type !== undefined)
        return yield* loginProvider(target.path, providerId, type, interaction);

      const provider = (yield* status(target)).find((candidate) => candidate.id === providerId);

      if (provider === undefined) {
        return yield* new AuthProviderUnknown({
          profilePath: target.path,
          providerId,
          message: `unknown auth provider ${providerId}`,
        });
      }

      return yield* loginProvider(target.path, providerId, defaultAuthType(provider), interaction);
    });

    return { status, login } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type AuthApi = (typeof Auth)["Service"];

const configuredSessionModelError = (profilePath: string, message: string) =>
  new ProviderConfigError({
    profilePath,
    operation: "select model",
    message,
    cause: undefined,
  });

export const selectSessionModel = <M, T extends string>(
  profilePath: string,
  services: {
    readonly settingsManager: {
      readonly getDefaultProvider: () => string | undefined;
      readonly getDefaultModel: () => string | undefined;
      readonly getDefaultThinkingLevel: () => T | undefined;
    };
    readonly modelRuntime: {
      readonly getProvider: (providerId: string) => object | undefined;
      readonly getModel: (providerId: string, modelId: string) => M | undefined;
      readonly supportedThinkingLevels: (model: M) => ReadonlyArray<string>;
      readonly hasConfiguredAuth: (providerId: string) => boolean;
    };
  },
  override:
    | { readonly provider?: string; readonly model?: string; readonly thinking?: T }
    | undefined,
) => {
  const overrideProvider = override?.provider;
  const overrideModel = override?.model;

  if ((overrideProvider === undefined) !== (overrideModel === undefined)) {
    return Result.fail(
      configuredSessionModelError(profilePath, "provider and model must be provided together"),
    );
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
      return Result.fail(
        configuredSessionModelError(
          profilePath,
          `provider is not configured in the Profile model registry: ${overrideProvider}`,
        ),
      );
    }

    if (model === undefined) {
      return Result.fail(
        configuredSessionModelError(
          profilePath,
          `model is not configured in the Profile model registry: ${overrideProvider}/${overrideModel}`,
        ),
      );
    }

    if (!services.modelRuntime.hasConfiguredAuth(overrideProvider)) {
      return Result.fail(
        configuredSessionModelError(
          profilePath,
          `provider auth is not configured in the Profile: ${overrideProvider}`,
        ),
      );
    }
  } else if (override?.thinking !== undefined && model === undefined) {
    return Result.fail(
      configuredSessionModelError(
        profilePath,
        "thinking override requires a configured Profile model",
      ),
    );
  }

  const overridePresent = overrideProvider !== undefined || override?.thinking !== undefined;

  if (
    overridePresent &&
    model !== undefined &&
    thinking !== undefined &&
    !services.modelRuntime.supportedThinkingLevels(model).some((level) => level === thinking)
  ) {
    return Result.fail(
      configuredSessionModelError(
        profilePath,
        `thinking level is not supported by ${providerId}/${modelId}: ${thinking}`,
      ),
    );
  }

  return Result.succeed({ model, thinking });
};
