import { lstat, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  ProfileFileSystemError,
  ProfileTargetNotDirectory,
  soulTemplate,
  type ProfileTarget,
} from "../domain/profile";

export interface InitializedProfile {
  readonly path: string;
  readonly created: boolean;
}

export interface ProfileListing {
  readonly name: string;
  readonly path: string;
}

export type ProfileError = ProfileFileSystemError | ProfileTargetNotDirectory;

export interface ProfilesShape {
  readonly initProfile: (target: ProfileTarget) => Effect.Effect<InitializedProfile, ProfileError>;
  readonly listProfiles: (
    profilesDirectory: string,
  ) => Effect.Effect<ReadonlyArray<ProfileListing>, ProfileFileSystemError>;
}

export class Profiles extends Context.Service<Profiles, ProfilesShape>()("ziggy/Profiles") {}

const errorDetails = (
  cause: unknown,
): { readonly message: string; readonly code: string | undefined } => {
  if (cause instanceof Error) {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    return { message: cause.message, code };
  }

  return { message: String(cause), code: undefined };
};

const fileSystemError = (
  operation: string,
  targetPath: string,
  cause: unknown,
): ProfileFileSystemError => {
  const details = errorDetails(cause);
  return new ProfileFileSystemError({
    operation,
    path: targetPath,
    message: details.message,
    code: details.code,
  });
};

const statPath = (targetPath: string) =>
  Effect.tryPromise({
    try: () => stat(targetPath),
    catch: (cause) => fileSystemError("inspect", targetPath, cause),
  });

const lstatPath = (targetPath: string) =>
  Effect.tryPromise({
    try: () => lstat(targetPath),
    catch: (cause) => fileSystemError("inspect", targetPath, cause),
  });

const pathExists = (targetPath: string) =>
  lstatPath(targetPath).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(false),
    ),
  );

const initProfile = (target: ProfileTarget): Effect.Effect<InitializedProfile, ProfileError> =>
  Effect.gen(function* () {
    const targetStatus = yield* statPath(target.path).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () => Effect.succeed(undefined),
      ),
    );

    if (targetStatus !== undefined && !targetStatus.isDirectory()) {
      return yield* new ProfileTargetNotDirectory({ path: target.path });
    }

    if (targetStatus === undefined) {
      yield* Effect.tryPromise({
        try: () => mkdir(target.path, { recursive: true }),
        catch: (cause) => fileSystemError("create directory", target.path, cause),
      });
    }

    const soulPath = path.join(target.path, "SOUL.md");
    if (yield* pathExists(soulPath)) {
      return { path: target.path, created: false };
    }

    yield* Effect.tryPromise({
      try: () => writeFile(soulPath, soulTemplate(target.name), { flag: "wx" }),
      catch: (cause) => fileSystemError("write", soulPath, cause),
    });

    return { path: target.path, created: true };
  });

const listProfiles = (
  profilesDirectory: string,
): Effect.Effect<ReadonlyArray<ProfileListing>, ProfileFileSystemError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(profilesDirectory, { withFileTypes: true }),
      catch: (cause) => fileSystemError("list", profilesDirectory, cause),
    }).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () => Effect.succeed([]),
      ),
    );

    const directories = entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    const listings = yield* Effect.forEach(directories, (entry) => {
      const profilePath = path.resolve(profilesDirectory, entry.name);
      return pathExists(path.join(profilePath, "SOUL.md")).pipe(
        Effect.map((hasSoul) => (hasSoul ? { name: entry.name, path: profilePath } : undefined)),
      );
    });

    return listings.filter((listing): listing is ProfileListing => listing !== undefined);
  });

export const ProfilesLive = Layer.succeed(Profiles, {
  initProfile,
  listProfiles,
});
