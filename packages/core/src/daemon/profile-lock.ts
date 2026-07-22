import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Context, Deferred, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import {
  rawProductionProfileLockFilesystem,
  type RawProfileLockFilesystem,
} from "./profile-lock-node-adapter.ts";

export class ProfileLockError extends Schema.TaggedErrorClass<ProfileLockError>(
  "@ziggy/core/daemon/ProfileLockError",
)("ProfileLockError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ProfileLockFilesystem {
  canonicalize(path: string): Effect.Effect<string, ProfileLockError>;
  mkdir(path: string): Effect.Effect<void, ProfileLockError>;
  create(path: string, content: string): Effect.Effect<void, ProfileLockError>;
  read(path: string): Effect.Effect<string, ProfileLockError>;
  remove(path: string): Effect.Effect<void, ProfileLockError>;
}

interface ProfileLockProcess {
  readonly pid: number;
  isAlive(pid: number): Effect.Effect<boolean, ProfileLockError>;
  readonly ownerToken: Effect.Effect<string, ProfileLockError>;
}

export interface ProfileLock {
  readonly profilePath: string;
  readonly pid: number;
  readonly close: Effect.Effect<void, ProfileLockError>;
}

export type ProfileLockInspection =
  | { readonly state: "absent" }
  | { readonly state: "live"; readonly pid: number }
  | { readonly state: "stale"; readonly pid: number };

export interface InspectProfileLockOptions {
  readonly profilePath: string;
  readonly filesystem?: Pick<ProfileLockFilesystem, "canonicalize" | "read">;
  readonly isAlive?: (pid: number) => Effect.Effect<boolean, ProfileLockError>;
}

export interface AcquireProfileLockOptions {
  readonly profilePath: string;
  readonly filesystem?: ProfileLockFilesystem;
  readonly process?: ProfileLockProcess;
}

interface LockMetadata {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly ownerToken: string;
}

const LockMetadataWireSchema = Schema.Struct({
  schemaVersion: Schema.Finite,
  pid: Schema.Finite,
  ownerToken: Schema.String,
});

const decodeLockMetadataWire = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LockMetadataWireSchema),
);

interface ProfileLockCoordinatorShape {
  withPermit<A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

export class ProfileLockCoordinator extends Context.Service<
  ProfileLockCoordinator,
  ProfileLockCoordinatorShape
>()("@ziggy/core/daemon/ProfileLockCoordinator") {
  static readonly make = Effect.gen(function* () {
    const registryGate = yield* Semaphore.make(1);
    const gates = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
    const gateFor = (key: string) =>
      Semaphore.withPermit(
        registryGate,
        Effect.gen(function* () {
          const current = yield* Ref.get(gates);
          const existing = current.get(key);
          if (existing !== undefined) return existing;
          const created = yield* Semaphore.make(1);
          yield* Ref.set(gates, new Map(current).set(key, created));
          return created;
        }),
      );
    return ProfileLockCoordinator.of({
      withPermit: (key, effect) =>
        gateFor(key).pipe(Effect.flatMap((gate) => Semaphore.withPermit(gate, effect))),
    });
  });

  static readonly layer = Layer.effect(this, this.make);
}

export function inspectProfileLock(
  options: InspectProfileLockOptions,
): Effect.Effect<ProfileLockInspection, ProfileLockError> {
  const filesystem = options.filesystem ?? productionFilesystem;
  const isAlive = options.isAlive ?? productionProcess.isAlive;
  return Effect.gen(function* () {
    const profilePath = yield* filesystem.canonicalize(options.profilePath);
    const metadata = yield* readMetadataIfPresent(
      filesystem,
      join(profilePath, ".runtime", "daemon.lock"),
    );
    if (metadata === undefined) return { state: "absent" };
    return (yield* isAlive(metadata.pid))
      ? { state: "live", pid: metadata.pid }
      : { state: "stale", pid: metadata.pid };
  });
}

export function acquireProfileLock(
  options: AcquireProfileLockOptions,
): Effect.Effect<ProfileLock, ProfileLockError, ProfileLockCoordinator> {
  const filesystem = options.filesystem ?? productionFilesystem;
  const processOperations = options.process ?? productionProcess;
  return Effect.gen(function* () {
    const coordinator = yield* ProfileLockCoordinator;
    const profilePath = yield* filesystem.canonicalize(options.profilePath);
    return yield* coordinator.withPermit(
      profilePath,
      acquireCanonicalProfileLock(filesystem, processOperations, profilePath),
    );
  });
}

function acquireCanonicalProfileLock(
  filesystem: ProfileLockFilesystem,
  processOperations: ProfileLockProcess,
  profilePath: string,
): Effect.Effect<ProfileLock, ProfileLockError> {
  return Effect.gen(function* () {
    const runtimePath = join(profilePath, ".runtime");
    const lockPath = join(runtimePath, "daemon.lock");
    const takeoverPath = join(runtimePath, "daemon.lock.takeover");
    yield* filesystem.mkdir(runtimePath);
    const metadata: LockMetadata = {
      schemaVersion: 1,
      pid: processOperations.pid,
      ownerToken: yield* processOperations.ownerToken,
    };
    yield* acquireLockFile(filesystem, processOperations, lockPath, takeoverPath, metadata);
    const closing = yield* DeferredClose.make(
      removeIfOwned(filesystem, lockPath, metadata.ownerToken),
    );
    return { profilePath, pid: metadata.pid, close: closing };
  });
}

function acquireLockFile(
  filesystem: ProfileLockFilesystem,
  processOperations: ProfileLockProcess,
  lockPath: string,
  takeoverPath: string,
  metadata: LockMetadata,
): Effect.Effect<void, ProfileLockError> {
  return filesystem.create(lockPath, `${JSON.stringify(metadata)}\n`).pipe(
    Effect.catch((error) =>
      hasCode(error.cause, "EEXIST")
        ? takeOverStaleLock(filesystem, processOperations, lockPath, takeoverPath, metadata)
        : Effect.fail(error),
    ),
    Effect.andThen(
      readMetadataIfPresent(filesystem, takeoverPath).pipe(
        Effect.flatMap((takeover) => {
          if (takeover === undefined) return Effect.void;
          return processOperations
            .isAlive(takeover.pid)
            .pipe(
              Effect.flatMap((alive) =>
                alive && takeover.pid !== metadata.pid
                  ? removeIfOwned(filesystem, lockPath, metadata.ownerToken).pipe(
                      Effect.andThen(
                        Effect.fail(
                          profileLockError(
                            "takeover",
                            `Profile lock takeover is already in progress by PID ${takeover.pid}`,
                          ),
                        ),
                      ),
                    )
                  : removeIfOwned(filesystem, takeoverPath, takeover.ownerToken),
              ),
            );
        }),
      ),
    ),
  );
}

function takeOverStaleLock(
  filesystem: ProfileLockFilesystem,
  processOperations: ProfileLockProcess,
  lockPath: string,
  takeoverPath: string,
  metadata: LockMetadata,
): Effect.Effect<void, ProfileLockError> {
  return filesystem.create(takeoverPath, `${JSON.stringify(metadata)}\n`).pipe(
    Effect.catch((error) => {
      if (!hasCode(error.cause, "EEXIST")) return Effect.fail(error);
      return filesystem.read(takeoverPath).pipe(
        Effect.flatMap(decodeMetadata),
        Effect.flatMap((contender) =>
          processOperations
            .isAlive(contender.pid)
            .pipe(
              Effect.flatMap((alive) =>
                alive
                  ? Effect.fail(
                      profileLockError(
                        "takeover",
                        `Profile lock takeover is already in progress by PID ${contender.pid}`,
                      ),
                    )
                  : removeIfOwned(filesystem, takeoverPath, contender.ownerToken).pipe(
                      Effect.andThen(
                        takeOverStaleLock(
                          filesystem,
                          processOperations,
                          lockPath,
                          takeoverPath,
                          metadata,
                        ),
                      ),
                    ),
              ),
            ),
        ),
      );
    }),
    Effect.flatMap(() =>
      readMetadataIfPresent(filesystem, lockPath).pipe(
        Effect.flatMap((existing) => {
          if (existing === undefined) return Effect.void;
          return processOperations
            .isAlive(existing.pid)
            .pipe(
              Effect.flatMap((alive) =>
                alive
                  ? Effect.fail(
                      profileLockError(
                        "acquire",
                        `Profile is already owned by live daemon PID ${existing.pid}`,
                      ),
                    )
                  : removeIfOwned(filesystem, lockPath, existing.ownerToken),
              ),
            );
        }),
        Effect.andThen(filesystem.create(lockPath, `${JSON.stringify(metadata)}\n`)),
        Effect.onExit(() => removeIfOwned(filesystem, takeoverPath, metadata.ownerToken)),
      ),
    ),
  );
}

function readMetadataIfPresent(
  filesystem: Pick<ProfileLockFilesystem, "read">,
  path: string,
): Effect.Effect<LockMetadata | undefined, ProfileLockError> {
  return filesystem.read(path).pipe(
    Effect.flatMap(decodeMetadata),
    Effect.catch((error) =>
      hasCode(error.cause, "ENOENT")
        ? Effect.sync((): LockMetadata | undefined => undefined)
        : Effect.fail(error),
    ),
  );
}

function removeIfOwned(
  filesystem: Pick<ProfileLockFilesystem, "read" | "remove">,
  path: string,
  ownerToken: string,
): Effect.Effect<void, ProfileLockError> {
  return readMetadataIfPresent(filesystem, path).pipe(
    Effect.flatMap((current) =>
      current?.ownerToken === ownerToken ? filesystem.remove(path) : Effect.void,
    ),
  );
}

const productionFilesystem: ProfileLockFilesystem = wrapRawFilesystem(
  rawProductionProfileLockFilesystem,
);

const productionProcess: ProfileLockProcess = {
  pid: process.pid,
  isAlive(pid) {
    return Effect.try({
      try: () => {
        process.kill(pid, 0);
        return true;
      },
      catch: (cause) => profileLockError("inspect-process", "Process inspection failed", cause),
    }).pipe(
      Effect.catch((error) => {
        if (hasCode(error.cause, "ESRCH")) return Effect.succeed(false);
        if (hasCode(error.cause, "EPERM")) return Effect.succeed(true);
        return Effect.fail(error);
      }),
    );
  },
  ownerToken: Effect.try({
    try: () => randomBytes(32).toString("hex"),
    catch: (cause) => profileLockError("owner-token", "Owner token generation failed", cause),
  }),
};

function wrapRawFilesystem(raw: RawProfileLockFilesystem): ProfileLockFilesystem {
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- This is the single Promise-to-Effect filesystem boundary.
  const fromRaw = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => profileLockError(operation, `${operation} failed`, cause),
    });
  return {
    canonicalize: (path) => fromRaw("canonicalize", () => raw.canonicalize(path)),
    mkdir: (path) => fromRaw("mkdir", () => raw.mkdir(path)),
    create: (path, content) => fromRaw("create", () => raw.create(path, content)),
    read: (path) => fromRaw("read", () => raw.read(path)),
    remove: (path) => fromRaw("remove", () => raw.remove(path)),
  };
}

function decodeMetadata(text: string): Effect.Effect<LockMetadata, ProfileLockError> {
  return decodeLockMetadataWire(text).pipe(
    Effect.mapError((cause) =>
      profileLockError("decode", "Malformed Profile lock metadata", cause),
    ),
    Effect.flatMap((value) => {
      if (value.schemaVersion !== 1) {
        return Effect.fail(profileLockError("decode", "Unsupported Profile lock schemaVersion"));
      }
      if (!Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0) {
        return Effect.fail(profileLockError("decode", "Malformed Profile lock PID"));
      }
      if (typeof value.ownerToken !== "string" || value.ownerToken.length === 0) {
        return Effect.fail(profileLockError("decode", "Malformed Profile lock owner token"));
      }
      return Effect.succeed({ schemaVersion: 1, pid: value.pid, ownerToken: value.ownerToken });
    }),
  );
}

function profileLockError(operation: string, message: string, cause?: unknown): ProfileLockError {
  return new ProfileLockError({ operation, message, ...(cause === undefined ? {} : { cause }) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

const DeferredClose = {
  make<E>(cleanup: Effect.Effect<void, E>): Effect.Effect<Effect.Effect<void, E>> {
    return Effect.gen(function* () {
      const result = yield* Deferred.make<void, E>();
      const started = yield* Ref.make(false);
      return yield* Effect.succeed(
        Effect.uninterruptible(
          Ref.modify(started, (current): readonly [boolean, boolean] => [current, true]).pipe(
            Effect.flatMap((alreadyStarted) =>
              alreadyStarted
                ? Deferred.await(result)
                : Deferred.complete(result, cleanup).pipe(Effect.andThen(Deferred.await(result))),
            ),
          ),
        ),
      );
    });
  },
};
