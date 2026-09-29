import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Semaphore } from "effect";
import { SessionBusy } from "../../domain/agent";
import type { makeSessionLeaseTransitions } from "./session-lease";
import { readSessionHeaderOnly } from "./session-discovery";

interface NavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface ChatRuntimeBinding {
  readonly switchSession: AgentSessionRuntime["switchSession"];
  readonly switchSessionUnderControl: AgentSessionRuntime["switchSession"];
  readonly withControl: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly withSessionSwitch: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly isSwitching: () => boolean;
  readonly onRebind: (callback: () => void) => () => void;
}

export const bindChatRuntime = async (
  runtime: AgentSessionRuntime,
  lease?: ReturnType<typeof makeSessionLeaseTransitions>,
): Promise<ChatRuntimeBinding> => {
  const semaphore = Semaphore.makeUnsafe(1);

  const rebindListeners = new Set<() => void>();
  let switching = false;

  const serialized = <A>(operation: () => Promise<A>): Promise<A> =>
    switching
      ? Promise.reject(
          new SessionBusy({
            profilePath: runtime.session.sessionManager.getCwd(),
            message: "session is switching; wait for the resume to finish",
          }),
        )
      : // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
        Effect.runPromise(
          semaphore.withPermit(Effect.tryPromise({ try: operation, catch: (cause) => cause })),
        );

  let invalidatedSession: AgentSessionRuntime["session"] | undefined;
  runtime.setBeforeSessionInvalidate(() => {
    invalidatedSession = runtime.session;
  });

  const replacementFailed = async (previous: AgentSessionRuntime["session"]): Promise<void> => {
    if (lease === undefined) return;

    if (runtime.session !== previous || invalidatedSession === previous) lease.poison();

    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
    await Effect.runPromise(lease.cancelReservation);
  };

  const switchSessionUnserialized: AgentSessionRuntime["switchSession"] = async (
    sessionPath,
    options,
  ) => {
    const previous = runtime.session;

    if (lease !== undefined) {
      // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
      const id = (await Effect.runPromise(readSessionHeaderOnly(sessionPath))).id;

      // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
      await Effect.runPromise(lease.reserve(id));
    }

    try {
      const result = await runtime.switchSession(sessionPath, options);

      if (lease !== undefined) {
        // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
        await Effect.runPromise(
          result.cancelled
            ? lease.cancelReservation
            : lease.transition(runtime.session.sessionManager.getSessionId()),
        );
      }

      return result;
    } catch (cause) {
      await replacementFailed(previous);
      throw cause;
    }
  };

  const switchSession: AgentSessionRuntime["switchSession"] = (sessionPath, options) =>
    serialized(() => switchSessionUnserialized(sessionPath, options));

  const bindSession = async (): Promise<void> => {
    const session = runtime.session;

    for (const listener of rebindListeners) listener();

    await session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) =>
          serialized(async () => {
            const previous = runtime.session;
            let result: Awaited<ReturnType<typeof runtime.newSession>>;

            try {
              result = await runtime.newSession(options);
            } catch (cause) {
              await replacementFailed(previous);
              throw cause;
            }

            if (lease !== undefined) {
              // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
              await Effect.runPromise(
                result.cancelled
                  ? lease.cancelReservation
                  : lease.transition(runtime.session.sessionManager.getSessionId()),
              );
            }

            return result;
          }),
        fork: (entryId, options) =>
          serialized(async () => {
            const previous = runtime.session;
            let result: Awaited<ReturnType<typeof runtime.fork>>;

            try {
              result = await runtime.fork(entryId, options);
            } catch (cause) {
              await replacementFailed(previous);
              throw cause;
            }

            if (lease !== undefined) {
              // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi callback bridge.
              await Effect.runPromise(
                result.cancelled
                  ? lease.cancelReservation
                  : lease.transition(runtime.session.sessionManager.getSessionId()),
              );
            }

            return { cancelled: result.cancelled };
          }),
        navigateTree: async (targetId, options) => {
          if (
            options?.summarize === undefined &&
            options?.customInstructions === undefined &&
            options?.replaceInstructions === undefined &&
            options?.label === undefined
          ) {
            const result = await session.navigateTree(targetId);

            return { cancelled: result.cancelled };
          }

          const navigateOptions: NavigateTreeOptions = {};

          if (options?.summarize !== undefined) navigateOptions.summarize = options.summarize;

          if (options?.customInstructions !== undefined) {
            navigateOptions.customInstructions = options.customInstructions;
          }

          if (options?.replaceInstructions !== undefined) {
            navigateOptions.replaceInstructions = options.replaceInstructions;
          }

          if (options?.label !== undefined) navigateOptions.label = options.label;
          const result = await session.navigateTree(targetId, navigateOptions);

          return { cancelled: result.cancelled };
        },
        switchSession,
        reload: () => session.reload(),
      },
      onError: (error) => {
        console.error(`Extension error (${error.extensionPath}): ${error.error}`);
      },
    });
  };

  runtime.setRebindSession(bindSession);
  await bindSession();

  return {
    switchSession,
    switchSessionUnderControl: switchSessionUnserialized,
    withControl: (effect) => semaphore.withPermit(effect),
    withSessionSwitch: (effect) =>
      semaphore.withPermit(
        Effect.sync(() => {
          switching = true;
        }).pipe(
          Effect.andThen(effect),
          Effect.ensuring(
            Effect.sync(() => {
              switching = false;
            }),
          ),
        ),
      ),
    isSwitching: () => switching,
    onRebind: (callback) => {
      rebindListeners.add(callback);

      return () => {
        rebindListeners.delete(callback);
      };
    },
  };
};
