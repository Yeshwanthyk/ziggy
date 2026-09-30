import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import {
  BUILTIN_CATALOG_FINGERPRINT,
  REQUIRED_BUNDLED_EXTENSION_IDS,
  bundledPackageMetadata,
} from "../catalog";
import type { ProfileExtensionInvalid } from "../domain/profile";
import { bundledFilePath } from "../generated/builtin-files";
import { readZiggyPaths } from "../platform/paths";
import { copyEmbeddedPackage, inspectTree, type TreeFailed } from "../platform/tree";
import type { ProfileFileSystemError } from "../profile";
import { fsError, invalid, packageExists, readExtensionPackage } from "./package";
import type { ExtensionPackage } from "./types";

const treeError = (failure: TreeFailed) =>
  failure.refused
    ? invalid(failure.path, failure.message, failure)
    : fsError("stage", failure.path, failure.cause);

const disk = <A>(operation: string, target: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => fsError(operation, target, cause) });

const removeStaging = (staging: string) =>
  disk("remove", staging, () => rm(staging, { recursive: true, force: true })).pipe(
    Effect.catch((failure) =>
      Effect.logWarning("could not remove extension staging directory", { failure }),
    ),
  );

/**
 * Copy bundled `id` into a fresh staging folder under `owner`, laid out like a Profile
 * (`<staging>/extensions/<id>`), check it, and hand the staging folder to `use`. The staging
 * folder is removed afterwards, whatever `use` moved out of it.
 */
export const withStagedBundle = <A, E, R>(
  owner: string,
  id: string,
  use: (staging: string, staged: ExtensionPackage) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProfileExtensionInvalid | ProfileFileSystemError, R> =>
  Effect.gen(function* () {
    const metadata = bundledPackageMetadata(id);

    if (metadata === undefined) return yield* invalid(id, `unknown extension '${id}'`);

    const staging = yield* disk("create", owner, () =>
      mkdtemp(path.join(owner, ".extension-stage-")),
    );

    return yield* Effect.gen(function* () {
      yield* copyEmbeddedPackage(
        path.join(staging, "extensions", id),
        metadata.sourcePath,
        metadata.packageFiles,
        bundledFilePath,
      ).pipe(Effect.mapError(treeError));
      yield* inspectTree(path.join(staging, "extensions", id)).pipe(Effect.mapError(treeError));

      return yield* use(staging, yield* readExtensionPackage(staging, id));
    }).pipe(Effect.ensuring(removeStaging(staging)));
  });

/**
 * Write the bundled package `id` to `<owner>/extensions/<id>` unless something is already
 * there. The copy is staged beside the shelf and checked before one rename publishes it,
 * so readers never see half a package. Losing a race to another writer is fine.
 */
export const unpackBundled = (
  owner: string,
  id: string,
): Effect.Effect<ExtensionPackage, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    if (yield* packageExists(owner, id)) return yield* readExtensionPackage(owner, id);

    const shelf = path.join(owner, "extensions");
    const destination = path.join(shelf, id);
    yield* disk("create", shelf, () => mkdir(shelf, { recursive: true }));

    yield* withStagedBundle(owner, id, (staging) =>
      disk("rename", destination, () =>
        rename(path.join(staging, "extensions", id), destination),
      ).pipe(
        Effect.catchIf(
          (error) => error.code === "EEXIST" || error.code === "ENOTEMPTY",
          () => Effect.void,
        ),
      ),
    );

    return yield* readExtensionPackage(owner, id);
  });

/**
 * The shelf that holds this build's required packages, under Ziggy's home and keyed by the
 * catalog fingerprint, so each Ziggy build reads exactly the files it shipped with.
 */
const requiredShelfOwner = readZiggyPaths.pipe(
  Effect.map(({ ziggyHome }) =>
    path.join(ziggyHome, "cache", "extensions", BUILTIN_CATALOG_FINGERPRINT),
  ),
  Effect.mapError((cause) => invalid("ZIGGY_HOME", "could not read ZIGGY_HOME", cause)),
);

/** Every required package, unpacked into the cache on first use. */
export const requiredPackages: Effect.Effect<
  ReadonlyArray<ExtensionPackage>,
  ProfileExtensionInvalid | ProfileFileSystemError
> = Effect.flatMap(requiredShelfOwner, (owner) =>
  Effect.forEach([...REQUIRED_BUNDLED_EXTENSION_IDS].sort(), (id) => unpackBundled(owner, id)),
);
