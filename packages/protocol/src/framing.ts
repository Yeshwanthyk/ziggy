import {
  PROTOCOL_VERSION,
  type ClientFeature,
  type ClientRequestFrame,
  type ProtocolErrorCode,
  ProtocolDecodeError,
  type ServerErrorFrame,
  type ServerFeature,
  type ServerFrame,
  type ServerSessionEventFrame,
  type ServerSuccessFrame,
  type SessionSummary,
} from "./types.ts";
import {
  approvalDecision,
  arrayValue,
  booleanValue,
  canonicalTimestampFor,
  decodeEnvelopeValue,
  exactRecord,
  identifierValue,
  nonnegativeSafeInteger,
  objectRecord,
  parseNdjsonLine,
  stringValue,
} from "./client.ts";

/**
 * Attach-protocol NDJSON codecs (S2 experiment). Strict, versioned framing only — no socket,
 * no daemon, no Session registry, no replay ordering, no connection state. Each frame is one
 * newline-terminated JSON object. Encode canonicalizes through the decoder so producer and wire
 * agree byte-for-byte. Decode rejects malformed JSON, wrong schema version, unknown methods,
 * invalid method params, unsafe sequence values, and extra keys, mirroring the Session codec —
 * and throws a typed ProtocolDecodeError carrying the exact ProtocolErrorCode and the recoverable
 * requestId (`null` when uncorrelated), so transport/daemon code can build a ServerErrorFrame
 * without matching TypeError message text.
 */

export function encodeClientRequest(frame: ClientRequestFrame): string {
  return `${JSON.stringify(decodeClientRequestValue(frame))}\n`;
}

export function decodeClientRequest(frame: string): ClientRequestFrame {
  let value: unknown;
  try {
    value = parseNdjsonLine(frame, "Client request frame");
  } catch (error) {
    throw decodeError("malformed-frame", null, error);
  }
  return decodeClientRequestValue(value);
}

export function encodeServerFrame(frame: ServerFrame): string {
  return `${JSON.stringify(decodeServerFrameValue(frame))}\n`;
}

export function decodeServerFrame(frame: string): ServerFrame {
  let value: unknown;
  try {
    value = parseNdjsonLine(frame, "Server frame");
  } catch (error) {
    throw decodeError("malformed-frame", null, error);
  }
  try {
    return decodeServerFrameValue(value);
  } catch (error) {
    if (error instanceof ProtocolDecodeError) {
      throw error;
    }
    // Any non-typed failure (objectRecord, result/error/event field validators) is a frame-shape
    // defect: map to malformed-frame, recovering the requestId when the parsed value is an object
    // with a valid id. Explicit version-mismatch/unknown-method mappings above rethrow unchanged.
    throw decodeError("malformed-frame", recoverRequestId(value), error);
  }
}

/** Build a ProtocolDecodeError, preserving a human message from an underlying error. */
function decodeError(
  code: ProtocolErrorCode,
  requestId: string | null,
  cause: unknown,
): ProtocolDecodeError {
  const message = cause instanceof Error && cause.message.length > 0 ? cause.message : code;
  return new ProtocolDecodeError(code, requestId, message);
}

function decodeClientRequestValue(value: unknown): ClientRequestFrame {
  let frame: Readonly<Record<string, unknown>>;
  try {
    frame = exactRecord(value, ["schemaVersion", "requestId", "method", "params"]);
  } catch (error) {
    // The request may be uncorrelated: recover requestId only if the value is an object with a
    // valid nonempty string id field. Missing/invalid/extra keys still fail exact-record here;
    // recoverRequestId only decides null-vs-string for the typed error.
    throw decodeError("malformed-frame", recoverRequestId(value), error);
  }
  if (frame.schemaVersion !== PROTOCOL_VERSION) {
    throw decodeError(
      "version-mismatch",
      recoverRequestId(frame),
      new TypeError("Unsupported protocol frame schema version"),
    );
  }
  const requestId = recoverRequestId(frame);
  if (requestId === null) {
    throw decodeError(
      "malformed-frame",
      null,
      new TypeError("requestId must be a nonempty string"),
    );
  }
  const method = frame.method;
  // A non-string method discriminator is a frame-shape defect (malformed-frame). A syntactically
  // valid but unregistered string method is mapped to unknown-method in decodeClientRequestVariant.
  if (typeof method !== "string") {
    throw decodeError("malformed-frame", requestId, new TypeError("method must be a string"));
  }
  return decodeClientRequestVariant(requestId, method, frame.params);
}

/** Recover a request id for a typed decode error: nonempty string, else null (uncorrelated). */
function recoverRequestId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value.requestId;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeClientRequestVariant(
  requestId: string,
  method: string,
  params: unknown,
): ClientRequestFrame {
  switch (method) {
    case "initialize": {
      const p = exactParams(requestId, params, ["client", "features"]);
      return decodeFields(requestId, () => {
        const client = exactRecord(p.client, ["name", "version"]);
        return {
          schemaVersion: PROTOCOL_VERSION,
          requestId,
          method: "initialize",
          params: {
            client: {
              name: identifierValue(client.name, "client.name"),
              version: identifierValue(client.version, "client.version"),
            },
            features: arrayValue(p.features, clientFeature, "features"),
          },
        };
      });
    }
    case "session/start": {
      const p = exactParams(requestId, params, []);
      return { schemaVersion: PROTOCOL_VERSION, requestId, method: "session/start", params: p };
    }
    case "session/resume": {
      const p = exactParams(requestId, params, ["sessionId", "sinceSeq"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/resume",
        params: {
          sessionId: identifierValue(p.sessionId, "sessionId"),
          sinceSeq: safeSequence(requestId, p.sinceSeq, "sinceSeq"),
        },
      }));
    }
    case "session/list": {
      const p = exactParams(requestId, params, []);
      return { schemaVersion: PROTOCOL_VERSION, requestId, method: "session/list", params: p };
    }
    case "session/subscribe": {
      const p = exactParams(requestId, params, ["sessionId", "sinceSeq"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/subscribe",
        params: {
          sessionId: identifierValue(p.sessionId, "sessionId"),
          sinceSeq: safeSequence(requestId, p.sinceSeq, "sinceSeq"),
        },
      }));
    }
    case "session/unsubscribe": {
      const p = exactParams(requestId, params, ["subscriptionId"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/unsubscribe",
        params: { subscriptionId: identifierValue(p.subscriptionId, "subscriptionId") },
      }));
    }
    case "turn/start": {
      const p = exactParams(requestId, params, ["sessionId", "message"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "turn/start",
        params: {
          sessionId: identifierValue(p.sessionId, "sessionId"),
          message: stringValue(p.message, "message"),
        },
      }));
    }
    case "turn/steer": {
      const p = exactParams(requestId, params, ["sessionId", "expectedTurnId", "message"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "turn/steer",
        params: {
          sessionId: identifierValue(p.sessionId, "sessionId"),
          expectedTurnId: identifierValue(p.expectedTurnId, "expectedTurnId"),
          message: stringValue(p.message, "message"),
        },
      }));
    }
    case "turn/interrupt": {
      const p = exactParams(requestId, params, ["sessionId", "expectedTurnId"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "turn/interrupt",
        params: {
          sessionId: identifierValue(p.sessionId, "sessionId"),
          expectedTurnId: identifierValue(p.expectedTurnId, "expectedTurnId"),
        },
      }));
    }
    case "approval/resolve": {
      const p = exactParams(requestId, params, ["sessionId", "approvalId", "decision"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "approval/resolve",
        params: {
          sessionId: identifierValue(p.sessionId, "sessionId"),
          approvalId: identifierValue(p.approvalId, "approvalId"),
          decision: approvalDecision(p.decision),
        },
      }));
    }
    default:
      throw decodeError(
        "unknown-method",
        requestId,
        new TypeError(`Unknown protocol method: ${method}`),
      );
  }
}

/**
 * Run a per-method field decode thunk, mapping any thrown TypeError to invalid-params carrying
 * the requestId. `safeSequence` already throws typed unsafe-sequence errors; those rethrow unchanged.
 */
function decodeFields(requestId: string, build: () => ClientRequestFrame): ClientRequestFrame {
  try {
    return build();
  } catch (error) {
    if (error instanceof ProtocolDecodeError) {
      throw error;
    }
    throw decodeError("invalid-params", requestId, error);
  }
}

/** Exact-record decode for method params, mapping failure to invalid-params with the requestId. */
function exactParams(
  requestId: string,
  params: unknown,
  requiredKeys: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
  try {
    return exactRecord(params, requiredKeys);
  } catch (error) {
    throw decodeError("invalid-params", requestId, error);
  }
}

/** Decode a nonnegative safe-integer sequence, mapping failure to unsafe-sequence with the requestId. */
function safeSequence(requestId: string, value: unknown, name: string): number {
  try {
    return nonnegativeSafeInteger(value, name);
  } catch (error) {
    throw decodeError("unsafe-sequence", requestId, error);
  }
}

function decodeServerFrameValue(value: unknown): ServerFrame {
  const record = objectRecord(value);
  const type = record.type;
  if (typeof type !== "string") {
    throw decodeError(
      "malformed-frame",
      null,
      new TypeError("Server frame requires a string type"),
    );
  }
  switch (type) {
    case "success":
      return decodeServerSuccess(record);
    case "error":
      return decodeServerError(record);
    case "event":
      return decodeServerEvent(record);
    default:
      throw decodeError(
        "malformed-frame",
        null,
        new TypeError(`Unknown server frame type: ${type}`),
      );
  }
}

function decodeServerSuccess(record: Readonly<Record<string, unknown>>): ServerSuccessFrame {
  let frame: Readonly<Record<string, unknown>>;
  try {
    frame = exactRecord(record, ["schemaVersion", "requestId", "method", "type", "result"]);
  } catch (error) {
    throw decodeError("malformed-frame", recoverRequestId(record), error);
  }
  if (frame.schemaVersion !== PROTOCOL_VERSION) {
    throw decodeError(
      "version-mismatch",
      recoverRequestId(frame),
      new TypeError("Unsupported protocol frame schema version"),
    );
  }
  const requestId = recoverRequestId(frame);
  if (requestId === null) {
    throw decodeError(
      "malformed-frame",
      null,
      new TypeError("requestId must be a nonempty string"),
    );
  }
  const method = frame.method;
  if (typeof method !== "string") {
    throw decodeError("malformed-frame", requestId, new TypeError("method must be a string"));
  }
  return decodeServerSuccessVariant(requestId, method, frame.result);
}

function decodeServerSuccessVariant(
  requestId: string,
  method: string,
  result: unknown,
): ServerSuccessFrame {
  switch (method) {
    case "initialize": {
      const r = exactRecord(result, ["protocolVersion", "features"]);
      if (r.protocolVersion !== PROTOCOL_VERSION) {
        throw decodeError(
          "version-mismatch",
          requestId,
          new TypeError("Unsupported protocol version"),
        );
      }
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "initialize",
        type: "success",
        result: {
          protocolVersion: PROTOCOL_VERSION,
          features: arrayValue(r.features, serverFeature, "features"),
        },
      };
    }
    case "session/start": {
      const r = exactRecord(result, ["session"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/start",
        type: "success",
        result: { session: decodeSessionSummary(r.session) },
      };
    }
    case "session/resume": {
      const r = exactRecord(result, ["session", "subscriptionId", "replayThroughSeq"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/resume",
        type: "success",
        result: {
          session: decodeSessionSummary(r.session),
          subscriptionId: identifierValue(r.subscriptionId, "subscriptionId"),
          replayThroughSeq: nonnegativeSafeInteger(r.replayThroughSeq, "replayThroughSeq"),
        },
      };
    }
    case "session/list": {
      const r = exactRecord(result, ["sessions"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/list",
        type: "success",
        result: { sessions: arrayValue(r.sessions, decodeSessionSummary, "sessions") },
      };
    }
    case "session/subscribe": {
      const r = exactRecord(result, ["subscriptionId", "replayThroughSeq"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/subscribe",
        type: "success",
        result: {
          subscriptionId: identifierValue(r.subscriptionId, "subscriptionId"),
          replayThroughSeq: nonnegativeSafeInteger(r.replayThroughSeq, "replayThroughSeq"),
        },
      };
    }
    case "session/unsubscribe": {
      const r = exactRecord(result, ["unsubscribed"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/unsubscribe",
        type: "success",
        result: { unsubscribed: booleanValue(r.unsubscribed, "unsubscribed") },
      };
    }
    case "turn/start": {
      const r = exactRecord(result, ["turnId", "disposition"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "turn/start",
        type: "success",
        result: {
          turnId: identifierValue(r.turnId, "turnId"),
          disposition: turnDisposition(r.disposition),
        },
      };
    }
    case "turn/steer": {
      const r = exactRecord(result, ["turnId"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "turn/steer",
        type: "success",
        result: { turnId: identifierValue(r.turnId, "turnId") },
      };
    }
    case "turn/interrupt": {
      const r = exactRecord(result, ["turnId"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "turn/interrupt",
        type: "success",
        result: { turnId: identifierValue(r.turnId, "turnId") },
      };
    }
    case "approval/resolve": {
      const r = exactRecord(result, ["outcome"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "approval/resolve",
        type: "success",
        result: { outcome: approvalOutcome(r.outcome) },
      };
    }
    default:
      throw decodeError(
        "unknown-method",
        requestId,
        new TypeError(`Unknown protocol method: ${method}`),
      );
  }
}

function decodeServerError(record: Readonly<Record<string, unknown>>): ServerErrorFrame {
  let frame: Readonly<Record<string, unknown>>;
  try {
    frame = exactRecord(record, ["schemaVersion", "requestId", "type", "code", "message"]);
  } catch (error) {
    throw decodeError("malformed-frame", recoverRequestId(record), error);
  }
  if (frame.schemaVersion !== PROTOCOL_VERSION) {
    throw decodeError(
      "version-mismatch",
      recoverRequestId(frame),
      new TypeError("Unsupported protocol frame schema version"),
    );
  }
  // requestId may be null for uncorrelated failures; a present id must be nonempty.
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId: decodeErrorRequestId(frame.requestId),
    type: "error",
    code: protocolErrorCode(frame.code),
    message: stringValue(frame.message, "message"),
  };
}

/** Decode a ServerErrorFrame requestId: null stays null, a string must be nonempty. */
function decodeErrorRequestId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return identifierValue(value, "requestId");
}

function decodeServerEvent(record: Readonly<Record<string, unknown>>): ServerSessionEventFrame {
  let frame: Readonly<Record<string, unknown>>;
  try {
    frame = exactRecord(record, ["schemaVersion", "type", "subscriptionId", "event"]);
  } catch (error) {
    throw decodeError("malformed-frame", null, error);
  }
  if (frame.schemaVersion !== PROTOCOL_VERSION) {
    throw decodeError(
      "version-mismatch",
      null,
      new TypeError("Unsupported protocol frame schema version"),
    );
  }
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "event",
    subscriptionId: identifierValue(frame.subscriptionId, "subscriptionId"),
    event: decodeEnvelopeValue(frame.event),
  };
}

function decodeSessionSummary(value: unknown): SessionSummary {
  const summary = exactRecord(value, ["sessionId", "createdAt", "lastSeq"], ["activeTurnId"]);
  return {
    sessionId: identifierValue(summary.sessionId, "sessionId"),
    createdAt: canonicalTimestampFor(summary.createdAt, "createdAt"),
    lastSeq: nonnegativeSafeInteger(summary.lastSeq, "lastSeq"),
    ...(Object.hasOwn(summary, "activeTurnId")
      ? { activeTurnId: identifierValue(summary.activeTurnId, "activeTurnId") }
      : {}),
  };
}

function clientFeature(value: unknown): ClientFeature {
  if (value === "modelChunks" || value === "approvalRequests") {
    return value;
  }
  throw new TypeError("Unknown client feature");
}

function serverFeature(value: unknown): ServerFeature {
  if (
    value === "sessionReplay" ||
    value === "turnSteering" ||
    value === "turnInterrupt" ||
    value === "approvals"
  ) {
    return value;
  }
  throw new TypeError("Unknown server feature");
}

function turnDisposition(value: unknown): "started" | "queued" {
  if (value === "started" || value === "queued") {
    return value;
  }
  throw new TypeError("disposition must be started or queued");
}

function approvalOutcome(value: unknown): "resolved" | "already-resolved" {
  if (value === "resolved" || value === "already-resolved") {
    return value;
  }
  throw new TypeError("outcome must be resolved or already-resolved");
}

function protocolErrorCode(value: unknown): ProtocolErrorCode {
  if (
    value === "version-mismatch" ||
    value === "malformed-frame" ||
    value === "unknown-method" ||
    value === "invalid-params" ||
    value === "unsafe-sequence" ||
    value === "not-initialized" ||
    value === "already-initialized" ||
    value === "session-not-found" ||
    value === "stale-turn" ||
    value === "overloaded" ||
    value === "shutting-down" ||
    value === "internal"
  ) {
    return value;
  }
  throw new TypeError("Unknown protocol error code");
}
