import {
  hasOnlyKeys,
  isBoundedCodePointString,
  isBoundedString,
  isBoundedUtf8String,
  isCommandId,
  isCursor,
  isProfileId,
  isRecord,
  isServerEpoch,
  isSafeInteger,
  type ZiggyProfileId,
} from "./common";

export type ZiggyLiveSessionKey =
  | "local/main"
  | `local/agents/${string}`
  | `ui/${string}`
  | `telegram/${string}`
  | `discord/${string}`
  | `slack/${string}`;

export type ZiggySessionKey = ZiggyLiveSessionKey;
export type ZiggyStoredSessionId = string;

export type ZiggyConversationContext =
  | { readonly kind: "local" }
  | { readonly kind: "user"; readonly userId: string }
  | {
      readonly kind: "group";
      readonly groupId: string;
      readonly memberAgentIds?: ReadonlyArray<string>;
      readonly defaultRecipient?: ZiggyRecipientId;
      readonly expectedRevision?: number;
    };

export type ZiggyRecipientId =
  | { readonly kind: "all" }
  | { readonly kind: "host" }
  | { readonly kind: "agent"; readonly agentId: string };

export type ZiggySessionRef =
  | {
      readonly profileId: ZiggyProfileId;
      readonly kind: "live";
      readonly key: ZiggyLiveSessionKey;
    }
  | {
      readonly profileId: ZiggyProfileId;
      readonly kind: "stored";
      readonly id: ZiggyStoredSessionId;
    };

export interface ZiggyLiveSession {
  readonly ref: Extract<ZiggySessionRef, { readonly kind: "live" }>;
  readonly kind: "ui" | "telegram" | "discord" | "slack";
  readonly idle: boolean;
  readonly context?: ZiggyConversationContext;
  readonly agentId?: string;
}

export interface ZiggyStoredSession {
  readonly ref: Extract<ZiggySessionRef, { readonly kind: "stored" }>;
  readonly createdAt: string;
  readonly entryCount: number;
  readonly terminalState: ZiggyTerminalState;
}

export interface ZiggySessionListResult {
  readonly profileId: ZiggyProfileId;
  readonly live: ReadonlyArray<ZiggyLiveSession>;
  readonly stored: ReadonlyArray<ZiggyStoredSession>;
}

export interface ZiggySessionProjection extends ZiggyLiveSession {
  readonly status: "idle" | "working" | "stopping" | "closed";
}

export interface ZiggySessionShowResult {
  readonly profileId: ZiggyProfileId;
  readonly ref: ZiggySessionRef;
  readonly kind: "live" | "stored";
  readonly createdAt?: string;
  readonly entryCount?: number;
  readonly terminalState?: ZiggyTerminalState;
  readonly live?: ZiggyLiveSession;
}

export interface ZiggyHistoryUserEntry {
  readonly kind: "user";
  readonly timestamp: string;
  readonly text: string;
}

export interface ZiggyHistoryAssistantEntry {
  readonly kind: "assistant";
  readonly timestamp: string;
  readonly text: string;
}

export interface ZiggyHistoryToolEntry {
  readonly kind: "tool";
  readonly timestamp: string;
  readonly phase: "start" | "end";
  readonly toolName: string;
  readonly failed: boolean;
}

export type ZiggySessionHistoryEntry =
  | ZiggyHistoryUserEntry
  | ZiggyHistoryAssistantEntry
  | ZiggyHistoryToolEntry;

export type ZiggyTerminalState = "completed" | "aborted" | "failed" | "incomplete";

export interface ZiggySessionHistoryResult {
  readonly profileId: ZiggyProfileId;
  readonly ref: ZiggySessionRef;
  readonly entries: ReadonlyArray<ZiggySessionHistoryEntry>;
  readonly terminalState: ZiggyTerminalState;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ZiggyEventCursor {
  readonly epoch: string;
  readonly seq: number;
}

export interface ZiggySessionOpenParams {
  readonly profileId: ZiggyProfileId;
  readonly context: ZiggyConversationContext;
  readonly name?: string;
  readonly agentId?: string;
  readonly commandId?: string;
}

export interface ZiggySessionHistoryParams {
  readonly ref: ZiggySessionRef;
  readonly before?: string;
}

export interface ZiggySessionWatchParams {
  readonly ref: ZiggySessionRef;
  readonly commandId?: string;
  readonly afterSeq?: number;
  readonly epoch?: string;
}

export interface ZiggySessionCommandParams {
  readonly ref: ZiggySessionRef;
  readonly commandId?: string;
}

export interface ZiggySessionTextParams extends ZiggySessionCommandParams {
  readonly text: string;
  readonly recipient?: ZiggyRecipientId;
}

export interface ZiggyConversationRequestMap {
  readonly "session.list": { readonly profileId: ZiggyProfileId };
  readonly "session.show": { readonly ref: ZiggySessionRef };
  readonly "session.history": ZiggySessionHistoryParams;
  readonly "session.open": ZiggySessionOpenParams;
  readonly "session.watch": ZiggySessionWatchParams;
  readonly "session.unwatch": ZiggySessionCommandParams;
  readonly "session.close": ZiggySessionCommandParams;
  readonly "prompt.submit": ZiggySessionTextParams;
  readonly "session.steer": ZiggySessionTextParams;
  readonly "session.follow-up": ZiggySessionTextParams;
  readonly "session.abort": ZiggySessionCommandParams;
}

export interface ZiggyConversationResultMap {
  readonly "session.list": ZiggySessionListResult;
  readonly "session.show": ZiggySessionShowResult;
  readonly "session.history": ZiggySessionHistoryResult;
  readonly "session.open": { readonly ref: Extract<ZiggySessionRef, { readonly kind: "live" }> };
  readonly "session.watch": Record<string, never>;
  readonly "session.unwatch": Record<string, never>;
  readonly "session.close": Record<string, never>;
  readonly "prompt.submit": Record<string, never>;
  readonly "session.steer": Record<string, never>;
  readonly "session.follow-up": Record<string, never>;
  readonly "session.abort": Record<string, never>;
}

export interface ZiggyAssistantTextEvent {
  readonly event: "assistant-text";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: { readonly delta: string; readonly snapshot: string };
}

export interface ZiggyThinkingEvent {
  readonly event: "thinking";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: { readonly delta: string };
}

export interface ZiggyToolEvent {
  readonly event: "tool";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: {
    readonly phase: "start" | "update" | "end";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly failed: boolean;
    readonly detail?: string;
  };
}

export interface ZiggyVoiceEvent {
  readonly event: "voice";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: { readonly agentId: string; readonly text: string };
}

export interface ZiggySettledEvent {
  readonly event: "settled";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: Record<string, never>;
}

export interface ZiggyErrorEvent {
  readonly event: "error";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: { readonly message: string };
}

export interface ZiggyReplayGapEvent {
  readonly event: "replay-gap";
  readonly eventId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly correlationId?: string;
  readonly payload: {
    readonly requestedAfter: number;
    readonly availableFrom: number;
    readonly availableTo: number;
    readonly reason: "epoch";
  };
}

export type ZiggyGatewayEvent =
  | ZiggyAssistantTextEvent
  | ZiggyThinkingEvent
  | ZiggyToolEvent
  | ZiggyVoiceEvent
  | ZiggySettledEvent
  | ZiggyErrorEvent
  | ZiggyReplayGapEvent;

const isLiveSessionKey = (value: unknown): value is ZiggyLiveSessionKey =>
  typeof value === "string" &&
  (/^local\/main$/u.test(value) ||
    /^local\/agents\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) ||
    /^(?:ui|telegram|discord|slack)\/[A-Za-z0-9._%~-]{1,240}$/u.test(value)) &&
  !value.split("/").some((segment) => segment === "." || segment === "..") &&
  new TextEncoder().encode(value).byteLength <= 256;

const isSessionName = (value: unknown): value is string =>
  isBoundedString(value, 64) && /^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u.test(value);

const isSessionRef = (value: unknown): value is ZiggySessionRef =>
  isRecord(value) &&
  isProfileId(value.profileId) &&
  ((value.kind === "live" &&
    hasOnlyKeys(value, ["profileId", "kind", "key"]) &&
    isLiveSessionKey(value.key)) ||
    (value.kind === "stored" &&
      hasOnlyKeys(value, ["profileId", "kind", "id"]) &&
      isBoundedString(value.id, 256) &&
      !value.id.includes("/") &&
      !value.id.includes("\\") &&
      !value.id.includes("..") &&
      !value.id.startsWith(".")));

export const isRecipient = (value: unknown): value is ZiggyRecipientId =>
  isRecord(value) &&
  (((value.kind === "all" || value.kind === "host") && hasOnlyKeys(value, ["kind"])) ||
    (value.kind === "agent" &&
      hasOnlyKeys(value, ["kind", "agentId"]) &&
      isBoundedString(value.agentId, 80) &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.agentId)));

const isConversationContext = (value: unknown): value is ZiggyConversationContext =>
  isRecord(value) &&
  ((value.kind === "local" && hasOnlyKeys(value, ["kind"])) ||
    (value.kind === "user" &&
      hasOnlyKeys(value, ["kind", "userId"]) &&
      isBoundedString(value.userId, 64)) ||
    (value.kind === "group" &&
      hasOnlyKeys(value, [
        "kind",
        "groupId",
        "memberAgentIds",
        "defaultRecipient",
        "expectedRevision",
      ]) &&
      isBoundedString(value.groupId, 64) &&
      (value.memberAgentIds === undefined ||
        (Array.isArray(value.memberAgentIds) &&
          value.memberAgentIds.length <= 4 &&
          value.memberAgentIds.every(
            (agentId) =>
              isBoundedString(agentId, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(agentId),
          ))) &&
      (value.defaultRecipient === undefined || isRecipient(value.defaultRecipient)) &&
      (value.expectedRevision === undefined || isSafeInteger(value.expectedRevision))));

const isCursorValue = (value: unknown): value is ZiggyEventCursor =>
  isRecord(value) &&
  hasOnlyKeys(value, ["epoch", "seq"]) &&
  isServerEpoch(value.epoch) &&
  isSafeInteger(value.seq);

const isLiveSession = (value: unknown): value is ZiggyLiveSession =>
  isRecord(value) &&
  hasOnlyKeys(value, ["ref", "kind", "idle", "context", "agentId"]) &&
  isRecord(value.ref) &&
  value.ref.kind === "live" &&
  isSessionRef(value.ref) &&
  (value.kind === "ui" ||
    value.kind === "telegram" ||
    value.kind === "discord" ||
    value.kind === "slack") &&
  typeof value.idle === "boolean" &&
  (value.context === undefined || isConversationContext(value.context)) &&
  (value.agentId === undefined ||
    (isBoundedString(value.agentId, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.agentId)));

const isTerminalState = (value: unknown): value is ZiggyTerminalState =>
  value === "completed" || value === "aborted" || value === "failed" || value === "incomplete";

const isStoredSession = (value: unknown): value is ZiggyStoredSession =>
  isRecord(value) &&
  hasOnlyKeys(value, ["ref", "createdAt", "entryCount", "terminalState"]) &&
  isRecord(value.ref) &&
  value.ref.kind === "stored" &&
  isSessionRef(value.ref) &&
  isBoundedString(value.createdAt, 128) &&
  isSafeInteger(value.entryCount) &&
  isTerminalState(value.terminalState);

const isHistoryEntry = (value: unknown): value is ZiggySessionHistoryEntry => {
  if (!isRecord(value) || !isBoundedString(value.timestamp, 128)) return false;
  if (value.kind === "user" || value.kind === "assistant") {
    return (
      hasOnlyKeys(value, ["kind", "timestamp", "text"]) &&
      isBoundedCodePointString(value.text, 2_048, 0)
    );
  }
  if (value.kind === "tool") {
    return (
      hasOnlyKeys(value, ["kind", "timestamp", "phase", "toolName", "failed"]) &&
      (value.phase === "start" || value.phase === "end") &&
      isBoundedCodePointString(value.toolName, 48, 0) &&
      typeof value.failed === "boolean"
    );
  }
  return false;
};

export const isSessionListResult = (value: unknown): value is ZiggySessionListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "live", "stored"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.live) &&
  value.live.length <= 128 &&
  value.live.every(
    (session) => isLiveSession(session) && session.ref.profileId === value.profileId,
  ) &&
  Array.isArray(value.stored) &&
  value.stored.length <= 256 &&
  value.stored.every(
    (session) => isStoredSession(session) && session.ref.profileId === value.profileId,
  );

export const isSessionShowResult = (value: unknown): value is ZiggySessionShowResult =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "profileId",
    "ref",
    "kind",
    "createdAt",
    "entryCount",
    "terminalState",
    "live",
  ]) &&
  isProfileId(value.profileId) &&
  isSessionRef(value.ref) &&
  value.ref.profileId === value.profileId &&
  ((value.kind === "live" &&
    value.ref.kind === "live" &&
    value.createdAt === undefined &&
    value.entryCount === undefined &&
    value.terminalState === undefined &&
    isLiveSession(value.live) &&
    value.live.ref.profileId === value.profileId) ||
    (value.kind === "stored" &&
      value.ref.kind === "stored" &&
      value.live === undefined &&
      isBoundedString(value.createdAt, 128) &&
      isSafeInteger(value.entryCount) &&
      isTerminalState(value.terminalState)));

export const isSessionHistoryResult = (value: unknown): value is ZiggySessionHistoryResult =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "profileId",
    "ref",
    "entries",
    "terminalState",
    "truncated",
    "hasMore",
    "nextCursor",
  ]) &&
  isProfileId(value.profileId) &&
  isSessionRef(value.ref) &&
  value.ref.profileId === value.profileId &&
  Array.isArray(value.entries) &&
  value.entries.length <= 32 &&
  value.entries.every(isHistoryEntry) &&
  isTerminalState(value.terminalState) &&
  typeof value.truncated === "boolean" &&
  typeof value.hasMore === "boolean" &&
  value.hasMore === (value.nextCursor !== undefined) &&
  (value.nextCursor === undefined || isCursor(value.nextCursor));

const isEventBase = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "event",
    "eventId",
    "epoch",
    "seq",
    "profileId",
    "session",
    "correlationId",
    "payload",
  ]) &&
  isBoundedString(value.eventId, 192) &&
  isServerEpoch(value.epoch) &&
  isSafeInteger(value.seq, 1) &&
  isProfileId(value.profileId) &&
  isRecord(value.session) &&
  isSessionRef(value.session) &&
  value.session.profileId === value.profileId &&
  (value.correlationId === undefined || isCommandId(value.correlationId)) &&
  isRecord(value.payload);

export const isGatewayEvent = (value: unknown): value is ZiggyGatewayEvent => {
  if (!isEventBase(value)) return false;
  const payload = value.payload;
  if (!isRecord(payload)) return false;
  if (value.event === "assistant-text") {
    return (
      hasOnlyKeys(payload, ["delta", "snapshot"]) &&
      isBoundedUtf8String(payload.delta, 2_000) &&
      isBoundedUtf8String(payload.snapshot, 8_000)
    );
  }
  if (value.event === "thinking") {
    return (
      hasOnlyKeys(payload, ["delta"]) && isBoundedUtf8String(payload.delta, 8_000)
    );
  }
  if (value.event === "tool") {
    return (
      hasOnlyKeys(payload, ["phase", "toolCallId", "toolName", "failed", "detail"]) &&
      (payload.phase === "start" || payload.phase === "update" || payload.phase === "end") &&
      isBoundedString(payload.toolCallId, 256) &&
      isBoundedString(payload.toolName, 256) &&
      typeof payload.failed === "boolean" &&
      (payload.detail === undefined || isBoundedString(payload.detail, 4_096))
    );
  }
  if (value.event === "voice") {
    return (
      hasOnlyKeys(payload, ["agentId", "text"]) &&
      isBoundedString(payload.agentId, 80) &&
      isBoundedCodePointString(payload.text, 4_096)
    );
  }
  if (value.event === "settled") {
    return hasOnlyKeys(payload, []);
  }
  if (value.event === "error") {
    return hasOnlyKeys(payload, ["message"]) && isBoundedString(payload.message, 360);
  }
  return (
    value.event === "replay-gap" &&
    hasOnlyKeys(payload, ["requestedAfter", "availableFrom", "availableTo", "reason"]) &&
    isSafeInteger(payload.requestedAfter) &&
    isSafeInteger(payload.availableFrom) &&
    isSafeInteger(payload.availableTo) &&
    payload.availableFrom <= payload.availableTo &&
    payload.reason === "epoch"
  );
};

export const isConversationContextValue = isConversationContext;
export const isSessionReference = isSessionRef;
export const isLiveSessionKeyValue = isLiveSessionKey;
export const isEventCursor = isCursorValue;
export const isSessionNameValue = isSessionName;
