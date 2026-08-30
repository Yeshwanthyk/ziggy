import { hasOnlyKeys, isBoundedString, isProfileId, isRecord, type ZiggyProfileId } from "./common";

export interface ZiggyProfileSummary {
  readonly profileId: ZiggyProfileId;
  readonly name: string;
  readonly current: boolean;
  readonly available: boolean;
}

export interface ZiggyProfileListResult {
  readonly profiles: ReadonlyArray<ZiggyProfileSummary>;
}

export interface ZiggyProfileCurrentResult {
  readonly profileId: ZiggyProfileId;
  readonly name: string;
}

export type ZiggyProfileScopedParams = { readonly profileId: ZiggyProfileId };

export interface ZiggyProfileHealthCheck {
  readonly id: string;
  readonly severity: "ok" | "warn" | "error";
  readonly message: string;
}

export interface ZiggyProfileHealthResult {
  readonly profileId: ZiggyProfileId;
  readonly checks: ReadonlyArray<ZiggyProfileHealthCheck>;
  readonly hasErrors: boolean;
}

export interface ZiggyProfileRequestMap {
  readonly "system.capabilities": Record<string, never>;
  readonly "profile.list": Record<string, never>;
  readonly "profile.current": Record<string, never>;
  readonly "profile.health": ZiggyProfileScopedParams;
}

export interface ZiggyProfileResultMap {
  readonly "system.capabilities": import("./common").ZiggySystemCapabilitiesResult;
  readonly "profile.list": ZiggyProfileListResult;
  readonly "profile.current": ZiggyProfileCurrentResult;
  readonly "profile.health": ZiggyProfileHealthResult;
}

export const isProfileSummary = (value: unknown): value is ZiggyProfileSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "name", "current", "available"]) &&
  isProfileId(value.profileId) &&
  isBoundedString(value.name, 128) &&
  typeof value.current === "boolean" &&
  typeof value.available === "boolean";

export const isProfileListResult = (value: unknown): value is ZiggyProfileListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profiles"]) &&
  Array.isArray(value.profiles) &&
  value.profiles.length <= 256 &&
  value.profiles.every(isProfileSummary);

export const isProfileCurrentResult = (value: unknown): value is ZiggyProfileCurrentResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "name"]) &&
  isProfileId(value.profileId) &&
  isBoundedString(value.name, 128);

export const isProfileHealthCheck = (value: unknown): value is ZiggyProfileHealthCheck =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "severity", "message"]) &&
  isBoundedString(value.id, 80) &&
  (value.severity === "ok" || value.severity === "warn" || value.severity === "error") &&
  isBoundedString(value.message, 360);

export const isProfileHealthResult = (value: unknown): value is ZiggyProfileHealthResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "checks", "hasErrors"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.checks) &&
  value.checks.length <= 64 &&
  value.checks.every(isProfileHealthCheck) &&
  typeof value.hasErrors === "boolean";
