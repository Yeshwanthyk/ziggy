import { rename } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import type { ProfileExtensionInvalid } from "../domain/profile";
import type { ProfileFileSystemError } from "../profile";
import { requiredPackages } from "./bundled";
import { fsError, invalid, packageExists, readExtensionPackage } from "./package";
import { readSelection, withSelectionLock } from "./selection";

/** The files Pi loads for one Profile, plus which optional package owns which folder. */
export interface PiResources {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
  readonly optional: ReadonlyArray<{ readonly id: string; readonly packagePath: string }>;
}

const interrupted = (profilePath: string, id: string) =>
  Effect.map(
    Effect.all([packageExists(profilePath, id), packageExists(profilePath, `${id}.old`)]),
    ([current, previous]) => !current && previous,
  );

/**
 * An update moves `<id>` to `<id>.old`, then the staged copy to `<id>`. If it stopped between the two
 * renames, only `<id>.old` is left; put it back so the Profile opens as before the update.
 * Callers hold the selection lock.
 */
export const recoverInterruptedUpdate = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    if (!(yield* interrupted(profilePath, id))) return;

    const packagePath = path.join(profilePath, "extensions", id);
    const previous = `${packagePath}.old`;

    yield* Effect.logWarning("restoring extension left behind by an interrupted update", {
      profilePath,
      id,
    });
    yield* Effect.tryPromise({
      try: () => rename(previous, packagePath),
      catch: (cause) => fsError("rename", previous, cause),
    });
  });

/** Read-only: a selected package must be on the shelf; an interrupted update is only reported. */
const readSelected = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    if (!(yield* packageExists(profilePath, id))) {
      const packagePath = path.join(profilePath, "extensions", id);

      return yield* invalid(
        packagePath,
        (yield* interrupted(profilePath, id))
          ? `selected extension '${id}' was left at ${packagePath}.old by an interrupted update; the next session open restores it`
          : `selected extension '${id}' is not installed at ${packagePath}`,
      );
    }

    return yield* readExtensionPackage(profilePath, id);
  });

/** Session open repairs an interrupted update, under the lock so it never races one in flight. */
const recoverUnderLock = (profilePath: string, id: string) =>
  Effect.flatMap(interrupted(profilePath, id), (found) =>
    found
      ? withSelectionLock(profilePath, recoverInterruptedUpdate(profilePath, id)).pipe(
          Effect.catchTag("ExtensionLockFailed", (failure) =>
            Effect.fail(
              invalid(
                path.join(profilePath, "extensions", id),
                `could not restore '${id}' after an interrupted update: ${failure.message}`,
                failure,
              ),
            ),
          ),
        )
      : Effect.void,
  );

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
  Effect.gen(function* () {
    const selected = yield* readSelection(profilePath);

    yield* Effect.forEach(selected, (id) => recoverUnderLock(profilePath, id), { discard: true });

    return yield* resolveResources(profilePath, selected);
  });
