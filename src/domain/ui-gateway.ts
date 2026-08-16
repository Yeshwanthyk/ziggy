import { Schema } from "effect";
import { ProfileExtensionId } from "./profile-extension";

// Protocol mirror: clients/gateway-client/src/index.ts. Keep both v1 surfaces aligned.

const boundedString = (label: string, maximum: number, minimum = 1) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.length >= minimum && value.length <= maximum, {
      expected: `${label} with ${minimum}-${maximum} characters`,
    }),
  );

export const UiRequestId = boundedString("request id", 128);
export type UiRequestId = typeof UiRequestId.Type;

export const UiMethod = boundedString("method", 64);
export type UiMethod = typeof UiMethod.Type;

export const UiSessionName = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u.test(value), {
    expected: "a lower-case single-segment UI session name",
  }),
);
export type UiSessionName = typeof UiSessionName.Type;

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

export const UiSessionKey = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^(?:ui|telegram|discord|slack)\/[A-Za-z0-9._%~-]{1,240}$/u.test(value) &&
      utf8Length(value) <= 256,
    { expected: "a bounded live session key" },
  ),
);
export type UiSessionKey = typeof UiSessionKey.Type;

export const UiPromptText = boundedString("prompt text", 60_000);
export type UiPromptText = typeof UiPromptText.Type;

export const UiRequestEnvelope = Schema.Struct({
  id: UiRequestId,
  method: UiMethod,
  params: Schema.Unknown,
});
export type UiRequestEnvelope = typeof UiRequestEnvelope.Type;

export const UiEmptyParams = Schema.Record(Schema.String, Schema.Never);
export const UiSessionOpenParams = Schema.Struct({ name: UiSessionName });
export const UiSessionParams = Schema.Struct({ session: UiSessionKey });
export const UiSessionTextParams = Schema.Struct({ session: UiSessionKey, text: UiPromptText });

export const UiExtensionId = ProfileExtensionId.check(Schema.isMaxLength(128));
export type UiExtensionId = typeof UiExtensionId.Type;

export const UiExtensionListForProfileParams = UiEmptyParams;
export const UiExtensionAddParams = Schema.Struct({ id: UiExtensionId });
export const UiExtensionRemoveParams = UiExtensionAddParams;
export const UiExtensionValidateParams = UiEmptyParams;

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

export const UI_METHODS = [
  "ping",
  "session.list",
  "session.open",
  "session.watch",
  "prompt.submit",
  "session.steer",
  "session.abort",
  "extension.list-for-profile",
  "extension.add",
  "extension.remove",
  "extension.validate",
] as const;
export type UiKnownMethod = (typeof UI_METHODS)[number];

export const UiGatewayErrorCode = Schema.Literals([
  "unauthorized",
  "unknown_method",
  "bad_params",
  "unknown_session",
  "watch_only",
  "session_busy",
  "not_streaming",
  "capacity_exceeded",
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
  key: UiSessionKey,
  kind: Schema.Literals(["telegram", "discord", "slack", "ui"]),
  idle: Schema.Boolean,
});
export type UiLiveSession = typeof UiLiveSession.Type;

export const UiStoredSession = Schema.Struct({
  id: boundedString("stored session id", 256),
  path: boundedString("stored session path", 4096),
  createdAt: boundedString("stored session timestamp", 128),
});
export type UiStoredSession = typeof UiStoredSession.Type;

export const UiPingResult = Schema.Struct({ pong: Schema.Literal(true) });
export type UiPingResult = typeof UiPingResult.Type;

export const UiSessionListResult = Schema.Struct({
  live: Schema.Array(UiLiveSession).check(Schema.isMaxLength(128)),
  stored: Schema.Array(UiStoredSession).check(Schema.isMaxLength(256)),
});
export type UiSessionListResult = typeof UiSessionListResult.Type;

export const UiSessionOpenResult = Schema.Struct({ session: UiSessionKey });
export type UiSessionOpenResult = typeof UiSessionOpenResult.Type;

export const UiEmptyResult = Schema.Struct({});
export type UiEmptyResult = typeof UiEmptyResult.Type;

const UiExtensionDescription = boundedString("extension description", 2_048, 0);
const UiExtensionPath = boundedString("extension path", 4_096);
const UiExtensionChoiceKind = Schema.Literals(["skill", "code", "skill+code", "remote"]);
const UiExtensionChoiceSource = Schema.Literals(["bundled", "remote-approved", "profile"]);

export const UiExtensionChoice = Schema.Struct({
  id: UiExtensionId,
  description: UiExtensionDescription,
  kind: UiExtensionChoiceKind,
  source: UiExtensionChoiceSource,
});
export type UiExtensionChoice = typeof UiExtensionChoice.Type;

export const UiExtensionListForProfileResult = Schema.Struct({
  available: Schema.Array(UiExtensionChoice).check(Schema.isMaxLength(128)),
  selected: Schema.Array(UiExtensionId).check(Schema.isMaxLength(128)),
});
export type UiExtensionListForProfileResult = typeof UiExtensionListForProfileResult.Type;

export const UiExtensionMutationResult = Schema.Struct({
  id: UiExtensionId,
  profilePath: UiExtensionPath,
  changed: Schema.Boolean,
  selected: Schema.Boolean,
});
export type UiExtensionMutationResult = typeof UiExtensionMutationResult.Type;

const UiNonNegativeCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);

export const UiExtensionValidationResult = Schema.Struct({
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

export const UiGatewayResult = Schema.Union([
  UiPingResult,
  UiSessionListResult,
  UiSessionOpenResult,
  UiEmptyResult,
  UiExtensionListForProfileResult,
  UiExtensionMutationResult,
  UiExtensionValidationResult,
]);
export type UiGatewayResult = typeof UiGatewayResult.Type;

const UiSuccessResponse = Schema.Struct({
  id: UiRequestId,
  ok: Schema.Literal(true),
  result: UiGatewayResult,
});
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

const UiAssistantTextEvent = Schema.Struct({
  event: Schema.Literal("assistant-text"),
  session: UiSessionKey,
  payload: Schema.Struct({ delta: Schema.String, snapshot: Schema.String }),
});
const UiThinkingEvent = Schema.Struct({
  event: Schema.Literal("thinking"),
  session: UiSessionKey,
  payload: Schema.Struct({ delta: Schema.String }),
});
const UiToolEvent = Schema.Struct({
  event: Schema.Literal("tool"),
  session: UiSessionKey,
  payload: Schema.Struct({
    phase: Schema.Literals(["start", "update", "end"]),
    toolCallId: Schema.String,
    toolName: Schema.String,
    failed: Schema.Boolean,
    detail: Schema.optionalKey(Schema.String),
  }),
});
const UiVoiceEvent = Schema.Struct({
  event: Schema.Literal("voice"),
  session: UiSessionKey,
  payload: Schema.Struct({ agentId: Schema.String, text: Schema.String }),
});
const UiSettledEvent = Schema.Struct({
  event: Schema.Literal("settled"),
  session: UiSessionKey,
  payload: Schema.Struct({}),
});
const UiErrorEvent = Schema.Struct({
  event: Schema.Literal("error"),
  session: UiSessionKey,
  payload: Schema.Struct({ message: Schema.String }),
});

export const UiEventFrame = Schema.Union([
  UiAssistantTextEvent,
  UiThinkingEvent,
  UiToolEvent,
  UiVoiceEvent,
  UiSettledEvent,
  UiErrorEvent,
]);
export type UiEventFrame = typeof UiEventFrame.Type;
