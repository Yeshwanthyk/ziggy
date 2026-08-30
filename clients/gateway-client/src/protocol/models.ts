import { hasOnlyKeys, isBoundedString, isProfileId, isRecord, type ZiggyProfileId } from "./common";

export type ZiggyModelThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ZiggyModelDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly thinkingLevels: ReadonlyArray<string>;
}

export interface ZiggyModelStatusResult {
  readonly profileId: ZiggyProfileId;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly thinking: string;
  readonly authConfigured: boolean;
}

export interface ZiggyModelListResult {
  readonly profileId: ZiggyProfileId;
  readonly models: ReadonlyArray<ZiggyModelDescriptor>;
}

export type ZiggyModelAvailableResult = ZiggyModelListResult;

export interface ZiggyModelSetParams {
  readonly profileId: ZiggyProfileId;
  readonly providerId: string;
  readonly modelId: string;
  readonly thinking?: ZiggyModelThinkingLevel;
  readonly commandId?: string;
}

export interface ZiggyModelSetResult {
  readonly profileId: ZiggyProfileId;
  readonly providerId: string;
  readonly modelId: string;
  readonly thinking: string | null;
}

export type ZiggyProviderAuthType = "api_key" | "oauth";

export interface ZiggyProviderAuthStatus {
  readonly id: string;
  readonly name: string;
  readonly supportsApiKeyLogin: boolean;
  readonly supportsOauth: boolean;
  readonly configured: boolean;
  readonly type?: ZiggyProviderAuthType;
}

export interface ZiggyAuthStatusResult {
  readonly profileId: ZiggyProfileId;
  readonly providers: ReadonlyArray<ZiggyProviderAuthStatus>;
}

export interface ZiggyModelRequestMap {
  readonly "model.status": { readonly profileId: ZiggyProfileId };
  readonly "model.list": { readonly profileId: ZiggyProfileId; readonly providerId?: string };
  readonly "model.available": { readonly profileId: ZiggyProfileId };
  readonly "model.set": ZiggyModelSetParams;
  readonly "auth.status": { readonly profileId: ZiggyProfileId };
}

export interface ZiggyModelResultMap {
  readonly "model.status": ZiggyModelStatusResult;
  readonly "model.list": ZiggyModelListResult;
  readonly "model.available": ZiggyModelAvailableResult;
  readonly "model.set": ZiggyModelSetResult;
  readonly "auth.status": ZiggyAuthStatusResult;
}

const isThinkingLevel = (value: unknown): value is ZiggyModelThinkingLevel =>
  value === "off" ||
  value === "minimal" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh" ||
  value === "max";

const isModel = (value: unknown): value is ZiggyModelDescriptor =>
  isRecord(value) &&
  hasOnlyKeys(value, ["providerId", "modelId", "name", "thinkingLevels"]) &&
  isBoundedString(value.providerId, 128) &&
  isBoundedString(value.modelId, 256) &&
  isBoundedString(value.name, 256) &&
  Array.isArray(value.thinkingLevels) &&
  value.thinkingLevels.length <= 32 &&
  value.thinkingLevels.every((level) => isBoundedString(level, 32));

export const isModelStatusResult = (value: unknown): value is ZiggyModelStatusResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "providerId", "modelId", "thinking", "authConfigured"]) &&
  isProfileId(value.profileId) &&
  (value.providerId === null || isBoundedString(value.providerId, 128)) &&
  (value.modelId === null || isBoundedString(value.modelId, 256)) &&
  isBoundedString(value.thinking, 32) &&
  typeof value.authConfigured === "boolean";

export const isModelListResult = (value: unknown): value is ZiggyModelListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "models"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.models) &&
  value.models.length <= 2_000 &&
  value.models.every(isModel);

export const isModelSetResult = (value: unknown): value is ZiggyModelSetResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "providerId", "modelId", "thinking"]) &&
  isProfileId(value.profileId) &&
  isBoundedString(value.providerId, 128) &&
  isBoundedString(value.modelId, 256) &&
  (value.thinking === null || isBoundedString(value.thinking, 32));

const isProviderAuthStatus = (value: unknown): value is ZiggyProviderAuthStatus =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id",
    "name",
    "supportsApiKeyLogin",
    "supportsOauth",
    "configured",
    "type",
  ]) &&
  isBoundedString(value.id, 128) &&
  isBoundedString(value.name, 256) &&
  typeof value.supportsApiKeyLogin === "boolean" &&
  typeof value.supportsOauth === "boolean" &&
  typeof value.configured === "boolean" &&
  (value.type === undefined || value.type === "api_key" || value.type === "oauth");

export const isAuthStatusResult = (value: unknown): value is ZiggyAuthStatusResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "providers"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.providers) &&
  value.providers.length <= 256 &&
  value.providers.every(isProviderAuthStatus);

export const isThinkingLevelValue = isThinkingLevel;
