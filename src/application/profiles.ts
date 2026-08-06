import { randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Predicate } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import {
  readExtensionPackage,
  readExtensionSelection,
  replaceExtensionSelection,
  scanExtensionShelf,
  type ExtensionPackage,
} from "../adapters/fs/profile-extensions";
import {
  ProfileExtensionInvalid,
  ProfileFileSystemError,
  ProfileSkillExists,
  ProfileSkillInvalid,
  ProfileSkillNotFound,
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

export interface ProfileSkills {
  readonly installed: ReadonlyArray<SkillListing>;
  readonly available: ReadonlyArray<SkillListing>;
}

export interface SkillListing {
  readonly id: string;
  readonly path: string;
}

export interface InstalledSkill {
  readonly id: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly replaced: boolean;
}

export type ProfileSkillError =
  | ProfileFileSystemError
  | ProfileSkillExists
  | ProfileSkillInvalid
  | ProfileSkillNotFound;

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
  | ProfileSkillError
  | ProfileExtensionInvalid;

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
  readonly listSkills: (
    target: ProfileTarget,
    repositoryRoot: string,
  ) => Effect.Effect<ProfileSkills, ProfileSkillError>;
  readonly addSkill: (
    target: ProfileTarget,
    repositoryRoot: string,
    source: string,
    cwd: string,
    force: boolean,
  ) => Effect.Effect<InstalledSkill, ProfileSkillError>;
  readonly listExtensions: (
    repositoryRoot: string,
  ) => Effect.Effect<ReadonlyArray<ExtensionPackage>, ProfileExtensionError>;
  readonly showExtension: (
    repositoryRoot: string,
    id: string,
  ) => Effect.Effect<ExtensionPackage, ProfileExtensionError>;
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

export class Profiles extends Context.Service<Profiles, ProfilesShape>()("ziggy/Profiles") {}

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

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const hasPathSyntax = (value: string): boolean =>
  value.includes("/") ||
  value.includes("\\") ||
  value.startsWith(".") ||
  value.startsWith("~") ||
  value.startsWith("/");

const readDirectory = (directoryPath: string) =>
  Effect.tryPromise({
    try: () => readdir(directoryPath, { withFileTypes: true }),
    catch: (cause) => fileSystemError("list", directoryPath, cause),
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed([]),
    ),
  );

const hasDirectSkillFile = (directoryPath: string) =>
  lstatPath(path.join(directoryPath, "SKILL.md")).pipe(
    Effect.map((status) => status.isFile()),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(false),
    ),
  );

const addSkillDirectories = (
  catalog: Map<string, string>,
  directoryPath: string,
  replace: boolean,
) =>
  Effect.gen(function* () {
    const entries = (yield* readDirectory(directoryPath)).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) {
        continue;
      }
      const skillPath = path.join(directoryPath, entry.name);
      if (!(yield* hasDirectSkillFile(skillPath))) {
        continue;
      }
      if (replace || !catalog.has(entry.name)) {
        catalog.set(entry.name, skillPath);
      }
    }
  });

const repositorySkillCatalog = (repositoryRoot: string) =>
  Effect.gen(function* () {
    const catalog = new Map<string, string>();
    const extensionsDirectory = path.join(repositoryRoot, "extensions");
    const extensions = (yield* readDirectory(extensionsDirectory))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const extension of extensions) {
      yield* addSkillDirectories(
        catalog,
        path.join(extensionsDirectory, extension.name, "skills"),
        false,
      );
    }
    yield* addSkillDirectories(catalog, path.join(repositoryRoot, "skills"), false);
    return catalog;
  });

const verifyInitializedProfile = (target: ProfileTarget) =>
  lstatPath(path.join(target.path, "SOUL.md")).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.void
        : new ProfileSkillInvalid({
            path: target.path,
            message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
          }),
    ),
    Effect.catchTag("ProfileFileSystemError", (error) =>
      Effect.fail(
        error.code === "ENOENT"
          ? new ProfileSkillInvalid({
              path: target.path,
              message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
            })
          : error,
      ),
    ),
  );

const inspectSkillTree = (sourcePath: string): Effect.Effect<void, ProfileSkillError> =>
  Effect.gen(function* () {
    const entries = yield* readDirectory(sourcePath);
    for (const entry of entries) {
      const entryPath = path.join(sourcePath, entry.name);
      const status = yield* lstatPath(entryPath);
      if (status.isSymbolicLink()) {
        return yield* new ProfileSkillInvalid({
          path: entryPath,
          message: `skill source contains a symbolic link: ${entryPath}`,
        });
      }
      if (status.isDirectory()) {
        yield* inspectSkillTree(entryPath);
        continue;
      }
      if (!status.isFile()) {
        return yield* new ProfileSkillInvalid({
          path: entryPath,
          message: `skill source contains an unsupported entry: ${entryPath}`,
        });
      }
    }
  });

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

const listInstalledSkills = (target: ProfileTarget) =>
  Effect.gen(function* () {
    const skillsDirectory = path.join(target.path, "skills");
    const entries = yield* readDirectory(skillsDirectory);
    const installed = yield* Effect.forEach(
      entries
        .filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name)),
      (entry) =>
        hasDirectSkillFile(path.join(skillsDirectory, entry.name)).pipe(
          Effect.map((valid) =>
            valid
              ? {
                  id: entry.name,
                  path: path.join(skillsDirectory, entry.name),
                }
              : undefined,
          ),
        ),
    );
    return installed.flatMap((skill) => (skill === undefined ? [] : [skill]));
  });

const listSkills = (
  target: ProfileTarget,
  repositoryRoot: string,
): Effect.Effect<ProfileSkills, ProfileSkillError> =>
  Effect.gen(function* () {
    yield* verifyInitializedProfile(target);
    const catalog = yield* repositorySkillCatalog(repositoryRoot);
    const installed = yield* listInstalledSkills(target);
    return {
      installed,
      available: [...catalog.entries()]
        .map(([id, skillPath]) => ({ id, path: skillPath }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  });

const resolveSkillSource = (
  repositoryRoot: string,
  source: string,
  cwd: string,
): Effect.Effect<{ readonly id: string; readonly sourcePath: string }, ProfileSkillError> =>
  Effect.gen(function* () {
    if (!hasPathSyntax(source)) {
      if (!SKILL_ID.test(source)) {
        return yield* new ProfileSkillInvalid({
          path: source,
          message: `invalid skill ID '${source}'; use lowercase letters, numbers, and hyphens`,
        });
      }
      const catalog = yield* repositorySkillCatalog(repositoryRoot);
      const sourcePath = catalog.get(source);
      if (sourcePath === undefined) {
        return yield* new ProfileSkillNotFound({
          source,
          message: `skill '${source}' was not found in ${repositoryRoot}`,
        });
      }
      return { id: source, sourcePath };
    }

    const sourcePath = path.resolve(cwd, source);
    const id = path.basename(sourcePath);
    if (!SKILL_ID.test(id)) {
      return yield* new ProfileSkillInvalid({
        path: sourcePath,
        message: `invalid skill ID '${id}'; use lowercase letters, numbers, and hyphens`,
      });
    }
    return { id, sourcePath };
  });

const validateSkillSource = (sourcePath: string): Effect.Effect<void, ProfileSkillError> =>
  Effect.gen(function* () {
    const sourceStatus = yield* lstatPath(sourcePath).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () =>
          new ProfileSkillNotFound({
            source: sourcePath,
            message: `skill source does not exist: ${sourcePath}`,
          }),
      ),
    );
    if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
      return yield* new ProfileSkillInvalid({
        path: sourcePath,
        message: `skill source is not a regular directory: ${sourcePath}`,
      });
    }

    const skillFile = path.join(sourcePath, "SKILL.md");
    const skillStatus = yield* lstatPath(skillFile).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () =>
          new ProfileSkillInvalid({
            path: skillFile,
            message: `skill source is missing a direct SKILL.md: ${sourcePath}`,
          }),
      ),
    );
    if (!skillStatus.isFile() || skillStatus.isSymbolicLink()) {
      return yield* new ProfileSkillInvalid({
        path: skillFile,
        message: `skill source requires a regular direct SKILL.md: ${sourcePath}`,
      });
    }
    yield* inspectSkillTree(sourcePath);
  });

const copySkill = (
  sourcePath: string,
  destinationPath: string,
  force: boolean,
): Effect.Effect<boolean, ProfileSkillError> =>
  Effect.gen(function* () {
    const destinationExists = yield* pathExists(destinationPath);
    if (destinationExists && !force) {
      return yield* new ProfileSkillExists({
        path: destinationPath,
        message: `skill is already installed at ${destinationPath}; pass --force to replace it`,
      });
    }

    const skillsDirectory = path.dirname(destinationPath);
    yield* Effect.tryPromise({
      try: () => mkdir(skillsDirectory, { recursive: true }),
      catch: (cause) => fileSystemError("create directory", skillsDirectory, cause),
    });

    const suffix = randomUUID();
    const stagingPath = path.join(
      skillsDirectory,
      `.${path.basename(destinationPath)}-stage-${suffix}`,
    );
    const backupPath = path.join(
      skillsDirectory,
      `.${path.basename(destinationPath)}-backup-${suffix}`,
    );
    const copyToStaging = Effect.tryPromise({
      try: () =>
        cp(sourcePath, stagingPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        }),
      catch: (cause) => fileSystemError("stage skill", stagingPath, cause),
    });
    const renameSkill = (from: string, to: string) =>
      Effect.tryPromise({
        try: () => rename(from, to),
        catch: (cause) => fileSystemError("rename", to, cause),
      });
    const removeTree = (treePath: string) =>
      Effect.tryPromise({
        try: () => rm(treePath, { recursive: true, force: true }),
        catch: (cause) => fileSystemError("remove", treePath, cause),
      });

    const install = Effect.gen(function* () {
      yield* copyToStaging;
      if (!destinationExists) {
        yield* renameSkill(stagingPath, destinationPath);
        return;
      }

      yield* renameSkill(destinationPath, backupPath);
      yield* renameSkill(stagingPath, destinationPath).pipe(
        Effect.catch((promotionError) =>
          renameSkill(backupPath, destinationPath).pipe(
            Effect.catch(() => Effect.fail(promotionError)),
            Effect.andThen(Effect.fail(promotionError)),
          ),
        ),
      );
      yield* removeTree(backupPath);
    });
    yield* install.pipe(
      Effect.ensuring(removeTree(stagingPath).pipe(Effect.catch(() => Effect.void))),
    );
    return destinationExists;
  });

const addSkill = (
  target: ProfileTarget,
  repositoryRoot: string,
  source: string,
  cwd: string,
  force: boolean,
): Effect.Effect<InstalledSkill, ProfileSkillError> =>
  Effect.gen(function* () {
    yield* verifyInitializedProfile(target);
    const resolved = yield* resolveSkillSource(repositoryRoot, source, cwd);
    yield* validateSkillSource(resolved.sourcePath);
    const destinationPath = path.join(target.path, "skills", resolved.id);
    const replaced = yield* copySkill(resolved.sourcePath, destinationPath, force);
    return {
      id: resolved.id,
      sourcePath: resolved.sourcePath,
      destinationPath,
      replaced,
    };
  });

const listExtensions = (repositoryRoot: string) => scanExtensionShelf(repositoryRoot);

const showExtension = (
  repositoryRoot: string,
  id: string,
): Effect.Effect<ExtensionPackage, ProfileExtensionError> =>
  Effect.gen(function* () {
    const shelf = yield* scanExtensionShelf(repositoryRoot);
    const extension = shelf.find((item) => item.id === id);
    return extension === undefined
      ? yield* new ProfileExtensionInvalid({
          path: path.join(repositoryRoot, "extensions", id),
          message: `unknown extension '${id}'`,
          cause: undefined,
        })
      : extension;
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
    const extension = yield* readExtensionPackage(repositoryRoot, id);
    if (extension.required) {
      return yield* new ProfileExtensionInvalid({
        path: extension.packagePath,
        message: "required extension 'pi-packages' cannot be added or removed",
        cause: undefined,
      });
    }
    const current = yield* readExtensionSelection(target.path);
    yield* Effect.forEach(current, (selectedId) =>
      readExtensionPackage(repositoryRoot, selectedId),
    );
    const alreadySelected = current.includes(id);
    if (alreadySelected === selected) {
      return { id, profilePath: target.path, changed: false, selected };
    }
    const next = selected ? [...current, id].sort() : current.filter((item) => item !== id);
    yield* replaceExtensionSelection(target.path, next);
    return { id, profilePath: target.path, changed: true, selected };
  });

export const ProfilesLive = Layer.succeed(Profiles, {
  initProfile,
  registerProfile,
  listProfiles,
  listSkills,
  addSkill,
  listExtensions,
  showExtension,
  addExtension: (target, repositoryRoot, id) =>
    mutateExtension(target, repositoryRoot, id, true),
  removeExtension: (target, repositoryRoot, id) =>
    mutateExtension(target, repositoryRoot, id, false),
});
