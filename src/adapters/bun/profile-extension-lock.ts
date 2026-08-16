import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Database, constants as sqliteConstants } from "bun:sqlite";
import { Clock, Effect, Layer, Result } from "effect";
import { fileSystemCauseDetails } from "../fs/cause";
import {
  ProfileExtensionLockFailed,
  ProfileExtensionMutationLock,
  type ProfileExtensionMutationLockApi,
} from "../../domain/profile-extension";

const LOCK_NAME = "profile-extensions.sqlite";
const LOCK_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 50;
const LOCK_DB_MODE = 0o600;
const RUNTIME_DIRECTORY_MODE = 0o700;
const LOCK_FILE_CREATE_FLAGS =
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_RDWR |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;
const LOCK_FILE_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const RUNTIME_DIRECTORY_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const LOCK_DATABASE_FLAGS =
  sqliteConstants.SQLITE_OPEN_READWRITE |
  sqliteConstants.SQLITE_OPEN_NOFOLLOW |
  sqliteConstants.SQLITE_OPEN_PRIVATECACHE;

export const profileExtensionLockPath = (profilePath: string): string =>
  join(profilePath, ".runtime", LOCK_NAME);

const lockFailure = (
  profilePath: string,
  operation: ProfileExtensionLockFailed["operation"],
  message: string,
  cause: unknown,
): ProfileExtensionLockFailed =>
  new ProfileExtensionLockFailed({
    profilePath,
    operation,
    message,
    cause,
  });

const physicalDirectory = async (directoryPath: string): Promise<void> => {
  const status = await lstat(directoryPath);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${directoryPath} must be a regular non-symlink directory`);
  }
};

const physicalLockArtifact = async (artifactPath: string): Promise<void> => {
  try {
    const status = await lstat(artifactPath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`${artifactPath} must be a regular non-symlink SQLite lock artifact`);
    }
  } catch (cause) {
    if (fileSystemCauseDetails(cause).code !== "ENOENT") throw cause;
  }
};

const inspectLockArtifacts = async (lockPath: string): Promise<void> => {
  await physicalLockArtifact(lockPath);
  for (const suffix of LOCK_SIDECARS) await physicalLockArtifact(`${lockPath}${suffix}`);
};

const canonicalProfilePath = async (profilePath: string): Promise<string> => {
  const absoluteProfilePath = resolve(profilePath);
  await physicalDirectory(absoluteProfilePath);
  const canonicalParent = await realpath(dirname(absoluteProfilePath));
  const canonicalPath = join(canonicalParent, basename(absoluteProfilePath));
  await physicalDirectory(canonicalPath);
  return canonicalPath;
};

const ensureRuntimeDirectory = async (profilePath: string): Promise<string> => {
  const physicalProfilePath = await canonicalProfilePath(profilePath);
  const runtimePath = join(physicalProfilePath, ".runtime");
  try {
    await physicalDirectory(runtimePath);
  } catch (cause) {
    if (fileSystemCauseDetails(cause).code !== "ENOENT") throw cause;
    try {
      await mkdir(runtimePath, { mode: RUNTIME_DIRECTORY_MODE });
    } catch (mkdirCause) {
      if (fileSystemCauseDetails(mkdirCause).code !== "EEXIST") throw mkdirCause;
    }
    await physicalDirectory(runtimePath);
  }

  const runtimeHandle = await open(runtimePath, RUNTIME_DIRECTORY_OPEN_FLAGS);
  try {
    const pathStatus = await lstat(runtimePath);
    const handleStatus = await runtimeHandle.stat();
    if (
      !pathStatus.isDirectory() ||
      pathStatus.dev !== handleStatus.dev ||
      pathStatus.ino !== handleStatus.ino
    ) {
      throw new Error(`${runtimePath} changed while opening the Profile runtime directory`);
    }
    await runtimeHandle.chmod(RUNTIME_DIRECTORY_MODE);
  } finally {
    await runtimeHandle.close();
  }
  return runtimePath;
};

const openLockFile = async (lockPath: string) => {
  await inspectLockArtifacts(lockPath);

  let handle;
  try {
    handle = await open(lockPath, LOCK_FILE_CREATE_FLAGS, LOCK_DB_MODE);
  } catch (cause) {
    if (fileSystemCauseDetails(cause).code !== "EEXIST") throw cause;
    handle = await open(lockPath, LOCK_FILE_OPEN_FLAGS);
  }

  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new Error(`${lockPath} must be a regular non-symlink SQLite lock artifact`);
    }
    await handle.chmod(LOCK_DB_MODE);
    return handle;
  } catch (cause) {
    try {
      await handle.close();
    } catch {
      // Preserve the validation/opening failure.
    }
    throw cause;
  }
};

const openLockDatabase = (profilePath: string, runtimePath: string) => {
  const lockPath = join(runtimePath, LOCK_NAME);
  return Effect.tryPromise({
    try: async () => {
      const fileHandle = await openLockFile(lockPath);
      let fileClosed = false;
      let database: Database | undefined;
      const closeFile = async (): Promise<void> => {
        if (fileClosed) return;
        await fileHandle.close();
        fileClosed = true;
      };

      try {
        database = new Database(lockPath, LOCK_DATABASE_FLAGS);
        database.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;");

        const pathStatus = await lstat(lockPath);
        const handleStatus = await fileHandle.stat();
        if (
          !pathStatus.isFile() ||
          pathStatus.dev !== handleStatus.dev ||
          pathStatus.ino !== handleStatus.ino
        ) {
          throw new Error(`${lockPath} changed while opening the SQLite lock artifact`);
        }
        await inspectLockArtifacts(lockPath);
        await closeFile();
        return database;
      } catch (cause) {
        try {
          database?.close(false);
        } finally {
          try {
            await closeFile();
          } catch {
            // Preserve the database/opening failure.
          }
        }
        throw cause;
      }
    },
    catch: (cause) =>
      lockFailure(profilePath, "acquire", "could not open the Profile extension lock", cause),
  });
};

const isBusy = (cause: unknown): boolean => {
  const details = fileSystemCauseDetails(cause);
  return (
    details.code?.startsWith("SQLITE_BUSY") === true ||
    details.message.includes("SQLITE_BUSY") ||
    details.message.toLowerCase().includes("database is locked")
  );
};

const closeDatabase = (
  profilePath: string,
  database: Database,
): Effect.Effect<void, ProfileExtensionLockFailed> =>
  Effect.try({
    try: () => {
      try {
        if (database.inTransaction) database.exec("ROLLBACK");
      } finally {
        database.close(false);
      }
    },
    catch: (cause) =>
      lockFailure(profilePath, "release", "could not release extension lock", cause),
  });

const withLock = <A, E, R>(
  profilePath: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProfileExtensionLockFailed, R> => {
  return Effect.tryPromise({
    try: () => ensureRuntimeDirectory(profilePath),
    catch: (cause) =>
      lockFailure(
        profilePath,
        "prepare",
        `could not prepare the Profile runtime directory at ${join(profilePath, ".runtime")}`,
        cause,
      ),
  }).pipe(
    Effect.flatMap((runtimePath) =>
      Effect.acquireUseRelease(
        openLockDatabase(profilePath, runtimePath),
        (database) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + LOCK_TIMEOUT_MS;
            while (true) {
              const attempt = yield* Effect.try({
                try: () => database.exec("BEGIN IMMEDIATE"),
                catch: (cause) =>
                  lockFailure(
                    profilePath,
                    "acquire",
                    "could not acquire the Profile extension lock",
                    cause,
                  ),
              }).pipe(Effect.result);
              if (Result.isSuccess(attempt)) break;
              if (!isBusy(attempt.failure.cause)) return yield* attempt.failure;
              if ((yield* Clock.currentTimeMillis) >= deadline) {
                return yield* lockFailure(
                  profilePath,
                  "acquire",
                  `Profile extension mutation lock timed out after ${LOCK_TIMEOUT_MS} milliseconds`,
                  attempt.failure.cause,
                );
              }
              yield* Effect.sleep(`${LOCK_RETRY_MS} millis`);
            }
            return yield* use;
          }),
        (database) => closeDatabase(profilePath, database),
      ),
    ),
  );
};

export const makeProfileExtensionMutationLock = (): ProfileExtensionMutationLockApi => ({
  withLock,
});

export const ProfileExtensionMutationLockLive = Layer.succeed(
  ProfileExtensionMutationLock,
  makeProfileExtensionMutationLock(),
);
