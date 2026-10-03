import { mkdir, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { inspectGatewayOwner } from "../adapters/bun/gateway-owner";
import { bundledPackageMetadata, isRequiredBundledExtension } from "../catalog";
import { writeFileAtomic } from "../platform/atomic-write";
import { fileSystemCauseDetails } from "../platform/cause";
import { hashTree } from "../platform/tree";
import type { ProfileTarget } from "../profile";
import { withStagedBundle } from "./bundled";
import { checkSelection } from "./loader";
import { packageExists, readExtensionPackage } from "./package";
import { recoverInterruptedUpdate } from "./resources";
import { withSelectionLock } from "./selection";
import {
  ExtensionId,
  ExtensionUpdateError,
  type ExtensionError,
  type ExtensionPackage,
  type ExtensionUpdateResult,
} from "./types";

/** Which bundled version a Profile copy came from, and the exact bytes it was. */
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: ExtensionId,
  source: Schema.Literal("bundled"),
  packageVersion: Schema.String,
  contentHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

type Receipt = typeof Receipt.Type;

const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));

const receiptPath = (profilePath: string, id: string) =>
  path.join(profilePath, ".runtime", "extension-updates", id, "receipt.json");

const refuse = (
  profilePath: string,
  id: string,
  reason: ExtensionUpdateError["reason"],
  message: string,
  cause?: unknown,
) => new ExtensionUpdateError({ profilePath, id, reason, message, cause });

const disk = <A>(profilePath: string, id: string, message: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => refuse(profilePath, id, "filesystem", message, cause),
  });

const readReceipt = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    const file = receiptPath(profilePath, id);

    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        fileSystemCauseDetails(cause).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(refuse(profilePath, id, "filesystem", `could not read ${file}`, cause)),
      ),
    );

    if (text === undefined) return undefined;

    const receipt = yield* decodeReceipt(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        refuse(profilePath, id, "filesystem", `extension receipt ${file} is invalid`, cause),
      ),
    );

    if (receipt.id !== id) {
      return yield* refuse(
        profilePath,
        id,
        "filesystem",
        `extension receipt ${file} names another package`,
      );
    }

    return receipt;
  });

const writeReceipt = (profilePath: string, receipt: Receipt) => {
  const file = receiptPath(profilePath, receipt.id);

  return disk(profilePath, receipt.id, `could not write ${file}`, () =>
    mkdir(path.dirname(file), { recursive: true }),
  ).pipe(
    Effect.andThen(writeFileAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`)),
    Effect.catchTag("AtomicWriteFailed", (cause) =>
      Effect.fail(refuse(profilePath, receipt.id, "filesystem", `could not write ${file}`, cause)),
    ),
  );
};

const hash = (profilePath: string, id: string, root: string) =>
  hashTree(root).pipe(
    Effect.mapError((failure) =>
      refuse(profilePath, id, "filesystem", `could not hash ${root}: ${failure.message}`, failure),
    ),
  );

/** Record that the Profile copy of bundled `id` is exactly this build's version. */
export const recordBundledCopy = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    const metadata = bundledPackageMetadata(id);

    if (metadata === undefined) return;

    yield* writeReceipt(profilePath, {
      version: 1,
      id,
      source: "bundled",
      packageVersion: metadata.version,
      contentHash: yield* hash(profilePath, id, path.join(profilePath, "extensions", id)),
    });
  });

const automationSources = (profilePath: string, item: ExtensionPackage) =>
  Effect.forEach(item.automations, (automation) =>
    disk(profilePath, item.id, `could not read ${automation.path}`, () =>
      readFile(automation.path, "utf8"),
    ).pipe(Effect.map((source) => `${automation.id}\n${source}`)),
  ).pipe(Effect.map((sources) => sources.toSorted().join("\n\0\n")));

const requireStopped = (target: ProfileTarget, id: string) =>
  inspectGatewayOwner(target).pipe(
    Effect.mapError((cause) =>
      refuse(
        target.path,
        id,
        "resident",
        "could not tell whether the Profile resident is running",
        cause,
      ),
    ),
    Effect.flatMap((owner) =>
      owner._tag === "running"
        ? Effect.fail(
            refuse(
              target.path,
              id,
              "resident",
              "Stop the Profile resident before updating extensions, or use --restart.",
            ),
          )
        : Effect.void,
    ),
  );

/**
 * Replace the Profile copy of bundled `id` with this build's version. The copy must be the
 * exact bytes its receipt names; an untracked copy is taken over only with `adopt`. The new
 * version is staged and loaded through Pi first, then swapped in by two renames through
 * `<id>.old`. A crash between them leaves only `<id>.old`, which the next open restores.
 */
export const updateBundled = (
  target: ProfileTarget,
  id: string,
  options: { readonly adopt: boolean },
): Effect.Effect<ExtensionUpdateResult, ExtensionUpdateError | ExtensionError> =>
  Effect.gen(function* () {
    const metadata = bundledPackageMetadata(id);

    if (metadata === undefined || isRequiredBundledExtension(id)) {
      return yield* refuse(
        target.path,
        id,
        "unsupported",
        metadata === undefined
          ? `'${id}' is not a bundled extension; only bundled copies can be updated`
          : `'${id}' is required; it is read from Ziggy's own cache and updates with Ziggy`,
      );
    }

    return yield* withSelectionLock(
      target.path,
      Effect.gen(function* () {
        yield* requireStopped(target, id);

        const packagePath = path.join(target.path, "extensions", id);
        const previous = `${packagePath}.old`;

        yield* recoverInterruptedUpdate(target.path, id);

        if (!(yield* packageExists(target.path, id))) {
          return yield* refuse(
            target.path,
            id,
            "unsupported",
            `extension '${id}' is not installed at ${packagePath}`,
          );
        }

        // A finished update that crashed before cleaning up leaves `<id>.old` beside `<id>`.
        yield* disk(target.path, id, `could not remove ${previous}`, () =>
          rm(previous, { recursive: true, force: true }),
        );

        const receipt = yield* readReceipt(target.path, id);
        const previousHash = yield* hash(target.path, id, packagePath);

        if (receipt === undefined && !options.adopt) {
          return yield* refuse(
            target.path,
            id,
            "unmanaged",
            "Extension origin is untracked. Use --adopt to explicitly take over these exact files; their previous origin cannot be verified.",
          );
        }

        return yield* withStagedBundle(target.path, id, (staging, staged) =>
          Effect.gen(function* () {
            const stagedPath = path.join(staging, "extensions", id);
            const contentHash = yield* hash(target.path, id, stagedPath);

            const nextReceipt: Receipt = {
              version: 1,
              id,
              source: "bundled",
              packageVersion: metadata.version,
              contentHash,
            };

            // Bytes that already match this build are current even when the receipt lags, so an
            // update that published but failed to record its receipt heals on the next run.
            if (
              receipt !== undefined &&
              receipt.contentHash !== previousHash &&
              contentHash !== previousHash
            ) {
              return yield* refuse(
                target.path,
                id,
                "modified",
                "Installed extension has local changes. Preserve or resolve them before updating; --adopt does not overwrite managed edits.",
              );
            }

            if (contentHash === previousHash) {
              yield* writeReceipt(target.path, nextReceipt);

              return {
                id,
                profilePath: target.path,
                status: receipt === undefined ? "adopted" : "current",
                previousHash,
                contentHash,
              } satisfies ExtensionUpdateResult;
            }

            const current = yield* readExtensionPackage(target.path, id);

            if (
              (yield* automationSources(target.path, current)) !==
              (yield* automationSources(target.path, staged))
            ) {
              return yield* refuse(
                target.path,
                id,
                "automation",
                "This update changes extension-owned automation definitions; that migration is not supported yet.",
              );
            }

            yield* checkSelection(staging, [id], [id]);

            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* disk(target.path, id, `could not move ${packagePath} aside`, () =>
                  rename(packagePath, previous),
                );
                yield* disk(target.path, id, `could not publish ${packagePath}`, () =>
                  rename(stagedPath, packagePath),
                ).pipe(
                  Effect.tapError(() =>
                    disk(target.path, id, `could not restore ${packagePath}`, () =>
                      rename(previous, packagePath),
                    ).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("could not restore extension after a failed update", {
                          cause,
                        }),
                      ),
                    ),
                  ),
                );
                yield* writeReceipt(target.path, nextReceipt).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      "updated extension; could not record its receipt, the next update will",
                      { cause },
                    ),
                  ),
                );
                yield* disk(target.path, id, `could not remove ${previous}`, () =>
                  rm(previous, { recursive: true, force: true }),
                ).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("updated extension; could not remove the old copy", {
                      cause,
                    }),
                  ),
                );
              }),
            );

            return {
              id,
              profilePath: target.path,
              status: "updated",
              previousHash,
              contentHash,
            } satisfies ExtensionUpdateResult;
          }),
        );
      }),
    );
  });
