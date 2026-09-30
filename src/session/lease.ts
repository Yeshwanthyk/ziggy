import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Result } from "effect";
import { SessionHeld } from "../domain/agent";
import { ProviderConfigError } from "../profile";

/** One writer per transcript: an open SQLite `BEGIN IMMEDIATE`, dropped by the OS if the process dies. */
export interface SessionLease {
  readonly id: string;
  readonly release: () => void;
}

export type SessionLeaseError = SessionHeld | ProviderConfigError;

/** Hashing bounds the filename and keeps an untrusted Pi header id inside `.runtime`. */
const leasePath = (profilePath: string, id: string): string =>
  join(
    profilePath,
    ".runtime",
    "session-leases",
    `${createHash("sha256").update(id).digest("hex")}.sqlite`,
  );

const attempt = <A>(run: () => A): Result.Result<A, unknown> => {
  // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- bun:sqlite and node:fs sync calls throw; this is the one catch.
  try {
    return Result.succeed(run());
  } catch (cause) {
    return Result.fail(cause);
  }
};

const isBusy = (cause: unknown): boolean =>
  String(cause).includes("SQLITE_BUSY") || String(cause).includes("database is locked");

/** Open the lease database and begin the write transaction that is the lease. */
const lock = (path: string, create: boolean): Result.Result<Database, unknown> =>
  Result.flatMap(
    attempt(() => new Database(path, { create, readwrite: true, strict: true })),
    (db) => {
      const locked = attempt(() => {
        db.exec(`PRAGMA busy_timeout = ${create ? 40 : 0}; PRAGMA journal_mode = DELETE;`);
        db.exec("BEGIN IMMEDIATE");
      });

      if (Result.isFailure(locked)) attempt(() => db.close(false));

      return Result.map(locked, () => db);
    },
  );

const unlock = (db: Database) =>
  attempt(() => {
    db.exec("ROLLBACK");
    db.close(false);
  });

const holderPid = (path: string): number | undefined => {
  const pid = Result.getOrUndefined(
    attempt(() => Number(readFileSync(`${path}.pid`, "utf8").trim())),
  );

  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const failed = (profilePath: string, operation: string, cause: unknown) =>
  new ProviderConfigError({ profilePath, operation, message: `could not ${operation}`, cause });

/** Take the lease on transcript `id`, or fail with `SessionHeld` naming the holding process. */
export const takeSessionLease = (
  profilePath: string,
  id: string,
): Result.Result<SessionLease, SessionLeaseError> => {
  const path = leasePath(profilePath, id);
  const directory = attempt(() => mkdirSync(dirname(path), { recursive: true, mode: 0o700 }));
  const locked = Result.flatMap(directory, () => lock(path, true));

  if (Result.isFailure(locked)) {
    if (!isBusy(locked.failure))
      return Result.fail(failed(profilePath, "take session lease", locked.failure));
    const pid = holderPid(path);
    const holder = pid === undefined ? "" : ` (pid ${pid})`;

    return Result.fail(
      new SessionHeld({
        profilePath,
        message: `this session is open in another Ziggy process${holder}; use the UI, or start a new session`,
        pid,
      }),
    );
  }

  const db = locked.success;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    // Drop the pid file while still holding the lock, so a later holder's pid is never removed.
    attempt(() => rmSync(`${path}.pid`, { force: true }));
    unlock(db);
  };

  const written = attempt(() => writeFileSync(`${path}.pid`, String(process.pid), { mode: 0o600 }));

  if (Result.isFailure(written)) {
    release();

    return Result.fail(failed(profilePath, "record session lease holder", written.failure));
  }

  return Result.succeed({ id, release });
};

/** Whether some connection holds transcript `id`. Never creates a lease file. */
export const isSessionHeld = (
  profilePath: string,
  id: string,
): Result.Result<boolean, ProviderConfigError> => {
  const path = leasePath(profilePath, id);

  if (!existsSync(path)) return Result.succeed(false);

  const locked = lock(path, false);

  if (Result.isSuccess(locked)) {
    unlock(locked.success);

    return Result.succeed(false);
  }

  return isBusy(locked.failure)
    ? Result.succeed(true)
    : Result.fail(failed(profilePath, "inspect session lease", locked.failure));
};

/** The leases a live handle holds while Pi moves between transcripts. */
export interface SessionLeaseSet {
  /** Take the lease on `id` unless this set already holds it. */
  readonly hold: (id: string) => Result.Result<void, SessionLeaseError>;
  /** Release every lease except `id`'s. */
  readonly keepOnly: (id: string | undefined) => void;
}

export const makeSessionLeaseSet = (profilePath: string): SessionLeaseSet => {
  const held = new Map<string, SessionLease>();

  return {
    hold: (id) =>
      held.has(id)
        ? Result.succeed(undefined)
        : Result.map(takeSessionLease(profilePath, id), (lease) => {
            held.set(id, lease);
          }),
    keepOnly: (id) => {
      for (const lease of held.values()) {
        if (lease.id === id) continue;
        lease.release();
        held.delete(lease.id);
      }
    },
  };
};
