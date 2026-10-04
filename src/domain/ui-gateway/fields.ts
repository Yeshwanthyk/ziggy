import { Schema } from "effect";
import { AutomationTargetString } from "../automation";
import { ProfileAgentId, ProfileAgentThinking } from "../profile";
import { ProfileId } from "../profile-directory";

export const UI_PROTOCOL_MAX_FRAME_BYTES = 64 * 1_024;

const UI_PROTOCOL_RESULT_BUDGET_BYTES = 56 * 1_024;

export const resultWithinWireBudget = Schema.makeFilter(
  <Result>(value: Result) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_PROTOCOL_RESULT_BUDGET_BYTES,
  { expected: "a result within the WebSocket frame budget" },
);

/*
 * The UI gateway is intentionally a single protocol. The browser and the
 * server are released together; there is no version negotiation or legacy
 * dispatch path here. These schemas are the wire contract.
 */

export const boundedString = (label: string, maximum: number, minimum = 1) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.length >= minimum && value.length <= maximum, {
      expected: `${label} with ${minimum}-${maximum} characters`,
    }),
  );

export const boundedCodePointString = (label: string, maximum: number, minimum = 1) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) => {
        const length = [...value].length;

        return length >= minimum && length <= maximum;
      },
      { expected: `${label} with ${minimum}-${maximum} Unicode code points` },
    ),
  );

export const boundedUtf8String = (label: string, maximum: number) =>
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
      (/^(?:ui|telegram|discord|slack|device)\/[A-Za-z0-9._%~-]{1,240}$/u.test(value) ||
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

export const UiSessionResumeParams = Schema.Struct({
  ref: UiSessionRef,
  sessionId: UiStoredSessionId,
  commandId: Schema.optionalKey(UiCommandId),
});

export const UiSessionModelSetParams = Schema.Struct({
  ref: UiSessionRef,
  providerId: boundedString("provider id", 128),
  modelId: boundedString("model id", 256),
  commandId: Schema.optionalKey(UiCommandId),
});

export const UiSessionThinkingSetParams = Schema.Struct({
  ref: UiSessionRef,
  thinking: ProfileAgentThinking,
  commandId: Schema.optionalKey(UiCommandId),
});

export const UiSessionRefParams = Schema.Struct({
  ref: UiSessionRef,
  commandId: Schema.optionalKey(UiCommandId),
  afterSeq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  epoch: Schema.optionalKey(UiServerEpoch),
});

export type UiSessionRefParams = typeof UiSessionRefParams.Type;

export const UiUploadId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
);

/** An MCP server or tool name as Pi registers it. */
const UiMcpName = boundedString("MCP name", 256);

/** A view's `ui://` resource, as its server's tools declare it. */
export const UiAppResourceUri = Schema.String.check(
  Schema.isPattern(/^ui:\/\/\S+$/u),
  Schema.isMaxLength(2_048),
);

// Ziggy caps input at 8 KiB and the result at 24 KiB (`extensions/mcp-apps.ts`).
const UI_TOOL_APP_MAX_BYTES = 40 * 1_024;

/** A model-called MCP tool that has a view: what the web UI needs to render the call. */
export const UiToolApp = Schema.Struct({
  server: UiMcpName,
  tool: UiMcpName,
  resourceUri: UiAppResourceUri,
  input: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  truncated: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter((value) => utf8Length(JSON.stringify(value)) <= UI_TOOL_APP_MAX_BYTES, {
    expected: `a tool view record of at most ${UI_TOOL_APP_MAX_BYTES} bytes`,
  }),
);

export type UiToolApp = typeof UiToolApp.Type;

/** What a view asked to add to the model's context for the next turn (`ui/update-model-context`). */
export const UiAppContext = Schema.Struct({
  server: UiMcpName,
  text: boundedCodePointString("app context", 4_000),
});

export type UiAppContext = typeof UiAppContext.Type;

export const UiSessionTextParams = Schema.Struct({
  ref: UiSessionRef,
  text: boundedCodePointString("prompt text", 60_000, 0),
  images: Schema.optionalKey(
    Schema.Array(UiUploadId).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  ),
  recipient: Schema.optionalKey(UiRecipient),
  /** Only on `prompt.submit`: context from the session's views, for this turn only. */
  context: Schema.optionalKey(
    Schema.Array(UiAppContext).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  ),
  commandId: Schema.optionalKey(UiCommandId),
});

/** `app.callTool`: a view calls one of its own server's tools that allows the app. */
export const UiAppCallToolParams = Schema.Struct({
  ref: UiSessionRef,
  server: UiMcpName,
  resourceUri: UiAppResourceUri,
  tool: UiMcpName,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

export type UiAppCallToolParams = typeof UiAppCallToolParams.Type;

/** `app.readResource`: a view resource that one of the server's tools declares. */
export const UiAppReadResourceParams = Schema.Struct({
  ref: UiSessionRef,
  server: UiMcpName,
  uri: UiAppResourceUri,
});

export type UiAppReadResourceParams = typeof UiAppReadResourceParams.Type;

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

export const UiExtensionId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(128),
);

export type UiExtensionId = typeof UiExtensionId.Type;

export const UiExtensionListForProfileParams = UiProfileScopedParams;

export const UiExtensionAddParams = Schema.Struct({
  profileId: ProfileId,
  id: UiExtensionId,
  commandId: Schema.optionalKey(UiCommandId),
});

export const UiExtensionRemoveParams = UiExtensionAddParams;

export const UiExtensionValidateParams = UiProfileScopedParams;

/** Mirrors `PluginSecretName`/`PluginSecretValue` in `extensions/secrets.ts`. */
export const UiPluginSecretSetParams = Schema.Struct({
  profileId: ProfileId,
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u), Schema.isMaxLength(128)),
  value: Schema.String.check(Schema.isPattern(/^[\x20-\x7e]+$/u), Schema.isMaxLength(1024)),
});

export const UiAgentListParams = UiProfileScopedParams;

export const UiAgentShowParams = Schema.Struct({
  profileId: ProfileId,
  agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
});

export const UiAgentDocumentParams = UiAgentShowParams;

export const UiAgentSaveParams = Schema.Struct({
  profileId: ProfileId,
  agentId: ProfileAgentId.check(Schema.isMaxLength(80)),
  expectedSource: boundedCodePointString("expected Profile agent source", 8_000, 0),
  source: boundedCodePointString("Profile agent source", 8_000, 0),
  commandId: Schema.optionalKey(UiCommandId),
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

export const UiDestinationListParams = Schema.Struct({
  profileId: ProfileId,
  after: Schema.optionalKey(AutomationTargetString),
});

export type UiDestinationListParams = typeof UiDestinationListParams.Type;

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

export const UiGroupListParams = UiProfileScopedParams;

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
