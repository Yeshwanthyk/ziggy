import { Schema } from "effect";
import type { MemoryIdInvalid } from "./memory";
import type { ProfileExtensionInvalid, ProfileFileSystemError } from "./profile";

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

export class ProviderCallError extends Schema.TaggedErrorClass<ProviderCallError>()(
  "ProviderCallError",
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

export type ZiggyAgentError =
  | ProfileNotInitialized
  | ProviderConfigError
  | ProviderCallError
  | MemoryIdInvalid
  | ProfileExtensionInvalid
  | ProfileFileSystemError;
