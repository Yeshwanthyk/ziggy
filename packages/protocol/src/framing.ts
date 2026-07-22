import {
  MAIN_SESSION_ID,
  PROTOCOL_VERSION,
  type AuthStatus,
  type ClientFeature,
  type ClientRequestFrame,
  type ExtensionApprovalRequirement,
  type ExtensionDoctorResponse,
  type ExtensionEnableResponse,
  type ExtensionInstallResponse,
  type ExtensionObservation,
  type ProtocolErrorCode,
  ProtocolDecodeError,
  type ServerAuthFrame,
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
            features: featureSet(p.features, clientFeature, "features"),
          },
        };
      });
    }
    case "auth/login": {
      const p = exactParams(requestId, params, ["providerId", "type"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "auth/login",
        params: {
          providerId: identifierValue(p.providerId, "providerId"),
          type: authType(p.type),
        },
      }));
    }
    case "auth/respond": {
      const p = exactParams(requestId, params, ["loginId", "promptId", "value"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "auth/respond",
        params: {
          loginId: identifierValue(p.loginId, "loginId"),
          promptId: identifierValue(p.promptId, "promptId"),
          value: boundedString(p.value, "value", 65_536),
        },
      }));
    }
    case "auth/status": {
      const p = exactParams(requestId, params, [], ["providerId"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "auth/status",
        params: Object.hasOwn(p, "providerId")
          ? { providerId: identifierValue(p.providerId, "providerId") }
          : {},
      }));
    }
    case "session/start": {
      const p = exactParams(requestId, params, []);
      return { schemaVersion: PROTOCOL_VERSION, requestId, method: "session/start", params: p };
    }
    case "session/ensure": {
      const p = exactParams(requestId, params, ["sessionId"]);
      return decodeFields(requestId, () => {
        if (p.sessionId !== MAIN_SESSION_ID) {
          throw new TypeError(`session/ensure requires sessionId ${MAIN_SESSION_ID}`);
        }
        return {
          schemaVersion: PROTOCOL_VERSION,
          requestId,
          method: "session/ensure",
          params: { sessionId: MAIN_SESSION_ID },
        };
      });
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
    case "extension/install": {
      const p = exactParams(requestId, params, ["sourcePath", "approvals"], ["verification"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/install",
        params: {
          sourcePath: pathValue(p.sourcePath, "sourcePath"),
          approvals: approvalFingerprints(p.approvals, "approvals"),
          ...(Object.hasOwn(p, "verification")
            ? { verification: decodeExtensionVerification(p.verification) }
            : {}),
        },
      }));
    }
    case "extension/enable": {
      const p = exactParams(requestId, params, ["extensionId", "approvals"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/enable",
        params: {
          extensionId: identifierValue(p.extensionId, "extensionId"),
          approvals: approvalFingerprints(p.approvals, "approvals"),
        },
      }));
    }
    case "extension/disable": {
      const p = exactParams(requestId, params, ["extensionId"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/disable",
        params: { extensionId: identifierValue(p.extensionId, "extensionId") },
      }));
    }
    case "extension/list": {
      const p = exactParams(requestId, params, []);
      return { schemaVersion: PROTOCOL_VERSION, requestId, method: "extension/list", params: p };
    }
    case "extension/doctor": {
      const p = exactParams(requestId, params, ["extensionId"], ["approval"]);
      return decodeFields(requestId, () => ({
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/doctor",
        params: {
          extensionId: identifierValue(p.extensionId, "extensionId"),
          ...(Object.hasOwn(p, "approval")
            ? { approval: approvalFingerprint(p.approval, "approval") }
            : {}),
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
  optionalKeys: ReadonlyArray<string> = [],
): Readonly<Record<string, unknown>> {
  try {
    return exactRecord(params, requiredKeys, optionalKeys);
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
    case "auth":
      return decodeServerAuth(record);
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
          features: featureSet(r.features, serverFeature, "features"),
        },
      };
    }
    case "auth/login": {
      const r = exactRecord(result, ["status"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "auth/login",
        type: "success",
        result: { status: decodeAuthStatus(r.status) },
      };
    }
    case "auth/respond": {
      const r = exactRecord(result, ["accepted"]);
      if (r.accepted !== true) throw new TypeError("accepted must be true");
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "auth/respond",
        type: "success",
        result: { accepted: true },
      };
    }
    case "auth/status": {
      const r = exactRecord(result, ["providers"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "auth/status",
        type: "success",
        result: { providers: arrayValue(r.providers, decodeAuthStatus, "providers") },
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
    case "session/ensure": {
      const r = exactRecord(result, ["session"]);
      const session = decodeSessionSummary(r.session);
      if (session.sessionId !== MAIN_SESSION_ID) {
        throw new TypeError(`session/ensure response requires Session ${MAIN_SESSION_ID}`);
      }
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "session/ensure",
        type: "success",
        result: { session },
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
    case "extension/install": {
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/install",
        type: "success",
        result: decodeExtensionInstallResponse(result),
      };
    }
    case "extension/enable": {
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/enable",
        type: "success",
        result: decodeExtensionEnableResponse(result),
      };
    }
    case "extension/disable": {
      const r = exactRecord(result, ["extension"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/disable",
        type: "success",
        result: { extension: decodeExtensionObservation(r.extension) },
      };
    }
    case "extension/list": {
      const r = exactRecord(result, ["extensions"]);
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/list",
        type: "success",
        result: {
          extensions: boundedArray(r.extensions, decodeExtensionObservation, "extensions", 1_024),
        },
      };
    }
    case "extension/doctor": {
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId,
        method: "extension/doctor",
        type: "success",
        result: decodeExtensionDoctorResponse(result),
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

function decodeExtensionInstallResponse(value: unknown): ExtensionInstallResponse {
  const result = objectRecord(value);
  if (result.status === "approval-required") return decodeExtensionApprovalResponse(result);
  if (result.status !== "installed") throw new TypeError("Unknown Extension install status");
  const exact = exactRecord(result, ["status", "extension"]);
  return { status: "installed", extension: decodeExtensionObservation(exact.extension) };
}

function decodeExtensionEnableResponse(value: unknown): ExtensionEnableResponse {
  const result = objectRecord(value);
  if (result.status === "approval-required") return decodeExtensionApprovalResponse(result);
  if (result.status !== "enabled") throw new TypeError("Unknown Extension enable status");
  const exact = exactRecord(result, ["status", "extension"]);
  return { status: "enabled", extension: decodeExtensionObservation(exact.extension) };
}

function decodeExtensionApprovalResponse(value: unknown): {
  readonly status: "approval-required";
  readonly extensionId: string;
  readonly requirements: ReadonlyArray<ExtensionApprovalRequirement>;
} {
  const result = exactRecord(value, ["status", "extensionId", "requirements"]);
  if (result.status !== "approval-required") {
    throw new TypeError("Extension response status must be approval-required");
  }
  const requirements = boundedArray(
    result.requirements,
    decodeExtensionApprovalRequirement,
    "requirements",
    256,
  );
  if (requirements.length === 0) {
    throw new TypeError("Approval requirements must not be empty");
  }
  return {
    status: "approval-required",
    extensionId: identifierValue(result.extensionId, "extensionId"),
    requirements,
  };
}

function decodeExtensionApprovalRequirement(value: unknown): ExtensionApprovalRequirement {
  const requirement = exactRecord(value, [
    "fingerprint",
    "extensionId",
    "extensionVersion",
    "entryKind",
    "entryId",
    "argv",
    "permissions",
    "executablePath",
    "executableSha256",
    "trustTier",
    "treeDigest",
    "epoch",
  ]);
  const permissions = exactRecord(requirement.permissions, ["network", "filesystem", "secrets"]);
  return {
    fingerprint: approvalFingerprint(requirement.fingerprint, "fingerprint"),
    extensionId: identifierValue(requirement.extensionId, "extensionId"),
    extensionVersion: boundedString(requirement.extensionVersion, "extensionVersion", 128),
    entryKind: extensionEntryKind(requirement.entryKind),
    entryId: identifierValue(requirement.entryId, "entryId"),
    argv: boundedArray(
      requirement.argv,
      (argument) => boundedString(argument, "argv entry", 8_192),
      "argv",
      256,
    ),
    permissions: {
      network: booleanValue(permissions.network, "permissions.network"),
      filesystem: extensionFilesystemPermission(permissions.filesystem),
      secrets: boundedUniqueStrings(permissions.secrets, "permissions.secrets", 256, 512),
    },
    executablePath: pathValue(requirement.executablePath, "executablePath"),
    executableSha256: sha256Value(requirement.executableSha256, "executableSha256"),
    trustTier: extensionTrustTier(requirement.trustTier),
    treeDigest: sha256Value(requirement.treeDigest, "treeDigest"),
    epoch: nonnegativeSafeInteger(requirement.epoch, "epoch"),
  };
}

function decodeExtensionObservation(value: unknown): ExtensionObservation {
  const observation = exactRecord(
    value,
    ["id", "version", "name", "enabled", "trustTier", "treeDigest", "approvalEpoch", "health"],
    ["message"],
  );
  return {
    id: identifierValue(observation.id, "extension.id"),
    version: boundedString(observation.version, "extension.version", 128),
    name: boundedString(observation.name, "extension.name", 512),
    enabled: booleanValue(observation.enabled, "extension.enabled"),
    trustTier: extensionTrustTier(observation.trustTier),
    treeDigest: sha256Value(observation.treeDigest, "extension.treeDigest"),
    approvalEpoch: nonnegativeSafeInteger(observation.approvalEpoch, "extension.approvalEpoch"),
    health: extensionHealth(observation.health),
    ...(Object.hasOwn(observation, "message")
      ? { message: boundedString(observation.message, "extension.message", 4_096) }
      : {}),
  };
}

function decodeExtensionDoctorResponse(value: unknown): ExtensionDoctorResponse {
  const result = objectRecord(value);
  if (result.status === "approval-required") return decodeExtensionApprovalResponse(result);
  const exact = exactRecord(result, [
    "extension",
    "status",
    "exitCode",
    "stdout",
    "stderr",
    "truncated",
  ]);
  const status = extensionDoctorStatus(exact.status);
  const exitCode =
    exact.exitCode === null ? null : nonnegativeSafeInteger(exact.exitCode, "exitCode");
  return {
    extension: decodeExtensionObservation(exact.extension),
    status,
    exitCode,
    stdout: boundedString(exact.stdout, "stdout", 65_536),
    stderr: boundedString(exact.stderr, "stderr", 65_536),
    truncated: booleanValue(exact.truncated, "truncated"),
  };
}

function decodeExtensionVerification(value: unknown): {
  readonly keyId: string;
  readonly signature: string;
} {
  const verification = exactRecord(value, ["keyId", "signature"]);
  return {
    keyId: boundedString(verification.keyId, "verification.keyId", 512),
    signature: boundedString(verification.signature, "verification.signature", 16_384),
  };
}

function approvalFingerprints(value: unknown, name: string): ReadonlyArray<string> {
  return boundedUniqueStrings(value, name, 256, 64, approvalFingerprint);
}

function boundedUniqueStrings(
  value: unknown,
  name: string,
  maxItems: number,
  maxBytes: number,
  decode: (value: unknown, name: string, maxBytes: number) => string = boundedString,
): ReadonlyArray<string> {
  const values = boundedArray(
    value,
    (item) => decode(item, `${name} entry`, maxBytes),
    name,
    maxItems,
  );
  if (new Set(values).size !== values.length)
    throw new TypeError(`${name} must not contain duplicates`);
  return values;
}

function boundedArray<Value>(
  value: unknown,
  decode: (item: unknown) => Value,
  name: string,
  maxItems: number,
): ReadonlyArray<Value> {
  const values = arrayValue(value, decode, name);
  if (values.length > maxItems) throw new TypeError(`${name} exceeds ${maxItems} entries`);
  return values;
}

function pathValue(value: unknown, name: string): string {
  const path = boundedString(value, name, 4_096);
  if (path.includes("\0")) throw new TypeError(`${name} must not contain NUL bytes`);
  return path;
}

function approvalFingerprint(value: unknown, name: string): string {
  return sha256Value(value, name);
}

function sha256Value(value: unknown, name: string): string {
  const digest = stringValue(value, name);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return digest;
}

function extensionEntryKind(value: unknown): "tool" | "setup" | "doctor" {
  if (value === "tool" || value === "setup" || value === "doctor") return value;
  throw new TypeError("Unknown Extension approval entry kind");
}

function extensionTrustTier(value: unknown): "builtin" | "verified" | "community" {
  if (value === "builtin" || value === "verified" || value === "community") return value;
  throw new TypeError("Unknown Extension trust tier");
}

function extensionFilesystemPermission(value: unknown): "none" | "profile" | "full" {
  if (value === "none" || value === "profile" || value === "full") return value;
  throw new TypeError("Unknown Extension filesystem permission");
}

function extensionHealth(value: unknown): "ready" | "mutated" | "invalid" {
  if (value === "ready" || value === "mutated" || value === "invalid") return value;
  throw new TypeError("Unknown Extension health");
}

function extensionDoctorStatus(value: unknown): "ok" | "failed" | "timeout" {
  if (value === "ok" || value === "failed" || value === "timeout") return value;
  throw new TypeError("Unknown Extension doctor status");
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

function decodeServerAuth(record: Readonly<Record<string, unknown>>): ServerAuthFrame {
  const frame = exactRecord(record, ["schemaVersion", "type", "requestId", "loginId", "event"]);
  if (frame.schemaVersion !== PROTOCOL_VERSION) {
    throw decodeError(
      "version-mismatch",
      recoverRequestId(frame),
      new TypeError("Unsupported protocol frame schema version"),
    );
  }
  const event = objectRecord(frame.event);
  const kind = event.kind;
  if (typeof kind !== "string") throw new TypeError("Auth event kind must be a string");
  const base: Omit<ServerAuthFrame, "event"> = {
    schemaVersion: PROTOCOL_VERSION,
    type: "auth",
    requestId: identifierValue(frame.requestId, "requestId"),
    loginId: identifierValue(frame.loginId, "loginId"),
  };
  if (kind === "text" || kind === "secret" || kind === "manual_code") {
    const value = exactRecord(event, ["kind", "promptId", "message"], ["placeholder"]);
    return {
      ...base,
      event: {
        kind,
        promptId: identifierValue(value.promptId, "promptId"),
        message: boundedString(value.message, "message", 8_192),
        ...(Object.hasOwn(value, "placeholder")
          ? { placeholder: boundedString(value.placeholder, "placeholder", 2_048) }
          : {}),
      },
    };
  }
  if (kind === "select") {
    const value = exactRecord(event, ["kind", "promptId", "message", "options"]);
    return {
      ...base,
      event: {
        kind,
        promptId: identifierValue(value.promptId, "promptId"),
        message: boundedString(value.message, "message", 8_192),
        options: arrayValue(value.options, decodeAuthOption, "options"),
      },
    };
  }
  if (kind === "info" || kind === "progress") {
    const value = exactRecord(event, ["kind", "message"]);
    return { ...base, event: { kind, message: boundedString(value.message, "message", 8_192) } };
  }
  if (kind === "auth_url") {
    const value = exactRecord(event, ["kind", "url"], ["instructions"]);
    return {
      ...base,
      event: {
        kind,
        url: boundedString(value.url, "url", 16_384),
        ...(Object.hasOwn(value, "instructions")
          ? { instructions: boundedString(value.instructions, "instructions", 8_192) }
          : {}),
      },
    };
  }
  if (kind === "device_code") {
    const value = exactRecord(event, ["kind", "userCode", "verificationUri"]);
    return {
      ...base,
      event: {
        kind,
        userCode: boundedString(value.userCode, "userCode", 2_048),
        verificationUri: boundedString(value.verificationUri, "verificationUri", 16_384),
      },
    };
  }
  if (kind === "prompt_cancelled") {
    const value = exactRecord(event, ["kind", "promptId"]);
    return {
      ...base,
      event: { kind, promptId: identifierValue(value.promptId, "promptId") },
    };
  }
  throw new TypeError("Unknown auth event kind");
}

function decodeAuthOption(value: unknown): {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
} {
  const option = exactRecord(value, ["id", "label"], ["description"]);
  return {
    id: identifierValue(option.id, "option.id"),
    label: boundedString(option.label, "option.label", 2_048),
    ...(Object.hasOwn(option, "description")
      ? { description: boundedString(option.description, "option.description", 4_096) }
      : {}),
  };
}

function decodeAuthStatus(value: unknown): AuthStatus {
  const status = exactRecord(value, ["providerId", "configured"], ["type", "source"]);
  const configured = booleanValue(status.configured, "configured");
  return {
    providerId: identifierValue(status.providerId, "providerId"),
    configured,
    ...(Object.hasOwn(status, "type") ? { type: authType(status.type) } : {}),
    ...(Object.hasOwn(status, "source")
      ? { source: boundedString(status.source, "source", 2_048) }
      : {}),
  };
}

function boundedString(value: unknown, name: string, maximum: number): string {
  const decoded = stringValue(value, name);
  if (decoded.length > maximum) throw new TypeError(`${name} is too long`);
  return decoded;
}

function authType(value: unknown): "api_key" | "oauth" {
  if (value === "api_key" || value === "oauth") return value;
  throw new TypeError("Unknown auth type");
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

function featureSet<Feature extends string>(
  value: unknown,
  decode: (item: unknown) => Feature,
  name: string,
): ReadonlyArray<Feature> {
  const features = arrayValue(value, decode, name);
  if (new Set(features).size !== features.length) {
    throw new TypeError(`${name} must not contain duplicates`);
  }
  return features;
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
    value === "approvals" ||
    value === "stableMainSession" ||
    value === "providerAuth" ||
    value === "extensionLifecycle"
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
    value === "extension-not-found" ||
    value === "extension-invalid" ||
    value === "extension-incompatible" ||
    value === "approval-required" ||
    value === "approval-invalid" ||
    value === "extension-conflict" ||
    value === "extension-operation-failed" ||
    value === "extension-timeout" ||
    value === "extension-mutated" ||
    value === "internal"
  ) {
    return value;
  }
  throw new TypeError("Unknown protocol error code");
}
