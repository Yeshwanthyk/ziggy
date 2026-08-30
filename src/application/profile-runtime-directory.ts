import { Effect } from "effect";
import {
  ProfileUnavailable,
  type ProfileDirectoryRow,
  type ProfileId,
  type ResolvedProfile,
} from "../domain/profile-directory";
import type { ChatRegistryApi } from "./chat-registry";
import type { ProfileDirectoryApi, ProfileDirectoryEntry } from "./profile-directory";

export interface ResidentProfileBranch extends ResolvedProfile {
  readonly registry: ChatRegistryApi;
}

export interface ProfileRuntimeDirectoryApi extends ProfileDirectoryApi {
  readonly branch: (
    profileId: ProfileId,
  ) => Effect.Effect<ResidentProfileBranch, ProfileUnavailable>;
  readonly markAvailable: (branch: ResidentProfileBranch) => Effect.Effect<void>;
  readonly markUnavailable: (profileId: ProfileId) => Effect.Effect<void>;
}

export const makeProfileRuntimeDirectory = (
  directory: ProfileDirectoryApi,
  initialBranches: ReadonlyArray<ResidentProfileBranch> = [],
): ProfileRuntimeDirectoryApi => {
  // Branch registration is synchronous at composition time. Runtime lifecycle code can still
  // use markAvailable/markUnavailable when a resident starts or stops; the initial set lets a
  // shared UI gateway be assembled before its first request without running an Effect just to
  // seed the private branch map.
  const branches = new Map<ProfileId, ResidentProfileBranch>(
    initialBranches.map((branch) => [branch.profileId, branch]),
  );
  const availableEntry = (entry: ProfileDirectoryEntry): ProfileDirectoryEntry => ({
    ...entry,
    available: entry.available && branches.has(entry.profileId),
  });
  const entries = () => directory.entries().pipe(Effect.map((rows) => rows.map(availableEntry)));
  return {
    entries,
    list: () =>
      entries().pipe(
        Effect.map((rows) =>
          rows.map(
            ({ profileId, name, current, available }): ProfileDirectoryRow => ({
              profileId,
              name,
              current,
              available,
            }),
          ),
        ),
      ),
    current: directory.current,
    resolve: (profileId) =>
      directory
        .resolve(profileId)
        .pipe(
          Effect.flatMap((resolved) =>
            branches.has(profileId)
              ? Effect.succeed(resolved)
              : Effect.fail(new ProfileUnavailable({ profileId })),
          ),
        ),
    branch: (profileId) => {
      const branch = branches.get(profileId);
      return branch === undefined
        ? Effect.fail(new ProfileUnavailable({ profileId }))
        : Effect.succeed(branch);
    },
    markAvailable: (branch) => Effect.sync(() => void branches.set(branch.profileId, branch)),
    markUnavailable: (profileId) => Effect.sync(() => void branches.delete(profileId)),
  };
};
