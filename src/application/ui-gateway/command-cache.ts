import { Cause, Deferred, Effect, Exit, Schema, Scope } from "effect";
import type { UiResponseFrame, UiRequestId } from "../../domain/ui-gateway";
import { protocolFailure } from "./errors";

export const safeFingerprint = (value: Schema.Json): string => JSON.stringify(value);

const MAX_CACHE = 512;

type Slot =
  | { readonly fingerprint: string; readonly pending: Deferred.Deferred<UiResponseFrame> }
  | { readonly fingerprint: string; readonly result: UiResponseFrame };

/** The caller supplies the gateway's child scope; no request fiber owns a command. */
export const makeCommandCache = (scope: Scope.Scope) => {
  const slots = new Map<string, Slot>();

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
        // Pending slots can exceed the completed-result cache cap. The UI server bounds each
        // socket to UI_SERVER_MAX_IN_FLIGHT requests and bounds its queue; the aggregate still
        // scales with the number of connected sockets, so pending slots must never be evicted.
        const pending = Deferred.makeUnsafe<UiResponseFrame>();
        slots.set(key, { fingerprint, pending });
        trim();

        yield* Effect.forkIn(
          Effect.gen(function* () {
            // The child starts masked, including when interrupted before its first instruction.
            // Only the actual command is interruptible; publication always finishes.
            const exit = yield* Effect.exit(Effect.interruptible(run));

            const result: UiResponseFrame = Exit.isSuccess(exit)
              ? exit.value
              : {
                  id,
                  ok: false,
                  error: protocolFailure(
                    "internal",
                    Cause.hasInterruptsOnly(exit.cause) ? "command interrupted" : "command failed",
                  ),
                };

            // Typed failure frames are retryable; cache only successful responses.
            slots.delete(key);

            if (result.ok) slots.set(key, { fingerprint, result });
            trim();
            yield* Deferred.succeed(pending, result);
          }),
          scope,
          { uninterruptible: true },
        );

        return yield* restore(Deferred.await(pending));
      }),
    );
};
