import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { ChatEvent } from "../../application/agent";

const AssistantTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const decodeAssistantTextContent = Schema.decodeUnknownOption(AssistantTextContent);

const MAX_PROGRESS_TEXT_CODE_POINTS = 3_800;

const MAX_PROGRESS_DELTA_CODE_POINTS = 512;

const MAX_PROGRESS_TOOL_NAME_CODE_POINTS = 48;

const MAX_PROGRESS_TOOL_ID_CODE_POINTS = 128;

const MAX_PROGRESS_TOOL_DETAIL_CODE_POINTS = 120;

const ProgressToolArgs = Schema.Struct({
  command: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  list: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const decodeProgressToolArgs = Schema.decodeUnknownOption(ProgressToolArgs);

const PROGRESS_TOOL_DETAIL_KEYS = [
  "command",
  "cmd",
  "path",
  "filePath",
  "file",
  "query",
  "list",
  "name",
] as const;

const boundedCodePoints = (value: string, maximum: number): string =>
  [...value].slice(0, maximum).join("");

export const safeProgressToolName = (value: string): string => {
  const normalized = value
    .replace(/[^\p{L}\p{N}_.:/-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return boundedCodePoints(
    normalized.length === 0 ? "tool" : normalized,
    MAX_PROGRESS_TOOL_NAME_CODE_POINTS,
  );
};

export const progressToolDetail = (args: typeof ProgressToolArgs.Type): string | undefined => {
  for (const key of PROGRESS_TOOL_DETAIL_KEYS) {
    const value = args[key];

    if (value === undefined) continue;
    const normalized = value.replace(/\s+/gu, " ").trim();

    if (normalized.length === 0) continue;

    return boundedCodePoints(normalized, MAX_PROGRESS_TOOL_DETAIL_CODE_POINTS);
  }

  return undefined;
};

const assistantTextSnapshot = (content: ReadonlyArray<{ readonly type: string }>): string =>
  boundedCodePoints(
    content
      .flatMap((item) =>
        Option.match(decodeAssistantTextContent(item), {
          onNone: () => [],
          onSome: ({ text }) => [text],
        }),
      )
      .join(""),
    MAX_PROGRESS_TEXT_CODE_POINTS,
  );

const toolEventPhase = (
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end",
): "start" | "update" | "end" =>
  type === "tool_execution_start" ? "start" : type === "tool_execution_update" ? "update" : "end";

export const createChatEventProjector = (): ((
  event: AgentSessionEvent,
) => ReadonlyArray<ChatEvent>) => {
  const lastToolDetail = new Map<string, string>();

  return (event) => {
    if (event.type === "message_update" && event.message.role === "assistant") {
      if (event.assistantMessageEvent.type === "thinking_delta") {
        const delta = boundedCodePoints(
          event.assistantMessageEvent.delta,
          MAX_PROGRESS_DELTA_CODE_POINTS,
        );

        return delta.length === 0 ? [] : [{ kind: "thinking", delta }];
      }

      if (event.assistantMessageEvent.type !== "text_delta") return [];

      const delta = boundedCodePoints(
        event.assistantMessageEvent.delta,
        MAX_PROGRESS_DELTA_CODE_POINTS,
      );

      const snapshot = assistantTextSnapshot(event.message.content);

      return snapshot.length > 0 || delta.length > 0
        ? [{ kind: "assistant-text", delta, snapshot }]
        : [];
    }

    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      const fromArgs = Option.match(
        decodeProgressToolArgs(event.type === "tool_execution_end" ? undefined : event.args, {
          onExcessProperty: "ignore",
        }),
        {
          onNone: () => undefined,
          onSome: progressToolDetail,
        },
      );

      if (fromArgs !== undefined) lastToolDetail.set(event.toolCallId, fromArgs);
      const detail = fromArgs ?? lastToolDetail.get(event.toolCallId);

      if (event.type === "tool_execution_end") lastToolDetail.delete(event.toolCallId);

      return [
        {
          kind: "tool",
          phase: toolEventPhase(event.type),
          toolCallId: boundedCodePoints(event.toolCallId, MAX_PROGRESS_TOOL_ID_CODE_POINTS),
          toolName: safeProgressToolName(event.toolName),
          failed: event.type === "tool_execution_end" && event.isError,
          ...Object.fromEntries(detail === undefined ? [] : ([["detail", detail]] as const)),
        },
      ];
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
        return [];
      }

      return [
        {
          kind: "error",
          message: event.message.errorMessage ?? `Request ${event.message.stopReason}`,
        },
      ];
    }

    if (event.type === "agent_settled") return [{ kind: "settled" }];

    return [];
  };
};
