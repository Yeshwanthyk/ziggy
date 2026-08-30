import {
  hasOnlyKeys,
  isBoundedString,
  isProfileId,
  isRecord,
  isSafeInteger,
  type ZiggyProfileId,
} from "./common";

export type ZiggyExtensionId = string;
export type ZiggyExtensionOperation = "list" | "add" | "remove" | "validate";
export type ZiggyExtensionFailureStage =
  | "catalog"
  | "download"
  | "checksum"
  | "archive"
  | "validation"
  | "validate"
  | "filesystem"
  | "resources"
  | "extensions"
  | "skills"
  | "services"
  | "lock"
  | "rollback"
  | "response";

export interface ZiggyExtensionFailure {
  readonly operation: ZiggyExtensionOperation;
  readonly stage: ZiggyExtensionFailureStage;
  readonly code: string;
  readonly message: string;
  readonly id?: ZiggyExtensionId;
  readonly source?: string;
  readonly selectionChanged: boolean;
}

export interface ZiggyExtensionChoice {
  readonly id: ZiggyExtensionId;
  readonly description: string;
  readonly kind: "skill" | "code" | "skill+code" | "remote";
  readonly source: "bundled" | "remote-approved" | "profile";
}

export interface ZiggyExtensionListResult {
  readonly profileId: ZiggyProfileId;
  readonly available: ReadonlyArray<ZiggyExtensionChoice>;
  readonly selected: ReadonlyArray<ZiggyExtensionId>;
}

export interface ZiggyExtensionMutationResult {
  readonly profileId: ZiggyProfileId;
  readonly id: ZiggyExtensionId;
  readonly changed: boolean;
  readonly selected: boolean;
}

export interface ZiggyExtensionValidationResult {
  readonly profileId: ZiggyProfileId;
  readonly selected: ReadonlyArray<ZiggyExtensionId>;
  readonly preflight: {
    readonly extensionPathCount: number;
    readonly skillPathCount: number;
    readonly extensionFactoryCount: number;
  };
}

export interface ZiggyExtensionRequestMap {
  readonly "extension.list-for-profile": { readonly profileId: ZiggyProfileId };
  readonly "extension.add": {
    readonly profileId: ZiggyProfileId;
    readonly id: ZiggyExtensionId;
    readonly commandId?: string;
  };
  readonly "extension.remove": {
    readonly profileId: ZiggyProfileId;
    readonly id: ZiggyExtensionId;
    readonly commandId?: string;
  };
  readonly "extension.validate": { readonly profileId: ZiggyProfileId };
}

export interface ZiggyExtensionResultMap {
  readonly "extension.list-for-profile": ZiggyExtensionListResult;
  readonly "extension.add": ZiggyExtensionMutationResult;
  readonly "extension.remove": ZiggyExtensionMutationResult;
  readonly "extension.validate": ZiggyExtensionValidationResult;
}

const isExtensionId = (value: unknown): value is string =>
  isBoundedString(value, 128) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

const isChoice = (value: unknown): value is ZiggyExtensionChoice =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "description", "kind", "source"]) &&
  isExtensionId(value.id) &&
  isBoundedString(value.description, 2_048, 0) &&
  (value.kind === "skill" ||
    value.kind === "code" ||
    value.kind === "skill+code" ||
    value.kind === "remote") &&
  (value.source === "bundled" || value.source === "remote-approved" || value.source === "profile");

export const isExtensionListResult = (value: unknown): value is ZiggyExtensionListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "available", "selected"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.available) &&
  value.available.length <= 128 &&
  value.available.every(isChoice) &&
  Array.isArray(value.selected) &&
  value.selected.length <= 128 &&
  value.selected.every(isExtensionId);

export const isExtensionMutationResult = (value: unknown): value is ZiggyExtensionMutationResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "id", "changed", "selected"]) &&
  isProfileId(value.profileId) &&
  isExtensionId(value.id) &&
  typeof value.changed === "boolean" &&
  typeof value.selected === "boolean";

const isCount = (value: unknown): value is number => isSafeInteger(value) && value <= 1_000_000;

export const isExtensionValidationResult = (
  value: unknown,
): value is ZiggyExtensionValidationResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "selected", "preflight"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.selected) &&
  value.selected.length <= 128 &&
  value.selected.every(isExtensionId) &&
  isRecord(value.preflight) &&
  hasOnlyKeys(value.preflight, ["extensionPathCount", "skillPathCount", "extensionFactoryCount"]) &&
  isCount(value.preflight.extensionPathCount) &&
  isCount(value.preflight.skillPathCount) &&
  isCount(value.preflight.extensionFactoryCount);

export const isExtensionFailure = (value: unknown): value is ZiggyExtensionFailure =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "operation",
    "stage",
    "code",
    "message",
    "id",
    "source",
    "selectionChanged",
  ]) &&
  (value.operation === "list" ||
    value.operation === "add" ||
    value.operation === "remove" ||
    value.operation === "validate") &&
  (value.stage === "catalog" ||
    value.stage === "download" ||
    value.stage === "checksum" ||
    value.stage === "archive" ||
    value.stage === "validation" ||
    value.stage === "validate" ||
    value.stage === "filesystem" ||
    value.stage === "resources" ||
    value.stage === "extensions" ||
    value.stage === "skills" ||
    value.stage === "services" ||
    value.stage === "lock" ||
    value.stage === "rollback" ||
    value.stage === "response") &&
  isBoundedString(value.code, 64) &&
  /^[A-Za-z0-9_.-]+$/u.test(value.code) &&
  isBoundedString(value.message, 360) &&
  (value.id === undefined || isExtensionId(value.id)) &&
  (value.source === undefined || isBoundedString(value.source, 240)) &&
  typeof value.selectionChanged === "boolean";

export const isExtensionIdValue = isExtensionId;
