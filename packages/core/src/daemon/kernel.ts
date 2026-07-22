import { MAIN_SESSION_ID, type SessionEnvelope, type SessionSummary } from "@ziggy/protocol";
import { Cause, Deferred, Effect, Exit, Ref, Schema, Scope } from "effect";
import type { SessionRuntime, SessionRuntimeError } from "../agent/runtime.ts";
import {
  acquireProfileLock,
  type AcquireProfileLockOptions,
  type ProfileLock,
  type ProfileLockCoordinator,
  type ProfileLockError,
} from "./profile-lock.ts";
import { reconcileSession, scanSessionLifecycle, SessionLifecycleError } from "./reconciliation.ts";
import {
  createSessionRegistry,
  type RegisteredSessionRuntime,
  type SessionRegistry,
  SessionRegistryCleanupError,
  type SessionRegistryClosedError,
  type SessionRegistrySessionExistsError,
} from "./registry.ts";

export class DaemonKernelError extends Schema.TaggedErrorClass<DaemonKernelError>(
  "@ziggy/core/daemon/DaemonKernelError",
)("DaemonKernelError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class DaemonKernelConfigurationError extends Schema.TaggedErrorClass<DaemonKernelConfigurationError>(
  "@ziggy/core/daemon/DaemonKernelConfigurationError",
)("DaemonKernelConfigurationError", {}) {
  override readonly message = "Daemon kernel requires a Session runtime factory";
}

export class DaemonKernelCleanupError extends Schema.TaggedErrorClass<DaemonKernelCleanupError>(
  "@ziggy/core/daemon/DaemonKernelCleanupError",
)("DaemonKernelCleanupError", {
  failures: Schema.Array(Schema.Defect()),
}) {
  override readonly message = "Failed to close daemon kernel resources";
}

const isSessionRegistryCleanupError = Schema.is(SessionRegistryCleanupError);

export interface DaemonWorld<WorldError = SessionRuntimeError> {
  appendSession(
    sessionId: string,
    event: SessionEnvelope["event"],
  ): Effect.Effect<SessionEnvelope, WorldError>;
  readSession(
    sessionId: string,
    afterSeq: number,
  ): Effect.Effect<ReadonlyArray<SessionEnvelope>, WorldError>;
  readonly listSessions: Effect.Effect<
    ReadonlyArray<{ readonly sessionId: string; readonly lastSeq: number }>,
    WorldError
  >;
}

export interface CreateDaemonKernelOptions<
  WorldError,
  World extends DaemonWorld<WorldError> = DaemonWorld<WorldError>,
  RuntimeError = DaemonKernelError,
> {
  readonly profilePath: string;
  readonly createWorld: (canonicalProfilePath: string) => World & DaemonWorld<WorldError>;
  readonly createRuntime?: (
    sessionId: string,
    world: World,
  ) => Effect.Effect<SessionRuntime, RuntimeError, Scope.Scope>;
  readonly createRuntimeFactory?: (
    canonicalProfilePath: string,
  ) => Effect.Effect<
    (sessionId: string, world: World) => Effect.Effect<SessionRuntime, RuntimeError, Scope.Scope>,
    RuntimeError,
    Scope.Scope
  >;
  readonly lock?: Omit<AcquireProfileLockOptions, "profilePath">;
}

export interface DaemonKernel<RuntimeError = DaemonKernelError> {
  readonly profilePath: string;
  createSession(
    sessionId: string,
  ): Effect.Effect<
    RegisteredSessionRuntime,
    | DaemonKernelError
    | RuntimeError
    | SessionLifecycleError
    | SessionRegistryClosedError
    | SessionRegistrySessionExistsError
  >;
  getOrCreateSession(
    sessionId: string,
  ): Effect.Effect<
    RegisteredSessionRuntime,
    | DaemonKernelError
    | RuntimeError
    | SessionLifecycleError
    | SessionRegistryClosedError
    | SessionRegistrySessionExistsError
  >;
  ensureMainSession(): Effect.Effect<
    SessionSummary,
    | DaemonKernelError
    | RuntimeError
    | SessionLifecycleError
    | SessionRegistryClosedError
    | SessionRegistrySessionExistsError
  >;
  getSessionSummary(
    sessionId: string,
  ): Effect.Effect<SessionSummary | undefined, SessionLifecycleError | RuntimeError>;
  readonly listSessions: Effect.Effect<
    ReadonlyArray<SessionSummary>,
    DaemonKernelError | SessionLifecycleError | RuntimeError
  >;
  readonly close: Effect.Effect<void, DaemonKernelCleanupError>;
}

export function createDaemonKernel<WorldError, World extends DaemonWorld<WorldError>, RuntimeError>(
  options: CreateDaemonKernelOptions<WorldError, World, RuntimeError>,
): Effect.Effect<
  DaemonKernel<RuntimeError | WorldError>,
  DaemonKernelConfigurationError | DaemonKernelError | ProfileLockError | RuntimeError,
  ProfileLockCoordinator
> {
  return Effect.acquireUseRelease(
    acquireProfileLock({ profilePath: options.profilePath, ...options.lock }),
    (lock) => createLockedDaemonKernel(options, lock),
    (lock, exit) => (Exit.isFailure(exit) ? lock.close : Effect.void),
  );
}

function createLockedDaemonKernel<WorldError, World extends DaemonWorld<WorldError>, RuntimeError>(
  options: CreateDaemonKernelOptions<WorldError, World, RuntimeError>,
  lock: ProfileLock,
): Effect.Effect<
  DaemonKernel<RuntimeError | WorldError>,
  DaemonKernelConfigurationError | DaemonKernelError | RuntimeError
> {
  return Effect.gen(function* () {
    const resources = yield* Scope.make();
    const acquisition = Effect.gen(function* () {
      const world = yield* Effect.try({
        try: () => options.createWorld(lock.profilePath),
        catch: (cause) =>
          new DaemonKernelError({
            operation: "create-world",
            message: "Failed to create daemon World",
            cause,
          }),
      });
      const createRuntime = yield* resolveRuntimeFactory(options, lock.profilePath, resources);
      const registry = yield* createSessionRegistry((sessionId) =>
        reconcileSession(world, sessionId).pipe(Effect.andThen(createRuntime(sessionId, world))),
      );
      const close = yield* memoizeClose(closeKernel(registry, resources, lock));
      return makeKernel(lock.profilePath, world, registry, close);
    });
    return yield* Effect.matchCauseEffect(acquisition, {
      onFailure: (cause) =>
        Scope.close(resources, Exit.failCause(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
      onSuccess: Effect.succeed,
    });
  });
}

function resolveRuntimeFactory<WorldError, World extends DaemonWorld<WorldError>, RuntimeError>(
  options: CreateDaemonKernelOptions<WorldError, World, RuntimeError>,
  profilePath: string,
  resources: Scope.Closeable,
): Effect.Effect<
  (sessionId: string, world: World) => Effect.Effect<SessionRuntime, RuntimeError, Scope.Scope>,
  DaemonKernelConfigurationError | RuntimeError
> {
  if (options.createRuntimeFactory !== undefined) {
    return options
      .createRuntimeFactory(profilePath)
      .pipe(Effect.provideService(Scope.Scope, resources));
  }
  return options.createRuntime === undefined
    ? Effect.fail(new DaemonKernelConfigurationError())
    : Effect.succeed(options.createRuntime);
}

function makeKernel<WorldError, World extends DaemonWorld<WorldError>, RuntimeError>(
  profilePath: string,
  world: World,
  registry: SessionRegistry<RuntimeError | SessionLifecycleError | WorldError>,
  close: Effect.Effect<void, DaemonKernelCleanupError>,
): DaemonKernel<RuntimeError | WorldError> {
  const getSessionSummary = (sessionId: string) =>
    world
      .readSession(sessionId, 0)
      .pipe(Effect.flatMap((envelopes) => summarizeSession(envelopes)));
  const getOrCreateSession = (
    sessionId: string,
  ): Effect.Effect<
    RegisteredSessionRuntime,
    | DaemonKernelError
    | RuntimeError
    | WorldError
    | SessionLifecycleError
    | SessionRegistryClosedError
    | SessionRegistrySessionExistsError
  > =>
    Effect.gen(function* () {
      if (sessionId !== MAIN_SESSION_ID) return yield* registry.getOrCreate(sessionId);
      const summary = yield* getSessionSummary(sessionId);
      if (summary === undefined) {
        return yield* new DaemonKernelError({
          operation: "get-or-create-session",
          message: `Session ${MAIN_SESSION_ID} must be created through session/ensure`,
        });
      }
      return yield* registry.getOrCreate(sessionId);
    });
  return {
    profilePath,
    createSession: (sessionId) =>
      Effect.gen(function* () {
        if (sessionId === MAIN_SESSION_ID) {
          return yield* new DaemonKernelError({
            operation: "create-session",
            message: `Session id ${MAIN_SESSION_ID} is reserved`,
          });
        }
        const summary = yield* getSessionSummary(sessionId);
        if (summary !== undefined) {
          return yield* new DaemonKernelError({
            operation: "create-session",
            message: `Session ${sessionId} already exists`,
          });
        }
        return yield* registry.create(sessionId);
      }),
    getOrCreateSession,
    ensureMainSession: () =>
      registry.getOrCreate(MAIN_SESSION_ID).pipe(
        Effect.andThen(getSessionSummary(MAIN_SESSION_ID)),
        Effect.flatMap((summary) =>
          summary === undefined
            ? Effect.fail(
                new DaemonKernelError({
                  operation: "ensure-main-session",
                  message: "Ensured main Session is missing",
                }),
              )
            : Effect.succeed(summary),
        ),
      ),
    getSessionSummary,
    listSessions: Effect.gen(function* () {
      const stored = yield* world.listSessions;
      return yield* Effect.forEach(stored, (session) =>
        world.readSession(session.sessionId, 0).pipe(
          Effect.flatMap((envelopes) => summarizeSession(envelopes)),
          Effect.flatMap((summary) =>
            summary === undefined
              ? Effect.fail(
                  new DaemonKernelError({
                    operation: "list-sessions",
                    message: `Session list references missing Session ${session.sessionId}`,
                  }),
                )
              : Effect.succeed(summary),
          ),
        ),
      );
    }),
    close,
  };
}

function closeKernel<E>(
  registry: SessionRegistry<E>,
  resources: Scope.Closeable,
  lock: ProfileLock,
): Effect.Effect<void, DaemonKernelCleanupError> {
  return Effect.gen(function* () {
    const registryFailures = yield* collectFailures(registry.close);
    const resourcesFailures = yield* collectFailures(Scope.close(resources, Exit.void));
    const lockFailures = yield* collectFailures(lock.close);
    const failures = [...registryFailures, ...resourcesFailures, ...lockFailures];
    if (failures.length > 0) {
      return yield* new DaemonKernelCleanupError({ failures });
    }
  });
}

function collectFailures<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<ReadonlyArray<unknown>> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) => {
      const squashed = Cause.squash(cause);
      return Effect.succeed(
        isSessionRegistryCleanupError(squashed) ? squashed.failures : [squashed],
      );
    },
    onSuccess: () => Effect.succeed([]),
  });
}

function summarizeSession(
  envelopes: ReadonlyArray<SessionEnvelope>,
): Effect.Effect<SessionSummary | undefined, SessionLifecycleError> {
  const first = envelopes[0];
  if (first === undefined) return Effect.sync((): SessionSummary | undefined => undefined);
  if (first.event.type !== "session-started") {
    return Effect.fail(
      new SessionLifecycleError({ message: "Session does not begin with session-started" }),
    );
  }
  const last = envelopes.at(-1);
  if (last === undefined) {
    return Effect.fail(new SessionLifecycleError({ message: "Session lost its first envelope" }));
  }
  return scanSessionLifecycle(envelopes).pipe(
    Effect.map((lifecycle) => ({
      sessionId: first.event.sessionId,
      createdAt: first.emittedAt,
      lastSeq: last.seq,
      ...(lifecycle.turnId === undefined ? {} : { activeTurnId: lifecycle.turnId }),
    })),
  );
}

function memoizeClose<E>(cleanup: Effect.Effect<void, E>): Effect.Effect<Effect.Effect<void, E>> {
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
}
