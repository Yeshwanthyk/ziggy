import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema, Scope } from "effect";
import { fileSystemCauseDetails } from "../fs/cause";

export class SessionLeaseHeld extends Schema.TaggedErrorClass<SessionLeaseHeld>()(
  "SessionLeaseHeld",
  { message: Schema.String, pid: Schema.optional(Schema.Int), cause: Schema.Defect() },
) {}

export class SessionLeaseFailed extends Schema.TaggedErrorClass<SessionLeaseFailed>()(
  "SessionLeaseFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const OwnerProjection = Schema.Struct({ ownerId: Schema.String, pid: Schema.Int });

const decodeProjection = Schema.decodeUnknownEffect(Schema.fromJsonString(OwnerProjection));

export interface SessionLeaseRuntime {
  readonly pid: number;
  readonly ownerId: () => string;
}

const liveRuntime: SessionLeaseRuntime = { pid: process.pid, ownerId: randomUUID };

const refusal = (pid?: number) =>
  `this session is open in another Ziggy process${pid === undefined ? "" : ` (pid ${pid})`}; use the UI, or start a new session`;

/** Hashing bounds the filename and prevents an untrusted Pi header from escaping .runtime. */
export const sessionLeasePath = (profilePath: string, sessionId: string): string =>
  join(
    profilePath,
    ".runtime",
    "session-leases",
    `${createHash("sha256").update(sessionId).digest("hex")}.sqlite`,
  );

const projectionPath = (path: string) => `${path}.owner`;

const cleanupProjection = (path: string, ownerId: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    });

    const record = yield* decodeProjection(raw);

    if (record.ownerId === ownerId)
      yield* Effect.tryPromise({ try: () => unlink(path), catch: (cause) => cause });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Session lease projection cleanup failed", { path, cause }),
    ),
  );

const inspectHolder = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(projectionPath(path), "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap(decodeProjection),
    Effect.map((record) => record.pid),
    Effect.orElseSucceed(() => undefined),
  );

/** BEGIN IMMEDIATE stays open until release. An OS process exit drops the authority even if a PID is reused. */
export const acquireSessionLease = (
  profilePath: string,
  sessionId: string,
  runtime: SessionLeaseRuntime = liveRuntime,
): Effect.Effect<Effect.Effect<void, SessionLeaseFailed>, SessionLeaseHeld | SessionLeaseFailed> =>
  Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      const path = sessionLeasePath(profilePath, sessionId);
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }),
        catch: (cause) =>
          new SessionLeaseFailed({ message: "could not create session lease directory", cause }),
      });

      const acquired = yield* Effect.try({
        try: () => {
          const db = new Database(path, { create: true, readwrite: true, strict: true });

          try {
            db.exec(
              "PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
            );
            db.exec("BEGIN IMMEDIATE");

            return db;
          } catch (cause) {
            db.close(false);
            throw cause;
          }
        },
        catch: (cause) => cause,
      }).pipe(Effect.result);

      if (acquired._tag === "Failure") {
        const pid = yield* inspectHolder(path);
        // SQLite lock errors represent another live writer. All other errors remain distinct.
        const text = String(acquired.failure);

        if (text.includes("SQLITE_BUSY") || text.includes("database is locked")) {
          return yield* new SessionLeaseHeld({
            message: refusal(pid),
            pid,
            cause: acquired.failure,
          });
        }

        return yield* new SessionLeaseFailed({
          message: "could not acquire session lease",
          cause: acquired.failure,
        });
      }

      const db = acquired.success;
      const ownerId = runtime.ownerId();
      const candidate = `${projectionPath(path)}.${ownerId}.candidate`;
      let closed = false;

      const release = Effect.suspend(() =>
        closed
          ? Effect.void
          : Effect.gen(function* () {
              yield* Effect.try({
                try: () => {
                  db.exec("ROLLBACK");
                  db.close(false);
                  closed = true;
                },
                catch: (cause) =>
                  new SessionLeaseFailed({ message: "could not release session lease", cause }),
              });
              yield* cleanupProjection(projectionPath(path), ownerId);
            }),
      );

      return yield* Effect.tryPromise({
        try: async () => {
          await writeFile(candidate, JSON.stringify({ ownerId, pid: runtime.pid }), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(candidate, projectionPath(path));

          return release;
        },
        catch: (cause) =>
          new SessionLeaseFailed({ message: "could not publish session lease holder", cause }),
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? release.pipe(
                Effect.catch((failure) =>
                  Effect.logWarning("Session lease cleanup failed", { failure }),
                ),
                Effect.andThen(
                  Effect.tryPromise({ try: () => unlink(candidate), catch: (cause) => cause }).pipe(
                    Effect.catch((cause) =>
                      fileSystemCauseDetails(cause).code === "ENOENT"
                        ? Effect.void
                        : Effect.logWarning("Session lease candidate cleanup failed", {
                            candidate,
                            cause,
                          }),
                    ),
                  ),
                ),
              )
            : Effect.void,
        ),
      );
    }),
  );

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

/** A non-creating snapshot of lease authority. Never opens the transcript or takes ownership. */
export const isSessionLeaseHeld = (
  profilePath: string,
  sessionId: string,
): Effect.Effect<boolean, SessionLeaseFailed> =>
  Effect.try({
    try: () => {
      const path = sessionLeasePath(profilePath, sessionId);

      if (!existsSync(path)) return false;

      const db = new Database(path, { create: false, readwrite: true, strict: true });

      try {
        db.exec("PRAGMA busy_timeout = 0;");
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");

        return false;
      } catch (cause) {
        if (String(cause).includes("SQLITE_BUSY") || String(cause).includes("database is locked"))
          return true;
        throw cause;
      } finally {
        db.close(false);
      }
    },
    catch: (cause) => new SessionLeaseFailed({ message: "could not inspect session lease", cause }),
  });

/** A runtime may replace Pi's session manager without closing its handle. */
export interface SessionLeaseTransitions {
  readonly reserve: (id: string) => Effect.Effect<void, SessionLeaseHeld | SessionLeaseFailed>;
  readonly cancelReservation: Effect.Effect<void, SessionLeaseFailed>;
  readonly transition: (id: string) => Effect.Effect<void, SessionLeaseHeld | SessionLeaseFailed>;
  readonly close: Effect.Effect<void, SessionLeaseFailed>;
  readonly owns: (id: string) => boolean;
  readonly poison: () => void;
}

export const makeSessionLeaseTransitions = (
  profilePath: string,
  initialId: string,
  initialRelease: Effect.Effect<void, SessionLeaseFailed>,
): SessionLeaseTransitions => {
  let currentId = initialId;
  let release = initialRelease;

  let reserved:
    | { readonly id: string; readonly release: Effect.Effect<void, SessionLeaseFailed> }
    | undefined;

  const pendingReleases: Array<Effect.Effect<void, SessionLeaseFailed>> = [];
  let poisoned = false;

  const retryRelease = (operation: Effect.Effect<void, SessionLeaseFailed>) =>
    operation.pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          pendingReleases.push(operation);
        }).pipe(
          Effect.andThen(
            Effect.logWarning("Session lease release failed; retrying on close", { cause }),
          ),
        ),
      ),
    );

  const cancelReservation = Effect.suspend(() => {
    const previous = reserved;
    reserved = undefined;

    return previous === undefined ? Effect.void : retryRelease(previous.release);
  });

  const reserve = (id: string) =>
    Effect.gen(function* () {
      if (id === currentId || reserved?.id === id) return;
      yield* cancelReservation;
      reserved = { id, release: yield* acquireSessionLease(profilePath, id) };
    });

  const transition = (id: string) =>
    Effect.gen(function* () {
      if (id === currentId) {
        yield* cancelReservation;

        return;
      }

      if (reserved !== undefined && reserved.id !== id) yield* cancelReservation;

      const next =
        reserved?.id === id ? reserved.release : yield* acquireSessionLease(profilePath, id);

      reserved = undefined;
      const previous = release;
      currentId = id;
      release = next;
      yield* retryRelease(previous);
      poisoned = false;
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          poisoned = true;
        }),
      ),
    );

  const close = Effect.gen(function* () {
    poisoned = true;
    yield* cancelReservation;
    yield* retryRelease(release);

    for (const pending of pendingReleases.splice(0)) yield* retryRelease(pending);
  });

  return {
    reserve,
    cancelReservation,
    transition,
    close,
    owns: (id) => !poisoned && id === currentId,
    poison: () => {
      poisoned = true;
    },
  };
};
