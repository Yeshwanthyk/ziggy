import { Context, Effect, Layer } from "effect";
import type { AutomationTuiHandler } from "../adapters/pi/automation-tui";
import { PiAgent, type ChatSessionMode } from "../adapters/pi/pi-agent";
import type {
  ChatModelOverride,
  ChatNotStreaming,
  OpenTuiError,
  ProfileAgentRunContext,
  ProfileAgentRunResult,
  ProfileSpecialistError,
  ZiggyAgentError,
} from "../domain/agent";
import type { ChatContext } from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";

export interface ChatPromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type ChatEvent =
  | {
      readonly kind: "assistant-text";
      readonly delta: string;
      readonly snapshot: string;
    }
  | {
      readonly kind: "thinking";
      readonly delta: string;
    }
  | {
      readonly kind: "tool";
      readonly phase: "start" | "update" | "end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly failed: boolean;
      readonly detail?: string;
    }
  | {
      readonly kind: "voice";
      readonly agentId: string;
      readonly text: string;
    }
  | { readonly kind: "settled" }
  | { readonly kind: "error"; readonly message: string };

export type ChatProgressEvent = Extract<ChatEvent, { kind: "assistant-text" | "tool" | "voice" }>;

export const formatSpecialistVoice = (agentId: string, text: string): string =>
  `**${agentId}:**\n${text}`;

export interface ChatPromptOptions {
  readonly images?: Array<ChatPromptImage>;
  /** Context for only this provider turn. It is not added to the persisted user message. */
  readonly ephemeralContext?: string;
  readonly onProgress?: (event: ChatProgressEvent) => void;
}

export interface ChatHandle {
  readonly isIdle: boolean;
  readonly prompt: (
    text: string,
    options?: ChatPromptOptions,
  ) => Effect.Effect<string, ZiggyAgentError>;
  readonly abort: Effect.Effect<void, ZiggyAgentError>;
  readonly steer: (text: string) => Effect.Effect<void, ZiggyAgentError | ChatNotStreaming>;
  readonly followUp: (text: string) => Effect.Effect<void, ZiggyAgentError | ChatNotStreaming>;
  readonly subscribe: (listener: (event: ChatEvent) => void) => () => void;
  readonly dispose: Effect.Effect<void, ZiggyAgentError>;
}

export const makeChatHandle = (
  methods: Pick<ChatHandle, "prompt"> & Partial<Omit<ChatHandle, "prompt">>,
): ChatHandle => ({
  isIdle: true,
  abort: Effect.void,
  steer: () => Effect.void,
  followUp: () => Effect.void,
  subscribe: () => () => undefined,
  dispose: Effect.void,
  ...methods,
});

export interface ZiggyAgentApi {
  readonly runOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openTui: (
    target: ProfileTarget,
    context: ChatContext,
    automationHandler?: AutomationTuiHandler,
  ) => Effect.Effect<number, OpenTuiError>;
  readonly openChat: (
    target: ProfileTarget,
    context: ChatContext,
    sessionDirectory: string,
    sessionMode?: ChatSessionMode,
    modelOverride?: ChatModelOverride,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError>;
  readonly openSpecialistChat: (
    target: ProfileTarget,
    agentId: string,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError | ProfileSpecialistError>;
  readonly runSpecialist: (
    target: ProfileTarget,
    agentId: string,
    task: string,
    context: ProfileAgentRunContext,
  ) => Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError>;
}

export class ZiggyAgent extends Context.Service<ZiggyAgent, ZiggyAgentApi>()("ziggy/ZiggyAgent") {}

export const ZiggyAgentLive = Layer.effect(
  ZiggyAgent,
  Effect.gen(function* () {
    const piAgent = yield* PiAgent;
    return {
      runOnce: (
        target: ProfileTarget,
        prompt: string,
        continueSession: boolean,
        context: ChatContext,
      ) => piAgent.askOnce(target, prompt, continueSession, context),
      openTui: (
        target: ProfileTarget,
        context: ChatContext,
        automationHandler?: AutomationTuiHandler,
      ) => piAgent.openTui(target, context, automationHandler),
      openChat: (
        target: ProfileTarget,
        context: ChatContext,
        sessionDirectory: string,
        sessionMode?: ChatSessionMode,
        modelOverride?: ChatModelOverride,
      ) => piAgent.openChat(target, context, sessionDirectory, sessionMode, modelOverride),
      openSpecialistChat: (target, agentId) => piAgent.openSpecialistChat(target, agentId),
      runSpecialist: (target, agentId, task, context) =>
        piAgent.runSpecialist(target, agentId, task, context),
    };
  }),
);
