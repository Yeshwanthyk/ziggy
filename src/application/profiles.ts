import { appendFile, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  readonly registerProfile: (
    registryPath: string,
    profilePath: string,
  ) => Effect.Effect<void, ProfileFileSystemError>;
  readonly listProfiles: (
    profilesDirectory: string,
    registryPath: string,
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

const readRegistry = (registryPath: string) =>
  Effect.tryPromise({
    try: () => readFile(registryPath, "utf8"),
    catch: (cause) => fileSystemError("read", registryPath, cause),
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(""),
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

const registerProfile = (
  registryPath: string,
  profilePath: string,
): Effect.Effect<void, ProfileFileSystemError> =>
  Effect.gen(function* () {
    const registryDirectory = path.dirname(registryPath);
    yield* Effect.tryPromise({
      try: () => mkdir(registryDirectory, { recursive: true }),
      catch: (cause) => fileSystemError("create directory", registryDirectory, cause),
    });

    const registry = yield* readRegistry(registryPath);
    const entries = registry.split("\n").filter((entry) => entry.length > 0);

    if (entries.includes(profilePath)) {
      return;
    }

    const prefix = registry.length > 0 && !registry.endsWith("\n") ? "\n" : "";
    yield* Effect.tryPromise({
      try: () => appendFile(registryPath, `${prefix}${profilePath}\n`, "utf8"),
      catch: (cause) => fileSystemError("append", registryPath, cause),
    });
  });

const listProfiles = (
  profilesDirectory: string,
  registryPath: string,
): Effect.Effect<ReadonlyArray<ProfileListing>, ProfileFileSystemError> =>
  Effect.gen(function* () {
    const registryEntries = (yield* readRegistry(registryPath))
      .split("\n")
      .filter((entry) => path.isAbsolute(entry))
      .map((entry) => path.resolve(entry));

    const entries = yield* Effect.tryPromise({
      try: () => readdir(profilesDirectory, { withFileTypes: true }),
      catch: (cause) => fileSystemError("list", profilesDirectory, cause),
    }).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () => Effect.succeed([]),
      ),
    );

    const directoryPaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.resolve(profilesDirectory, entry.name));
    const profilePaths = [...new Set([...registryEntries, ...directoryPaths])];

    const listings = yield* Effect.forEach(profilePaths, (profilePath) =>
      pathExists(path.join(profilePath, "SOUL.md")).pipe(
        Effect.map((hasSoul) => ({
          hasSoul,
          listing: hasSoul ? { name: path.basename(profilePath), path: profilePath } : undefined,
        })),
      ),
    );

    const validRegistryEntries = registryEntries.filter((registryEntry) =>
      listings.some(({ hasSoul, listing }) => hasSoul && listing?.path === registryEntry),
    );
    if (validRegistryEntries.length !== registryEntries.length) {
      yield* Effect.tryPromise({
        try: () =>
          writeFile(
            registryPath,
            validRegistryEntries.length === 0 ? "" : `${validRegistryEntries.join("\n")}\n`,
            "utf8",
          ),
        catch: (cause) => fileSystemError("write", registryPath, cause),
      });
    }

    return listings
      .flatMap(({ listing }) => (listing === undefined ? [] : [listing]))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
      );
  });

export const ProfilesLive = Layer.succeed(Profiles, {
  initProfile,
  registerProfile,
  listProfiles,
});
