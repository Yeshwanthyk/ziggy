import { Schema } from "effect";
import {
  UiEventFrame,
  UiToolApp,
  type UiEventFrame as UiEventFrameValue,
  type UiCommandId,
  type UiSessionRef,
} from "../../domain/ui-gateway";
import type { ProfileId } from "../../domain/profile-directory";
import type { LiveSessionEvent } from "../../resident/live-sessions";
import { boundedText } from "./errors";

const decodeEventFrame = Schema.decodeUnknownSync(UiEventFrame);

/** A view record that would not fit the wire is dropped; the tool line still shows. */
const isWireToolApp = Schema.is(UiToolApp);

const ASSISTANT_DELTA_MAX_BYTES = 2_000;

const ASSISTANT_SNAPSHOT_MAX_BYTES = 8_000;

const THINKING_DELTA_MAX_BYTES = 8_000;

const TOOL_DETAIL_MAX_CODE_POINTS = 4_096;

const wireText = (value: string, maximum: number): string => [...value].slice(0, maximum).join("");

const wireTextBytes = (value: string, maximum: number): string => {
  const encoder = new TextEncoder();
  const result: string[] = [];
  let size = 0;

  for (const point of value) {
    const nextSize = size + encoder.encode(point).byteLength;

    if (nextSize > maximum) break;
    result.push(point);
    size = nextSize;
  }

  return result.join("");
};

export const eventFrame = (
  profileId: ProfileId,
  ref: UiSessionRef,
  event: LiveSessionEvent,
  epoch: string,
  correlationId?: UiCommandId,
): UiEventFrameValue => {
  const base = {
    profileId,
    session: ref,
    epoch,
    seq: event.seq,
    eventId: event.eventId,
  };

  const withCorrelation = <A extends object>(value: A): A => {
    if (correlationId === undefined) return value;

    return { ...value, correlationId };
  };

  switch (event.event.kind) {
    case "session-state":
      return decodeEventFrame(
        withCorrelation({ ...base, event: "session-state", payload: { scope: event.event.scope } }),
      );
    case "assistant-text":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "assistant-text",
          payload: {
            delta: wireTextBytes(event.event.delta, ASSISTANT_DELTA_MAX_BYTES),
            snapshot: wireTextBytes(event.event.snapshot, ASSISTANT_SNAPSHOT_MAX_BYTES),
          },
        }),
      );
    case "thinking":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "thinking",
          payload: {
            delta: wireTextBytes(event.event.delta, THINKING_DELTA_MAX_BYTES),
          },
        }),
      );
    case "tool": {
      const tool = event.event;

      const payload = {
        phase: tool.phase,
        toolCallId: boundedText(tool.toolCallId, 256, "tool"),
        toolName: boundedText(tool.toolName, 256, "tool"),
        failed: tool.failed,
      };

      const detailed =
        tool.detail === undefined
          ? payload
          : { ...payload, detail: wireText(tool.detail, TOOL_DETAIL_MAX_CODE_POINTS) };

      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "tool",
          payload: isWireToolApp(tool.app) ? { ...detailed, app: tool.app } : detailed,
        }),
      );
    }

    case "voice":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "voice",
          payload: {
            agentId: event.event.agentId,
            text: wireText(event.event.text, 4_096),
          },
        }),
      );
    case "automation-result":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "automation-result",
          payload: {
            automationId: event.event.automationId,
            runId: event.event.runId,
            text: wireText(event.event.text, 1_024),
            timestamp: event.event.timestamp,
          },
        }),
      );
    case "settled":
      return decodeEventFrame(withCorrelation({ ...base, event: "settled", payload: {} }));
    case "error":
      return decodeEventFrame(
        withCorrelation({
          ...base,
          event: "error",
          payload: { message: boundedText(event.event.message) },
        }),
      );
  }
};
