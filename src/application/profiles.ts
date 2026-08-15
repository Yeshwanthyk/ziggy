import { appendFile, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import {
  readExtensionSelection,
  readSelectedExtensionPackage,
  removeExtensionSelection,
  setExtensionSelection,
} from "../adapters/fs/profile-extensions";
import {
  ProfileExtensionInvalid,
  ProfileFileSystemError,
  ProfileTargetNotDirectory,
  soulTemplate,
  type ProfileTarget,
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

export type ProfileExtensionError = ProfileExtensionInvalid | ProfileFileSystemError;

export interface ProfileExtensionMutation {
  readonly id: string;
  readonly profilePath: string;
  readonly changed: boolean;
  readonly selected: boolean;
}

export type ProfileError =
  | ProfileFileSystemError
  | ProfileTargetNotDirectory
  | ProfileExtensionInvalid;

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
  readonly addExtension: (
    target: ProfileTarget,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ProfileExtensionMutation, ProfileExtensionError>;
  readonly removeExtension: (
    target: ProfileTarget,
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ProfileExtensionMutation, ProfileExtensionError>;
}

export class Profiles extends Context.Service<Profiles, ProfilesApi>()("ziggy/Profiles") {}

const fileSystemError = (
  operation: string,
  targetPath: string,
  cause: unknown,
): ProfileFileSystemError => {
  const details = fileSystemCauseDetails(cause);
  return new ProfileFileSystemError({
    operation,
    path: targetPath,
    message: details.message,
    code: details.code,
    cause,
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

const ensureStarterDirectory = (
  targetPath: string,
  name: "agents" | "automations",
): Effect.Effect<boolean, ProfileFileSystemError> => {
  const directoryPath = path.join(targetPath, name);
  return lstatPath(directoryPath).pipe(
    Effect.flatMap((status) =>
      status.isDirectory() && !status.isSymbolicLink()
        ? Effect.succeed(false)
        : Effect.fail(
            fileSystemError(
              "validate directory",
              directoryPath,
              `${directoryPath} must be a regular non-symlink directory`,
            ),
          ),
    ),
    Effect.catchIf(
      (failure) => failure.code === "ENOENT",
      () =>
        Effect.tryPromise({
          try: () => mkdir(directoryPath),
          catch: (cause) => fileSystemError("create directory", directoryPath, cause),
        }).pipe(Effect.as(true)),
    ),
  );
};

const initProfile = (
  target: ProfileTarget,
  options: InitProfileOptions = {},
): Effect.Effect<InitializedProfile, ProfileError> =>
  Effect.gen(function* () {
    const targetStatus = yield* statPath(target.path).pipe(
      Effect.catchIf(
        (failure) => failure.code === "ENOENT",
        () => Effect.void,
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
    const soulStatus = yield* lstatPath(soulPath).pipe(
      Effect.catchIf(
        (failure) => failure.code === "ENOENT",
        () => Effect.void,
      ),
    );
    if (soulStatus !== undefined && (!soulStatus.isFile() || soulStatus.isSymbolicLink())) {
      return yield* new ProfileTargetNotDirectory({ path: soulPath });
    }

    let created = false;
    if (soulStatus === undefined) {
      yield* Effect.tryPromise({
        try: () => writeFile(soulPath, soulTemplate(target.name), { flag: "wx" }),
        catch: (cause) => fileSystemError("write", soulPath, cause),
      });
      created = true;
    }

    const createdDirectories: Array<"agents" | "automations"> = [];
    if (options.createStarterDirectories === true) {
      for (const name of ["agents", "automations"] as const) {
        if (yield* ensureStarterDirectory(target.path, name)) createdDirectories.push(name);
      }
    }

    return { path: target.path, created, createdDirectories };
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

const verifyExtensionProfile = (target: ProfileTarget) =>
  lstatPath(path.join(target.path, "SOUL.md")).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.void
        : Effect.fail(
            new ProfileExtensionInvalid({
              path: target.path,
              message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
              cause: undefined,
            }),
          ),
    ),
    Effect.catchIf(
      (error) => Predicate.isTagged(error, "ProfileFileSystemError") && error.code === "ENOENT",
      () =>
        Effect.fail(
          new ProfileExtensionInvalid({
            path: target.path,
            message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
            cause: undefined,
          }),
        ),
    ),
  );

const mutateExtension = (
  target: ProfileTarget,
  repositoryRoot: string,
  id: string,
  selected: boolean,
): Effect.Effect<ProfileExtensionMutation, ProfileExtensionError> =>
  Effect.gen(function* () {
    yield* verifyExtensionProfile(target);
    if (!selected) {
      const result = yield* removeExtensionSelection(target.path, id);
      return {
        id,
        profilePath: target.path,
        changed: result.changed,
        selected: false,
      };
    }
    const extension = yield* readSelectedExtensionPackage(target.path, repositoryRoot, id);
    if (extension.required) {
      return yield* new ProfileExtensionInvalid({
        path: extension.packagePath,
        message: `required extension '${id}' cannot be added or removed`,
        cause: undefined,
      });
    }
    const current = yield* readExtensionSelection(target.path);
    yield* Effect.forEach(current, (selectedId) =>
      readSelectedExtensionPackage(target.path, repositoryRoot, selectedId),
    );
    const alreadySelected = current.includes(id);
    if (alreadySelected) {
      return { id, profilePath: target.path, changed: false, selected: true };
    }
    const next = [...current, id].sort();
    const result = yield* setExtensionSelection(target.path, repositoryRoot, next);
    return { id, profilePath: target.path, changed: result.changed, selected: true };
  });

export const ProfilesLive = Layer.succeed(Profiles, {
  initProfile,
  registerProfile,
  listProfiles,
  addExtension: (target, repositoryRoot, id) => mutateExtension(target, repositoryRoot, id, true),
  removeExtension: (target, repositoryRoot, id) =>
    mutateExtension(target, repositoryRoot, id, false),
});
