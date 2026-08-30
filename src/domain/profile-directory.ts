import { Schema } from "effect";
import type { ProfileTarget } from "./profile";

/** Opaque, stable identity for a Profile.  Paths never cross the UI protocol boundary. */
export const ProfileId = Schema.String.check(
  Schema.makeFilter((value) => /^prf_[a-f0-9]{24}$/u.test(value), {
    expected: "an opaque Profile id",
  }),
);
export type ProfileId = typeof ProfileId.Type;

export interface ProfileDirectoryRow {
  readonly profileId: ProfileId;
  readonly name: string;
  readonly current: boolean;
  readonly available: boolean;
}

export interface ResolvedProfile {
  readonly profileId: ProfileId;
  readonly target: ProfileTarget;
}

export class DefaultProfileUnknown extends Schema.TaggedErrorClass<DefaultProfileUnknown>()(
  "DefaultProfileUnknown",
  { profileId: ProfileId },
) {}

export class DefaultProfileUnavailable extends Schema.TaggedErrorClass<DefaultProfileUnavailable>()(
  "DefaultProfileUnavailable",
  { profileId: ProfileId, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class UnknownProfile extends Schema.TaggedErrorClass<UnknownProfile>()("UnknownProfile", {
  profileId: ProfileId,
}) {}

export class ProfileUnavailable extends Schema.TaggedErrorClass<ProfileUnavailable>()(
  "ProfileUnavailable",
  { profileId: ProfileId },
) {}

export class ProfileIdCollision extends Schema.TaggedErrorClass<ProfileIdCollision>()(
  "ProfileIdCollision",
  { profileId: ProfileId },
) {}

export class ProfileDirectoryReadError extends Schema.TaggedErrorClass<ProfileDirectoryReadError>()(
  "ProfileDirectoryReadError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.UndefinedOr(Schema.String),
    cause: Schema.Defect(),
  },
) {}
