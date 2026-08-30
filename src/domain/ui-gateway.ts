import { Schema } from "effect";
import { ProfileAgentId, ProfileAgentThinking } from "./profile";
import { ProfileId } from "./profile-directory";
import { ProfileExtensionId } from "./profile-extension";
import { SHARED_MEMORY_CAP, codePointLength, memoryEntries } from "./memory";

/*
 * The UI gateway is intentionally a single protocol. The browser and the
 * server are released together; there is no version negotiation or legacy
 * dispatch path here. These schemas are the wire contract.
 */

const boundedString = (label: string, maximum: number, minimum = 1) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.length >= minimum && value.length <= maximum, {
      expected: `${label} with ${minimum}-${maximum} characters`,
    }),
  );

const boundedCodePointString = (label: string, maximum: number, minimum = 1) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) => {
        const length = [...value].length;
        return length >= minimum && length <= maximum;
      },
      { expected: `${label} with ${minimum}-${maximum} Unicode code points` },
    ),
  );

const boundedUtf8String = (label: string, maximum: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => utf8Length(value) <= maximum, {
      expected: `${label} of at most ${maximum} UTF-8 bytes`,
    }),
  );

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const noDotPathSegments = (value: string): boolean =>
  value.split("/").every((segment) => segment !== "." && segment !== "..");

export const UiRequestId = boundedString("request id", 128);
export type UiRequestId = typeof UiRequestId.Type;

export const UiCommandId = boundedString("command id", 128);
export type UiCommandId = typeof UiCommandId.Type;

export const UiMethod = boundedString("method", 64);
export type UiMethod = typeof UiMethod.Type;

export const UiServerEpoch = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/u.test(value)),
);
export type UiServerEpoch = typeof UiServerEpoch.Type;

export const UiSessionName = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u.test(value), {
    expected: "a lower-case single-segment UI session name",
  }),
);
export type UiSessionName = typeof UiSessionName.Type;

/** Canonical keys for live Pi-backed chats. */
export const UiSessionKey = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (/^(?:ui|telegram|discord|slack)\/[A-Za-z0-9._%~-]{1,240}$/u.test(value) ||
        /^local\/(?:main|agents\/[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(value)) &&
      noDotPathSegments(value) &&
      utf8Length(value) <= 256,
    { expected: "a bounded Profile-local live session key" },
  ),
);
export type UiSessionKey = typeof UiSessionKey.Type;
export const UiLiveSessionKey = UiSessionKey;
export type UiLiveSessionKey = UiSessionKey;

/** Stored IDs are Pi IDs, not paths. The protocol never exposes JSONL paths. */
export const UiStoredSessionId = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 256 &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("..") &&
      !value.startsWith("."),
    { expected: "a bounded opaque stored session id" },
  ),
);
export type UiStoredSessionId = typeof UiStoredSessionId.Type;

export const UiPromptText = boundedCodePointString("prompt text", 60_000);
export type UiPromptText = typeof UiPromptText.Type;

export const UiRequestEnvelope = Schema.Struct({
  id: UiRequestId,
  method: UiMethod,
  params: Schema.Json,
});
export type UiRequestEnvelope = typeof UiRequestEnvelope.Type;

export const UiEmptyParams = Schema.Record(Schema.String, Schema.Never);
export const UiProfileScopedParams = Schema.Struct({ profileId: ProfileId });
export type UiProfileScopedParams = typeof UiProfileScopedParams.Type;

export const UiRecipient = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("host") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
  }),
]);
export type UiRecipient = typeof UiRecipient.Type;

export const UiConversationContext = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({ kind: Schema.Literal("user"), userId: boundedString("user id", 64) }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    groupId: boundedString("group id", 64),
    memberAgentIds: Schema.optionalKey(
      Schema.Array(ProfileAgentId.check(Schema.isMaxLength(80))).check(Schema.isMaxLength(4)),
    ),
    defaultRecipient: Schema.optionalKey(UiRecipient),
    expectedRevision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
]);
export type UiConversationContext = typeof UiConversationContext.Type;

export const UiSessionRef = Schema.Union([
  Schema.Struct({ profileId: ProfileId, kind: Schema.Literal("live"), key: UiSessionKey }),
  Schema.Struct({ profileId: ProfileId, kind: Schema.Literal("stored"), id: UiStoredSessionId }),
]);
export type UiSessionRef = typeof UiSessionRef.Type;

export const UiSessionOpenParams = Schema.Struct({
  profileId: ProfileId,
  context: UiConversationContext,
  name: Schema.optionalKey(UiSessionName),
  agentId: Schema.optionalKey(ProfileAgentId.check(Schema.isMaxLength(80))),
  commandId: Schema.optionalKey(UiCommandId),
});
export type UiSessionOpenParams = typeof UiSessionOpenParams.Type;

export const UiSessionRefParams = Schema.Struct({
  ref: UiSessionRef,
  commandId: Schema.optionalKey(UiCommandId),
  afterSeq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  epoch: Schema.optionalKey(UiServerEpoch),
});
export type UiSessionRefParams = typeof UiSessionRefParams.Type;

export const UiSessionTextParams = Schema.Struct({
  ref: UiSessionRef,
  text: UiPromptText,
  recipient: Schema.optionalKey(UiRecipient),
  commandId: Schema.optionalKey(UiCommandId),
});
export type UiSessionTextParams = typeof UiSessionTextParams.Type;

export const UiSessionHistoryCursor = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
export type UiSessionHistoryCursor = typeof UiSessionHistoryCursor.Type;

export const UiSessionHistoryParams = Schema.Struct({
  ref: UiSessionRef,
  before: Schema.optionalKey(UiSessionHistoryCursor),
});
export type UiSessionHistoryParams = typeof UiSessionHistoryParams.Type;

export const UiExtensionId = ProfileExtensionId.check(Schema.isMaxLength(128));
export type UiExtensionId = typeof UiExtensionId.Type;
export const UiExtensionListForProfileParams = UiProfileScopedParams;
export const UiExtensionAddParams = Schema.Struct({
  profileId: ProfileId,
  id: UiExtensionId,
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiExtensionRemoveParams = UiExtensionAddParams;
export const UiExtensionValidateParams = UiProfileScopedParams;

export const UiAgentListParams = UiProfileScopedParams;
export const UiAgentShowParams = Schema.Struct({
  profileId: ProfileId,
  agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
});
export const UiAgentValidateParams = Schema.Struct({
  profileId: ProfileId,
  agentId: Schema.optionalKey(ProfileAgentId.check(Schema.isMaxLength(80))),
});
export const UiAgentCreateParams = Schema.Struct({
  profileId: ProfileId,
  agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiAgentRunParams = Schema.Struct({
  profileId: ProfileId,
  agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
  task: UiPromptText,
  commandId: Schema.optionalKey(UiCommandId),
});

export const UiModelListParams = Schema.Struct({
  profileId: ProfileId,
  providerId: Schema.optionalKey(boundedString("provider id", 128)),
});
export const UiModelStatusParams = UiProfileScopedParams;
export const UiModelAvailableParams = UiProfileScopedParams;
export const UiModelSetParams = Schema.Struct({
  profileId: ProfileId,
  providerId: boundedString("provider id", 128),
  modelId: boundedString("model id", 256),
  thinking: Schema.optionalKey(ProfileAgentThinking),
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiAuthStatusParams = UiProfileScopedParams;

export const UiAutomationId = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9-]{1,80}$/u.test(value), {
    expected: "a bounded lowercase kebab-case automation id",
  }),
);
export type UiAutomationId = typeof UiAutomationId.Type;
export const UiAutomationListParams = UiProfileScopedParams;
export const UiAutomationShowParams = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
});
export const UiAutomationValidateParams = UiAutomationShowParams;
export const UiAutomationCreateParams = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiAutomationSaveParams = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
  expectedSource: boundedCodePointString("expected automation source", 8_000, 0),
  source: boundedCodePointString("automation source", 8_000, 0),
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiAutomationPauseParams = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiAutomationResumeParams = UiAutomationPauseParams;
export const UiAutomationRunParams = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
  commandId: Schema.optionalKey(UiCommandId),
});
export const UiAutomationStatusParams = UiProfileScopedParams;
export const UiAutomationRunsParams = Schema.Struct({
  profileId: ProfileId,
  automationId: Schema.optionalKey(UiAutomationId),
});

export const UiMemoryPath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value === "MEMORY.md" || /^memory\/(?:users|groups)\/[a-z0-9._-]{1,64}\.md$/u.test(value),
    {
      expected: "a canonical logical memory path",
    },
  ),
);
export type UiMemoryPath = typeof UiMemoryPath.Type;
export const UiMemoryListParams = UiProfileScopedParams;
export const UiMemoryShowParams = Schema.Struct({ profileId: ProfileId, path: UiMemoryPath });

export const UiRecipientId = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("host") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
  }),
]);
export type UiRecipientId = typeof UiRecipientId.Type;
export const UiGroupId = boundedString("group id", 64);
export type UiGroupId = typeof UiGroupId.Type;
export const UiGroupRecord = Schema.Struct({
  groupId: UiGroupId,
  conversationId: boundedString("conversation id", 256),
  hostProfileId: ProfileId,
  memberAgentIds: Schema.Array(ProfileAgentId.check(Schema.isMaxLength(80))).check(
    Schema.isMaxLength(4),
  ),
  defaultRecipient: UiRecipientId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type UiGroupRecord = typeof UiGroupRecord.Type;

export const UiPinId = boundedString("pin id", 128);
export type UiPinId = typeof UiPinId.Type;
export const UiPin = Schema.Struct({
  id: UiPinId,
  ref: UiSessionRef,
  label: Schema.optionalKey(boundedString("pin label", 160)),
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
});
export type UiPin = typeof UiPin.Type;
export const UiPinListParams = UiProfileScopedParams;
export const UiPinSetParams = Schema.Struct({
  profileId: ProfileId,
  pin: UiPin,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  commandId: UiCommandId,
});
export const UiPinRemoveParams = Schema.Struct({
  profileId: ProfileId,
  pinId: UiPinId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  commandId: UiCommandId,
});

export const UiExtensionOperation = Schema.Literals(["list", "add", "remove", "validate"]);
export type UiExtensionOperation = typeof UiExtensionOperation.Type;
export const UiExtensionFailureStage = Schema.Literals([
  "catalog",
  "download",
  "checksum",
  "archive",
  "validation",
  "validate",
  "filesystem",
  "resources",
  "extensions",
  "skills",
  "services",
  "lock",
  "rollback",
  "response",
]);
export type UiExtensionFailureStage = typeof UiExtensionFailureStage.Type;
export const UiExtensionFailureCode = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/u),
);
export type UiExtensionFailureCode = typeof UiExtensionFailureCode.Type;
export const UiGatewayMessage = boundedString("UI gateway error message", 360);
export const UiExtensionFailureSource = boundedString("extension failure source", 240);
export const UiExtensionFailure = Schema.Struct({
  operation: UiExtensionOperation,
  stage: UiExtensionFailureStage,
  code: UiExtensionFailureCode,
  message: UiGatewayMessage,
  id: Schema.optionalKey(UiExtensionId),
  source: Schema.optionalKey(UiExtensionFailureSource),
  selectionChanged: Schema.Boolean,
});
export type UiExtensionFailure = typeof UiExtensionFailure.Type;

/** The complete current method registry and parity anchor. */
export const UI_METHODS = [
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
] as const;
export type UiKnownMethod = (typeof UI_METHODS)[number];

export const UiGatewayErrorCode = Schema.Literals([
  "unauthorized",
  "unknown_method",
  "bad_params",
  "unknown_session",
  "stale_cursor",
  "replay_gap",
  "watch_only",
  "session_busy",
  "not_streaming",
  "capacity_exceeded",
  "unknown_profile",
  "profile_unavailable",
  "profile_id_collision",
  "conflict",
  "automation_not_found",
  "cross_profile_group",
  "ownership",
  "internal",
]);
export type UiGatewayErrorCode = typeof UiGatewayErrorCode.Type;

export class UiGatewayError extends Schema.TaggedErrorClass<UiGatewayError>()("UiGatewayError", {
  code: UiGatewayErrorCode,
  message: UiGatewayMessage,
  details: Schema.optionalKey(UiExtensionFailure),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const UiLiveSession = Schema.Struct({
  ref: Schema.Struct({ profileId: ProfileId, kind: Schema.Literal("live"), key: UiSessionKey }),
  kind: Schema.Literals(["telegram", "discord", "slack", "ui"]),
  idle: Schema.Boolean,
  context: Schema.optionalKey(UiConversationContext),
  agentId: Schema.optionalKey(ProfileAgentId.check(Schema.isMaxLength(80))),
});
export type UiLiveSession = typeof UiLiveSession.Type;
export const UiStoredSession = Schema.Struct({
  ref: Schema.Struct({
    profileId: ProfileId,
    kind: Schema.Literal("stored"),
    id: UiStoredSessionId,
  }),
  createdAt: boundedString("stored session timestamp", 128),
  entryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  terminalState: Schema.Literals(["completed", "aborted", "failed", "incomplete"]),
});
export type UiStoredSession = typeof UiStoredSession.Type;

export const UiPingResult = Schema.Struct({ pong: Schema.Literal(true) });
export type UiPingResult = typeof UiPingResult.Type;
export const UiSystemCapabilitiesResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  defaultProfileId: ProfileId,
  methods: Schema.Array(UiMethod).check(Schema.isMaxLength(128)),
  events: Schema.Array(boundedString("event", 64)).check(Schema.isMaxLength(32)),
  bounds: Schema.Struct({
    maxPromptCodePoints: Schema.Int,
    replayWindow: Schema.Int,
    maxHistoryEntries: Schema.Int,
  }),
  serverEpoch: UiServerEpoch,
});
export type UiSystemCapabilitiesResult = typeof UiSystemCapabilitiesResult.Type;
export const UiProfileSummary = Schema.Struct({
  profileId: ProfileId,
  name: boundedString("Profile name", 128),
  current: Schema.Boolean,
  available: Schema.Boolean,
});
export type UiProfileSummary = typeof UiProfileSummary.Type;
export const UiProfileListResult = Schema.Struct({
  profiles: Schema.Array(UiProfileSummary).check(Schema.isMaxLength(256)),
});
export type UiProfileListResult = typeof UiProfileListResult.Type;
export const UiProfileCurrentResult = Schema.Struct({
  profileId: ProfileId,
  name: boundedString("Profile name", 128),
});
export type UiProfileCurrentResult = typeof UiProfileCurrentResult.Type;
export const UiProfileHealthCheck = Schema.Struct({
  id: boundedString("health check id", 80),
  severity: Schema.Literals(["ok", "warn", "error"]),
  message: UiGatewayMessage,
});
export const UiProfileHealthResult = Schema.Struct({
  profileId: ProfileId,
  checks: Schema.Array(UiProfileHealthCheck).check(Schema.isMaxLength(64)),
  hasErrors: Schema.Boolean,
});
export type UiProfileHealthResult = typeof UiProfileHealthResult.Type;

export const UiSessionListResult = Schema.Struct({
  profileId: ProfileId,
  live: Schema.Array(UiLiveSession).check(Schema.isMaxLength(128)),
  stored: Schema.Array(UiStoredSession).check(Schema.isMaxLength(256)),
});
export type UiSessionListResult = typeof UiSessionListResult.Type;
export const UiSessionOpenResult = Schema.Struct({ ref: UiSessionRef });
export type UiSessionOpenResult = typeof UiSessionOpenResult.Type;
export const UiSessionShowResult = Schema.Struct({
  profileId: ProfileId,
  ref: UiSessionRef,
  kind: Schema.Literals(["live", "stored"]),
  createdAt: Schema.optionalKey(boundedString("session timestamp", 128)),
  entryCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  terminalState: Schema.optionalKey(
    Schema.Literals(["completed", "aborted", "failed", "incomplete"]),
  ),
  live: Schema.optionalKey(UiLiveSession),
});
export type UiSessionShowResult = typeof UiSessionShowResult.Type;
export const UiSessionHistoryEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["user", "assistant"]),
    timestamp: boundedString("session history timestamp", 128),
    text: boundedCodePointString("session history text", 1_024, 0),
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    timestamp: boundedString("session history timestamp", 128),
    phase: Schema.Literals(["start", "end"]),
    toolName: boundedCodePointString("session history tool name", 48),
    failed: Schema.Boolean,
  }),
]);
export type UiSessionHistoryEntry = typeof UiSessionHistoryEntry.Type;
export const UiSessionHistoryResult = Schema.Struct({
  profileId: ProfileId,
  ref: UiSessionRef,
  entries: Schema.Array(UiSessionHistoryEntry).check(Schema.isMaxLength(8)),
  terminalState: Schema.Literals(["completed", "aborted", "failed", "incomplete"]),
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextCursor: Schema.optionalKey(UiSessionHistoryCursor),
});
export type UiSessionHistoryResult = typeof UiSessionHistoryResult.Type;
export const UiEmptyResult = Schema.Struct({});
export type UiEmptyResult = typeof UiEmptyResult.Type;

const relativeLogicalPath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length >= 1 &&
      value.length <= 512 &&
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.split(/[\\/]/u).includes(".."),
    { expected: "a bounded logical Profile-relative path" },
  ),
);

export const UiProfileAgent = Schema.Struct({
  id: ProfileAgentId.check(Schema.isMaxLength(80)),
  description: boundedString("Profile agent description", 2_048),
  provider: Schema.optionalKey(boundedString("Profile agent provider", 128)),
  model: Schema.optionalKey(boundedString("Profile agent model", 256)),
  thinking: Schema.optionalKey(ProfileAgentThinking),
  tools: Schema.Array(boundedString("Profile agent tool", 128)).check(Schema.isMaxLength(128)),
});
export type UiProfileAgent = typeof UiProfileAgent.Type;
export const UiAgentListResult = Schema.Struct({
  profileId: ProfileId,
  agents: Schema.Array(UiProfileAgent).check(Schema.isMaxLength(256)),
});
export type UiAgentListResult = typeof UiAgentListResult.Type;
export const UiAgentShowResult = Schema.Struct({ profileId: ProfileId, agent: UiProfileAgent });
export type UiAgentShowResult = typeof UiAgentShowResult.Type;
export const UiAgentCreateResult = UiAgentShowResult;
export type UiAgentCreateResult = typeof UiAgentCreateResult.Type;
export const UiAgentValidation = Schema.Struct({
  id: ProfileAgentId.check(Schema.isMaxLength(80)),
  valid: Schema.Boolean,
  message: Schema.optionalKey(UiGatewayMessage),
});
export const UiAgentValidateResult = Schema.Struct({
  profileId: ProfileId,
  validations: Schema.Array(UiAgentValidation).check(Schema.isMaxLength(256)),
});
export type UiAgentValidateResult = typeof UiAgentValidateResult.Type;
export const UiAgentRunResult = Schema.Struct({
  profileId: ProfileId,
  agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
  answer: boundedCodePointString("agent answer", 8_000, 0),
  sessionId: UiStoredSessionId,
});
export type UiAgentRunResult = typeof UiAgentRunResult.Type;

const UiMemoryCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);
const UiMemoryState = Schema.Literals(["missing", "empty", "present"]);
export const UiMemoryDocumentSummary = Schema.Struct({
  path: relativeLogicalPath,
  scope: Schema.Literals(["shared", "person", "group"]),
  state: UiMemoryState,
  entryCount: UiMemoryCount,
  codePoints: UiMemoryCount,
  cap: UiMemoryCount,
});
export type UiMemoryDocumentSummary = typeof UiMemoryDocumentSummary.Type;
export const UiMemoryListResult = Schema.Struct({
  profileId: ProfileId,
  documents: Schema.Array(UiMemoryDocumentSummary).check(Schema.isMaxLength(1_000)),
});
export type UiMemoryListResult = typeof UiMemoryListResult.Type;
export const UiMemoryShowResult = Schema.Struct({
  profileId: ProfileId,
  path: UiMemoryPath,
  scope: Schema.Literals(["shared", "person", "group"]),
  state: UiMemoryState,
  content: boundedCodePointString("memory content", SHARED_MEMORY_CAP, 0),
  entries: Schema.Array(Schema.String).check(Schema.isMaxLength(SHARED_MEMORY_CAP)),
  codePoints: UiMemoryCount,
  cap: UiMemoryCount,
}).check(
  Schema.makeFilter(
    (value) =>
      codePointLength(value.content) === value.codePoints &&
      value.codePoints <= value.cap &&
      memoryEntries(value.content).length === value.entries.length,
    { expected: "an authoritative bounded memory document" },
  ),
);
export type UiMemoryShowResult = typeof UiMemoryShowResult.Type;

export const UiModelStatusResult = Schema.Struct({
  profileId: ProfileId,
  providerId: Schema.NullOr(boundedString("provider id", 128)),
  modelId: Schema.NullOr(boundedString("model id", 256)),
  thinking: boundedString("thinking level", 32),
  authConfigured: Schema.Boolean,
});
export type UiModelStatusResult = typeof UiModelStatusResult.Type;
export const UiKnownModel = Schema.Struct({
  providerId: boundedString("provider id", 128),
  modelId: boundedString("model id", 256),
  name: boundedString("model name", 256),
  thinkingLevels: Schema.Array(boundedString("thinking level", 32)).check(Schema.isMaxLength(32)),
});
export const UiModelListResult = Schema.Struct({
  profileId: ProfileId,
  models: Schema.Array(UiKnownModel).check(Schema.isMaxLength(256)),
  truncated: Schema.Boolean,
});
export type UiModelListResult = typeof UiModelListResult.Type;
export const UiModelAvailableResult = UiModelListResult;
export type UiModelAvailableResult = typeof UiModelAvailableResult.Type;
export const UiModelSetResult = Schema.Struct({
  profileId: ProfileId,
  providerId: boundedString("provider id", 128),
  modelId: boundedString("model id", 256),
  thinking: Schema.NullOr(boundedString("thinking level", 32)),
});
export type UiModelSetResult = typeof UiModelSetResult.Type;
export const UiAuthProvider = Schema.Struct({
  id: boundedString("auth provider id", 128),
  name: boundedString("auth provider name", 256),
  configured: Schema.Boolean,
  type: Schema.optionalKey(Schema.Literals(["api_key", "oauth"])),
  supportsApiKeyLogin: Schema.Boolean,
  supportsOauth: Schema.Boolean,
});
export const UiAuthStatusResult = Schema.Struct({
  profileId: ProfileId,
  providers: Schema.Array(UiAuthProvider).check(Schema.isMaxLength(256)),
});
export type UiAuthStatusResult = typeof UiAuthStatusResult.Type;

export const UiAutomationDefinition = Schema.Struct({
  id: UiAutomationId,
  valid: Schema.Boolean,
  lifecycle: Schema.Literals(["active", "paused", "conflict"]),
  schedule: Schema.optionalKey(boundedString("automation schedule", 256)),
  timezone: Schema.optionalKey(boundedString("automation timezone", 128)),
  gateState: Schema.optionalKey(Schema.Literals(["scheduled", "manual-only"])),
  message: Schema.optionalKey(UiGatewayMessage),
});
export type UiAutomationDefinition = typeof UiAutomationDefinition.Type;
export const UiAutomationListResult = Schema.Struct({
  profileId: ProfileId,
  automations: Schema.Array(UiAutomationDefinition).check(Schema.isMaxLength(256)),
});
export type UiAutomationListResult = typeof UiAutomationListResult.Type;
export const UiAutomationShowResult = Schema.Struct({
  profileId: ProfileId,
  id: UiAutomationId,
  lifecycle: Schema.Literals(["active", "paused"]),
  source: boundedCodePointString("automation definition source", 8_000, 0),
});
export type UiAutomationShowResult = typeof UiAutomationShowResult.Type;
export const UiAutomationSaveResult = UiAutomationShowResult;
export type UiAutomationSaveResult = typeof UiAutomationSaveResult.Type;
export const UiAutomationCreateResult = Schema.Struct({
  profileId: ProfileId,
  id: UiAutomationId,
  valid: Schema.Boolean,
  lifecycle: Schema.Literals(["active", "paused", "conflict"]),
  schedule: Schema.optionalKey(boundedString("automation schedule", 256)),
  timezone: Schema.optionalKey(boundedString("automation timezone", 128)),
  gateState: Schema.optionalKey(Schema.Literals(["scheduled", "manual-only"])),
  message: Schema.optionalKey(UiGatewayMessage),
});
export type UiAutomationCreateResult = typeof UiAutomationCreateResult.Type;
export const UiAutomationValidateResult = Schema.Struct({
  profileId: ProfileId,
  validations: Schema.Array(UiAutomationDefinition).check(Schema.isMaxLength(256)),
});
export type UiAutomationValidateResult = typeof UiAutomationValidateResult.Type;
export const UiAutomationPauseResult = Schema.Struct({
  profileId: ProfileId,
  id: UiAutomationId,
  lifecycle: Schema.Literals(["active", "paused"]),
});
export type UiAutomationPauseResult = typeof UiAutomationPauseResult.Type;
export const UiAutomationResumeResult = UiAutomationPauseResult;
export type UiAutomationResumeResult = typeof UiAutomationResumeResult.Type;
const UiMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const UiAutomationRun = Schema.Struct({
  runId: boundedString("automation run id", 256),
  automationId: UiAutomationId,
  trigger: Schema.Literals(["manual-force", "scheduled"]),
  state: Schema.Literals([
    "claimed",
    "running",
    "completed",
    "failed",
    "skipped-gate",
    "skipped-busy",
    "missed",
    "unknown",
  ]),
  scheduledForMs: Schema.NullOr(UiMillis),
  recordedAtMs: UiMillis,
  startedAtMs: Schema.NullOr(UiMillis),
  finishedAtMs: Schema.NullOr(UiMillis),
  failureCategory: Schema.NullOr(boundedString("automation failure category", 128)),
  targets: Schema.Array(
    Schema.Struct({
      target: boundedString("automation target", 256),
      status: Schema.Literals(["delivered", "failed"]),
      failureCategory: Schema.NullOr(boundedString("target failure category", 64)),
      retriable: Schema.NullOr(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(128)),
});
export type UiAutomationRun = typeof UiAutomationRun.Type;
export const UiAutomationStatusResult = Schema.Struct({
  profileId: ProfileId,
  observedAtMs: UiMillis,
  heartbeatAtMs: Schema.NullOr(UiMillis),
  lastTickAtMs: Schema.NullOr(UiMillis),
  lastTickStatus: Schema.NullOr(Schema.Literals(["ok", "error"])),
  lastTickError: Schema.NullOr(UiGatewayMessage),
  schedules: Schema.Array(
    Schema.Struct({
      automationId: UiAutomationId,
      definitionState: Schema.Literals(["valid", "invalid", "deleted"]),
      nextScheduledAtMs: Schema.NullOr(UiMillis),
      definitionObservedAtMs: UiMillis,
      definitionError: Schema.NullOr(UiGatewayMessage),
    }),
  ).check(Schema.isMaxLength(256)),
  activeRunCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  latestRun: Schema.NullOr(UiAutomationRun),
  latestErrorRun: Schema.NullOr(UiAutomationRun),
});
export type UiAutomationStatusResult = typeof UiAutomationStatusResult.Type;
export const UiAutomationRunsResult = Schema.Struct({
  profileId: ProfileId,
  runs: Schema.Array(UiAutomationRun).check(Schema.isMaxLength(256)),
});
export type UiAutomationRunsResult = typeof UiAutomationRunsResult.Type;
export const UiAutomationRunCommandResult = Schema.Struct({
  profileId: ProfileId,
  automationId: UiAutomationId,
  accepted: Schema.Boolean,
  outcome: boundedString("automation outcome", 64),
});
export type UiAutomationRunCommandResult = typeof UiAutomationRunCommandResult.Type;

const UiExtensionDescription = boundedString("extension description", 2_048, 0);
const UiExtensionChoiceKind = Schema.Literals(["skill", "code", "skill+code", "remote"]);
const UiExtensionChoiceSource = Schema.Literals(["bundled", "remote-approved", "profile"]);
const UiNonNegativeCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);
export const UiExtensionChoice = Schema.Struct({
  id: UiExtensionId,
  description: UiExtensionDescription,
  kind: UiExtensionChoiceKind,
  source: UiExtensionChoiceSource,
});
export type UiExtensionChoice = typeof UiExtensionChoice.Type;
export const UiExtensionListForProfileResult = Schema.Struct({
  profileId: ProfileId,
  available: Schema.Array(UiExtensionChoice).check(Schema.isMaxLength(128)),
  selected: Schema.Array(UiExtensionId).check(Schema.isMaxLength(128)),
});
export type UiExtensionListForProfileResult = typeof UiExtensionListForProfileResult.Type;
/** Deliberately no filesystem path: Profile identity is carried by the request/result. */
export const UiExtensionMutationResult = Schema.Struct({
  profileId: ProfileId,
  id: UiExtensionId,
  changed: Schema.Boolean,
  selected: Schema.Boolean,
});
export type UiExtensionMutationResult = typeof UiExtensionMutationResult.Type;
export const UiExtensionValidationResult = Schema.Struct({
  profileId: ProfileId,
  selected: Schema.Array(UiExtensionId).check(Schema.isMaxLength(128)),
  preflight: Schema.Struct({
    extensionPathCount: UiNonNegativeCount,
    skillPathCount: UiNonNegativeCount,
    extensionFactoryCount: UiNonNegativeCount,
  }),
});
export type UiExtensionValidationResult = typeof UiExtensionValidationResult.Type;
export const UiExtensionListing = UiExtensionListForProfileResult;
export type UiExtensionListing = UiExtensionListForProfileResult;
export const UiExtensionMutation = UiExtensionMutationResult;
export type UiExtensionMutation = UiExtensionMutationResult;
export const UiExtensionValidation = UiExtensionValidationResult;
export type UiExtensionValidation = UiExtensionValidationResult;

export const UiPinListResult = Schema.Struct({
  profileId: ProfileId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pins: Schema.Array(UiPin).check(Schema.isMaxLength(256)),
});
export type UiPinListResult = typeof UiPinListResult.Type;
export const UiPinMutationResult = UiPinListResult;
export type UiPinMutationResult = typeof UiPinMutationResult.Type;
export const UiGroupListResult = Schema.Struct({
  profileId: ProfileId,
  groups: Schema.Array(UiGroupRecord).check(Schema.isMaxLength(256)),
});
export type UiGroupListResult = typeof UiGroupListResult.Type;

export const UI_PROTOCOL_MAX_FRAME_BYTES = 64 * 1_024;

export const UiGatewayResult = Schema.Union([
  UiPingResult,
  UiSystemCapabilitiesResult,
  UiProfileListResult,
  UiProfileCurrentResult,
  UiProfileHealthResult,
  UiSessionListResult,
  UiSessionOpenResult,
  UiSessionShowResult,
  UiSessionHistoryResult,
  UiEmptyResult,
  UiAgentListResult,
  UiAgentShowResult,
  UiAgentValidateResult,
  UiAgentRunResult,
  UiModelStatusResult,
  UiModelListResult,
  UiModelSetResult,
  UiAuthStatusResult,
  UiAutomationListResult,
  UiAutomationShowResult,
  UiAutomationCreateResult,
  UiAutomationValidateResult,
  UiAutomationPauseResult,
  UiAutomationStatusResult,
  UiAutomationRunsResult,
  UiAutomationRunCommandResult,
  UiMemoryListResult,
  UiMemoryShowResult,
  UiExtensionListForProfileResult,
  UiExtensionMutationResult,
  UiExtensionValidationResult,
  UiPinListResult,
  UiGroupListResult,
]);
export type UiGatewayResult = typeof UiGatewayResult.Type;

const UiSuccessResponse = Schema.Struct({
  id: UiRequestId,
  ok: Schema.Literal(true),
  result: UiGatewayResult,
}).check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_PROTOCOL_MAX_FRAME_BYTES,
    { expected: "a response within the WebSocket frame budget" },
  ),
);
const UiFailureResponse = Schema.Struct({
  id: UiRequestId,
  ok: Schema.Literal(false),
  error: Schema.Struct({
    code: UiGatewayErrorCode,
    message: UiGatewayMessage,
    details: Schema.optionalKey(UiExtensionFailure),
  }),
});
export const UiResponseFrame = Schema.Union([UiSuccessResponse, UiFailureResponse]);
export type UiResponseFrame = typeof UiResponseFrame.Type;

export const UI_EVENTS = [
  "assistant-text",
  "thinking",
  "tool",
  "voice",
  "settled",
  "error",
  "replay-gap",
] as const;
export type UiEventName = (typeof UI_EVENTS)[number];
const UiEventBase = {
  profileId: ProfileId,
  session: UiSessionRef,
  epoch: UiServerEpoch,
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  eventId: boundedString("event id", 192),
  correlationId: Schema.optionalKey(UiCommandId),
};
const UiAssistantTextEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("assistant-text"),
  payload: Schema.Struct({
    delta: boundedUtf8String("assistant delta", 2_000),
    snapshot: boundedUtf8String("assistant snapshot", 8_000),
  }),
});
const UiThinkingEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("thinking"),
  payload: Schema.Struct({ delta: boundedUtf8String("thinking delta", 8_000) }),
});
const UiToolEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("tool"),
  payload: Schema.Struct({
    phase: Schema.Literals(["start", "update", "end"]),
    toolCallId: boundedString("tool call id", 256),
    toolName: boundedCodePointString("tool name", 256),
    failed: Schema.Boolean,
    detail: Schema.optionalKey(boundedCodePointString("tool detail", 4_096, 0)),
  }),
});
const UiVoiceEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("voice"),
  payload: Schema.Struct({
    agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
    text: boundedCodePointString("specialist voice", 4_096, 0),
  }),
});
const UiSettledEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("settled"),
  payload: Schema.Struct({}),
});
const UiErrorEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("error"),
  payload: Schema.Struct({ message: UiGatewayMessage }),
});
const UiReplayGapEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("replay-gap"),
  payload: Schema.Struct({
    requestedAfter: Schema.Int,
    availableFrom: Schema.Int,
    availableTo: Schema.Int,
    reason: Schema.Literal("epoch"),
  }),
});
export const UiEventFrame = Schema.Union([
  UiAssistantTextEvent,
  UiThinkingEvent,
  UiToolEvent,
  UiVoiceEvent,
  UiSettledEvent,
  UiErrorEvent,
  UiReplayGapEvent,
]);
export type UiEventFrame = typeof UiEventFrame.Type;
