import { Schema } from "effect";
import type { MemoryIdInvalid } from "./memory";
import type {
  ProfileAgentInvalid,
  ProfileExtensionInvalid,
  ProfileFileSystemError,
} from "./profile";

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

export class SpecialistAgentNotFound extends Schema.TaggedErrorClass<SpecialistAgentNotFound>()(
  "SpecialistAgentNotFound",
  {
    profilePath: Schema.String,
    agentId: Schema.String,
    message: Schema.String,
  },
) {}

export class SpecialistProviderUnsupported extends Schema.TaggedErrorClass<SpecialistProviderUnsupported>()(
  "SpecialistProviderUnsupported",
  {
    profilePath: Schema.String,
    providerId: Schema.String,
    message: Schema.String,
  },
) {}

export class SpecialistModelUnsupported extends Schema.TaggedErrorClass<SpecialistModelUnsupported>()(
  "SpecialistModelUnsupported",
  {
    profilePath: Schema.String,
    providerId: Schema.String,
    modelId: Schema.String,
    message: Schema.String,
  },
) {}

export class SpecialistAuthUnavailable extends Schema.TaggedErrorClass<SpecialistAuthUnavailable>()(
  "SpecialistAuthUnavailable",
  {
    profilePath: Schema.String,
    providerId: Schema.String,
    message: Schema.String,
  },
) {}

export class SpecialistThinkingUnsupported extends Schema.TaggedErrorClass<SpecialistThinkingUnsupported>()(
  "SpecialistThinkingUnsupported",
  {
    profilePath: Schema.String,
    providerId: Schema.String,
    modelId: Schema.String,
    thinking: Schema.String,
    message: Schema.String,
  },
) {}

export class SpecialistToolUnsupported extends Schema.TaggedErrorClass<SpecialistToolUnsupported>()(
  "SpecialistToolUnsupported",
  {
    profilePath: Schema.String,
    agentId: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class SpecialistRunFailed extends Schema.TaggedErrorClass<SpecialistRunFailed>()(
  "SpecialistRunFailed",
  {
    profilePath: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type ZiggyAgentError =
  | ProfileNotInitialized
  | ProviderConfigError
  | ProviderCallError
  | MemoryIdInvalid
  | ProfileExtensionInvalid
  | ProfileFileSystemError;

export type OpenTuiError = ZiggyAgentError | ProfileAgentInvalid;
