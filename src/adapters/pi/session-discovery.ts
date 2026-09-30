import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { fileSystemCauseDetails } from "../../platform/cause";

export class SessionFileUnreadable extends Schema.TaggedErrorClass<SessionFileUnreadable>()(
  "SessionFileUnreadable",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String.check(Schema.isMinLength(1)),
  cwd: Schema.String,
});

const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(Header));

const MAX_HEADER_BYTES = 64 * 1024;

/** Read only the first JSONL header, never Pi's repair-capable SessionManager. */
export const readSessionHeaderOnly = (file: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(file, constants.O_RDONLY | constants.O_NOFOLLOW),
      catch: (cause) =>
        new SessionFileUnreadable({ message: "could not open session header", cause }),
    }),
    (handle) =>
      Effect.tryPromise({
        try: async () => {
          const buffer = Buffer.alloc(MAX_HEADER_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const newline = buffer.subarray(0, bytesRead).indexOf(10);

          if (newline < 0)
            throw new Error("session header exceeds the read limit or has no newline");

          return buffer.subarray(0, newline).toString("utf8");
        },
        catch: (cause) =>
          new SessionFileUnreadable({ message: "could not read session header", cause }),
      }).pipe(
        Effect.flatMap((text) =>
          decodeHeader(text).pipe(
            Effect.mapError(
              (cause) => new SessionFileUnreadable({ message: "invalid session header", cause }),
            ),
          ),
        ),
      ),
    (handle) => Effect.promise(() => handle.close()),
  );

/** Mirrors Pi's newest-readable-file selection without constructing a SessionManager. */
export const findRecentSessionFile = (cwd: string, directory: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (cause) =>
        new SessionFileUnreadable({ message: "could not list session directory", cause }),
    }).pipe(
      Effect.catch((cause) =>
        fileSystemCauseDetails(cause.cause).code === "ENOENT"
          ? Effect.succeed([])
          : Effect.fail(cause),
      ),
    );

    const files = yield* Effect.forEach(
      entries.filter((name) => name.endsWith(".jsonl")),
      (name) => {
        const file = join(directory, name);

        return Effect.tryPromise({ try: () => stat(file), catch: () => undefined }).pipe(
          Effect.map((info) => ({ file, mtime: info.mtimeMs })),
          Effect.orElseSucceed(() => undefined),
        );
      },
    );

    for (const entry of files
      .filter((item) => item !== undefined)
      .sort((a, b) => b.mtime - a.mtime)) {
      const header = yield* readSessionHeaderOnly(entry.file).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (header !== undefined && resolve(header.cwd) === resolve(cwd)) return entry.file;
    }

    return undefined;
  });

export const sessionDirectoryForFile = dirname;
