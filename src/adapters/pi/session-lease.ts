import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema, Scope } from "effect";
import { fileSystemCauseDetails } from "../fs/cause";

export class SessionLeaseHeld extends Schema.TaggedErrorClass<SessionLeaseHeld>()(
  "SessionLeaseHeld",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class SessionLeaseFailed extends Schema.TaggedErrorClass<SessionLeaseFailed>()(
  "SessionLeaseFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export interface SessionLeaseRuntime {
  readonly pid: number;
  readonly isAlive: (pid: number) => boolean;
  readonly ownerId: () => string;
}

const liveRuntime: SessionLeaseRuntime = {
  pid: process.pid,
  ownerId: randomUUID,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (cause) {
      return fileSystemCauseDetails(cause).code !== "ESRCH";
    }
  },
};

const refusal = "this session is open in the resident; use the UI, or start a new session";

const LeaseRow = Schema.NullOr(Schema.Struct({ pid: Schema.Int }));

const decodeLeaseRow = Schema.decodeUnknownSync(LeaseRow);

export const sessionLeasePath = (profilePath: string): string =>
  join(profilePath, ".runtime", "session-leases.sqlite");

/** SQLite is the authority; each mutation serializes through BEGIN IMMEDIATE. */
export const acquireSessionLease = (
  profilePath: string,
  sessionId: string,
  runtime: SessionLeaseRuntime = liveRuntime,
): Effect.Effect<Effect.Effect<void, SessionLeaseFailed>, SessionLeaseHeld | SessionLeaseFailed> =>
  Effect.gen(function* () {
    const path = sessionLeasePath(profilePath);
    yield* Effect.tryPromise({
      try: () => mkdir(join(profilePath, ".runtime"), { recursive: true }),
      catch: (cause) =>
        new SessionLeaseFailed({ message: "could not create session lease directory", cause }),
    });

    return yield* Effect.try({
      try: () => {
        const db = new Database(path, { create: true, readwrite: true, strict: true });

        try {
          db.exec(
            "PRAGMA busy_timeout = 2000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
          );
          db.exec(
            "CREATE TABLE IF NOT EXISTS leases (session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, pid INTEGER NOT NULL)",
          );
          db.exec("BEGIN IMMEDIATE");

          try {
            const row = decodeLeaseRow(
              db.query("SELECT pid FROM leases WHERE session_id = ?").get(sessionId),
            );

            if (row !== null && runtime.isAlive(row.pid)) {
              throw new SessionLeaseHeld({ message: refusal, cause: undefined });
            }

            const ownerId = runtime.ownerId();
            db.query(
              "INSERT OR REPLACE INTO leases (session_id, owner_id, pid) VALUES (?, ?, ?)",
            ).run(sessionId, ownerId, runtime.pid);
            db.exec("COMMIT");

            return Effect.try({
              try: () => {
                const releaseDb = new Database(path, { readwrite: true, strict: true });

                try {
                  releaseDb.exec("PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE");

                  try {
                    releaseDb
                      .query("DELETE FROM leases WHERE session_id = ? AND owner_id = ?")
                      .run(sessionId, ownerId);
                    releaseDb.exec("COMMIT");
                  } catch (cause) {
                    releaseDb.exec("ROLLBACK");
                    throw cause;
                  }
                } finally {
                  releaseDb.close(false);
                }
              },
              catch: (cause) =>
                new SessionLeaseFailed({ message: "could not release session lease", cause }),
            });
          } catch (cause) {
            db.exec("ROLLBACK");
            throw cause;
          }
        } finally {
          db.close(false);
        }
      },
      catch: (cause) =>
        cause instanceof SessionLeaseHeld
          ? cause
          : new SessionLeaseFailed({ message: "could not acquire session lease", cause }),
    });
  });

export const scopedSessionLease = (
  profilePath: string,
  sessionId: string,
  runtime?: SessionLeaseRuntime,
): Effect.Effect<void, SessionLeaseHeld | SessionLeaseFailed, Scope.Scope> =>
  Effect.acquireRelease(acquireSessionLease(profilePath, sessionId, runtime), (release) =>
    release.pipe(
      Effect.catch((failure) => Effect.logWarning("Session lease release failed", { failure })),
    ),
  ).pipe(Effect.asVoid);

/** A runtime may replace Pi's session manager without closing its handle. */
export const makeSessionLeaseTransitions = (
  profilePath: string,
  initialId: string,
  initialRelease: Effect.Effect<void, SessionLeaseFailed>,
) => {
  let currentId = initialId;
  let release = initialRelease;

  let reserved:
    | { readonly id: string; readonly release: Effect.Effect<void, SessionLeaseFailed> }
    | undefined;

  let poisoned = false;

  const reserve = (id: string) =>
    Effect.gen(function* () {
      if (id === currentId || reserved?.id === id) return;
      reserved = { id, release: yield* acquireSessionLease(profilePath, id) };
    });

  const cancelReservation = Effect.suspend(() => {
    const previous = reserved;
    reserved = undefined;

    return previous === undefined ? Effect.void : previous.release;
  });

  const transition = (id: string) =>
    Effect.gen(function* () {
      if (id === currentId) {
        yield* cancelReservation;

        return;
      }

      const next =
        reserved?.id === id ? reserved.release : yield* acquireSessionLease(profilePath, id);

      reserved = undefined;
      const previous = release;
      currentId = id;
      release = next;
      yield* previous;
      poisoned = false;
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          poisoned = true;
        }),
      ),
    );

  const close = Effect.gen(function* () {
    yield* cancelReservation;
    yield* release;
  });

  return {
    reserve,
    cancelReservation,
    transition,
    close,
    owns: (id: string) => !poisoned && id === currentId,
  };
};
