import { Effect } from "effect";
import type { Database } from "bun:sqlite";
import { ProfileExtensionLockFailed } from "../../domain/profile-extension";
import { openProfileLockDatabase } from "./profile-extension-lock";

const failure = (profilePath: string, operation: "acquire" | "release", cause: unknown) =>
  new ProfileExtensionLockFailed({
    profilePath,
    operation,
    message:
      operation === "acquire"
        ? "Profile is in use or an extension update is activating; stop its runtimes and retry"
        : "could not release the Profile runtime lease",
    cause,
  });

const makeLease = (database: Database) => {
  let closed = false;

  return {
    release: () => {
      if (closed) return;
      database.close(false);
      closed = true;
    },
  };
};

const acquire = (profilePath: string, mode: "reader" | "update") =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const database = yield* openProfileLockDatabase(profilePath, "profile-runtime.sqlite");
      const lease = makeLease(database);
      yield* Effect.try({
        try: () => {
          // Rollback-journal SHARED readers coexist; EXCLUSIVE activation excludes every reader.
          // The stable artifact is never unlinked. SQLite releases ownership when a process exits.
          database.exec(mode === "update" ? "BEGIN EXCLUSIVE" : "BEGIN");
          database.query("SELECT count(*) FROM sqlite_master").get();
        },
        catch: (cause) => failure(profilePath, "acquire", cause),
      }).pipe(
        Effect.onError(() =>
          Effect.try({
            try: lease.release,
            catch: (cause) => failure(profilePath, "release", cause),
          }).pipe(
            Effect.catch((cause) => Effect.logWarning("Runtime lease cleanup failed", { cause })),
          ),
        ),
      );

      return lease;
    }),
  );

export const acquireProfileRuntimeLease = (profilePath: string) => acquire(profilePath, "reader");

export const withProfileRuntimeLock = <A, E, R>(
  profilePath: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProfileExtensionLockFailed, R> =>
  Effect.acquireUseRelease(
    acquireProfileRuntimeLease(profilePath),
    () => use,
    (lease) =>
      Effect.try({
        try: lease.release,
        catch: (cause) => failure(profilePath, "release", cause),
      }),
  );

export const withProfileUpdateLock = <A, E, R>(
  profilePath: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProfileExtensionLockFailed, R> =>
  Effect.acquireUseRelease(
    acquire(profilePath, "update"),
    () => use,
    (lease) =>
      Effect.try({
        try: lease.release,
        catch: (cause) => failure(profilePath, "release", cause),
      }),
  );
