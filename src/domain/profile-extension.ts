import { Context, Effect, Schema } from "effect";
import type {
  ExtensionCatalogInstallFailed,
  ExtensionCatalogInvalid,
  ExtensionCatalogUnavailable,
} from "./extension-catalog";
import type { ProfileExtensionInvalid, ProfileFileSystemError, ProfileTarget } from "./profile";

export const ProfileExtensionId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type ProfileExtensionId = typeof ProfileExtensionId.Type;

export type ProfileExtensionKind = "skill" | "code" | "skill+code" | "remote";
export type ProfileExtensionCatalogSource = "bundled" | "remote-approved";

export interface ProfileExtensionCatalogListing {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly kind: ProfileExtensionKind;
  readonly required: boolean;
  readonly source: ProfileExtensionCatalogSource;
  readonly installed: boolean;
  readonly packagePath?: string;
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly extensionPaths?: ReadonlyArray<string>;
}

export interface ProfileExtensionChoice {
  readonly id: string;
  readonly description: string;
  readonly kind: ProfileExtensionKind;
  readonly source: "bundled" | "remote-approved" | "profile";
}

export interface ProfileExtensionListing {
  readonly available: ReadonlyArray<ProfileExtensionChoice>;
  readonly selected: ReadonlyArray<string>;
}

export interface ProfileExtensionMutation {
  readonly id: string;
  readonly profilePath: string;
  readonly changed: boolean;
  readonly selected: boolean;
}

export interface ProfileExtensionSetResult {
  readonly changed: boolean;
  readonly selected: ReadonlyArray<string>;
}

export interface ProfileExtensionRuntimePreparation {
  readonly selected: ReadonlyArray<string>;
  /** Stable digest of the exact extensions.json bytes prepared for this runtime. */
  readonly generation: string;
}

const ProfileExtensionRollbackDetail = Schema.Struct({
  operation: Schema.String.check(Schema.isMaxLength(96)),
  path: Schema.String.check(Schema.isMaxLength(240)),
  message: Schema.String.check(Schema.isMaxLength(360)),
});

export class ProfileExtensionRollbackFailed extends Schema.TaggedErrorClass<ProfileExtensionRollbackFailed>()(
  "ProfileExtensionRollbackFailed",
  {
    profilePath: Schema.String,
    operation: Schema.String.check(Schema.isMaxLength(96)),
    message: Schema.String.check(Schema.isMaxLength(360)),
    originalFailure: Schema.Defect(),
    rollbackFailures: Schema.Array(ProfileExtensionRollbackDetail).check(Schema.isMaxLength(12)),
    cause: Schema.Defect(),
  },
) {}
export interface ProfileExtensionPreflightResult {
  readonly extensionPathCount: number;
  readonly skillPathCount: number;
  readonly extensionFactoryCount: number;
}

export interface ProfileExtensionValidation {
  readonly selected: ReadonlyArray<string>;
  readonly preflight: ProfileExtensionPreflightResult;
}

export class ProfileExtensionPreflightFailed extends Schema.TaggedErrorClass<ProfileExtensionPreflightFailed>()(
  "ProfileExtensionPreflightFailed",
  {
    profilePath: Schema.String,
    stage: Schema.Literals(["resources", "extensions", "skills", "services"]),
    message: Schema.String,
    diagnostics: Schema.Array(
      Schema.Struct({
        source: Schema.String,
        message: Schema.String,
      }),
    ),
    cause: Schema.Defect(),
  },
) {}

export class ProfileExtensionLockFailed extends Schema.TaggedErrorClass<ProfileExtensionLockFailed>()(
  "ProfileExtensionLockFailed",
  {
    profilePath: Schema.String,
    operation: Schema.Literals(["prepare", "acquire", "release"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type ProfileExtensionRuntimeError =
  | ProfileExtensionInvalid
  | ProfileFileSystemError
  | ProfileExtensionPreflightFailed
  | ProfileExtensionLockFailed
  | ProfileExtensionRollbackFailed;

export type ProfileExtensionError =
  | ProfileExtensionInvalid
  | ProfileFileSystemError
  | ExtensionCatalogInvalid
  | ExtensionCatalogUnavailable
  | ExtensionCatalogInstallFailed
  | ProfileExtensionPreflightFailed
  | ProfileExtensionLockFailed
  | ProfileExtensionRollbackFailed;

export interface ProfileExtensionPreflightApi {
  readonly preflight: (
    profilePath: string,
    repositoryRoot: string,
    selected: ReadonlyArray<string>,
  ) => Effect.Effect<ProfileExtensionPreflightResult, ProfileExtensionError>;
}

export class ProfileExtensionPreflight extends Context.Service<
  ProfileExtensionPreflight,
  ProfileExtensionPreflightApi
>()("ziggy/ProfileExtensionPreflight") {}

export interface ProfileExtensionMutationLockApi {
  readonly withLock: <A, E, R>(
    profilePath: string,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProfileExtensionLockFailed, R>;
}

export class ProfileExtensionMutationLock extends Context.Service<
  ProfileExtensionMutationLock,
  ProfileExtensionMutationLockApi
>()("ziggy/ProfileExtensionMutationLock") {}

export interface ProfileExtensionsApi {
  readonly list: (
    repositoryRoot: string,
  ) => Effect.Effect<ReadonlyArray<ProfileExtensionCatalogListing>, ProfileExtensionError>;
  readonly show: (
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ProfileExtensionCatalogListing, ProfileExtensionError>;
  readonly listForProfile: (
    profilePath: string,
    repositoryRoot: string,
  ) => Effect.Effect<ProfileExtensionListing, ProfileExtensionError>;
  readonly add: (
    target: ProfileTarget,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ProfileExtensionMutation, ProfileExtensionError>;
  readonly remove: (
    target: ProfileTarget,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ProfileExtensionMutation, ProfileExtensionError>;
  readonly setSelected: (
    target: ProfileTarget,
    repositoryRoot: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ProfileExtensionSetResult, ProfileExtensionError>;
  readonly validate: (
    target: ProfileTarget,
    repositoryRoot: string,
  ) => Effect.Effect<ProfileExtensionValidation, ProfileExtensionError>;
  readonly prepareRuntime: (
    profilePath: string,
    repositoryRoot: string,
  ) => Effect.Effect<ProfileExtensionRuntimePreparation, ProfileExtensionRuntimeError>;
  readonly activateRuntime: (
    profilePath: string,
    repositoryRoot: string,
    preparation: ProfileExtensionRuntimePreparation,
  ) => Effect.Effect<void, ProfileExtensionRuntimeError>;
}
