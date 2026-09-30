import { Context, Effect, Schema } from "effect";
import type {
  ChatModelOverride,
  ChatNotStreaming,
  ProfileAgentRunContext,
  ProfileAgentRunResult,
  ProfileSpecialistError,
  SessionReference,
  ZiggyAgentError,
} from "../domain/agent";
import type { ProfileAgentThinking } from "../domain/profile";
import type {
  AutomationConversationDeliveryFailed,
  AutomationConversationResult,
} from "../domain/automation";
import type { ProfileTarget } from "../profile";

/** Who a conversation is with: the local owner, one person, or a group. */
export type ChatContext =
  | { readonly kind: "local" }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "group"; readonly groupId: string };

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
  | { readonly kind: "session-state"; readonly scope: "transcript" | "model" }
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
  /** Switches to the Profile session with this id. */
  readonly resume: (
    id: string,
  ) => Effect.Effect<ChatResumeResult, ZiggyAgentError | SessionReadFailed | SessionNotFound>;
  readonly isIdle: boolean;
  /** The current persisted Pi transcript identity, resolved at read time. */
  readonly currentSession: Effect.Effect<SessionReference | undefined, ZiggyAgentError>;
  readonly appendAutomationResult: (
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

/** Everything needed to open a live Profile session. */
export interface OpenSession {
  readonly target: ProfileTarget;
  readonly context: ChatContext;
  /** Where the transcript lives; `continue` resumes the most recent one there. */
  readonly directory: string;
  readonly session: "new" | "continue";
  /** Talk to this Profile agent instead of the Profile itself. */
  readonly agent?: string;
  readonly model?: ChatModelOverride;
  /** Transcript name, set on the first prompt if the transcript has none. */
  readonly name?: string | undefined;
}

export interface ZiggyAgentApi {
  readonly open: (
    request: OpenSession,
  ) => Effect.Effect<ChatHandle, ZiggyAgentError | ProfileSpecialistError>;
  readonly runOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
    context: ChatContext,
    options?: RunOnceOptions,
  ) => Effect.Effect<number, ZiggyAgentError>;
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

// ── Stored transcripts, read back by store.ts ─────────────────────────────────

export interface SessionReferenceMetadata {
  readonly id: string;
  readonly path: string;
}

export interface SessionModelChange {
  readonly at: string;
  readonly provider: string;
  readonly model: string;
}

export interface SessionThinkingChange {
  readonly at: string;
  readonly level: string;
}

export interface SessionUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: number;
}

/** Read-only list projection. */
export interface ProfileSessionSummary {
  readonly id: string;
  readonly path: string;
  readonly title: string | undefined;
  readonly updatedAt: string;
}

export interface SessionMetadata {
  readonly path: string;
  readonly id: string;
  readonly name?: string;
  readonly kind: "root" | "child";
  readonly createdAt: string;
  /** Latest persisted conversation message timestamp; metadata-only entries do not advance it. */
  readonly activityAt?: string;
  readonly entryCount: number;
  readonly parent: SessionReferenceMetadata | undefined;
  readonly parentUnknown: boolean;
  readonly children: ReadonlyArray<SessionReferenceMetadata>;
  readonly modelChanges: ReadonlyArray<SessionModelChange>;
  readonly thinkingChanges: ReadonlyArray<SessionThinkingChange>;
  readonly usage: SessionUsage;
  readonly terminalState: SessionTerminalState;
}

export class SessionReadFailed extends Schema.TaggedErrorClass<SessionReadFailed>()(
  "SessionReadFailed",
  {
    path: Schema.String,
    operation: Schema.Literals(["inspect-root", "walk", "read", "decode", "resolve"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  reference: Schema.String,
  message: Schema.String,
}) {}

export const SessionHistoryTerminalState = Schema.Literals([
  "completed",
  "aborted",
  "failed",
  "incomplete",
]);

export type SessionHistoryTerminalState = typeof SessionHistoryTerminalState.Type;

export type SessionTerminalState = SessionHistoryTerminalState;

export type SessionHistoryEntry =
  | {
      readonly kind: "user" | "assistant";
      readonly timestamp: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool";
      readonly timestamp: string;
      readonly phase: "start" | "end";
      readonly toolName: string;
      readonly failed: boolean;
    }
  | {
      readonly kind: "automation-result";
      readonly timestamp: string;
      readonly automationId: string;
      readonly runId: string;
      readonly text: string;
    };

export interface SessionHistoryPage {
  readonly entries: ReadonlyArray<SessionHistoryEntry>;
  readonly terminalState: SessionHistoryTerminalState;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export class SessionHistoryCursorInvalid extends Schema.TaggedErrorClass<SessionHistoryCursorInvalid>()(
  "SessionHistoryCursorInvalid",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}
