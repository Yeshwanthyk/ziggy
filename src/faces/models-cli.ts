import type { KnownModel, ModelSelection, ModelStatus } from "../adapters/pi/models";

export const renderModelStatus = (status: ModelStatus): string =>
  [
    `provider\t${status.providerId ?? "none"}`,
    `model\t${status.modelId ?? "none"}`,
    `thinking\t${status.thinking}`,
    `auth\t${status.authConfigured ? "configured" : "not configured"}`,
  ].join("\n");

export const renderModels = (models: ReadonlyArray<KnownModel>): string => {
  if (models.length === 0) return "no models";
  return models
    .map(
      (model) =>
        `${model.providerId}/${model.modelId}\t${model.name}\tthinking: ${model.thinkingLevels.join(",")}`,
    )
    .join("\n");
};

export const renderModelSelection = (selection: ModelSelection): string =>
  `selected ${selection.providerId}/${selection.modelId}${selection.thinking === undefined ? "" : ` with thinking ${selection.thinking}`}`;
