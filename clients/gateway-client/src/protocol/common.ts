/**
 * The wire contract shared by every gateway capability.
 *
 * This package intentionally has no dependency on a UI framework or on the
 * server's Effect/Pi implementation.  Values arriving from a socket are
 * unknown until one of the decoders below (or a capability decoder) accepts
 * them.
 */

import type { ZiggyAgentRequestMap, ZiggyAgentResultMap } from "./agents";
import type { ZiggyAutomationRequestMap, ZiggyAutomationResultMap } from "./automations";
import type {
  ZiggyConversationRequestMap,
  ZiggyConversationResultMap,
  ZiggyGatewayEvent,
  ZiggySessionRef,
} from "./conversations";
import type { ZiggyExtensionRequestMap, ZiggyExtensionResultMap } from "./extensions";
import type { ZiggyMemoryRequestMap, ZiggyMemoryResultMap } from "./memory";
import type { ZiggyModelRequestMap, ZiggyModelResultMap } from "./models";
import type { ZiggyNavigationRequestMap, ZiggyNavigationResultMap } from "./navigation";
import type { ZiggyProfileRequestMap, ZiggyProfileResultMap } from "./profiles";

export const ZIGGY_PROTOCOL_VERSION = 1;

export type ZiggyProfileId = `prf_${string}`;

export type ZiggyGatewayErrorCode =
  | "unauthorized"
  | "unknown_method"
  | "bad_params"
  | "unknown_session"
  | "stale_cursor"
  | "replay_gap"
  | "watch_only"
  | "session_busy"
  | "not_streaming"
  | "capacity_exceeded"
  | "unknown_profile"
  | "profile_unavailable"
  | "profile_id_collision"
  | "conflict"
  | "automation_not_found"
  | "cross_profile_group"
  | "ownership"
  | "internal";

export interface ZiggyErrorDetails {
  readonly operation: "list" | "add" | "remove" | "validate";
  readonly stage:
    | "catalog"
    | "download"
    | "checksum"
    | "archive"
    | "validation"
    | "validate"
    | "filesystem"
    | "resources"
    | "extensions"
    | "skills"
    | "services"
    | "lock"
    | "rollback"
    | "response";
  readonly code: string;
  readonly message: string;
  readonly id?: string;
  readonly source?: string;
  readonly selectionChanged: boolean;
}

export interface ZiggyGatewayFailure {
  readonly code: ZiggyGatewayErrorCode;
  readonly message: string;
  readonly details?: ZiggyErrorDetails;
}

export class ZiggyGatewayError extends Error {
  readonly code: ZiggyGatewayErrorCode;
  readonly details?: ZiggyErrorDetails;

  constructor(code: ZiggyGatewayErrorCode, message: string, details?: ZiggyErrorDetails) {
    super(message);
    this.name = "ZiggyGatewayError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface ZiggyRequestMap
  extends
    ZiggyProfileRequestMap,
    ZiggyConversationRequestMap,
    ZiggyAgentRequestMap,
    ZiggyModelRequestMap,
    ZiggyAutomationRequestMap,
    ZiggyMemoryRequestMap,
    ZiggyExtensionRequestMap,
    ZiggyNavigationRequestMap {
  readonly ping: Record<string, never>;
}

export interface ZiggyResultMap
  extends
    ZiggyProfileResultMap,
    ZiggyConversationResultMap,
    ZiggyAgentResultMap,
    ZiggyModelResultMap,
    ZiggyAutomationResultMap,
    ZiggyMemoryResultMap,
    ZiggyExtensionResultMap,
    ZiggyNavigationResultMap {
  readonly ping: ZiggyPingResult;
}

export type ZiggyMethod = keyof ZiggyRequestMap;

export interface ZiggyPingResult {
  readonly pong: true;
}

export interface ZiggyRequestFrame<Method extends ZiggyMethod = ZiggyMethod> {
  readonly id: string;
  readonly method: Method;
  readonly params: ZiggyRequestMap[Method];
}

export interface ZiggySuccessFrame {
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface ZiggyFailureFrame {
  readonly id: string;
  readonly ok: false;
  readonly error: ZiggyGatewayFailure;
}

export type ZiggyResponseFrame = ZiggySuccessFrame | ZiggyFailureFrame;

export interface ZiggyServerLimits {
  readonly maxPromptCodePoints: number;
  readonly replayWindow: number;
  readonly maxHistoryEntries: number;
}

export interface ZiggySystemCapabilitiesResult {
  readonly protocolVersion: typeof ZIGGY_PROTOCOL_VERSION;
  readonly defaultProfileId: ZiggyProfileId;
  readonly serverEpoch: string;
  readonly methods: ReadonlyArray<ZiggyMethod>;
  readonly events: ReadonlyArray<ZiggyEventName>;
  readonly bounds: ZiggyServerLimits;
}

export type ZiggyEventName =
  | ZiggyGatewayEvent["event"]
  | "connection-state"
  | "history-reconciliation";

export interface ZiggyConnectionStateEvent {
  readonly event: "connection-state";
  readonly state: ZiggyConnectionState;
}

export interface ZiggyReconciliationEvent {
  readonly event: "history-reconciliation";
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly reason: "epoch-changed" | "replay-gap" | "sequence-gap";
  readonly previousEpoch?: string;
  readonly previousSequence?: number;
  readonly currentEpoch?: string;
  readonly currentSequence?: number;
}

export type ZiggyClientEvent =
  | ZiggyGatewayEvent
  | ZiggyConnectionStateEvent
  | ZiggyReconciliationEvent;

export const isClientEventNamed = <Name extends ZiggyEventName>(
  event: ZiggyClientEvent,
  eventName: Name,
): event is Extract<ZiggyClientEvent, { readonly event: Name }> => event.event === eventName;

export type ZiggyConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export const ZIGGY_METHODS: ReadonlyArray<ZiggyMethod> = [
  "ping",
  "system.capabilities",
  "profile.list",
  "profile.current",
  "profile.health",
  "session.list",
  "session.show",
  "session.history",
  "session.open",
  "session.watch",
  "session.unwatch",
  "session.close",
  "prompt.submit",
  "session.steer",
  "session.follow-up",
  "session.abort",
  "agent.list",
  "agent.show",
  "agent.create",
  "agent.validate",
  "agent.run",
  "model.status",
  "model.list",
  "model.available",
  "model.set",
  "auth.status",
  "automation.list",
  "automation.show",
  "automation.create",
  "automation.save",
  "automation.validate",
  "automation.pause",
  "automation.resume",
  "automation.run",
  "automation.status",
  "automation.runs",
  "memory.list",
  "memory.show",
  "extension.list-for-profile",
  "extension.add",
  "extension.remove",
  "extension.validate",
  "pin.list",
  "pin.set",
  "pin.remove",
];

export const ZIGGY_EVENT_NAMES: ReadonlyArray<ZiggyEventName> = [
  "assistant-text",
  "thinking",
  "tool",
  "voice",
  "settled",
  "error",
  "replay-gap",
];

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

export const isBoundedString = (value: unknown, maximum: number, minimum = 1): value is string =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum;

export const isBoundedCodePointString = (
  value: unknown,
  maximum: number,
  minimum = 1,
): value is string =>
  typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum;

export const isBoundedUtf8String = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximum;

export const isSafeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

export const isEmptyRecord = (value: unknown): value is Record<string, never> =>
  isRecord(value) && Object.keys(value).length === 0;

export const isProfileId = (value: unknown): value is ZiggyProfileId =>
  typeof value === "string" && /^prf_[a-f0-9]{24}$/u.test(value);

export const isCommandId = (value: unknown): value is string => isBoundedString(value, 128);

export const isServerEpoch = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/u.test(value);

export const isCursor = (value: unknown): value is string =>
  isBoundedString(value, 1_024) && /^[A-Za-z0-9_-]+$/u.test(value);

export const isGatewayErrorCode = (value: unknown): value is ZiggyGatewayErrorCode =>
  value === "unauthorized" ||
  value === "unknown_method" ||
  value === "bad_params" ||
  value === "unknown_session" ||
  value === "stale_cursor" ||
  value === "replay_gap" ||
  value === "watch_only" ||
  value === "session_busy" ||
  value === "not_streaming" ||
  value === "capacity_exceeded" ||
  value === "unknown_profile" ||
  value === "profile_unavailable" ||
  value === "profile_id_collision" ||
  value === "conflict" ||
  value === "automation_not_found" ||
  value === "cross_profile_group" ||
  value === "ownership" ||
  value === "internal";

export const decodeResponseFrame = (value: unknown): ZiggyResponseFrame | undefined => {
  if (!isRecord(value) || !isBoundedString(value.id, 128) || typeof value.ok !== "boolean") {
    return undefined;
  }
  if (value.ok) {
    return hasOnlyKeys(value, ["id", "ok", "result"])
      ? { id: value.id, ok: true, result: value.result }
      : undefined;
  }
  if (
    !hasOnlyKeys(value, ["id", "ok", "error"]) ||
    !isRecord(value.error) ||
    !hasOnlyKeys(value.error, ["code", "message", "details"]) ||
    !isGatewayErrorCode(value.error.code) ||
    !isBoundedString(value.error.message, 360)
  ) {
    return undefined;
  }
  if (value.error.details !== undefined && !isRecord(value.error.details)) return undefined;
  const details = value.error.details;
  if (details === undefined) {
    return {
      id: value.id,
      ok: false,
      error: { code: value.error.code, message: value.error.message },
    };
  }
  if (
    !hasOnlyKeys(details, [
      "operation",
      "stage",
      "code",
      "message",
      "id",
      "source",
      "selectionChanged",
    ]) ||
    details.operation === undefined ||
    (details.operation !== "list" &&
      details.operation !== "add" &&
      details.operation !== "remove" &&
      details.operation !== "validate") ||
    details.stage === undefined ||
    (details.stage !== "catalog" &&
      details.stage !== "download" &&
      details.stage !== "checksum" &&
      details.stage !== "archive" &&
      details.stage !== "validation" &&
      details.stage !== "validate" &&
      details.stage !== "filesystem" &&
      details.stage !== "resources" &&
      details.stage !== "extensions" &&
      details.stage !== "skills" &&
      details.stage !== "services" &&
      details.stage !== "lock" &&
      details.stage !== "rollback" &&
      details.stage !== "response") ||
    !isBoundedString(details.code, 64) ||
    !/^[A-Za-z0-9_.-]+$/u.test(details.code) ||
    !isBoundedString(details.message, 360) ||
    (details.id !== undefined &&
      (!isBoundedString(details.id, 128) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(details.id))) ||
    (details.source !== undefined && !isBoundedString(details.source, 240)) ||
    typeof details.selectionChanged !== "boolean"
  ) {
    return undefined;
  }
  type MutableErrorDetails = {
    operation: ZiggyErrorDetails["operation"];
    stage: ZiggyErrorDetails["stage"];
    code: string;
    message: string;
    id?: string;
    source?: string;
    selectionChanged: boolean;
  };
  const decodedDetails: MutableErrorDetails = {
    operation: details.operation,
    stage: details.stage,
    code: details.code,
    message: details.message,
    selectionChanged: details.selectionChanged,
  };
  if (details.id !== undefined) decodedDetails.id = details.id;
  if (details.source !== undefined) decodedDetails.source = details.source;
  return {
    id: value.id,
    ok: false,
    error: { code: value.error.code, message: value.error.message, details: decodedDetails },
  };
};

export type ZiggyJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ZiggyJsonValue>
  | { readonly [key: string]: ZiggyJsonValue };

const isJsonValue = (value: unknown): value is ZiggyJsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

export const decodeJson = (value: unknown): ZiggyJsonValue | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
