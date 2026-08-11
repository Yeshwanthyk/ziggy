import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { ZiggyUpdateUnavailable } from "../../domain/extension-catalog";

export type SelfUpdateInstaller = (
  targetPath: string,
  executable: Uint8Array,
  sha256: string,
) => Effect.Effect<void, ZiggyUpdateUnavailable>;

export const installSelfUpdate: SelfUpdateInstaller = (targetPath, executable, sha256) =>
  Effect.gen(function* () {
    const status = yield* Effect.tryPromise({
      try: () => lstat(targetPath),
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ZiggyUpdateUnavailable({ message: "could not inspect Ziggy executable", cause }),
      ),
    );
    if (!status.isFile() || status.isSymbolicLink()) {
      return yield* Effect.fail(
        new ZiggyUpdateUnavailable({
          message: "refusing to update a non-regular or symlinked Ziggy executable",
          cause: undefined,
        }),
      );
    }
    if (createHash("sha256").update(executable).digest("hex") !== sha256) {
      return yield* Effect.fail(
        new ZiggyUpdateUnavailable({ message: "Ziggy update checksum mismatch", cause: undefined }),
      );
    }
    const stagingRoot = yield* Effect.tryPromise({
      try: () => mkdtemp(path.join(path.dirname(targetPath), ".ziggy-update-")),
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ZiggyUpdateUnavailable({
            message: "could not create update staging directory",
            cause,
          }),
      ),
    );
    const stagingPath = path.join(stagingRoot, path.basename(targetPath));
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(stagingPath, executable, { mode: status.mode & 0o777 });
        await chmod(stagingPath, status.mode & 0o777);
        await rename(stagingPath, targetPath);
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ZiggyUpdateUnavailable({
            message: "could not atomically install Ziggy update",
            cause,
          }),
      ),
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(stagingRoot, { recursive: true, force: true }),
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  }).pipe(Effect.asVoid);
