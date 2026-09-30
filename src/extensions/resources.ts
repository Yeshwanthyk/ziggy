import { rename } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import type { ProfileExtensionInvalid } from "../domain/profile";
import type { ProfileFileSystemError } from "../profile";
import { requiredPackages } from "./bundled";
import { fsError, invalid, packageExists, readExtensionPackage } from "./package";
import { readSelection } from "./selection";

/** The files Pi loads for one Profile, plus which optional package owns which folder. */
export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
  readonly optional: ReadonlyArray<{ readonly id: string; readonly packagePath: string }>;
}

/**
 * An update moves `<id>` to `<id>.old`, then the staged copy to `<id>`. If it stopped between the two
 * renames, only `<id>.old` is left; put it back so the Profile opens as before the update.
 */
const recoverInterruptedUpdate = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    if (yield* packageExists(profilePath, id)) return;

    const packagePath = path.join(profilePath, "extensions", id);
    const previous = `${packagePath}.old`;

    if (!(yield* packageExists(profilePath, `${id}.old`))) return;

    yield* Effect.logWarning("restoring extension left behind by an interrupted update", {
      profilePath,
      id,
    });
    yield* Effect.tryPromise({
      try: () => rename(previous, packagePath),
      catch: (cause) => fsError("rename", previous, cause),
    });
  });

const readSelected = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    yield* recoverInterruptedUpdate(profilePath, id);

    if (!(yield* packageExists(profilePath, id))) {
      const packagePath = path.join(profilePath, "extensions", id);

      return yield* invalid(
        packagePath,
        `selected extension '${id}' is not installed at ${packagePath}`,
      );
    }

    return yield* readExtensionPackage(profilePath, id);
  });

/** Resolve the packages Pi should load for `selected`: the Profile's own, then required. */
export const resolveResources = (
  profilePath: string,
  selected: ReadonlyArray<string>,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const packages = yield* Effect.forEach([...selected].sort(), (id) =>
      readSelected(profilePath, id),
    );

    const required = yield* requiredPackages;

    return {
      extensionPaths: packages.flatMap((item) =>
        item.extensionPaths.length > 0 ? [item.packagePath] : [],
      ),
      skillPaths: [
        ...packages.flatMap((item) => item.skillPaths),
        ...required.flatMap((item) => item.skillPaths),
      ],
      optional: packages.map((item) => ({ id: item.id, packagePath: item.packagePath })),
    };
  });

/** Resolve the packages the Profile's `extensions.json` selects. */
export const profileResources = (
  profilePath: string,
): Effect.Effect<PiResources, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.flatMap(readSelection(profilePath), (selected) => resolveResources(profilePath, selected));
