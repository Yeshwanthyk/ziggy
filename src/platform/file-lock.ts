import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Database, constants as sqliteConstants } from "bun:sqlite";
import { Clock, Effect, Result, Schema, type Scope } from "effect";
import { fileSystemCauseDetails } from "./cause";

/**
 * A cross-process lock held as a SQLite `BEGIN IMMEDIATE` transaction on a file under `root`.
 * SQLite releases it when the holder exits, so a crashed holder never leaves a stale lock.
 */
export interface FileLock {
  /** Existing, non-symlink directory that owns the lock. It is never created. */
  readonly root: string;
  /** Lock file relative to `root`. Missing directories on the way are created with mode 0700. */
  readonly file: string;
  /** How long to retry a held lock before failing with `held`. `0` fails at once. */
  readonly waitMs: number;
}

export class FileLockFailed extends Schema.TaggedErrorClass<FileLockFailed>()("FileLockFailed", {
  path: Schema.String,
  reason: Schema.Literals(["prepare", "open", "held"]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

const RETRY_MS = 50;

const FILE_MODE = 0o600;

const DIRECTORY_MODE = 0o700;

const FILE_CREATE_FLAGS =
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_RDWR |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;

const FILE_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

const DIRECTORY_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

const DATABASE_FLAGS =
  sqliteConstants.SQLITE_OPEN_READWRITE |
  sqliteConstants.SQLITE_OPEN_NOFOLLOW |
  sqliteConstants.SQLITE_OPEN_PRIVATECACHE;

const refuse = (message: string): Promise<never> => Promise.reject(new Error(message));

const realDirectory = async (path: string): Promise<void> => {
  const status = await lstat(path);

  if (status.isSymbolicLink() || !status.isDirectory()) {
    await refuse(`${path} must be a regular non-symlink directory`);
  }
};

const realFileIfPresent = async (path: string): Promise<void> => {
  const status = await lstat(path).catch((cause: unknown) =>
    fileSystemCauseDetails(cause).code === "ENOENT" ? undefined : Promise.reject(cause),
  );

  if (status !== undefined && (status.isSymbolicLink() || !status.isFile())) {
    await refuse(`${path} must be a regular non-symlink SQLite lock file`);
  }
};

const inspectLockFiles = async (path: string): Promise<void> => {
  await realFileIfPresent(path);

  for (const suffix of SIDECARS) await realFileIfPresent(`${path}${suffix}`);
};

const lockSegments = (file: string): readonly string[] => {
  const normalized = normalize(file);

  if (
    isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.split(sep).includes("")
  ) {
    throw new Error(`${file} must be a relative path inside the lock root`);
  }

  return normalized.split(sep);
};

/** Create `path` with mode 0700 if missing, then prove the open directory is the named one. */
const ensureDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { mode: DIRECTORY_MODE }).catch((cause: unknown) =>
    fileSystemCauseDetails(cause).code === "EEXIST" ? undefined : Promise.reject(cause),
  );
  await realDirectory(path);
  const handle = await open(path, DIRECTORY_OPEN_FLAGS);

  try {
    const pathStatus = await lstat(path);
    const handleStatus = await handle.stat();

    if (
      !pathStatus.isDirectory() ||
      pathStatus.dev !== handleStatus.dev ||
      pathStatus.ino !== handleStatus.ino
    ) {
      await refuse(`${path} changed while opening it`);
    }

    await handle.chmod(DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
};

/** Resolve the lock file path, refusing symlinks from the root down and creating directories. */
const prepareLockPath = async (lock: Pick<FileLock, "root" | "file">): Promise<string> => {
  const absoluteRoot = resolve(lock.root);
  await realDirectory(absoluteRoot);
  const root = join(await realpath(dirname(absoluteRoot)), basename(absoluteRoot));
  await realDirectory(root);
  const segments = lockSegments(lock.file);
  let directory = root;

  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    await ensureDirectory(directory);
  }

  return join(directory, segments.at(-1) ?? lock.file);
};

const openLockFile = async (path: string) => {
  await inspectLockFiles(path);

  const handle = await open(path, FILE_CREATE_FLAGS, FILE_MODE).catch((cause: unknown) =>
    fileSystemCauseDetails(cause).code === "EEXIST"
      ? open(path, FILE_OPEN_FLAGS)
      : Promise.reject(cause),
  );

  try {
    if (!(await handle.stat()).isFile()) {
      await refuse(`${path} must be a regular non-symlink SQLite lock file`);
    }

    await handle.chmod(FILE_MODE);

    return handle;
  } catch (cause) {
    await handle.close().catch(() => undefined);

    throw cause;
  }
};

const openLockDatabase = async (path: string): Promise<Database> => {
  const handle = await openLockFile(path);
  let database: Database | undefined;

  try {
    database = new Database(path, DATABASE_FLAGS);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;");
    const pathStatus = await lstat(path);
    const handleStatus = await handle.stat();

    if (
      !pathStatus.isFile() ||
      pathStatus.dev !== handleStatus.dev ||
      pathStatus.ino !== handleStatus.ino
    ) {
      await refuse(`${path} changed while opening it`);
    }

    await inspectLockFiles(path);

    return database;
  } catch (cause) {
    database?.close(false);

    throw cause;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const openAt = (
  lock: Pick<FileLock, "root" | "file">,
): Effect.Effect<{ readonly database: Database; readonly path: string }, FileLockFailed> =>
  Effect.tryPromise({
    try: () => prepareLockPath(lock),
    catch: (cause) =>
      new FileLockFailed({
        path: join(lock.root, lock.file),
        reason: "prepare",
        message: `could not prepare the lock directory for ${join(lock.root, lock.file)}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((path) =>
      Effect.tryPromise({
        try: async () => ({ database: await openLockDatabase(path), path }),
        catch: (cause) =>
          new FileLockFailed({ path, reason: "open", message: `could not open ${path}`, cause }),
      }),
    ),
  );

/**
 * Open the hardened SQLite file behind a lock without taking it. Callers that need a
 * different transaction mode than `BEGIN IMMEDIATE` start it themselves and own the close.
 */
export const openFileLockDatabase = (
  lock: Pick<FileLock, "root" | "file">,
): Effect.Effect<Database, FileLockFailed> => Effect.map(openAt(lock), ({ database }) => database);

const isBusy = (cause: unknown): boolean => {
  const details = fileSystemCauseDetails(cause);

  return (
    details.code?.startsWith("SQLITE_BUSY") === true ||
    details.message.includes("SQLITE_BUSY") ||
    details.message.toLowerCase().includes("database is locked")
  );
};

const begin = (
  database: Database,
  path: string,
  waitMs: number,
): Effect.Effect<void, FileLockFailed> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + waitMs;

    while (true) {
      const attempt = yield* Effect.try({
        try: () => database.exec("BEGIN IMMEDIATE"),
        catch: (cause) => cause,
      }).pipe(Effect.result);

      if (Result.isSuccess(attempt)) return;

      if (!isBusy(attempt.failure)) {
        return yield* new FileLockFailed({
          path,
          reason: "open",
          message: `could not lock ${path}`,
          cause: attempt.failure,
        });
      }

      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new FileLockFailed({
          path,
          reason: "held",
          message:
            waitMs === 0
              ? `${path} is held by another process`
              : `${path} is held by another process; timed out after ${waitMs} milliseconds`,
          cause: attempt.failure,
        });
      }

      // Acquisition runs uninterruptibly; only the wait between attempts may be interrupted,
      // and `take` then closes the database it opened.
      yield* Effect.interruptible(Effect.sleep(`${RETRY_MS} millis`));
    }
  });

const release = ({
  database,
  path,
}: {
  readonly database: Database;
  readonly path: string;
}): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      try {
        if (database.inTransaction) database.exec("ROLLBACK");
      } finally {
        database.close(false);
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => Effect.logWarning("file lock release failed", { path, cause })));

const take = (lock: FileLock) =>
  Effect.flatMap(openAt(lock), (held) =>
    begin(held.database, held.path, lock.waitMs).pipe(
      Effect.onError(() => release(held)),
      Effect.as(held),
    ),
  );

/** Hold the lock for the rest of the current scope. */
export const acquireFileLock = (lock: FileLock): Effect.Effect<void, FileLockFailed, Scope.Scope> =>
  Effect.asVoid(Effect.acquireRelease(take(lock), release));

/** Run `use` while holding the lock; lock failures are reported through `onLockFailure`. */
export const withFileLock = <A, E, R, F>(
  lock: FileLock,
  use: Effect.Effect<A, E, R>,
  onLockFailure: (failure: FileLockFailed) => F,
): Effect.Effect<A, E | F, R> =>
  Effect.acquireUseRelease(Effect.mapError(take(lock), onLockFailure), () => use, release);
