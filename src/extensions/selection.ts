import { unlink } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { isRequiredBundledExtension } from "../catalog";
import type { ProfileExtensionInvalid } from "../domain/profile";
import { writeFileAtomic } from "../platform/atomic-write";
import { withFileLock } from "../platform/file-lock";
import { readPhysicalFile } from "../platform/tree";
import type { ProfileFileSystemError } from "../profile";
import { fsError, invalid } from "./package";
import { ExtensionId, ExtensionLockFailed } from "./types";

const Selection = Schema.Struct({ extensions: Schema.Array(ExtensionId) });

const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(Selection));

const selectionPath = (profilePath: string) => path.join(profilePath, "extensions.json");

/** The decoded selection plus the exact text, so a failed change can put the file back. */
export interface SelectionSnapshot {
  readonly exists: boolean;
  readonly text: string;
  readonly selected: ReadonlyArray<string>;
}

const decode = (
  file: string,
  text: string,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid> =>
  decodeSelection(text, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => invalid(file, `invalid extension selection: ${file}`, cause)),
    Effect.flatMap(({ extensions }) => {
      const reserved = extensions.find(isRequiredBundledExtension);

      if (new Set(extensions).size !== extensions.length) {
        return Effect.fail(invalid(file, "extension selection contains duplicate IDs"));
      }

      return reserved === undefined
        ? Effect.succeed([...extensions].sort())
        : Effect.fail(
            invalid(file, `extension selection cannot include reserved ID '${reserved}'`),
          );
    }),
  );

export const snapshotSelection = (
  profilePath: string,
): Effect.Effect<SelectionSnapshot, ProfileExtensionInvalid | ProfileFileSystemError> => {
  const file = selectionPath(profilePath);

  return readPhysicalFile(file).pipe(
    Effect.mapError((failure) =>
      failure.refused
        ? invalid(file, "extension selection must be a physical file", failure)
        : fsError("read", file, failure.cause),
    ),
    Effect.flatMap((bytes) => {
      if (bytes === undefined) {
        return Effect.succeed<SelectionSnapshot>({ exists: false, text: "", selected: [] });
      }

      const text = Buffer.from(bytes).toString("utf8");

      return Effect.map(decode(file, text), (selected) => ({ exists: true, text, selected }));
    }),
  );
};

/** The ids in `extensions.json`, sorted; a missing file selects nothing. */
export const readSelection = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<string>, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.map(snapshotSelection(profilePath), (snapshot) => snapshot.selected);

const writeText = (profilePath: string, text: string) => {
  const file = selectionPath(profilePath);

  return writeFileAtomic(file, text).pipe(
    Effect.mapError((failure) => fsError("write", file, failure.cause)),
  );
};

export const writeSelection = (
  profilePath: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<void, ProfileFileSystemError> =>
  writeText(profilePath, `${JSON.stringify({ extensions: [...ids].sort() }, null, 2)}\n`);

/** Put `extensions.json` back to exactly what the snapshot saw, including absence. */
export const restoreSelection = (
  profilePath: string,
  snapshot: SelectionSnapshot,
): Effect.Effect<void, ProfileFileSystemError> => {
  if (snapshot.exists) return writeText(profilePath, snapshot.text);

  const file = selectionPath(profilePath);

  return Effect.tryPromise({
    try: () => unlink(file),
    catch: (cause) => fsError("remove", file, cause),
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.void,
    ),
  );
};

/** Serialize extension changes to one Profile across processes. */
export const withSelectionLock = <A, E, R>(
  profilePath: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ExtensionLockFailed, R> =>
  withFileLock(
    { root: profilePath, file: ".runtime/profile-extensions.sqlite", waitMs: 2000 },
    use,
    (failure) =>
      new ExtensionLockFailed({
        profilePath,
        message: {
          prepare: `could not prepare the Profile runtime directory at ${path.join(profilePath, ".runtime")}`,
          open: "could not open the Profile extension lock",
          held: "Profile extension mutation lock timed out after 2000 milliseconds",
        }[failure.reason],
        cause: failure,
      }),
  );
