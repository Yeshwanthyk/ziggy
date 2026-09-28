import { Effect } from "effect";
import type { ChatEvent, ChatHandle, ChatPromptOptions } from "../../application/agent";
import type { ChatModelOverride, ChatNotStreaming, ZiggyAgentError } from "../../domain/agent";
import type { ChatContext } from "../../domain/memory";
import type { ProfileTarget } from "../../domain/profile";
import type { ChatSessionMode, PiAgentApi } from "./pi-agent";

/** One headless Pi session. The handle owns its lifetime; close releases its writer lease. */
export interface RuntimeSession {
  readonly prompt: (
    text: string,
    options?: ChatPromptOptions,
  ) => Effect.Effect<string, ZiggyAgentError>;
  readonly steer: (text: string) => Effect.Effect<void, ZiggyAgentError | ChatNotStreaming>;
  readonly abort: Effect.Effect<void, ZiggyAgentError>;
  readonly events: (listener: (event: ChatEvent) => void) => () => void;
  readonly close: Effect.Effect<void, ZiggyAgentError>;
}

export interface SessionRuntime {
  readonly open: (
    target: ProfileTarget,
    context: ChatContext,
    directory: string,
    mode?: ChatSessionMode,
    model?: ChatModelOverride,
    name?: string,
  ) => Effect.Effect<RuntimeSession, ZiggyAgentError>;
}

export const runtimeSessionFromChat = (handle: ChatHandle) => ({
  ...handle,
  get isIdle() {
    return handle.isIdle;
  },
  events: handle.subscribe,
  close: handle.dispose,
});

/** Pi is the sole implementation; no presence or broadcast capability belongs here. */
export const makePiSessionRuntime = (pi: PiAgentApi) =>
  ({
    open: (target, context, directory, mode, model, name) =>
      pi
        .openChat(target, context, directory, mode, model, name)
        .pipe(Effect.map(runtimeSessionFromChat)),
  }) satisfies SessionRuntime;
