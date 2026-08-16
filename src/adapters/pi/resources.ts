import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  APPROVED_BUNDLED_EXTENSION_IDS,
  BUILTIN_PACKAGE_METADATA,
  REQUIRED_BUNDLED_EXTENSION_IDS,
} from "../../catalog";
import { ProfileExtensionInvalid, ProfileFileSystemError } from "../../domain/profile";
import { fileSystemCauseDetails } from "../fs/cause";
import {
  bundledExtensionPackage,
  readExtensionPackage,
  readExtensionSelection,
} from "../fs/profile-extensions";
import { bundledFilePath } from "../../generated/builtin-files";

export interface BundledExtensionFactory {
  readonly name: string;
  readonly factory: ExtensionFactory;
}

export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
  readonly extensionFactories: ReadonlyArray<BundledExtensionFactory>;
}

const embeddedBundledSkillPaths = new Set<string>();
for (const packageInfo of BUILTIN_PACKAGE_METADATA) {
  if (!packageInfo.required) continue;
  for (const skill of packageInfo.skills) {
    const embeddedPath = bundledFilePath(skill.logicalPath);
    if (embeddedPath !== undefined) embeddedBundledSkillPaths.add(embeddedPath);
  }
}

/** Embedded bundled files keep a .embed suffix, although their contents are trusted Markdown. */
export const isEmbeddedBundledSkillPath = (skillPath: string): boolean =>
  embeddedBundledSkillPaths.has(skillPath);

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

/** Compose the exact Pi resource set for an explicit candidate selection. */
export const composePiResources = (
  profilePath: string,
  selectedIds: ReadonlyArray<string>,
  approvedRepositoryIds: ReadonlySet<string> = APPROVED_BUNDLED_EXTENSION_IDS,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const selected = yield* Effect.forEach([...selectedIds].sort(), (id) =>
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
    const required = yield* Effect.forEach([...REQUIRED_BUNDLED_EXTENSION_IDS], (id) =>
      readRequiredPackage(profilePath, id).pipe(
        Effect.flatMap((onDisk) =>
          onDisk === undefined ? bundledExtensionPackage(id) : Effect.succeed(onDisk),
        ),
      ),
    );
    return {
      extensionPaths: selected.flatMap((item) =>
        item.extensionPaths.length > 0 ? [item.packagePath] : [],
      ),
      skillPaths: [
        ...selected.flatMap((item) => item.skillPaths),
        ...required.flatMap((item) => item.skillPaths),
      ],
      extensionFactories: [],
    };
  });

export const discoverPiResources = (
  profilePath: string,
  _repositoryRoot: string,
  approvedRepositoryIds: ReadonlySet<string> = APPROVED_BUNDLED_EXTENSION_IDS,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  readExtensionSelection(profilePath).pipe(
    Effect.flatMap((selected) => composePiResources(profilePath, selected, approvedRepositoryIds)),
  );
