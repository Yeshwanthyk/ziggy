import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Result, Schema, Scope } from "effect";
import { fileSystemCauseDetails } from "../fs/cause";
import { GatewayOwnerError } from "../../domain/gateway";
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

export interface GatewayOwnerRuntime {
  readonly pid: number;
  readonly makeOwnerId: () => string;
  readonly now: () => Date;
  readonly pidIsAlive: (pid: number) => boolean;
  readonly afterLinkConflict?: (path: string) => Effect.Effect<void>;
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
    message: `gateway ownership at ${path} is unreadable; refusing to start`,
    cause,
  });

const inspectExistingOwner = (path: string, runtime: GatewayOwnerRuntime) =>
  Effect.gen(function* () {
    const sourceResult = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => ({ cause, details: fileSystemCauseDetails(cause) }),
    }).pipe(Effect.result);
    if (Result.isFailure(sourceResult)) {
      if (sourceResult.failure.details.code === "ENOENT")
        return { kind: "released" as const, cause: sourceResult.failure.cause };
      return yield* unreadableError(path, sourceResult.failure.cause);
    }
    const record = yield* decodeGatewayOwnerRecordJson(sourceResult.success).pipe(
      Effect.mapError((cause) => unreadableError(path, cause)),
    );
    if (runtime.pidIsAlive(record.pid)) {
      return yield* new GatewayOwnerError({
        reason: "held",
        path,
        pid: record.pid,
        message: `gateway already running for ${dirname(dirname(path))} (pid ${record.pid})`,
        cause: undefined,
      });
    }
    return yield* new GatewayOwnerError({
      reason: "stale",
      path,
      pid: record.pid,
      message: `stale gateway owner at ${path} (pid ${record.pid}); remove the lock file after confirming that process is stopped`,
      cause: undefined,
    });
  });

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
    let finalMissingCause: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const linked = yield* Effect.tryPromise({
        try: () => link(candidate, path),
        catch: (cause) => fileSystemCauseDetails(cause),
      }).pipe(Effect.result);
      if (Result.isSuccess(linked)) return { path, ownerId };
      if (linked.failure.code !== "EEXIST") return yield* filesystemError(path, linked.failure);
      yield* runtime.afterLinkConflict?.(path) ?? Effect.void;
      const inspection = yield* inspectExistingOwner(path, runtime);
      finalMissingCause = inspection.cause;
    }
    return yield* unreadableError(path, finalMissingCause);
  }).pipe(Effect.ensuring(Effect.promise(() => unlink(candidate).catch(() => undefined))));
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
