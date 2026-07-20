import {
  SESSION_SCHEMA_VERSION,
  type ApprovalDecision,
  type FinalModelResponse,
  type FrozenSessionSnapshot,
  type FrozenTool,
  type JsonObject,
  type JsonValue,
  type ModelContent,
  type ModelUsage,
  type SessionEnvelope,
  type SessionEvent,
  type TurnStatus,
} from "./types.ts";

const MILLISECOND_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeSessionEnvelope(envelope: SessionEnvelope): string {
  const canonical = decodeEnvelopeValue(envelope);
  const encoded = JSON.stringify(canonical);
  if (encoded === undefined) {
    throw new TypeError("Session envelope is not JSON-safe");
  }
  return `${encoded}\n`;
}

export function decodeSessionEnvelope(frame: string): SessionEnvelope {
  return decodeEnvelopeValue(parseNdjsonLine(frame, "Session frame"));
}

/** Parse one newline-terminated NDJSON line into an unknown JSON value, rejecting empty/torn/multiple frames. */
export function parseNdjsonLine(frame: string, name: string): unknown {
  if (!frame.endsWith("\n") || frame.length === 1) {
    throw new TypeError(`${name} must contain one newline-terminated frame`);
  }
  const body = frame.slice(0, -1);
  if (body.includes("\n") || body.includes("\r")) {
    throw new TypeError(`${name} must contain exactly one frame`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
}

export function decodeEnvelopeValue(value: unknown): SessionEnvelope {
  const record = exactRecord(value, ["schemaVersion", "seq", "emittedAt", "event"]);
  if (record.schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new TypeError("Unsupported Session schema version");
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    seq: positiveSafeInteger(record.seq, "seq"),
    emittedAt: canonicalTimestamp(record.emittedAt),
    event: decodeEvent(record.event),
  };
}

function decodeEvent(value: unknown): SessionEvent {
  const record = objectRecord(value);
  if (typeof record.type !== "string") {
    throw new TypeError("Session event requires a string type");
  }

  switch (record.type) {
    case "session-started": {
      const event = exactRecord(record, ["type", "sessionId", "snapshot"]);
      return {
        type: "session-started",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        snapshot: decodeSnapshot(event.snapshot),
      };
    }
    case "turn-started": {
      const event = exactRecord(record, ["type", "sessionId", "turnId", "message", "origin"]);
      return {
        type: "turn-started",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        message: stringValue(event.message, "message"),
        origin: turnOrigin(event.origin),
      };
    }
    case "step-started": {
      const event = exactRecord(record, [
        "type",
        "sessionId",
        "turnId",
        "stepId",
        "provider",
        "model",
      ]);
      return {
        type: "step-started",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        stepId: identifierValue(event.stepId, "stepId"),
        provider: identifierValue(event.provider, "provider"),
        model: identifierValue(event.model, "model"),
      };
    }
    case "model-chunk": {
      const event = exactRecord(record, [
        "type",
        "sessionId",
        "turnId",
        "stepId",
        "contentIndex",
        "kind",
        "delta",
      ]);
      return {
        type: "model-chunk",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        stepId: identifierValue(event.stepId, "stepId"),
        contentIndex: nonnegativeSafeInteger(event.contentIndex, "contentIndex"),
        kind: chunkKind(event.kind),
        delta: stringValue(event.delta, "delta"),
      };
    }
    case "model-response": {
      const event = exactRecord(record, ["type", "sessionId", "turnId", "stepId", "response"]);
      return {
        type: "model-response",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        stepId: identifierValue(event.stepId, "stepId"),
        response: decodeModelResponse(event.response),
      };
    }
    case "tool-call": {
      const event = exactRecord(record, [
        "type",
        "sessionId",
        "turnId",
        "stepId",
        "toolCallId",
        "toolName",
        "input",
        "sourceIndex",
      ]);
      return {
        type: "tool-call",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        stepId: identifierValue(event.stepId, "stepId"),
        toolCallId: identifierValue(event.toolCallId, "toolCallId"),
        toolName: identifierValue(event.toolName, "toolName"),
        input: decodeJsonObject(event.input),
        sourceIndex: nonnegativeSafeInteger(event.sourceIndex, "sourceIndex"),
      };
    }
    case "tool-result": {
      const event = exactRecord(record, [
        "type",
        "sessionId",
        "turnId",
        "stepId",
        "toolCallId",
        "output",
        "isError",
        "sourceIndex",
      ]);
      return {
        type: "tool-result",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        stepId: identifierValue(event.stepId, "stepId"),
        toolCallId: identifierValue(event.toolCallId, "toolCallId"),
        output: decodeJsonValue(event.output),
        isError: booleanValue(event.isError, "isError"),
        sourceIndex: nonnegativeSafeInteger(event.sourceIndex, "sourceIndex"),
      };
    }
    case "step-ended": {
      const event = exactRecord(record, ["type", "sessionId", "turnId", "stepId", "status"]);
      return {
        type: "step-ended",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        stepId: identifierValue(event.stepId, "stepId"),
        status: turnStatus(event.status),
      };
    }
    case "turn-ended": {
      const event = exactRecord(record, ["type", "sessionId", "turnId", "status"]);
      return {
        type: "turn-ended",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        status: turnStatus(event.status),
      };
    }
    case "steer-received":
      return decodeMessageEvent(record, "steer-received");
    case "follow-up-received":
      return decodeMessageEvent(record, "follow-up-received");
    case "interrupt-received": {
      const event = exactRecord(record, ["type", "sessionId", "turnId"]);
      return {
        type: "interrupt-received",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
      };
    }
    case "approval-requested": {
      const event = exactRecord(record, [
        "type",
        "sessionId",
        "turnId",
        "approvalId",
        "toolCallId",
        "prompt",
        "choices",
      ]);
      return {
        type: "approval-requested",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        approvalId: identifierValue(event.approvalId, "approvalId"),
        toolCallId: identifierValue(event.toolCallId, "toolCallId"),
        prompt: stringValue(event.prompt, "prompt"),
        choices: approvalChoices(event.choices),
      };
    }
    case "approval-resolved": {
      const event = exactRecord(record, ["type", "sessionId", "turnId", "approvalId", "decision"]);
      return {
        type: "approval-resolved",
        sessionId: identifierValue(event.sessionId, "sessionId"),
        turnId: identifierValue(event.turnId, "turnId"),
        approvalId: identifierValue(event.approvalId, "approvalId"),
        decision: approvalDecision(event.decision),
      };
    }
    default:
      throw new TypeError(`Unknown Session event type: ${record.type}`);
  }
}

function decodeMessageEvent(
  value: Readonly<Record<string, unknown>>,
  type: "steer-received" | "follow-up-received",
): Extract<SessionEvent, { readonly type: typeof type }> {
  const event = exactRecord(value, ["type", "sessionId", "turnId", "message"]);
  return {
    type,
    sessionId: identifierValue(event.sessionId, "sessionId"),
    turnId: identifierValue(event.turnId, "turnId"),
    message: stringValue(event.message, "message"),
  };
}

function decodeSnapshot(value: unknown): FrozenSessionSnapshot {
  const snapshot = exactRecord(value, ["systemPrompt", "tools"]);
  return {
    systemPrompt: stringValue(snapshot.systemPrompt, "systemPrompt"),
    tools: arrayValue(snapshot.tools, decodeFrozenTool, "tools"),
  };
}

function decodeFrozenTool(value: unknown): FrozenTool {
  const tool = exactRecord(value, ["name", "description", "inputSchema"]);
  return {
    name: identifierValue(tool.name, "name"),
    description: stringValue(tool.description, "description"),
    inputSchema: decodeJsonObject(tool.inputSchema),
  };
}

function decodeModelResponse(value: unknown): FinalModelResponse {
  const response = exactRecord(
    value,
    ["api", "provider", "model", "content", "usage", "stopReason", "timestamp"],
    ["responseModel", "responseId", "errorMessage"],
  );
  return {
    api: identifierValue(response.api, "api"),
    provider: identifierValue(response.provider, "provider"),
    model: identifierValue(response.model, "model"),
    ...(Object.hasOwn(response, "responseModel")
      ? { responseModel: identifierValue(response.responseModel, "responseModel") }
      : {}),
    ...(Object.hasOwn(response, "responseId")
      ? { responseId: identifierValue(response.responseId, "responseId") }
      : {}),
    content: arrayValue(response.content, decodeModelContent, "content"),
    usage: decodeUsage(response.usage),
    stopReason: stopReason(response.stopReason),
    ...(Object.hasOwn(response, "errorMessage")
      ? { errorMessage: stringValue(response.errorMessage, "errorMessage") }
      : {}),
    timestamp: nonnegativeSafeInteger(response.timestamp, "timestamp"),
  };
}

function decodeModelContent(value: unknown): ModelContent {
  const content = objectRecord(value);
  switch (content.type) {
    case "thinking": {
      const item = exactRecord(content, ["type", "thinking"], ["thinkingSignature", "redacted"]);
      return {
        type: "thinking",
        thinking: stringValue(item.thinking, "thinking"),
        ...(Object.hasOwn(item, "thinkingSignature")
          ? { thinkingSignature: stringValue(item.thinkingSignature, "thinkingSignature") }
          : {}),
        ...(Object.hasOwn(item, "redacted")
          ? { redacted: booleanValue(item.redacted, "redacted") }
          : {}),
      };
    }
    case "text": {
      const item = exactRecord(content, ["type", "text"], ["textSignature"]);
      return {
        type: "text",
        text: stringValue(item.text, "text"),
        ...(Object.hasOwn(item, "textSignature")
          ? { textSignature: stringValue(item.textSignature, "textSignature") }
          : {}),
      };
    }
    case "toolCall": {
      const item = exactRecord(content, ["type", "id", "name", "arguments"], ["thoughtSignature"]);
      return {
        type: "toolCall",
        id: identifierValue(item.id, "id"),
        name: identifierValue(item.name, "name"),
        arguments: decodeJsonObject(item.arguments),
        ...(Object.hasOwn(item, "thoughtSignature")
          ? { thoughtSignature: stringValue(item.thoughtSignature, "thoughtSignature") }
          : {}),
      };
    }
    default:
      throw new TypeError("Unknown model content type");
  }
}

function decodeUsage(value: unknown): ModelUsage {
  const usage = exactRecord(
    value,
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"],
    ["cacheWrite1h", "reasoning"],
  );
  return {
    input: nonnegativeSafeInteger(usage.input, "usage.input"),
    output: nonnegativeSafeInteger(usage.output, "usage.output"),
    cacheRead: nonnegativeSafeInteger(usage.cacheRead, "usage.cacheRead"),
    cacheWrite: nonnegativeSafeInteger(usage.cacheWrite, "usage.cacheWrite"),
    ...(Object.hasOwn(usage, "cacheWrite1h")
      ? { cacheWrite1h: nonnegativeSafeInteger(usage.cacheWrite1h, "usage.cacheWrite1h") }
      : {}),
    ...(Object.hasOwn(usage, "reasoning")
      ? { reasoning: nonnegativeSafeInteger(usage.reasoning, "usage.reasoning") }
      : {}),
    totalTokens: nonnegativeSafeInteger(usage.totalTokens, "usage.totalTokens"),
  };
}

function decodeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return finiteNumber(value, "JSON number");
  }
  if (Array.isArray(value)) {
    return value.map(decodeJsonValue);
  }
  return decodeJsonObject(value);
}

function decodeJsonObject(value: unknown): JsonObject {
  const record = objectRecord(value);
  const decoded: Array<readonly [string, JsonValue]> = [];
  for (const [key, item] of Object.entries(record)) {
    decoded.push([key, decodeJsonValue(item)]);
  }
  return Object.fromEntries(decoded);
}

export function exactRecord(
  value: unknown,
  requiredKeys: ReadonlyArray<string>,
  optionalKeys: ReadonlyArray<string> = [],
): Readonly<Record<string, unknown>> {
  const record = objectRecord(value);
  const actualKeys = Object.keys(record);
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    actualKeys.some((key) => !allowedKeys.includes(key))
  ) {
    throw new TypeError(`Expected exact keys: ${requiredKeys.join(", ")}`);
  }
  return record;
}

export function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isObjectRecord(value)) {
    throw new TypeError("Expected a JSON object");
  }
  return value;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function arrayValue<Value>(
  value: unknown,
  decode: (item: unknown) => Value,
  name: string,
): ReadonlyArray<Value> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value.map(decode);
}

export function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function identifierValue(value: unknown, name: string): string {
  const identifier = stringValue(value, name);
  if (identifier.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return identifier;
}

export function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function nonnegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  return canonicalTimestampFor(value, "emittedAt");
}

/** Validate a canonical millisecond ISO timestamp, naming the field in errors. */
export function canonicalTimestampFor(value: unknown, name: string): string {
  const timestamp = stringValue(value, name);
  if (!MILLISECOND_ISO_TIMESTAMP.test(timestamp)) {
    throw new TypeError(`${name} must be a canonical millisecond ISO timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new TypeError(`${name} must be a valid canonical timestamp`);
  }
  return timestamp;
}

function turnOrigin(value: unknown): "user" | "follow-up" {
  if (value === "user" || value === "follow-up") {
    return value;
  }
  throw new TypeError("origin must be user or follow-up");
}

function chunkKind(value: unknown): "text" | "thinking" {
  if (value === "text" || value === "thinking") {
    return value;
  }
  throw new TypeError("kind must be text or thinking");
}

function turnStatus(value: unknown): TurnStatus {
  if (value === "completed" || value === "failed" || value === "interrupted") {
    return value;
  }
  throw new TypeError("status must be completed, failed, or interrupted");
}

function stopReason(value: unknown): FinalModelResponse["stopReason"] {
  if (
    value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
  ) {
    return value;
  }
  throw new TypeError("Unknown model stop reason");
}

export function approvalDecision(value: unknown): ApprovalDecision {
  if (value === "approve" || value === "deny") {
    return value;
  }
  throw new TypeError("decision must be approve or deny");
}

function approvalChoices(value: unknown): ReadonlyArray<ApprovalDecision> {
  return arrayValue(value, approvalDecision, "choices");
}
