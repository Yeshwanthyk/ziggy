import { Cause, Deferred, Effect, Exit, Ref, Schema, Scope, Semaphore } from "effect";
import type { SessionRuntime } from "../agent/runtime.ts";

export class SessionRegistryClosedError extends Schema.TaggedErrorClass<SessionRegistryClosedError>(
  "@ziggy/core/daemon/SessionRegistryClosedError",
)("SessionRegistryClosedError", {}) {
  override readonly message = "Session registry is closed";
}

export class SessionRegistryCleanupError extends Schema.TaggedErrorClass<SessionRegistryCleanupError>(
  "@ziggy/core/daemon/SessionRegistryCleanupError",
)("SessionRegistryCleanupError", {
  failures: Schema.Array(Schema.Defect()),
}) {
  override readonly message = "Failed to close Session runtimes";
}

export class SessionRegistrySessionExistsError extends Schema.TaggedErrorClass<SessionRegistrySessionExistsError>(
  "@ziggy/core/daemon/SessionRegistrySessionExistsError",
)("SessionRegistrySessionExistsError", { sessionId: Schema.String }) {
  override get message(): string {
    return `Session ${this.sessionId} already exists`;
  }
}

export type RegisteredSessionRuntime = Omit<SessionRuntime, "close">;
export type SessionRuntimeFactory<E> = (
  sessionId: string,
) => Effect.Effect<SessionRuntime, E, Scope.Scope>;

export interface SessionRegistry<E> {
  create(
    sessionId: string,
  ): Effect.Effect<
    RegisteredSessionRuntime,
    E | SessionRegistryClosedError | SessionRegistrySessionExistsError
  >;
  getOrCreate(
    sessionId: string,
  ): Effect.Effect<
    RegisteredSessionRuntime,
    E | SessionRegistryClosedError | SessionRegistrySessionExistsError
  >;
  readonly close: Effect.Effect<void, SessionRegistryCleanupError>;
}

interface RegistryEntry<E> {
  readonly runtime: Deferred.Deferred<SessionRuntime, E>;
  readonly scope: Scope.Closeable;
}

interface RegistryState<E> {
  readonly entries: ReadonlyMap<string, RegistryEntry<E>>;
  readonly stopped: boolean;
}

interface EntrySelection<E> {
  readonly entry: RegistryEntry<E>;
  readonly owner: boolean;
}

export function createSessionRegistry<E>(
  factory: SessionRuntimeFactory<E>,
): Effect.Effect<SessionRegistry<E>> {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const state = yield* Ref.make<RegistryState<E>>({ entries: new Map(), stopped: false });

    const selectEntry = (
      sessionId: string,
      requireFresh: boolean,
    ): Effect.Effect<
      EntrySelection<E>,
      SessionRegistryClosedError | SessionRegistrySessionExistsError
    > =>
      Semaphore.withPermit(
        gate,
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.stopped) return yield* new SessionRegistryClosedError();
          const existing = current.entries.get(sessionId);
          if (existing !== undefined) {
            if (requireFresh) return yield* new SessionRegistrySessionExistsError({ sessionId });
            return { entry: existing, owner: false };
          }
          const entry: RegistryEntry<E> = {
            runtime: yield* Deferred.make<SessionRuntime, E>(),
            scope: yield* Scope.make(),
          };
          const entries = new Map(current.entries);
          entries.set(sessionId, entry);
          yield* Ref.set(state, { ...current, entries });
          return { entry, owner: true };
        }),
      );

    const acquireSelection = (
      sessionId: string,
      selection: EntrySelection<E>,
    ): Effect.Effect<RegisteredSessionRuntime, E> =>
      selection.owner
        ? createEntry(factory, state, gate, sessionId, selection)
        : Deferred.await(selection.entry.runtime).pipe(Effect.map(facade));

    const create = (
      sessionId: string,
    ): Effect.Effect<
      RegisteredSessionRuntime,
      E | SessionRegistryClosedError | SessionRegistrySessionExistsError
    > =>
      selectEntry(sessionId, true).pipe(
        Effect.flatMap((selection) => acquireSelection(sessionId, selection)),
      );

    const getOrCreate = (
      sessionId: string,
    ): Effect.Effect<
      RegisteredSessionRuntime,
      E | SessionRegistryClosedError | SessionRegistrySessionExistsError
    > =>
      selectEntry(sessionId, false).pipe(
        Effect.flatMap((selection) => acquireSelection(sessionId, selection)),
      );

    const close = yield* memoizeClose(
      Semaphore.withPermit(
        gate,
        Ref.modify(
          state,
          (current): readonly [ReadonlyArray<RegistryEntry<E>>, RegistryState<E>] => [
            [...current.entries.values()],
            { ...current, stopped: true },
          ],
        ),
      ).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, cleanupEntry, { concurrency: "unbounded" }),
        ),
        Effect.flatMap((failureGroups) => {
          const failures = failureGroups.flat();
          return failures.length === 0
            ? Effect.void
            : Effect.fail(new SessionRegistryCleanupError({ failures }));
        }),
        Effect.ensuring(
          Semaphore.withPermit(
            gate,
            Ref.update(state, (current) => ({ ...current, entries: new Map() })),
          ),
        ),
      ),
    );

    return { create, getOrCreate, close };
  });
}

function createEntry<E>(
  factory: SessionRuntimeFactory<E>,
  state: Ref.Ref<RegistryState<E>>,
  gate: Semaphore.Semaphore,
  sessionId: string,
  selection: EntrySelection<E>,
): Effect.Effect<RegisteredSessionRuntime, E> {
  return Effect.uninterruptibleMask((restore) =>
    restore(
      factory(sessionId).pipe(Effect.provideService(Scope.Scope, selection.entry.scope)),
    ).pipe(
      Effect.exit,
      Effect.tap((exit) => Deferred.done(selection.entry.runtime, exit)),
      Effect.tap((exit) =>
        Exit.isFailure(exit)
          ? Semaphore.withPermit(
              gate,
              Ref.update(state, (current) => {
                if (current.entries.get(sessionId) !== selection.entry) return current;
                const entries = new Map(current.entries);
                entries.delete(sessionId);
                return { ...current, entries };
              }),
            ).pipe(Effect.andThen(Scope.close(selection.entry.scope, exit)))
          : Effect.void,
      ),
      Effect.andThen(Deferred.await(selection.entry.runtime)),
      Effect.map(facade),
    ),
  );
}

function cleanupEntry<E>(entry: RegistryEntry<E>): Effect.Effect<ReadonlyArray<unknown>> {
  return Effect.exit(Deferred.await(entry.runtime)).pipe(
    Effect.flatMap((creation) => {
      if (Exit.isFailure(creation)) {
        return Scope.close(entry.scope, creation).pipe(
          Effect.map((): ReadonlyArray<unknown> => []),
        );
      }
      return Effect.gen(function* () {
        const runtimeExit = yield* Effect.exit(creation.value.close);
        const scopeExit = yield* Effect.exit(Scope.close(entry.scope, Exit.void));
        return [runtimeExit, scopeExit].flatMap((exit) =>
          Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
        );
      });
    }),
  );
}

function facade(runtime: SessionRuntime): RegisteredSessionRuntime {
  return {
    startTurn: (input) => runtime.startTurn(input),
    steer: (input) => runtime.steer(input),
    interrupt: (input) => runtime.interrupt(input),
    resolveApproval: (input) => runtime.resolveApproval(input),
    waitForIdle: runtime.waitForIdle,
    subscribe: (input) => runtime.subscribe(input),
  };
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
