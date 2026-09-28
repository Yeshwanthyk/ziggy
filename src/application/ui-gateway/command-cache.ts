import { Cause, Deferred, Effect, Exit, Option, Scope } from "effect";
import type { UiResponseFrame, UiRequestId } from "../../domain/ui-gateway";
import { protocolFailure } from "./errors";

const MAX_CACHE = 512;

type Slot =
  | { readonly fingerprint: string; readonly pending: Deferred.Deferred<UiResponseFrame> }
  | { readonly fingerprint: string; readonly result: UiResponseFrame };

/** One gateway-owned scope outlives every connection, but closes with the UI server scope. */
export const makeCommandCache = () => {
  const slots = new Map<string, Slot>();
  const scope = Scope.makeUnsafe();
  let registered = false;
  let closed = false;

  const trim = () => {
    for (const [key, slot] of slots) {
      if (slots.size <= MAX_CACHE) break;

      if ("result" in slot) slots.delete(key);
    }
  };

  return <E, R>(
    key: string,
    fingerprint: string,
    id: UiRequestId,
    run: Effect.Effect<UiResponseFrame, E, R>,
  ): Effect.Effect<UiResponseFrame, ReturnType<typeof protocolFailure>, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // In production the UI server supplies its scope. Tests that call the gateway directly
        // have no server lifecycle; their short-lived commands complete without an owner scope.
        const serverScope = yield* Effect.serviceOption(Scope.Scope);

        if (!registered && Option.isSome(serverScope)) {
          yield* Scope.addFinalizer(
            serverScope.value,
            Effect.sync(() => {
              closed = true;
            }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
          );
          registered = true;
        }

        if (closed) return yield* Effect.fail(protocolFailure("internal", "UI server stopped"));

        const existing = slots.get(key);

        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint)
            return yield* Effect.fail(
              protocolFailure("conflict", "command id was already used for a different request"),
            );

          if ("result" in existing) return existing.result;

          return yield* restore(Deferred.await(existing.pending));
        }

        // No yield between lookup and insert: simultaneous callers cannot both claim this key.
        const pending = Deferred.makeUnsafe<UiResponseFrame>();
        slots.set(key, { fingerprint, pending });
        trim();

        yield* Effect.forkIn(
          Effect.uninterruptibleMask((restoreRun) =>
            Effect.gen(function* () {
              const exit = yield* Effect.exit(restoreRun(run));

              const result: UiResponseFrame = Exit.isSuccess(exit)
                ? exit.value
                : {
                    id,
                    ok: false,
                    error: protocolFailure(
                      "internal",
                      Cause.hasInterruptsOnly(exit.cause)
                        ? "command interrupted"
                        : "command failed",
                    ),
                  };

              // Failure frames (including typed failures mapped by dispatch) are retryable.
              // Only successful responses represent a completed idempotent command.
              slots.delete(key);

              if (result.ok) slots.set(key, { fingerprint, result });
              trim();
              yield* Deferred.succeed(pending, result);
            }),
          ),
          scope,
          { uninterruptible: false },
        );

        return yield* restore(Deferred.await(pending));
      }),
    );
};
