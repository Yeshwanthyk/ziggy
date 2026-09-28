import { Context, Effect, Layer } from "effect";
import { PiAgent, type ChatSessionMode } from "../adapters/pi/pi-agent";
import { makePiSessionRuntime } from "../adapters/pi/runtime";
import type {
  ChatModelOverride,
  ChatNotStreaming,
  ProfileAgentRunContext,
  ProfileAgentRunResult,
  ProfileSpecialistError,
  SessionReference,
  ZiggyAgentError,
} from "../domain/agent";
import { ProviderConfigError } from "../domain/agent";
import type { ChatContext } from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";
import type { ProfileAgentThinking } from "../domain/profile";
import type { SessionNotFound, SessionReadFailed } from "../domain/session";
import type {
  AutomationConversationDeliveryFailed,
  AutomationConversationResult,
} from "../domain/automation";

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
  | {
      readonly kind: "automation-result";
      readonly automationId: string;
      readonly runId: string;
      readonly text: string;
      readonly timestamp: string;
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

export interface ChatSessionModelState {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinking: ProfileAgentThinking;
}

export interface ChatResumeResult {
  readonly cancelled: boolean;
}

export interface ChatHandle {
  /** Live session state; changing it never persists a Profile-wide default. */
  readonly modelState: Effect.Effect<ChatSessionModelState, ZiggyAgentError>;
  readonly setModel: (
    providerId: string,
    modelId: string,
  ) => Effect.Effect<ChatSessionModelState, ZiggyAgentError>;
  readonly setThinkingLevel: (
    level: ProfileAgentThinking,
  ) => Effect.Effect<ChatSessionModelState, ZiggyAgentError>;
  /** Accepts a Profile session id or a path relative to its sessions directory. */
  readonly resume: (
    reference: string,
  ) => Effect.Effect<ChatResumeResult, ZiggyAgentError | SessionReadFailed | SessionNotFound>;
  readonly isIdle: boolean;
  /** The current persisted Pi transcript identity, resolved at read time. */
  readonly currentSession?: Effect.Effect<SessionReference | undefined, ZiggyAgentError>;
  readonly appendAutomationResult?: (
    result: AutomationConversationResult,
  ) => Effect.Effect<boolean, AutomationConversationDeliveryFailed>;
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
    options?: RunOnceOptions,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openChat: (
    target: ProfileTarget,
    context: ChatContext,
    sessionDirectory: string,
    sessionMode?: ChatSessionMode,
    modelOverride?: ChatModelOverride,
    sessionName?: string,
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

export interface RunOnceOptions {
  readonly mode?: "text" | "json";
  readonly sessionPath?: string;
}

export class ZiggyAgent extends Context.Service<ZiggyAgent, ZiggyAgentApi>()("ziggy/ZiggyAgent") {}

export const ZiggyAgentLive = Layer.effect(
  ZiggyAgent,
  Effect.gen(function* () {
    const piAgent = yield* PiAgent;
    const runtime = makePiSessionRuntime(piAgent);

    return {
      runOnce: (
        target: ProfileTarget,
        prompt: string,
        continueSession: boolean,
        context: ChatContext,
        options?: RunOnceOptions,
      ) => piAgent.askOnce(target, prompt, continueSession, context, options),
      openChat: (
        target: ProfileTarget,
        context: ChatContext,
        sessionDirectory: string,
        sessionMode?: ChatSessionMode,
        modelOverride?: ChatModelOverride,
        sessionName?: string,
      ) => runtime.open(target, context, sessionDirectory, sessionMode, modelOverride, sessionName),
      openSpecialistChat: (target, agentId) => piAgent.openSpecialistChat(target, agentId),
      runSpecialist: (target, agentId, task, context) =>
        piAgent.runSpecialist(target, agentId, task, context),
    };
  }),
);
