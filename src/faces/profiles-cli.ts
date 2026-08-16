import { Schema } from "effect";

export const ProfileListingJson = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
export type ProfileListingJson = typeof ProfileListingJson.Type;

export const ProfilesJson = Schema.Array(ProfileListingJson);
export type ProfilesJson = typeof ProfilesJson.Type;
const encodeProfiles = Schema.encodeSync(ProfilesJson);

export const renderProfilesJson = (profiles: ReadonlyArray<ProfileListingJson>): string =>
  JSON.stringify(encodeProfiles(profiles));

export const renderProfileListingsJson = renderProfilesJson;
