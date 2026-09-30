import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { fileSystemCauseDetails } from "./cause";

export class AtomicWriteFailed extends Schema.TaggedErrorClass<AtomicWriteFailed>()(
  "AtomicWriteFailed",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const TEMPORARY_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const removeTemporary = (path: string): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => rm(path), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? Effect.void
        : Effect.logWarning("atomic write could not remove its temporary file", { path, cause }),
    ),
  );

/**
 * Replace `path` so readers see the old content or the new content, never a partial file.
 * Writes a private (0600) sibling, syncs it, then renames it over `path`.
 * The parent directory must already exist; callers own its policy.
 */
export const writeFileAtomic = (
  path: string,
  content: string | Uint8Array,
): Effect.Effect<void, AtomicWriteFailed> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

  return Effect.tryPromise({
    try: async () => {
      const handle = await open(temporary, TEMPORARY_FLAGS, 0o600);

      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporary, path);
    },
    catch: (cause) =>
      new AtomicWriteFailed({
        path,
        message: `could not write ${path}: ${fileSystemCauseDetails(cause).message}`,
        cause,
      }),
  }).pipe(Effect.onError(() => removeTemporary(temporary)));
};
