import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import type { ProfileTarget } from "../domain/profile";
import {
  DefaultProfileUnavailable,
  DefaultProfileUnknown,
  ProfileDirectoryReadError,
  ProfileIdCollision,
  ProfileUnavailable,
  UnknownProfile,
  type ProfileDirectoryRow,
  type ProfileId,
  type ResolvedProfile,
} from "../domain/profile-directory";

export interface ProfileDirectoryConfig {
  readonly registryPath: string;
  readonly idForPath?: (normalizedPath: string) => ProfileId;
  readonly includeCurrent?: boolean;
}

export interface ProfileDirectoryEntry extends ProfileDirectoryRow {
  readonly target: ProfileTarget;
}

export interface ProfileDirectoryApi {
  readonly entries: () => Effect.Effect<
    ReadonlyArray<ProfileDirectoryEntry>,
    ProfileDirectoryReadError | ProfileIdCollision
  >;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProfileDirectoryRow>,
    ProfileDirectoryReadError | ProfileIdCollision
  >;
  readonly current: () => Effect.Effect<
    ResolvedProfile,
    | ProfileDirectoryReadError
    | ProfileIdCollision
    | DefaultProfileUnknown
    | DefaultProfileUnavailable
  >;
  readonly resolve: (
    profileId: ProfileId,
  ) => Effect.Effect<
    ResolvedProfile,
    ProfileDirectoryReadError | ProfileIdCollision | UnknownProfile | ProfileUnavailable
  >;
}

interface DirectoryTarget {
  readonly profileId: ProfileId;
  readonly target: ProfileTarget;
  readonly current: boolean;
  readonly available: boolean;
}

export const stableProfileId = (normalizedPath: string): ProfileId =>
  `prf_${createHash("sha256").update(normalizedPath).digest("hex").slice(0, 24)}`;

const displayName = (profilePath: string): string => {
  const basename = path.basename(profilePath);
  if (basename.length === 0) return "Profile";
  return basename.charAt(0).toUpperCase() + basename.slice(1);
};

const readRegistry = (registryPath: string): Effect.Effect<string, ProfileDirectoryReadError> =>
  Effect.tryPromise({
    try: () => readFile(registryPath, "utf8"),
    catch: (cause) => {
      const details = fileSystemCauseDetails(cause);
      return new ProfileDirectoryReadError({
        operation: "read registered Profiles",
        message: "could not read the registered Profile directory",
        code: details.code,
        cause,
      });
    },
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(""),
    ),
  );

const inspectPath = (targetPath: string) =>
  Effect.tryPromise({
    try: () => lstat(targetPath),
    catch: (cause) => cause,
  });

const isAvailable = (profilePath: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const target = yield* inspectPath(profilePath);
    if (!target.isDirectory() || target.isSymbolicLink()) return false;
    const soul = yield* inspectPath(path.join(profilePath, "SOUL.md"));
    return soul.isFile() && !soul.isSymbolicLink();
  }).pipe(Effect.catch(() => Effect.succeed(false)));

export const makeProfileDirectory = (
  currentTarget: ProfileTarget,
  config: ProfileDirectoryConfig,
): ProfileDirectoryApi => {
  const build = Effect.gen(function* () {
    const currentPath = path.resolve(currentTarget.path);
    const registry = yield* readRegistry(config.registryPath);
    const registeredPaths = registry
      .split("\n")
      .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
      .map((entry) => path.resolve(entry));
    const normalizedPaths = [
      ...(config.includeCurrent === false ? [] : [currentPath]),
      ...registeredPaths,
    ].filter((entry, index, entries) => entries.indexOf(entry) === index);
    const idForPath = config.idForPath ?? stableProfileId;
    const targets = yield* Effect.forEach(normalizedPaths, (normalizedPath) =>
      isAvailable(normalizedPath).pipe(
        Effect.map(
          (available): DirectoryTarget => ({
            profileId: idForPath(normalizedPath),
            target: {
              path: normalizedPath,
              name: (normalizedPath === currentPath
                ? currentTarget.name
                : displayName(normalizedPath)
              ).slice(0, 128),
            },
            current: normalizedPath === currentPath,
            available,
          }),
        ),
      ),
    );
    const profileIds = new Set<ProfileId>();
    for (const target of targets) {
      if (profileIds.has(target.profileId))
        return yield* new ProfileIdCollision({ profileId: target.profileId });
      profileIds.add(target.profileId);
    }
    return targets;
  });

  return {
    entries: () =>
      build.pipe(
        Effect.map((targets) =>
          targets.map(({ profileId, target, current, available }) => ({
            profileId,
            target,
            name: target.name,
            current,
            available,
          })),
        ),
      ),
    list: () =>
      build.pipe(
        Effect.map((targets) =>
          targets.map(({ profileId, target, current, available }) => ({
            profileId,
            name: target.name,
            current,
            available,
          })),
        ),
      ),
    current: () =>
      Effect.gen(function* () {
        const targets = yield* build;
        const current = targets.find((candidate) => candidate.current);
        if (current === undefined) {
          return yield* new DefaultProfileUnknown({
            profileId: stableProfileId(path.resolve(currentTarget.path)),
          });
        }
        if (!current.available)
          return yield* new DefaultProfileUnavailable({ profileId: current.profileId });
        return { profileId: current.profileId, target: current.target };
      }),
    resolve: (profileId) =>
      Effect.gen(function* () {
        const targets = yield* build;
        const resolved = targets.find((candidate) => candidate.profileId === profileId);
        if (resolved === undefined) return yield* new UnknownProfile({ profileId });
        if (!resolved.available) return yield* new ProfileUnavailable({ profileId });
        return { profileId: resolved.profileId, target: resolved.target };
      }),
  };
};
