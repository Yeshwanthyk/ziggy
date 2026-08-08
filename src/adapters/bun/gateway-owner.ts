import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export interface GatewayOwnerHandle {
  readonly path: string;
  readonly ownerId: string;
}

export interface GatewayOwnerInspectionRuntime {
  readonly pidIsAlive: (pid: number) => boolean;
}

export interface GatewayOwnerRuntime extends GatewayOwnerInspectionRuntime {
  readonly pid: number;
  readonly makeOwnerId: () => string;
  readonly now: () => Date;
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
  removeCandidate: unlink,
  reportCleanupFailure: (path, cause) =>
    Effect.logWarning("Gateway owner candidate cleanup failed", { path, cause }),
};

export const gatewayOwnerPath = (target: ProfileTarget): string =>
  join(target.path, ".runtime", "gateway-owner.lock");

const filesystemError = (path: string, cause: unknown) =>
  new GatewayOwnerError({
    reason: "filesystem",
    path,
    pid: undefined,
    message: `could not acquire gateway ownership at ${path}: ${fileSystemCauseDetails(cause).message}`,
    cause,
  });

const unreadableError = (path: string, cause: unknown) =>
  new GatewayOwnerError({
    reason: "unreadable",
    path,
    pid: undefined,
    message: `gateway ownership at ${path} is unreadable`,
    cause,
  });

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
    (handle) =>
      Effect.tryPromise({
        try: () => handle.close(),
        catch: (cause) => ({ cause, details: fileSystemCauseDetails(cause) }),
      }),
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
    return runtime.pidIsAlive(record.pid)
      ? { _tag: "running", path, pid: record.pid, acquiredAt: record.acquiredAt }
      : { _tag: "stale", path, pid: record.pid, acquiredAt: record.acquiredAt };
  });
};

const inspectExistingOwner = (target: ProfileTarget, runtime: GatewayOwnerRuntime) =>
  inspectGatewayOwner(target, runtime).pipe(
    Effect.flatMap((status) => {
      if (status._tag === "stopped") return Effect.succeed({ kind: "released" as const });
      if (status._tag === "running")
        return Effect.fail(
          new GatewayOwnerError({
            reason: "held",
            path: status.path,
            pid: status.pid,
            message: `gateway already running for ${target.path} (pid ${status.pid})`,
            cause: undefined,
          }),
        );
      return Effect.fail(
        new GatewayOwnerError({
          reason: "stale",
          path: status.path,
          pid: status.pid,
          message: `stale gateway owner at ${status.path} (pid ${status.pid}); remove the lock file after confirming that process is stopped`,
          cause: undefined,
        }),
      );
    }),
  );

const acquire = (
  target: ProfileTarget,
  runtime: GatewayOwnerRuntime,
): Effect.Effect<GatewayOwnerHandle, GatewayOwnerError> => {
  const path = gatewayOwnerPath(target);
  const ownerId = runtime.makeOwnerId();
  const candidate = join(dirname(path), `.gateway-owner.${ownerId}.candidate`);
  const record: GatewayOwnerRecord = {
    version: 1,
    ownerId,
    pid: runtime.pid,
    acquiredAt: runtime.now().toISOString(),
  };

  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true }),
      catch: (cause) => filesystemError(path, cause),
    });
    yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(candidate, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => filesystemError(path, cause),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const linked = yield* Effect.tryPromise({
        try: () => link(candidate, path),
        catch: (cause) => fileSystemCauseDetails(cause),
      }).pipe(Effect.result);
      if (Result.isSuccess(linked)) return { path, ownerId };
      if (linked.failure.code !== "EEXIST") return yield* filesystemError(path, linked.failure);
      yield* runtime.afterLinkConflict?.(path) ?? Effect.void;
      yield* inspectExistingOwner(target, runtime);
    }
    return yield* unreadableError(path, undefined);
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => (runtime.removeCandidate ?? unlink)(candidate),
        catch: (cause) => ({ cause, details: fileSystemCauseDetails(cause) }),
      }).pipe(
        Effect.catch((failure) =>
          failure.details.code === "ENOENT"
            ? Effect.void
            : ((runtime.reportCleanupFailure ?? liveRuntime.reportCleanupFailure)?.(
                candidate,
                failure.cause,
              ) ?? Effect.void),
        ),
      ),
    ),
  );
};

const release = (handle: GatewayOwnerHandle): Effect.Effect<void> =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => readFile(handle.path, "utf8"),
      catch: fileSystemCauseDetails,
    }).pipe(Effect.catch((cause) => (cause.code === "ENOENT" ? Effect.void : Effect.fail(cause))));
    if (source === undefined) return;
    const record = yield* decodeGatewayOwnerRecordJson(source);
    if (record.ownerId === handle.ownerId)
      yield* Effect.tryPromise({
        try: () => unlink(handle.path),
        catch: fileSystemCauseDetails,
      }).pipe(
        Effect.catch((cause) => (cause.code === "ENOENT" ? Effect.void : Effect.fail(cause))),
      );
  }).pipe(
    Effect.catch((cause) =>
      Effect.sync(() =>
        console.error(`[gateway] owner release failed: ${fileSystemCauseDetails(cause).message}`),
      ),
    ),
  );

export const acquireGatewayOwner = (
  target: ProfileTarget,
  runtime: GatewayOwnerRuntime = liveRuntime,
): Effect.Effect<GatewayOwnerHandle, GatewayOwnerError, Scope.Scope> =>
  Effect.acquireRelease(acquire(target, runtime), release);
