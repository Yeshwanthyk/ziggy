import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { APPROVED_BUNDLED_EXTENSION_IDS, BUILTIN_CORE_SKILLS } from "../../catalog";
import { bundledFilePath } from "../../generated/builtin-files";
import { ProfileExtensionInvalid, ProfileFileSystemError } from "../../domain/profile";
import { fileSystemCauseDetails } from "../fs/cause";
import {
  bundledExtensionPackage,
  readExtensionSelection,
  readSelectedExtensionPackage,
} from "../fs/profile-extensions";
import { builtinFactories } from "./generated/builtin-resources";

export interface BundledExtensionFactory {
  readonly name: string;
  readonly factory: ExtensionFactory;
}

export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
  readonly extensionFactories: ReadonlyArray<BundledExtensionFactory>;
}

const inspectPath = (targetPath: string) =>
  Effect.tryPromise({
    try: () => stat(targetPath),
    catch: (cause) => {
      const details = fileSystemCauseDetails(cause);
      return new ProfileFileSystemError({
        operation: "inspect",
        path: targetPath,
        message: details.message,
        code: details.code,
        cause,
      });
    },
  });

const existingDirectory = (directoryPath: string) =>
  inspectPath(directoryPath).pipe(
    Effect.map((status) => (status.isDirectory() ? directoryPath : undefined)),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.void,
    ),
  );

const requiredBundledSkill = (logicalPath: string) => {
  const filePath = bundledFilePath(logicalPath);
  return filePath === undefined
    ? Effect.fail(
        new ProfileExtensionInvalid({
          path: logicalPath,
          message: `required skill does not exist: ${logicalPath}`,
          cause: undefined,
        }),
      )
    : Effect.succeed(filePath);
};

export const discoverPiResources = (
  profilePath: string,
  repositoryRoot: string,
  approvedRepositoryIds: ReadonlySet<string> = APPROVED_BUNDLED_EXTENSION_IDS,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const selectedIds = yield* readExtensionSelection(profilePath);
    const required = yield* bundledExtensionPackage("pi-packages");
    const selected = yield* Effect.forEach(selectedIds, (id) =>
      readSelectedExtensionPackage(profilePath, repositoryRoot, id, approvedRepositoryIds),
    );
    const profileExtensionsPath = join(profilePath, "extensions");
    const profileOwnedPrefix = `${profileExtensionsPath}/`;
    const isProfileOwned = (packagePath: string) =>
      packagePath === profileExtensionsPath || packagePath.startsWith(profileOwnedPrefix);
    const profileOwned = selected.filter((item) => isProfileOwned(item.packagePath));
    const catalogue = selected.filter((item) => !isProfileOwned(item.packagePath));
    const profileSkills = yield* existingDirectory(join(profilePath, "skills"));
    const coreSkills = yield* Effect.forEach(BUILTIN_CORE_SKILLS, (skill) =>
      requiredBundledSkill(skill.logicalPath),
    );
    const selectedBundledIds = new Set(catalogue.map((item) => item.id));
    return {
      extensionPaths: profileOwned.flatMap((item) => item.extensionPaths),
      skillPaths: [
        ...(profileSkills === undefined ? [] : [profileSkills]),
        ...profileOwned.flatMap((item) => item.skillPaths),
        ...required.skillPaths,
        ...coreSkills,
        ...catalogue.flatMap((item) => item.skillPaths),
      ],
      extensionFactories: builtinFactories.flatMap((entry) =>
        selectedBundledIds.has(entry.id) ? [{ name: entry.id, factory: entry.factory }] : [],
      ),
    };
  });
