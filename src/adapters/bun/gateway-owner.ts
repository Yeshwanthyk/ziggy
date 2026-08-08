import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Result, Schema, Scope } from "effect";
import { fileSystemCauseDetails } from "../fs/cause";
import { GatewayOwnerError, type GatewayOwnerStatus } from "../../domain/gateway";
import type { ProfileTarget } from "../../domain/profile";

const PositivePid = Schema.Int.check(Schema.isGreaterThan(0));
const OwnerId = Schema.String.check(Schema.isUUID());
const IsoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
    },
    { expected: "an ISO timestamp" },
  ),
);

export const GatewayOwnerRecord = Schema.Struct({
  version: Schema.Literal(1),
  ownerId: OwnerId,
  pid: PositivePid,
  acquiredAt: IsoTimestamp,
});
export type GatewayOwnerRecord = typeof GatewayOwnerRecord.Type;
export const decodeGatewayOwnerRecordJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GatewayOwnerRecord),
  { onExcessProperty: "error" },
);

const leaseAuthority = Symbol("ziggy/GatewayLeaseAuthority");
export interface GatewayOwnerHandle {
  readonly path: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly [leaseAuthority]?: true;
}

export const isGatewayOwnerAuthority = (profilePath: string, handle: GatewayOwnerHandle): boolean =>
  handle[leaseAuthority] === true &&
  handle.path === join(profilePath, ".runtime", "gateway-owner.lock");

export interface GatewayOwnerInspectionRuntime {
  readonly pidIsAlive: (pid: number) => boolean;
}

export interface GatewayOwnerRuntime extends GatewayOwnerInspectionRuntime {
  readonly pid: number;
  readonly makeOwnerId: () => string;
  readonly now: () => Date;
  /** Legacy fixture hooks; the SQLite lease no longer uses hard links. */
  readonly afterLinkConflict?: (path: string) => Effect.Effect<void>;
  readonly removeCandidate?: (path: string) => Promise<void>;
  readonly reportCleanupFailure?: (path: string, cause: unknown) => Effect.Effect<void>;
}

const liveRuntime: GatewayOwnerRuntime = {
  pid: process.pid,
  makeOwnerId: randomUUID,
  now: () => new Date(),
  pidIsAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return fileSystemCauseDetails(cause).code !== "ESRCH";
    }
  },
  reportCleanupFailure: (path, cause) =>
    Effect.logWarning("Gateway owner cleanup failed", { path, cause }),
};

export const gatewayOwnerPath = (target: ProfileTarget): string =>
  join(target.path, ".runtime", "gateway-owner.lock");
export const gatewayLeasePath = (target: ProfileTarget): string =>
  join(target.path, ".runtime", "serve-owner.sqlite");

const ownerError = (
  reason: GatewayOwnerError["reason"],
  path: string,
  message: string,
  cause: unknown,
  pid?: number,
) => new GatewayOwnerError({ reason, path, pid, message, cause });

const filesystemError = (path: string, cause: unknown) =>
  ownerError(
    "filesystem",
    path,
    `could not acquire gateway ownership at ${path}: ${fileSystemCauseDetails(cause).message}`,
    cause,
  );
const unreadableError = (path: string, cause: unknown) =>
  ownerError("unreadable", path, `gateway ownership at ${path} is unreadable`, cause);

const inspectPath = (path: string) =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => ({ cause, details: fileSystemCauseDetails(cause) }),
  }).pipe(Effect.result);

const readOwnerFile = (path: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      catch: (cause) => ({ cause, details: fileSystemCauseDetails(cause) }),
    }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.readFile("utf8"),
        catch: (cause) => ({ cause, details: fileSystemCauseDetails(cause) }),
      }),
    (handle) => Effect.promise(() => handle.close()),
  );

export const inspectGatewayOwner = (
  target: ProfileTarget,
  runtime: GatewayOwnerInspectionRuntime = liveRuntime,
): Effect.Effect<GatewayOwnerStatus, GatewayOwnerError> => {
  const path = gatewayOwnerPath(target);
  const runtimePath = dirname(path);
  return Effect.gen(function* () {
    const runtimeStatus = yield* inspectPath(runtimePath);
    if (Result.isFailure(runtimeStatus)) {
      if (runtimeStatus.failure.details.code === "ENOENT") return { _tag: "stopped", path };
      return yield* unreadableError(path, runtimeStatus.failure.cause);
    }
    if (!runtimeStatus.success.isDirectory() || runtimeStatus.success.isSymbolicLink())
      return yield* unreadableError(path, `${runtimePath} must be a regular non-symlink directory`);
    const ownerStatus = yield* inspectPath(path);
    if (Result.isFailure(ownerStatus)) {
      if (ownerStatus.failure.details.code === "ENOENT") return { _tag: "stopped", path };
      return yield* unreadableError(path, ownerStatus.failure.cause);
    }
    if (!ownerStatus.success.isFile() || ownerStatus.success.isSymbolicLink())
      return yield* unreadableError(path, `${path} must be a regular non-symlink file`);
    const sourceResult = yield* readOwnerFile(path).pipe(Effect.result);
    if (Result.isFailure(sourceResult)) {
      if (sourceResult.failure.details.code === "ENOENT") return { _tag: "stopped", path };
      return yield* unreadableError(path, sourceResult.failure.cause);
    }
    const record = yield* decodeGatewayOwnerRecordJson(sourceResult.success).pipe(
      Effect.mapError((cause) => unreadableError(path, cause)),
    );
    const fields = { path, pid: record.pid, acquiredAt: record.acquiredAt };
    return runtime.pidIsAlive(record.pid)
      ? { _tag: "running", ...fields }
      : { _tag: "stale", ...fields };
  });
};

const reportCleanup = (runtime: GatewayOwnerRuntime, path: string, cause: unknown) =>
  (runtime.reportCleanupFailure ?? liveRuntime.reportCleanupFailure)?.(path, cause) ?? Effect.void;

const removeMatchingProjection = (handle: GatewayOwnerHandle, runtime: GatewayOwnerRuntime) =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => readFile(handle.path, "utf8"),
      catch: fileSystemCauseDetails,
    });
    const record = yield* decodeGatewayOwnerRecordJson(source);
    if (record.ownerId === handle.ownerId)
      yield* Effect.tryPromise({ try: () => unlink(handle.path), catch: fileSystemCauseDetails });
  }).pipe(
    Effect.catch((cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? Effect.void
        : reportCleanup(runtime, handle.path, cause),
    ),
  );

const publishProjection = (
  target: ProfileTarget,
  runtime: GatewayOwnerRuntime,
): Effect.Effect<GatewayOwnerHandle, GatewayOwnerError> => {
  const path = gatewayOwnerPath(target);
  const ownerId = runtime.makeOwnerId();
  const acquiredAt = runtime.now().toISOString();
  const candidate = join(dirname(path), `.gateway-owner.${ownerId}.candidate`);
  const record: GatewayOwnerRecord = { version: 1, ownerId, pid: runtime.pid, acquiredAt };
  return Effect.gen(function* () {
    const status = yield* inspectGatewayOwner(target, runtime);
    if (status._tag === "running")
      return yield* ownerError(
        "held",
        status.path,
        `gateway already running for ${target.path} (pid ${status.pid})`,
        undefined,
        status.pid,
      );
    yield* Effect.tryPromise({
      try: async () => {
        const file = await open(candidate, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(candidate, path);
      },
      catch: (cause) => filesystemError(path, cause),
    });
    return { path, ownerId, pid: runtime.pid, acquiredAt, [leaseAuthority]: true as const };
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({ try: () => unlink(candidate), catch: fileSystemCauseDetails }).pipe(
        Effect.catch((cause) =>
          cause.code === "ENOENT" ? Effect.void : reportCleanup(runtime, candidate, cause),
        ),
      ),
    ),
  );
};

export const acquireGatewayOwner = (
  target: ProfileTarget,
  runtime: GatewayOwnerRuntime = liveRuntime,
): Effect.Effect<GatewayOwnerHandle, GatewayOwnerError, Scope.Scope> => {
  const leasePath = gatewayLeasePath(target);
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(leasePath), { recursive: true }),
      catch: (cause) => filesystemError(leasePath, cause),
    });
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const opened = new Database(leasePath, { create: true, readwrite: true, strict: true });
          opened.exec(
            "PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
          );
          return opened;
        },
        catch: (cause) => filesystemError(leasePath, cause),
      }),
      (opened) =>
        Effect.try({ try: () => opened.close(false), catch: fileSystemCauseDetails }).pipe(
          Effect.catch((cause) => reportCleanup(runtime, leasePath, cause)),
        ),
    );
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => db.exec("BEGIN IMMEDIATE"),
        catch: (cause) =>
          ownerError("held", leasePath, `gateway already running for ${target.path}`, cause),
      }),
      () =>
        Effect.try({ try: () => db.exec("ROLLBACK"), catch: fileSystemCauseDetails }).pipe(
          Effect.catch((cause) => reportCleanup(runtime, leasePath, cause)),
        ),
    );
    return yield* Effect.acquireRelease(publishProjection(target, runtime), (handle) =>
      removeMatchingProjection(handle, runtime),
    );
  });
};
