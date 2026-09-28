import { Cause, Deferred, Effect, Exit } from "effect";
import type { UiResponseFrame, UiRequestId } from "../../domain/ui-gateway";
import { protocolFailure } from "./errors";

const MAX_CACHE = 512;

type Slot =
  | { readonly fingerprint: string; readonly pending: Deferred.Deferred<UiResponseFrame> }
  | { readonly fingerprint: string; readonly result: UiResponseFrame };

/** An idempotency slot stays addressable until its owner publishes an outcome. */
export const makeCommandCache = () => {
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

        const pending = yield* Deferred.make<UiResponseFrame>();
        slots.set(key, { fingerprint, pending });
        trim();

        const exit = yield* Effect.exit(restore(run));

        const result = Exit.isSuccess(exit)
          ? exit.value
          : {
              id,
              ok: false as const,
              error: protocolFailure(
                "internal",
                Cause.hasInterruptsOnly(exit.cause) ? "command interrupted" : "command failed",
              ),
            };

        // Publish before releasing the slot. Waiters already holding the Deferred always finish,
        // even if the owner was interrupted or the command died with a defect.
        yield* Deferred.succeed(pending, result);

        if (Exit.isSuccess(exit)) slots.set(key, { fingerprint, result });
        else slots.delete(key); // failed attempts may be retried with the same command id
        trim();

        return result;
      }),
    );
};
