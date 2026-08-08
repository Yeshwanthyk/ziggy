import { Context, Effect, Layer } from "effect";
import {
  getModelStatus,
  type KnownModel,
  listModels,
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

export interface ModelsShape {
  readonly status: (target: ProfileTarget) => Effect.Effect<ModelStatus, ModelsError>;
  readonly list: (
    target: ProfileTarget,
    providerId?: string,
  ) => Effect.Effect<ReadonlyArray<KnownModel>, ModelsError>;
  readonly set: (
    target: ProfileTarget,
    providerId: string,
    modelId: string,
    thinking?: string,
  ) => Effect.Effect<ModelSelection, ModelsError>;
}

export class Models extends Context.Service<Models, ModelsShape>()("ziggy/Models") {}

export const ModelsLive = Layer.succeed(Models, {
  status: (target) => getModelStatus(target.path),
  list: (target, providerId) => listModels(target.path, providerId),
  set: (target, providerId, modelId, thinking) =>
    setModel(target.path, providerId, modelId, thinking),
});
