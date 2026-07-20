export const SESSION_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type TurnStatus = "completed" | "failed" | "interrupted";
export type ApprovalDecision = "approve" | "deny";

export interface FrozenTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface FrozenSessionSnapshot {
  /** The fully assembled, frozen system-prompt prefix, including SOUL.md and Memory. */
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<FrozenTool>;
}

export interface ThinkingContent {
  readonly type: "thinking";
  readonly thinking: string;
  readonly thinkingSignature?: string;
  readonly redacted?: boolean;
}

export interface TextContent {
  readonly type: "text";
  readonly text: string;
  readonly textSignature?: string;
}

export interface ToolCallContent {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly thoughtSignature?: string;
}

export type ModelContent = ThinkingContent | TextContent | ToolCallContent;

export interface ModelUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
}

export interface FinalModelResponse {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly content: ReadonlyArray<ModelContent>;
  readonly usage: ModelUsage;
  readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly errorMessage?: string;
  readonly timestamp: number;
}

export type SessionEvent =
  | {
      readonly type: "session-started";
      readonly sessionId: string;
      readonly snapshot: FrozenSessionSnapshot;
    }
  | {
      readonly type: "turn-started";
      readonly sessionId: string;
      readonly turnId: string;
      readonly message: string;
      readonly origin: "user" | "follow-up";
    }
  | {
      readonly type: "step-started";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly provider: string;
      readonly model: string;
    }
  | {
      readonly type: "model-chunk";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly contentIndex: number;
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly type: "model-response";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly response: FinalModelResponse;
    }
  | {
      readonly type: "tool-call";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonObject;
      readonly sourceIndex: number;
    }
  | {
      readonly type: "tool-result";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly toolCallId: string;
      readonly output: JsonValue;
      readonly isError: boolean;
      readonly sourceIndex: number;
    }
  | {
      readonly type: "step-ended";
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly status: TurnStatus;
    }
  | {
      readonly type: "turn-ended";
      readonly sessionId: string;
      readonly turnId: string;
      readonly status: TurnStatus;
    }
  | {
      readonly type: "steer-received";
      readonly sessionId: string;
      readonly turnId: string;
      readonly message: string;
    }
  | {
      readonly type: "follow-up-received";
      readonly sessionId: string;
      readonly turnId: string;
      readonly message: string;
    }
  | {
      readonly type: "interrupt-received";
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "approval-requested";
      readonly sessionId: string;
      readonly turnId: string;
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly prompt: string;
      readonly choices: ReadonlyArray<ApprovalDecision>;
    }
  | {
      readonly type: "approval-resolved";
      readonly sessionId: string;
      readonly turnId: string;
      readonly approvalId: string;
      readonly decision: ApprovalDecision;
    };

export interface SessionEnvelope {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly emittedAt: string;
  readonly event: SessionEvent;
}

export type ClientFeature = "modelChunks" | "approvalRequests";
export type ServerFeature = "sessionReplay" | "turnSteering" | "turnInterrupt" | "approvals";

export type ProtocolMethod =
  | "initialize"
  | "session/start"
  | "session/resume"
  | "session/list"
  | "session/subscribe"
  | "session/unsubscribe"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "approval/resolve";

export interface InitializeRequest {
  readonly client: { readonly name: string; readonly version: string };
  readonly features: ReadonlyArray<ClientFeature>;
}

export interface InitializeResponse {
  readonly protocolVersion: 1;
  readonly features: ReadonlyArray<ServerFeature>;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastSeq: number;
  readonly activeTurnId?: string;
}

export type SessionStartRequest = Record<never, never>;
export interface SessionStartResponse {
  readonly session: SessionSummary;
}

export interface SessionResumeRequest {
  readonly sessionId: string;
  readonly sinceSeq: number;
}

export interface SessionResumeResponse {
  readonly session: SessionSummary;
  readonly subscriptionId: string;
  readonly replayThroughSeq: number;
}

export type SessionListRequest = Record<never, never>;
export interface SessionListResponse {
  readonly sessions: ReadonlyArray<SessionSummary>;
}

export interface SessionSubscribeRequest {
  readonly sessionId: string;
  readonly sinceSeq: number;
}

export interface SessionSubscribeResponse {
  readonly subscriptionId: string;
  readonly replayThroughSeq: number;
}

export interface SessionUnsubscribeRequest {
  readonly subscriptionId: string;
}

export interface SessionUnsubscribeResponse {
  readonly unsubscribed: boolean;
}

export interface TurnStartRequest {
  readonly sessionId: string;
  readonly message: string;
}

export interface TurnStartResponse {
  readonly turnId: string;
  readonly disposition: "started" | "queued";
}

export interface TurnSteerRequest {
  readonly sessionId: string;
  readonly expectedTurnId: string;
  readonly message: string;
}

export interface TurnSteerResponse {
  readonly turnId: string;
}

export interface TurnInterruptRequest {
  readonly sessionId: string;
  readonly expectedTurnId: string;
}

export interface TurnInterruptResponse {
  readonly turnId: string;
}

/** Approval resolution is first-response-wins. */
export interface ApprovalResolveRequest {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
}

export interface ApprovalResolveResponse {
  readonly outcome: "resolved" | "already-resolved";
}
