import { Schema } from "effect";
import type {
  ProfileExtensionLockFailed,
  ProfileExtensionPreflightFailed,
  ProfileExtensionRollbackFailed,
} from "../domain/profile-extension";

type ProfileExtensionFailure =
  | ProfileExtensionPreflightFailed
  | ProfileExtensionLockFailed
  | ProfileExtensionRollbackFailed;

const MAX_DIAGNOSTIC_SOURCE = 160;
const MAX_DIAGNOSTIC_REASON = 360;
const MAX_ROLLBACK_OPERATION = 96;
const MAX_ROLLBACK_PATH = 240;

const bounded = (value: string, maximum: number): string =>
  [
    ...value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ]
    .slice(0, maximum)
    .join("");

const safeText = (value: string, maximum: number): string =>
  bounded(value, maximum) || "unavailable";

export const renderProfileExtensionFailure = (failure: ProfileExtensionFailure): string => {
  switch (failure._tag) {
    case "ProfileExtensionPreflightFailed": {
      const diagnostic = failure.diagnostics[0];
      return [
        `Profile extension preflight failed: ${safeText(failure.message, MAX_DIAGNOSTIC_REASON)}`,
        `stage=${failure.stage}`,
        diagnostic === undefined
          ? "diagnostic=unavailable"
          : `diagnostic source=${safeText(diagnostic.source, MAX_DIAGNOSTIC_SOURCE)}; reason=${safeText(diagnostic.message, MAX_DIAGNOSTIC_REASON)}`,
      ].join("; ");
    }
    case "ProfileExtensionLockFailed":
      return `Profile extension lock failed: operation=${failure.operation}; reason=${safeText(failure.message, MAX_DIAGNOSTIC_REASON)}`;
    case "ProfileExtensionRollbackFailed": {
      const rollbackFailure = failure.rollbackFailures[0];
      return [
        `Profile extension rollback failed: operation=${failure.operation}; reason=${safeText(failure.message, MAX_DIAGNOSTIC_REASON)}`,
        rollbackFailure === undefined
          ? "rollback failure=unavailable"
          : `rollback operation=${safeText(rollbackFailure.operation, MAX_ROLLBACK_OPERATION)}; path=${safeText(rollbackFailure.path, MAX_ROLLBACK_PATH)}; reason=${safeText(rollbackFailure.message, MAX_DIAGNOSTIC_REASON)}`,
      ].join("; ");
    }
  }
};

const ExtensionSkillJson = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
});

export const ExtensionCatalogListingJson = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["skill", "code", "skill+code", "remote"]),
  required: Schema.Boolean,
  source: Schema.Literals(["bundled", "remote-approved"]),
  installed: Schema.Boolean,
  packagePath: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(ExtensionSkillJson)),
  extensionPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type ExtensionCatalogListingJson = typeof ExtensionCatalogListingJson.Type;

export const ExtensionsJson = Schema.Array(ExtensionCatalogListingJson);
export type ExtensionsJson = typeof ExtensionsJson.Type;
const encodeExtensions = Schema.encodeSync(ExtensionsJson);
const encodeExtension = Schema.encodeSync(ExtensionCatalogListingJson);

export const renderExtensionsJson = (
  extensions: ReadonlyArray<ExtensionCatalogListingJson>,
): string => JSON.stringify(encodeExtensions(extensions));

export const renderExtensionJson = (extension: ExtensionCatalogListingJson): string =>
  JSON.stringify(encodeExtension(extension));

export const renderExtensionListingsJson = renderExtensionsJson;
