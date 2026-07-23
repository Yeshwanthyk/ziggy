export const SESSION_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 2;
export const MAIN_SESSION_ID = "main";

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
export type ServerFeature =
  | "sessionReplay"
  | "turnSteering"
  | "turnInterrupt"
  | "approvals"
  | "stableMainSession"
  | "providerAuth"
  | "extensionLifecycle";

export const BASE_SERVER_FEATURES: ReadonlyArray<ServerFeature> = [
  "sessionReplay",
  "turnSteering",
  "turnInterrupt",
  "approvals",
  "stableMainSession",
];

export function negotiateServerFeatures(
  providerAuth: boolean,
  extensionLifecycle = false,
): ReadonlyArray<ServerFeature> {
  const extensionFeatures: ReadonlyArray<ServerFeature> = extensionLifecycle
    ? ["extensionLifecycle"]
    : [];
  const authFeatures: ReadonlyArray<ServerFeature> = providerAuth ? ["providerAuth"] : [];
  return [...BASE_SERVER_FEATURES, ...extensionFeatures, ...authFeatures];
}

export type ProtocolMethod =
  | "initialize"
  | "auth/login"
  | "auth/respond"
  | "auth/status"
  | "session/start"
  | "session/ensure"
  | "session/resume"
  | "session/list"
  | "session/subscribe"
  | "session/unsubscribe"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "approval/resolve"
  | "extension/install"
  | "extension/enable"
  | "extension/disable"
  | "extension/list"
  | "extension/doctor";

export interface InitializeRequest {
  readonly client: { readonly name: string; readonly version: string };
  readonly features: ReadonlyArray<ClientFeature>;
}

export interface InitializeResponse {
  readonly protocolVersion: 2;
  readonly features: ReadonlyArray<ServerFeature>;
}

export type AuthType = "api_key" | "oauth";
export interface AuthStatus {
  readonly providerId: string;
  readonly configured: boolean;
  readonly type?: AuthType;
  readonly source?: string;
}
export interface AuthLoginRequest {
  readonly providerId: string;
  readonly type: AuthType;
}
export interface AuthLoginResponse {
  readonly status: AuthStatus;
}
export interface AuthRespondRequest {
  readonly loginId: string;
  readonly promptId: string;
  readonly value: string;
}
export interface AuthRespondResponse {
  readonly accepted: true;
}
export interface AuthStatusRequest {
  readonly providerId?: string;
}
export interface AuthStatusResponse {
  readonly providers: ReadonlyArray<AuthStatus>;
}

export type AuthPromptEvent =
  | {
      readonly kind: "text" | "secret" | "manual_code";
      readonly promptId: string;
      readonly message: string;
      readonly placeholder?: string;
    }
  | {
      readonly kind: "select";
      readonly promptId: string;
      readonly message: string;
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }>;
    };
export type AuthNotifyEvent =
  | { readonly kind: "info" | "progress"; readonly message: string }
  | { readonly kind: "auth_url"; readonly url: string; readonly instructions?: string }
  | { readonly kind: "device_code"; readonly userCode: string; readonly verificationUri: string }
  | { readonly kind: "prompt_cancelled"; readonly promptId: string };
export interface ServerAuthFrame {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly type: "auth";
  readonly requestId: string;
  readonly loginId: string;
  readonly event: AuthPromptEvent | AuthNotifyEvent;
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

export interface SessionEnsureRequest {
  readonly sessionId: typeof MAIN_SESSION_ID;
}

export interface SessionEnsureResponse {
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

export type ExtensionTrustTier = "builtin" | "verified" | "community";
export type ExtensionEntryKind = "tool" | "setup" | "doctor" | "command";

interface ExtensionApprovalRequirementBase {
  readonly fingerprint: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly entryId: string;
  readonly argv: ReadonlyArray<string>;
  readonly permissions: {
    readonly network: boolean;
    readonly filesystem: "none" | "profile" | "full";
    readonly secrets: ReadonlyArray<string>;
  };
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly trustTier: ExtensionTrustTier;
  readonly treeDigest: string;
  readonly epoch: number;
}
export type ExtensionApprovalRequirement =
  | (ExtensionApprovalRequirementBase & {
      readonly entryKind: "tool" | "setup" | "doctor";
    })
  | (ExtensionApprovalRequirementBase & {
      readonly entryKind: "command";
      readonly argumentMode: "none" | "append";
      readonly cwd: "extension" | "profile";
      readonly timeoutMs: number;
    });

export interface ExtensionObservation {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trustTier: ExtensionTrustTier;
  readonly treeDigest: string;
  readonly approvalEpoch: number;
  readonly health: "ready" | "mutated" | "invalid";
  readonly message?: string;
}

export interface ExtensionInstallRequest {
  readonly sourcePath: string;
  readonly approvals: ReadonlyArray<string>;
  readonly verification?: {
    readonly keyId: string;
    readonly signature: string;
  };
}

export type ExtensionInstallResponse =
  | {
      readonly status: "approval-required";
      readonly extensionId: string;
      readonly requirements: ReadonlyArray<ExtensionApprovalRequirement>;
    }
  | { readonly status: "installed"; readonly extension: ExtensionObservation };

export interface ExtensionEnableRequest {
  readonly extensionId: string;
  readonly approvals: ReadonlyArray<string>;
}

export type ExtensionEnableResponse =
  | {
      readonly status: "approval-required";
      readonly extensionId: string;
      readonly requirements: ReadonlyArray<ExtensionApprovalRequirement>;
    }
  | { readonly status: "enabled"; readonly extension: ExtensionObservation };

export interface ExtensionDisableRequest {
  readonly extensionId: string;
}

export interface ExtensionDisableResponse {
  readonly extension: ExtensionObservation;
}

export type ExtensionListRequest = Record<never, never>;
export interface ExtensionListResponse {
  readonly extensions: ReadonlyArray<ExtensionObservation>;
}

export interface ExtensionDoctorRequest {
  readonly extensionId: string;
  readonly approval?: string;
}

export type ExtensionDoctorResponse =
  | {
      readonly status: "approval-required";
      readonly extensionId: string;
      readonly requirements: ReadonlyArray<ExtensionApprovalRequirement>;
    }
  | {
      readonly status: "ok" | "failed" | "timeout";
      readonly extension: ExtensionObservation;
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly truncated: boolean;
    };

/**
 * Attach-protocol NDJSON framing (S2 experiment). The codec is transport-agnostic and owns no
 * connection state, Session registry, replay ordering, or transport behavior. Frame schema
 * version is stamped with PROTOCOL_VERSION so on-wire frames fail loud on mismatch, mirroring
 * the Session NDJSON stamp. The Session-event frame carries the canonical SessionEnvelope
 * unchanged as its payload; it does not create a second event sequence authority.
 */

/**
 * Closed union of error codes the sole ServerErrorFrame may carry. Covers both codec-level
 * rejections (the codes a typed ProtocolDecodeError maps to) and the mandatory daemon
 * lifecycle/runtime outcomes the S2 daemon must emit. No string-matching required: decode
 * failures throw ProtocolDecodeError carrying the exact code.
 */
export type ProtocolErrorCode =
  | "version-mismatch"
  | "malformed-frame"
  | "unknown-method"
  | "invalid-params"
  | "unsafe-sequence"
  | "not-initialized"
  | "already-initialized"
  | "session-not-found"
  | "stale-turn"
  | "overloaded"
  | "shutting-down"
  | "extension-not-found"
  | "extension-invalid"
  | "extension-incompatible"
  | "approval-required"
  | "approval-invalid"
  | "extension-conflict"
  | "extension-operation-failed"
  | "extension-timeout"
  | "extension-mutated"
  | "internal";

interface ClientRequestBase {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
}

type ClientRequestVariant<Method extends ProtocolMethod, Params> = ClientRequestBase & {
  readonly method: Method;
  readonly params: Params;
};

/** One client→server NDJSON request frame: schema-stamped, id-correlated, method-specific params. */
export type ClientRequestFrame =
  | ClientRequestVariant<"initialize", InitializeRequest>
  | ClientRequestVariant<"auth/login", AuthLoginRequest>
  | ClientRequestVariant<"auth/respond", AuthRespondRequest>
  | ClientRequestVariant<"auth/status", AuthStatusRequest>
  | ClientRequestVariant<"session/start", SessionStartRequest>
  | ClientRequestVariant<"session/ensure", SessionEnsureRequest>
  | ClientRequestVariant<"session/resume", SessionResumeRequest>
  | ClientRequestVariant<"session/list", SessionListRequest>
  | ClientRequestVariant<"session/subscribe", SessionSubscribeRequest>
  | ClientRequestVariant<"session/unsubscribe", SessionUnsubscribeRequest>
  | ClientRequestVariant<"turn/start", TurnStartRequest>
  | ClientRequestVariant<"turn/steer", TurnSteerRequest>
  | ClientRequestVariant<"turn/interrupt", TurnInterruptRequest>
  | ClientRequestVariant<"approval/resolve", ApprovalResolveRequest>
  | ClientRequestVariant<"extension/install", ExtensionInstallRequest>
  | ClientRequestVariant<"extension/enable", ExtensionEnableRequest>
  | ClientRequestVariant<"extension/disable", ExtensionDisableRequest>
  | ClientRequestVariant<"extension/list", ExtensionListRequest>
  | ClientRequestVariant<"extension/doctor", ExtensionDoctorRequest>;

type ServerSuccessVariant<Method extends ProtocolMethod, Result> = ClientRequestBase & {
  readonly method: Method;
  readonly type: "success";
  readonly result: Result;
};

/** Server→client success frame correlated by requestId, echoing the method for a stateless codec. */
export type ServerSuccessFrame =
  | ServerSuccessVariant<"initialize", InitializeResponse>
  | ServerSuccessVariant<"auth/login", AuthLoginResponse>
  | ServerSuccessVariant<"auth/respond", AuthRespondResponse>
  | ServerSuccessVariant<"auth/status", AuthStatusResponse>
  | ServerSuccessVariant<"session/start", SessionStartResponse>
  | ServerSuccessVariant<"session/ensure", SessionEnsureResponse>
  | ServerSuccessVariant<"session/resume", SessionResumeResponse>
  | ServerSuccessVariant<"session/list", SessionListResponse>
  | ServerSuccessVariant<"session/subscribe", SessionSubscribeResponse>
  | ServerSuccessVariant<"session/unsubscribe", SessionUnsubscribeResponse>
  | ServerSuccessVariant<"turn/start", TurnStartResponse>
  | ServerSuccessVariant<"turn/steer", TurnSteerResponse>
  | ServerSuccessVariant<"turn/interrupt", TurnInterruptResponse>
  | ServerSuccessVariant<"approval/resolve", ApprovalResolveResponse>
  | ServerSuccessVariant<"extension/install", ExtensionInstallResponse>
  | ServerSuccessVariant<"extension/enable", ExtensionEnableResponse>
  | ServerSuccessVariant<"extension/disable", ExtensionDisableResponse>
  | ServerSuccessVariant<"extension/list", ExtensionListResponse>
  | ServerSuccessVariant<"extension/doctor", ExtensionDoctorResponse>;

/**
 * Server→client structured error frame. `requestId` is `string` when the failing request was
 * parseable and carried an id, `null` for uncorrelated failures (malformed JSON, missing/invalid
 * requestId, unsupported framing) where inventing an id would be wrong. Closed error-code union.
 */
export interface ServerErrorFrame {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string | null;
  readonly type: "error";
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

/**
 * Server→client Session-event frame. The `event` payload is the canonical SessionEnvelope
 * unchanged; its `seq` remains the sole event sequence authority (Constitution rule 2/3).
 * `subscriptionId` correlates to the subscribe/resume handle for demultiplexing only.
 */
export interface ServerSessionEventFrame {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly type: "event";
  readonly subscriptionId: string;
  readonly event: SessionEnvelope;
}

export type ServerFrame =
  | ServerSuccessFrame
  | ServerErrorFrame
  | ServerSessionEventFrame
  | ServerAuthFrame;

/**
 * Typed error thrown by the attach-protocol decode path. Transport/daemon code maps a decode
 * failure to a ServerErrorFrame by reading `code` and `requestId` — never by matching the
 * TypeError message text. `requestId` is `null` when the request id could not be recovered
 * (malformed JSON, missing/invalid requestId field). `message` is preserved for human diagnostics.
 */
export class ProtocolDecodeError extends Error {
  readonly code: ProtocolErrorCode;
  readonly requestId: string | null;
  constructor(code: ProtocolErrorCode, requestId: string | null, message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
    this.code = code;
    this.requestId = requestId;
  }
}
