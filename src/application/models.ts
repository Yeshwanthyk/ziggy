import { Context, Effect, Layer } from "effect";
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
