import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  readExtensionSelection,
  scanExtensionShelf,
} from "../fs/profile-extensions";
import { ProfileExtensionInvalid, ProfileFileSystemError } from "../../domain/profile";
import { fileSystemCauseDetails } from "../fs/cause";

export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
}

const existingDirectory = (directoryPath: string) =>
  Effect.tryPromise({
    try: () => stat(directoryPath),
    catch: (cause) => {
      const details = fileSystemCauseDetails(cause);
      return new ProfileFileSystemError({
        operation: "inspect",
        path: directoryPath,
        message: details.message,
        code: details.code,
      });
    },
  }).pipe(
    Effect.map((status) => (status.isDirectory() ? directoryPath : undefined)),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(undefined),
    ),
  );

export const discoverPiResources = (
  profilePath: string,
  repositoryRoot: string,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const shelf = yield* scanExtensionShelf(repositoryRoot);
    const selectedIds = yield* readExtensionSelection(profilePath, shelf);
    const selected = shelf.filter((item) => selectedIds.includes(item.id));
    const required = shelf.find((item) => item.id === "pi-packages");
    if (required === undefined) {
      return yield* new ProfileExtensionInvalid({
        path: join(repositoryRoot, "extensions", "pi-packages"),
        message: "required extension 'pi-packages' is absent from the shelf",
        cause: undefined,
      });
    }
    const profileSkills = yield* existingDirectory(join(profilePath, "skills"));
    return {
      extensionPaths: [required, ...selected].flatMap((item) => item.extensionPaths),
      skillPaths: [
        ...(profileSkills === undefined ? [] : [profileSkills]),
        ...required.skillPaths,
        join(repositoryRoot, "skills", "extension-authoring", "SKILL.md"),
        ...selected.flatMap((item) => item.skillPaths),
      ],
    };
  });
