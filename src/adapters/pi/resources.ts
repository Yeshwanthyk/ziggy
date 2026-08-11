import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";
import {
  readExtensionPackage,
  readExtensionSelection,
  readSelectedExtensionPackage,
} from "../fs/profile-extensions";
import { ProfileExtensionInvalid, ProfileFileSystemError } from "../../domain/profile";
import { fileSystemCauseDetails } from "../fs/cause";
import { APPROVED_BUNDLED_EXTENSION_IDS } from "../../catalog";

export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
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

const requiredFile = (filePath: string) =>
  inspectPath(filePath).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () =>
        Effect.fail(
          new ProfileExtensionInvalid({
            path: filePath,
            message: `required skill does not exist: ${filePath}`,
            cause: undefined,
          }),
        ),
    ),
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.succeed(filePath)
        : Effect.fail(
            new ProfileExtensionInvalid({
              path: filePath,
              message: `required skill has the wrong type: ${filePath}`,
              cause: undefined,
            }),
          ),
    ),
  );

export const discoverPiResources = (
  profilePath: string,
  repositoryRoot: string,
  approvedRepositoryIds: ReadonlySet<string> = APPROVED_BUNDLED_EXTENSION_IDS,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const selectedIds = yield* readExtensionSelection(profilePath);
    const required = yield* readExtensionPackage(repositoryRoot, "pi-packages");
    const selected = yield* Effect.forEach(selectedIds, (id) =>
      readSelectedExtensionPackage(profilePath, repositoryRoot, id, approvedRepositoryIds),
    );
    const profileExtensionsPath = join(profilePath, "extensions");
    const isProfileOwned = (packagePath: string) => {
      const fromProfileShelf = relative(profileExtensionsPath, packagePath);
      return fromProfileShelf !== ".." && !fromProfileShelf.startsWith(`..${sep}`);
    };
    const profileOwned = selected.filter((item) => isProfileOwned(item.packagePath));
    const catalogue = selected.filter((item) => !isProfileOwned(item.packagePath));
    const profileSkills = yield* existingDirectory(join(profilePath, "skills"));
    const extensionAuthoringSkill = yield* requiredFile(
      join(repositoryRoot, "skills", "extension-authoring", "SKILL.md"),
    );
    return {
      extensionPaths: [...profileOwned, required, ...catalogue].flatMap(
        (item) => item.extensionPaths,
      ),
      skillPaths: [
        ...(profileSkills === undefined ? [] : [profileSkills]),
        ...profileOwned.flatMap((item) => item.skillPaths),
        ...required.skillPaths,
        extensionAuthoringSkill,
        ...catalogue.flatMap((item) => item.skillPaths),
      ],
    };
  });
