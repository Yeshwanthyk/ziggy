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
  readExtensionPackage,
  readExtensionSelection,
} from "../fs/profile-extensions";

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
      () => Effect.succeed(undefined),
    ),
  );

const requiredBundledSkill = (
  logicalPath: string,
): Effect.Effect<string, ProfileExtensionInvalid> => {
  const filePath = bundledFilePath(logicalPath);
  if (filePath === undefined) {
    return Effect.fail(
      new ProfileExtensionInvalid({
        path: logicalPath,
        message: `required skill does not exist: ${logicalPath}`,
        cause: undefined,
      }),
    );
  }
  return Effect.succeed(filePath);
};

const missingSelected = (profilePath: string, id: string) =>
  new ProfileExtensionInvalid({
    path: join(profilePath, "extensions", id),
    message: `selected extension '${id}' is not installed at ${join(profilePath, "extensions", id)}`,
    cause: undefined,
  });

const readRequiredPackage = (profilePath: string, id: string) =>
  existingDirectory(join(profilePath, "extensions", id)).pipe(
    Effect.flatMap((directory) =>
      directory === undefined ? Effect.succeed(undefined) : readExtensionPackage(profilePath, id),
    ),
  );

export const discoverPiResources = (
  profilePath: string,
  _repositoryRoot: string,
  approvedRepositoryIds: ReadonlySet<string> = APPROVED_BUNDLED_EXTENSION_IDS,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const selectedIds = yield* readExtensionSelection(profilePath);
    const selected = yield* Effect.forEach(selectedIds, (id) =>
      existingDirectory(join(profilePath, "extensions", id)).pipe(
        Effect.flatMap((directory) => {
          if (directory !== undefined) return readExtensionPackage(profilePath, id);
          return approvedRepositoryIds.has(id)
            ? Effect.fail(missingSelected(profilePath, id))
            : Effect.fail(
                new ProfileExtensionInvalid({
                  path: join(profilePath, "extensions.json"),
                  message: `selected extension '${id}' is neither approved nor Profile-local`,
                  cause: undefined,
                }),
              );
        }),
      ),
    );
    const requiredOnDisk = yield* readRequiredPackage(profilePath, "pi-packages");
    const required =
      requiredOnDisk === undefined ? yield* bundledExtensionPackage("pi-packages") : requiredOnDisk;
    const coreSkills = yield* Effect.forEach(BUILTIN_CORE_SKILLS, (skill) =>
      readRequiredPackage(profilePath, skill.id).pipe(
        Effect.flatMap((installed) =>
          installed === undefined
            ? requiredBundledSkill(skill.logicalPath).pipe(Effect.map((path) => [path]))
            : Effect.succeed([...installed.skillPaths]),
        ),
      ),
    );
    return {
      extensionPaths: selected.flatMap((item) =>
        item.extensionPaths.length > 0 ? [item.packagePath] : [],
      ),
      skillPaths: [
        ...selected.flatMap((item) => item.skillPaths),
        ...required.skillPaths,
        ...coreSkills.flat(),
      ],
      extensionFactories: [],
    };
  });
