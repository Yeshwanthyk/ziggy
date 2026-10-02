import { Schema } from "effect";
import { ProfileAgentId } from "../profile";
import { ProfileId } from "../profile-directory";
import {
  boundedString,
  boundedCodePointString,
  boundedUtf8String,
  UiAutomationId,
  UiCommandId,
  UiExtensionFailure,
  UiGatewayMessage,
  UiRequestId,
  UiServerEpoch,
  UiSessionRef,
  UiToolApp,
  UI_PROTOCOL_MAX_FRAME_BYTES,
} from "./fields";
import { UiGatewayErrorCode } from "./core-results";
import { UiGatewayResult } from "./results";

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
  "automation-result",
  "settled",
  "error",
  "replay-gap",
  "session-state",
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
    app: Schema.optionalKey(UiToolApp),
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

const UiAutomationResultEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("automation-result"),
  payload: Schema.Struct({
    automationId: UiAutomationId,
    runId: boundedString("automation run id", 256),
    text: boundedCodePointString("automation result text", 1_024, 0),
    timestamp: boundedString("automation result timestamp", 128),
  }),
});

const UiSessionStateEvent = Schema.Struct({
  ...UiEventBase,
  event: Schema.Literal("session-state"),
  payload: Schema.Struct({ scope: Schema.Literals(["transcript", "model"]) }),
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
  UiAutomationResultEvent,
  UiSessionStateEvent,
  UiSettledEvent,
  UiErrorEvent,
  UiReplayGapEvent,
]);

export type UiEventFrame = typeof UiEventFrame.Type;
