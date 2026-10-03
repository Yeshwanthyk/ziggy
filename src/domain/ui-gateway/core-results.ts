import { Schema } from "effect";
import { AutomationTargetString } from "../automation";
import { ProfileAgentId, ProfileAgentThinking } from "../profile";
import { ProfileId } from "../profile-directory";
import { SHARED_MEMORY_CAP, memoryEntries } from "../../memory";
import { codePointLength } from "../../platform/text";
import {
  boundedString,
  boundedCodePointString,
  resultWithinWireBudget,
  UiAutomationId,
  UiConversationContext,
  UiExtensionFailure,
  UiGatewayMessage,
  UiMemoryPath,
  UiSessionHistoryCursor,
  UiSessionKey,
  UiSessionRef,
  UiStoredSessionId,
  UiMethod,
  UiServerEpoch,
  UiToolApp,
  UiUploadId,
} from "./fields";

export const UI_METHODS = [
  "ping",
  "system.capabilities",
  "profile.list",
  "profile.current",
  "profile.health",
  "group.list",
  "session.list",
  "session.show",
  "session.history",
  "session.open",
  "session.model.status",
  "session.model.set",
  "session.thinking.set",
  "session.summaries",
  "session.resume",
  "session.watch",
  "session.unwatch",
  "session.close",
  "prompt.submit",
  "session.steer",
  "session.follow-up",
  "session.abort",
  "agent.list",
  "agent.show",
  "agent.document",
  "agent.save",
  "agent.create",
  "agent.validate",
  "agent.run",
  "model.status",
  "model.list",
  "model.available",
  "model.set",
  "auth.status",
  "destination.list",
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
  "plugin.secret.set",
  "app.callTool",
  "app.readResource",
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
  kind: Schema.Literals(["telegram", "discord", "slack", "device", "ui"]),
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
  profiles: Schema.Array(UiProfileSummary).check(Schema.isMaxLength(32)),
}).check(resultWithinWireBudget);

export type UiProfileListResult = typeof UiProfileListResult.Type;

export const UiProfileCurrentResult = Schema.Struct({
  profileId: ProfileId,
  name: boundedString("Profile name", 128),
  /** Exact `ziggy` CLI argument that resolves back to this Profile. */
  cliTarget: boundedString("Profile CLI target", 4096),
});

export type UiProfileCurrentResult = typeof UiProfileCurrentResult.Type;

export const UiProfileHealthCheck = Schema.Struct({
  id: boundedString("health check id", 80),
  severity: Schema.Literals(["ok", "warn", "error"]),
  message: UiGatewayMessage,
});

export const UiProfileHealthResult = Schema.Struct({
  profileId: ProfileId,
  checks: Schema.Array(UiProfileHealthCheck).check(Schema.isMaxLength(16)),
  hasErrors: Schema.Boolean,
}).check(resultWithinWireBudget);

export type UiProfileHealthResult = typeof UiProfileHealthResult.Type;

export const UiSessionSummary = Schema.Struct({
  id: UiStoredSessionId,
  title: boundedCodePointString("session title", 160),
  updatedAt: boundedString("session updated time", 128),
  held: Schema.Boolean,
});

export const UiSessionSummaryResult = Schema.Struct({
  profileId: ProfileId,
  canResume: Schema.Boolean,
  currentSessionId: Schema.NullOr(UiStoredSessionId),
  sessions: Schema.Array(UiSessionSummary).check(Schema.isMaxLength(32)),
  truncated: Schema.Boolean,
}).check(resultWithinWireBudget);

export const UiSessionResumeResult = Schema.Struct({
  profileId: ProfileId,
  ref: UiSessionRef,
  cancelled: Schema.Boolean,
  sessionId: UiStoredSessionId,
});

export const UiSessionModelResult = Schema.Struct({
  profileId: ProfileId,
  ref: UiSessionRef,
  providerId: Schema.NullOr(boundedString("provider id", 128)),
  modelId: Schema.NullOr(boundedString("model id", 256)),
  thinking: ProfileAgentThinking,
});

export const UiSessionListResult = Schema.Struct({
  profileId: ProfileId,
  live: Schema.Array(UiLiveSession).check(Schema.isMaxLength(16)),
  stored: Schema.Array(UiStoredSession).check(Schema.isMaxLength(12)),
}).check(resultWithinWireBudget);

export type UiSessionListResult = typeof UiSessionListResult.Type;

export const UiAutomationDestination = Schema.Struct({
  target: AutomationTargetString,
  kind: Schema.Literals(["conversation", "telegram", "discord", "slack"]),
  label: Schema.optionalKey(boundedCodePointString("destination label", 160, 1)),
  category: Schema.Literals(["agent", "session", "telegram", "discord", "slack"]),
  pinned: Schema.Boolean,
  activityAt: Schema.optionalKey(boundedString("destination activity timestamp", 128)),
  agentId: Schema.optionalKey(ProfileAgentId.check(Schema.isMaxLength(80))),
});

export type UiAutomationDestination = typeof UiAutomationDestination.Type;

export const UiDestinationListResult = Schema.Struct({
  profileId: ProfileId,
  entries: Schema.Array(UiAutomationDestination).check(Schema.isMaxLength(32)),
  nextCursor: Schema.optionalKey(AutomationTargetString),
}).check(resultWithinWireBudget);

export type UiDestinationListResult = typeof UiDestinationListResult.Type;

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
  storedSessionId: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(
        (value) =>
          value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value),
        { expected: "a canonical 1-128 character Pi session id" },
      ),
    ),
  ),
});

export type UiSessionShowResult = typeof UiSessionShowResult.Type;

export const UiSessionHistoryEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    timestamp: boundedString("session history timestamp", 128),
    text: boundedCodePointString("session history text", 1_024, 0),
    imageCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    kind: Schema.Literal("assistant"),
    timestamp: boundedString("session history timestamp", 128),
    text: boundedCodePointString("session history text", 1_024, 0),
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    timestamp: boundedString("session history timestamp", 128),
    phase: Schema.Literals(["start", "end"]),
    toolName: boundedCodePointString("session history tool name", 48),
    failed: Schema.Boolean,
    app: Schema.optionalKey(UiToolApp),
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-result"),
    timestamp: boundedString("session history timestamp", 128),
    automationId: UiAutomationId,
    runId: boundedString("automation run id", 256),
    text: boundedCodePointString("automation result text", 1_024, 0),
  }),
]);

export type UiSessionHistoryEntry = typeof UiSessionHistoryEntry.Type;

/**
 * `app.callTool` and `app.readResource`: the JSON result is too large for a frame (a view's HTML
 * runs to hundreds of KiB), so it waits once, for this connection's owner, at `/app-content/<id>`.
 */
export const UiAppContentResult = Schema.Struct({
  profileId: ProfileId,
  contentId: UiUploadId,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type UiAppContentResult = typeof UiAppContentResult.Type;

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

export const UiAcknowledgedResult = Schema.Struct({ acknowledged: Schema.Literal(true) });

export type UiAcknowledgedResult = typeof UiAcknowledgedResult.Type;

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
  description: boundedString("Profile agent description", 512),
  provider: Schema.optionalKey(boundedString("Profile agent provider", 128)),
  model: Schema.optionalKey(boundedString("Profile agent model", 256)),
  thinking: Schema.optionalKey(ProfileAgentThinking),
  tools: Schema.Array(boundedString("Profile agent tool", 128)).check(Schema.isMaxLength(8)),
});

export type UiProfileAgent = typeof UiProfileAgent.Type;

export const UiAgentListResult = Schema.Struct({
  profileId: ProfileId,
  agents: Schema.Array(UiProfileAgent).check(Schema.isMaxLength(4)),
}).check(resultWithinWireBudget);

export type UiAgentListResult = typeof UiAgentListResult.Type;

export const UiAgentShowResult = Schema.Struct({ profileId: ProfileId, agent: UiProfileAgent });

export type UiAgentShowResult = typeof UiAgentShowResult.Type;

export const UiAgentDocumentResult = Schema.Struct({
  profileId: ProfileId,
  id: ProfileAgentId.check(Schema.isMaxLength(80)),
  source: boundedCodePointString("Profile agent source", 8_000, 0),
}).check(resultWithinWireBudget);

export type UiAgentDocumentResult = typeof UiAgentDocumentResult.Type;

export const UiAgentCreateResult = UiAgentShowResult;

export type UiAgentCreateResult = typeof UiAgentCreateResult.Type;

export const UiAgentValidation = Schema.Struct({
  id: ProfileAgentId.check(Schema.isMaxLength(80)),
  valid: Schema.Boolean,
  message: Schema.optionalKey(UiGatewayMessage),
});

export const UiAgentValidateResult = Schema.Struct({
  profileId: ProfileId,
  validations: Schema.Array(UiAgentValidation).check(Schema.isMaxLength(16)),
}).check(resultWithinWireBudget);

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
  documents: Schema.Array(UiMemoryDocumentSummary).check(Schema.isMaxLength(16)),
}).check(resultWithinWireBudget);

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
  providers: Schema.Array(UiAuthProvider).check(Schema.isMaxLength(16)),
}).check(resultWithinWireBudget);

export type UiAuthStatusResult = typeof UiAuthStatusResult.Type;
