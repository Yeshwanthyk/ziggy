import { Schema } from "effect";

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

export const UI_METHODS = [
  "ping",
  "session.list",
  "session.open",
  "session.watch",
  "prompt.submit",
  "session.steer",
  "session.abort",
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
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const UiLiveSession = Schema.Struct({
  key: UiSessionKey,
  kind: Schema.Literals(["telegram", "discord", "slack", "ui"]),
  idle: Schema.Boolean,
});
export type UiLiveSession = typeof UiLiveSession.Type;

export const UiStoredSession = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  createdAt: Schema.String,
});

const UiSuccessResponse = Schema.Struct({
  id: UiRequestId,
  ok: Schema.Literal(true),
  result: Schema.Unknown,
});
const UiFailureResponse = Schema.Struct({
  id: UiRequestId,
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: UiGatewayErrorCode, message: Schema.String }),
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
