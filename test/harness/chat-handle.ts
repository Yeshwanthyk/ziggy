/** A fake `ChatHandle` for unit tests: pass `prompt` and override what the test drives. */
import { Effect } from "effect";
import type { ChatHandle } from "ziggy/application/agent";
import { ProviderConfigError } from "ziggy/domain/agent";
import { AutomationConversationDeliveryFailed } from "ziggy/domain/automation";

const unsupportedLiveControl = (operation: string) =>
  Effect.fail(
    new ProviderConfigError({
      profilePath: "",
      operation,
      message: "live session controls are unavailable on this handle",
      cause: undefined,
    }),
  );

export const makeChatHandle = (
  methods: Pick<ChatHandle, "prompt"> & Partial<Omit<ChatHandle, "prompt">>,
): ChatHandle => ({
  isIdle: true,
  modelState: unsupportedLiveControl("read model"),
  setModel: () => unsupportedLiveControl("set model"),
  setThinkingLevel: () => unsupportedLiveControl("set thinking"),
  resume: () => unsupportedLiveControl("resume session"),
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
  subscribe: () => () => undefined,
  dispose: Effect.void,
  ...methods,
});
