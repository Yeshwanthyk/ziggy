/** A fake `ChatHandle` for unit tests: pass `prompt` and override what the test drives. */
import { Effect } from "effect";
import type { ChatHandle } from "ziggy/session/index";
import { AutomationConversationDeliveryFailed } from "ziggy/domain/automation";
import { ProviderConfigError } from "ziggy/profile/index";

const unsupportedLiveControl = (operation: string) =>
  Effect.fail(
    new ProviderConfigError({
      profilePath: "",
      operation,
      message: "live session controls are unavailable on this handle",
      cause: undefined,
    }),
  );

/** Like the real handle, a completed `resume` tells subscribers the transcript changed. */
export const makeChatHandle = (
  methods: Pick<ChatHandle, "prompt"> & Partial<Omit<ChatHandle, "prompt">>,
): ChatHandle => {
  const listeners = new Set<Parameters<ChatHandle["subscribe"]>[0]>();
  const resume = methods.resume;

  return {
    isIdle: true,
    modelState: unsupportedLiveControl("read model"),
    setModel: () => unsupportedLiveControl("set model"),
    setThinkingLevel: () => unsupportedLiveControl("set thinking"),
    currentSession: Effect.succeed(undefined),
    appendAutomationResult: () =>
      Effect.fail(
        new AutomationConversationDeliveryFailed({
          category: "owner-unavailable",
          retriable: true,
          message: "this fake handle cannot accept automation results",
        }),
      ),
    abort: Effect.void,
    steer: () => Effect.void,
    followUp: () => Effect.void,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    dispose: Effect.void,
    ...methods,
    resume: (reference) =>
      resume === undefined
        ? unsupportedLiveControl("resume session")
        : resume(reference).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result.cancelled) return;

                for (const listener of listeners)
                  listener({ kind: "session-state", scope: "transcript" });
              }),
            ),
          ),
  };
};
