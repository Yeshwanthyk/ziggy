import { Context, Effect, Layer } from "effect";
import type {
  ProfileFileSystemError,
  ProfileTargetNotDirectory,
  ProfileTarget,
} from "../domain/profile";

export interface InitializedProfile {
  readonly path: string;
  readonly created: boolean;
  readonly createdDirectories: ReadonlyArray<"agents" | "automations">;
}

export interface InitProfileOptions {
  readonly createStarterDirectories?: boolean;
}

export interface ProfileListing {
  readonly name: string;
  readonly path: string;
}

export type ProfileError = ProfileFileSystemError | ProfileTargetNotDirectory;

export interface ProfilesApi {
  readonly initProfile: (
    target: ProfileTarget,
    options?: InitProfileOptions,
  ) => Effect.Effect<InitializedProfile, ProfileError>;
  readonly registerProfile: (
    registryPath: string,
    profilePath: string,
  ) => Effect.Effect<void, ProfileFileSystemError>;
  readonly listProfiles: (
    profilesDirectory: string,
    registryPath: string,
  ) => Effect.Effect<ReadonlyArray<ProfileListing>, ProfileFileSystemError>;
}

export class Profiles extends Context.Service<Profiles, ProfilesApi>()("ziggy/Profiles") {}

export class ProfileStore extends Context.Service<ProfileStore, ProfilesApi>()(
  "ziggy/ProfileStore",
) {}

export const ProfilesLive = Layer.effect(Profiles, ProfileStore);
