import * as path from "node:path";
import { Schema } from "effect";
import type { ZiggyPathsApi } from "../platform/paths";

/** A Profile folder and its display name. */
export interface ProfileTarget {
  readonly path: string;
  readonly name: string;
}

export class ProfileTargetNotDirectory extends Schema.TaggedErrorClass<ProfileTargetNotDirectory>()(
  "ProfileTargetNotDirectory",
  {
    path: Schema.String,
  },
) {}

export class ProfileFileSystemError extends Schema.TaggedErrorClass<ProfileFileSystemError>()(
  "ProfileFileSystemError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    code: Schema.UndefinedOr(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ProfileNotInitialized extends Schema.TaggedErrorClass<ProfileNotInitialized>()(
  "ProfileNotInitialized",
  {
    profilePath: Schema.String,
    message: Schema.String,
  },
) {}

export class ProviderConfigError extends Schema.TaggedErrorClass<ProviderConfigError>()(
  "ProviderConfigError",
  {
    profilePath: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AuthProviderUnknown extends Schema.TaggedErrorClass<AuthProviderUnknown>()(
  "AuthProviderUnknown",
  {
    profilePath: Schema.String,
    providerId: Schema.String,
    message: Schema.String,
  },
) {}

export class AuthTypeUnsupported extends Schema.TaggedErrorClass<AuthTypeUnsupported>()(
  "AuthTypeUnsupported",
  {
    providerId: Schema.String,
    requested: Schema.Literals(["api_key", "oauth"]),
    message: Schema.String,
  },
) {}

export class AuthFlowFailed extends Schema.TaggedErrorClass<AuthFlowFailed>()("AuthFlowFailed", {
  providerId: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ModelProviderUnknown extends Schema.TaggedErrorClass<ModelProviderUnknown>()(
  "ModelProviderUnknown",
  {
    profilePath: Schema.String,
    providerId: Schema.String,
    message: Schema.String,
  },
) {}

export class ModelUnknown extends Schema.TaggedErrorClass<ModelUnknown>()("ModelUnknown", {
  profilePath: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  message: Schema.String,
}) {}

export class ModelThinkingUnsupported extends Schema.TaggedErrorClass<ModelThinkingUnsupported>()(
  "ModelThinkingUnsupported",
  {
    providerId: Schema.String,
    modelId: Schema.String,
    thinking: Schema.String,
    supported: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export class ModelOperationFailed extends Schema.TaggedErrorClass<ModelOperationFailed>()(
  "ModelOperationFailed",
  {
    profilePath: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ModelSettingsWriteFailed extends Schema.TaggedErrorClass<ModelSettingsWriteFailed>()(
  "ModelSettingsWriteFailed",
  {
    profilePath: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const hasPathSyntax = (value: string): boolean =>
  value.includes("/") ||
  value.includes("\\") ||
  value.startsWith(".") ||
  value.startsWith("~") ||
  value.startsWith("/");

const expandLeadingTilde = (value: string, homedir: string): string => {
  if (value.startsWith("~")) {
    return path.join(homedir, value.slice(1));
  }

  return value;
};

/** Resolve a CLI Profile argument: a path, or a name under `profilesDirectory`. */
export const resolveProfileTarget = (
  value: string,
  paths: Pick<ZiggyPathsApi, "cwd" | "homedir" | "profilesDirectory">,
): ProfileTarget => {
  const targetPath = hasPathSyntax(value)
    ? path.resolve(paths.cwd, expandLeadingTilde(value, paths.homedir))
    : path.join(paths.profilesDirectory, value);

  const basename = path.basename(targetPath);

  return {
    path: targetPath,
    name: basename.length === 0 ? basename : basename.charAt(0).toUpperCase() + basename.slice(1),
  };
};

/**
 * The shortest CLI argument that resolves back to `profilePath`: the folder name when the
 * Profile lives directly under `profilesDirectory`, otherwise the absolute path. Round-trip
 * invariant: `resolveProfileTarget(profileCliTarget(p, dir), paths).path === p` whenever
 * `dir === paths.profilesDirectory` and `p` is absolute.
 */
export const profileCliTarget = (profilePath: string, profilesDirectory: string): string => {
  const name = path.basename(profilePath);

  return name.length > 0 &&
    !hasPathSyntax(name) &&
    path.join(profilesDirectory, name) === profilePath
    ? name
    : profilePath;
};
