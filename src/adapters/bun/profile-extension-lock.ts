import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  ProfileExtensionLockFailed,
  ProfileExtensionMutationLock,
  type ProfileExtensionMutationLockApi,
} from "../../domain/profile-extension";
import { type FileLockFailed, openFileLockDatabase, withFileLock } from "../../platform/file-lock";

const LOCK_FILE = join(".runtime", "profile-extensions.sqlite");

const LOCK_TIMEOUT_MS = 2_000;

export const profileExtensionLockPath = (profilePath: string): string =>
  join(profilePath, LOCK_FILE);

const lockFailure = (profilePath: string, failure: FileLockFailed): ProfileExtensionLockFailed =>
  new ProfileExtensionLockFailed({
    profilePath,
    operation: failure.reason === "prepare" ? "prepare" : "acquire",
    message:
      failure.reason === "held"
        ? `Profile extension mutation lock timed out after ${LOCK_TIMEOUT_MS} milliseconds`
        : failure.message,
    cause: failure.cause,
  });

/** Open a hardened SQLite file under the Profile's `.runtime` without taking a lock on it. */
export const openProfileLockDatabase = (profilePath: string, lockName: string) =>
  openFileLockDatabase({ root: profilePath, file: join(".runtime", lockName) }).pipe(
    Effect.mapError((failure) => lockFailure(profilePath, failure)),
  );

const withLock = <A, E, R>(
  profilePath: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProfileExtensionLockFailed, R> =>
  withFileLock({ root: profilePath, file: LOCK_FILE, waitMs: LOCK_TIMEOUT_MS }, use, (failure) =>
    lockFailure(profilePath, failure),
  );

export const makeProfileExtensionMutationLock = (): ProfileExtensionMutationLockApi => ({
  withLock,
});

export const ProfileExtensionMutationLockLive = Layer.succeed(
  ProfileExtensionMutationLock,
  makeProfileExtensionMutationLock(),
);
