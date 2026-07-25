import { Schema } from "effect";
import type { MemoryIdInvalid } from "./memory";

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

export type ZiggyAgentError =
  | ProfileNotInitialized
  | ProviderConfigError
  | ProviderCallError
  | MemoryIdInvalid;
