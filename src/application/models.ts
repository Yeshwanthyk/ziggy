import { Context, Effect, Layer, Result } from "effect";
import { ProviderConfigError } from "../domain/agent";
import {
  getModelStatusReadOnly,
  type KnownModel,
  listAvailableModels,
  listModelsReadOnly,
  type ModelSelection,
  type ModelStatus,
  setModel,
} from "../adapters/pi/models";
import type {
  ModelOperationFailed,
  ModelProviderUnknown,
  ModelSettingsWriteFailed,
  ModelThinkingUnsupported,
  ModelUnknown,
  ProfileNotInitialized,
} from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";

export type ModelsError =
  | ProfileNotInitialized
  | ModelOperationFailed
  | ModelProviderUnknown
  | ModelUnknown
  | ModelThinkingUnsupported
  | ModelSettingsWriteFailed;

export interface ModelsApi {
  readonly status: (target: ProfileTarget) => Effect.Effect<ModelStatus, ModelsError>;
  readonly readOnlyStatus: (target: ProfileTarget) => Effect.Effect<ModelStatus, ModelsError>;
  readonly list: (
    target: ProfileTarget,
    providerId?: string,
  ) => Effect.Effect<ReadonlyArray<KnownModel>, ModelsError>;
  readonly available: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<KnownModel>, ModelsError>;
  readonly set: (
    target: ProfileTarget,
    providerId: string,
    modelId: string,
    thinking?: string,
  ) => Effect.Effect<ModelSelection, ModelsError>;
}

export class Models extends Context.Service<Models, ModelsApi>()("ziggy/Models") {}

export const ModelsLive = Layer.succeed(Models, {
  status: (target) => getModelStatusReadOnly(target.path),
  readOnlyStatus: (target) => getModelStatusReadOnly(target.path),
  list: (target, providerId) => listModelsReadOnly(target.path, providerId),
  available: (target) => listAvailableModels(target.path),
  set: (target, providerId, modelId, thinking) =>
    setModel(target.path, providerId, modelId, thinking),
});

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
