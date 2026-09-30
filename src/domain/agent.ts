import { Schema } from "effect";
import type { ProfileNotInitialized, ProviderConfigError } from "../profile";
import type { MemoryIdInvalid } from "./memory";
import {
  type ProfileAgentInvalid,
  type ProfileAgentMentionInvalid,
  ProfileAgentThinking,
} from "./profile";
import type { ProfileExtensionRuntimeError } from "./profile-extension";

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

export class SessionHeld extends Schema.TaggedErrorClass<SessionHeld>()("SessionHeld", {
  profilePath: Schema.String,
  message: Schema.String,
  pid: Schema.optional(Schema.Int),
}) {}

export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  profilePath: Schema.String,
  message: Schema.String,
}) {}

export type ZiggyAgentError =
  | SessionBusy
  | SessionHeld
  | ProfileNotInitialized
  | ProviderConfigError
  | ProviderCallError
  | MemoryIdInvalid
  | ProfileAgentInvalid
  | ProfileAgentMentionInvalid
  | ProfileExtensionRuntimeError;

export type ProfileSpecialistError =
  | ZiggyAgentError
  | SpecialistAgentNotFound
  | SpecialistProviderUnsupported
  | SpecialistModelUnsupported
  | SpecialistAuthUnavailable
  | SpecialistThinkingUnsupported
  | SpecialistToolUnsupported
  | SpecialistRunFailed;
