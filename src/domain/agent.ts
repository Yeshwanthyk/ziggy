import { Schema } from "effect";
import type { MemoryIdInvalid } from "./memory";
import {
  type ProfileAgentInvalid,
  type ProfileAgentMentionInvalid,
  ProfileAgentThinking,
  type ProfileExtensionInvalid,
  type ProfileFileSystemError,
} from "./profile";

/** Read-only projection of one Pi-owned session. */
export interface SessionReference {
  readonly id: string;
  readonly file: string;
}

/** Bounded Profile agent output; Pi JSONL remains the transcript authority. */
export interface ProfileAgentRunResult {
  readonly answer: string;
  readonly session: SessionReference;
}

export interface ProfileAgentRunContext {
  readonly sessionDirectory: string;
}

/** Optional per-session model policy. Omitted keys inherit the Profile default. */
export const ChatModelOverride = Schema.Struct({
  provider: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  thinking: Schema.optionalKey(ProfileAgentThinking),
}).check(
  Schema.makeFilter(
    (override) => (override.provider === undefined) === (override.model === undefined),
    { expected: "provider and model must be provided together" },
  ),
);
export type ChatModelOverride = typeof ChatModelOverride.Type;

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

export class ChatNotStreaming extends Schema.TaggedErrorClass<ChatNotStreaming>()(
  "ChatNotStreaming",
  {
    profilePath: Schema.String,
    operation: Schema.String,
    message: Schema.String,
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
  | ProfileAgentInvalid
  | ProfileAgentMentionInvalid
  | ProfileExtensionInvalid
  | ProfileFileSystemError;

export type ProfileSpecialistError =
  | ZiggyAgentError
  | ProfileAgentInvalid
  | SpecialistAgentNotFound
  | SpecialistProviderUnsupported
  | SpecialistModelUnsupported
  | SpecialistAuthUnavailable
  | SpecialistThinkingUnsupported
  | SpecialistToolUnsupported
  | SpecialistRunFailed;

export type OpenTuiError = ZiggyAgentError | ProfileAgentInvalid;
