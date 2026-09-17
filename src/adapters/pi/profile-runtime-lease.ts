import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  ProfileExtensionLockFailed,
  ProfileExtensionRollbackFailed,
} from "../../domain/profile-extension";
import { acquireProfileRuntimeLease } from "../bun/profile-runtime-lock";
import { hasPendingExtensionUpdates } from "../fs/extension-update";

const failedDisposalLeases = new Set<
  Effect.Success<ReturnType<typeof acquireProfileRuntimeLease>>
>();

const isRollbackFailure = Schema.is(ProfileExtensionRollbackFailed);

/** Keep package paths pinned until Pi has stopped its tools and disposed its extensions. */
export const leaseProfileRuntime = <
  A extends {
    dispose: () => Promise<void>;
    session: Pick<AgentSessionRuntime["session"], "abort">;
  },
  E,
  R,
>(
  profilePath: string,
  create: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProfileExtensionLockFailed, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const lease = yield* acquireProfileRuntimeLease(profilePath);
      let handedOff = false;

      const release = Effect.try({
        try: lease.release,
        catch: (cause) =>
          new ProfileExtensionLockFailed({
            profilePath,
            operation: "release",
            message: "could not release runtime lease",
            cause,
          }),
      });

      return yield* Effect.gen(function* () {
        const pending = yield* hasPendingExtensionUpdates(profilePath).pipe(
          Effect.mapError(
            (cause) =>
              new ProfileExtensionLockFailed({
                profilePath,
                operation: "acquire",
                message: "could not inspect pending extension updates",
                cause,
              }),
          ),
        );

        if (pending)
          return yield* new ProfileExtensionLockFailed({
            profilePath,
            operation: "acquire",
            message:
              "Profile has an unfinished extension update; recover it before starting a runtime",
            cause: undefined,
          });

        // Pi's construction Promise has no cancellation contract. Let it settle before releasing
        // the lease, then honor interruption and dispose before any caller can use the runtime.
        const runtime = yield* create.pipe(
          Effect.tapError((cause) =>
            Effect.sync(() => {
              if (isRollbackFailure(cause)) {
                // Failed shutdown cannot prove extensions stopped. Keep the lease alive until exit.
                handedOff = true;
                failedDisposalLeases.add(lease);
              }
            }),
          ),
        );

        const originalDispose = runtime.dispose.bind(runtime);
        let disposal: Promise<void> | undefined;
        runtime.dispose = () => {
          disposal ??= (async () => {
            // Retain ownership even if a caller drops a runtime whose shutdown rejects.
            failedDisposalLeases.add(lease);
            await runtime.session.abort();
            await originalDispose();
            lease.release();
            failedDisposalLeases.delete(lease);
          })();

          return disposal;
        };

        handedOff = true;

        const ready = yield* restore(Effect.succeed(runtime)).pipe(
          Effect.onInterrupt(() =>
            Effect.tryPromise({
              try: () => runtime.dispose(),
              catch: (cause) =>
                new ProfileExtensionLockFailed({
                  profilePath,
                  operation: "release",
                  message: "could not dispose interrupted runtime",
                  cause,
                }),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Interrupted runtime disposal failed", { cause }),
              ),
            ),
          ),
        );

        return ready;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            handedOff
              ? Effect.void
              : release.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Runtime lease cleanup failed", { cause }),
                  ),
                ),
          ),
        ),
      );
    }),
  );
