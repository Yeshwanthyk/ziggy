import * as path from "node:path";
import { Effect, Schema } from "effect";
import type {
  SessionHistoryEntry,
  SessionHistoryPage,
  SessionMetadata,
  SessionTerminalState,
} from "../../domain/session";
import {
  SessionHistoryCursorInvalid,
  SessionNotFound,
  SessionReadFailed,
} from "../../domain/session";
import { showProfileSession } from "./sessions";
import { scanTranscriptLines, TranscriptLineRejected } from "./transcript-lines";
import { AutomationResultDetails } from "./automation-result";

export const MAX_HISTORY_ENTRIES = 8;

export const MAX_HISTORY_TEXT_CODE_POINTS = 1_024;

type RawJson = string | number | boolean | null | ReadonlyArray<RawJson> | RawRecord;

type RawRecord = { readonly [key: string]: RawJson };

const RawJson: Schema.Decoder<RawJson, never> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(RawJson),
    Schema.Record(Schema.String, RawJson),
  ]),
);

const RawRecord: Schema.Decoder<RawRecord, never> = Schema.Record(Schema.String, RawJson);

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RawRecord));

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});

const decodeCursorJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));

const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));

const readFailure = (file: string, operation: "read" | "decode", message: string, cause: unknown) =>
  new SessionReadFailed({ path: file, operation, message, cause });

const isStringSchema = Schema.is(Schema.String);

const isRawRecordSchema = Schema.is(RawRecord);

const isRawArraySchema = Schema.is(Schema.Array(RawJson));

const isAutomationResultDetails = Schema.is(AutomationResultDetails);

const isString = (value: RawJson | undefined): value is string => isStringSchema(value);

const isRawRecord = (value: RawJson | undefined): value is RawRecord => isRawRecordSchema(value);

const isRawArray = (value: RawJson | undefined): value is ReadonlyArray<RawJson> =>
  isRawArraySchema(value);

const stringValue = (value: RawJson | undefined): string | undefined =>
  isString(value) ? value : undefined;

const recordValue = (value: RawJson | undefined): RawRecord | undefined =>
  isRawRecord(value) ? value : undefined;

const messageText = (message: RawJson | undefined): string => {
  if (message === undefined) return "";

  if (isString(message)) return message;
  const record = recordValue(message);

  if (record === undefined) return "";
  const content = record.content;

  if (isString(content)) return content;

  if (!isRawArray(content)) return "";

  return content
    .map((part) => {
      const item = recordValue(part);

      return item === undefined ? "" : (stringValue(item.text) ?? "");
    })
    .filter((part) => part.length > 0)
    .join("");
};

const validTimestamp = (value: RawJson | undefined, fallback: string): string => {
  const timestamp = stringValue(value);

  return timestamp !== undefined && Number.isFinite(Date.parse(timestamp)) ? timestamp : fallback;
};

const boundedText = (value: string, maximum: number): string =>
  [...value].slice(0, maximum).join("");

const MAX_ACTIVE_TOOL_CALLS = 1_024;

const projectRecord = (
  record: RawRecord,
  activeTools: Map<string, { readonly timestamp: string; readonly toolName: string }>,
): SessionHistoryEntry | undefined => {
  const type = stringValue(record.type);
  const timestamp = validTimestamp(record.timestamp, new Date(0).toISOString());
  const message = recordValue(record.message);
  const role = stringValue(message?.role);

  if (type === "custom_message" && stringValue(record.customType) === "ziggy.automation-result") {
    const details = recordValue(record.details);
    const text = boundedText(messageText(record.content), MAX_HISTORY_TEXT_CODE_POINTS);

    if (isAutomationResultDetails(details) && text.length > 0) {
      return {
        kind: "automation-result",
        timestamp,
        automationId: details.automationId,
        runId: details.runId,
        text,
      };
    }
  }

  if (type === "message" && role === "user") {
    const text = boundedText(messageText(message), MAX_HISTORY_TEXT_CODE_POINTS);

    return text.length > 0 ? { kind: "user", timestamp, text } : undefined;
  }

  if (type === "message" && role === "assistant") {
    const text = boundedText(messageText(message), MAX_HISTORY_TEXT_CODE_POINTS);

    return text.length > 0 ? { kind: "assistant", timestamp, text } : undefined;
  }

  if (type === "message" && (role === "toolResult" || role === "tool")) {
    const toolCallId = stringValue(record.toolCallId) ?? stringValue(message?.toolCallId);
    const toolName = stringValue(record.toolName) ?? stringValue(message?.toolName) ?? "tool";

    if (toolCallId !== undefined) {
      const started = activeTools.get(toolCallId);
      activeTools.delete(toolCallId);

      return {
        kind: "tool",
        timestamp,
        phase: "end",
        toolName: boundedText(started?.toolName ?? toolName, 48),
        failed: Boolean(message?.isError ?? record.isError ?? false),
      };
    }

    return undefined;
  }

  if (type === "toolCall" || type === "tool_call") {
    const toolCallId = stringValue(record.toolCallId) ?? stringValue(record.id);
    const toolName = stringValue(record.toolName) ?? stringValue(record.name) ?? "tool";

    if (toolCallId !== undefined) {
      if (activeTools.size >= MAX_ACTIVE_TOOL_CALLS) {
        const oldest = activeTools.keys().next().value;

        if (oldest !== undefined) activeTools.delete(oldest);
      }

      activeTools.set(toolCallId, { timestamp, toolName });
    }

    return {
      kind: "tool",
      timestamp,
      phase: "start",
      toolName: boundedText(toolName, 48),
      failed: false,
    };
  }

  return undefined;
};

const cursorError = (message: string, cause?: unknown): SessionHistoryCursorInvalid => {
  if (cause === undefined) return new SessionHistoryCursorInvalid({ message });

  return new SessionHistoryCursorInvalid({ message, cause });
};

const decodeCursor = (
  cursor: string,
): Effect.Effect<typeof Cursor.Type, SessionHistoryCursorInvalid> =>
  Effect.gen(function* () {
    const bytes = yield* Effect.try({
      try: () => Buffer.from(cursor, "base64url"),
      catch: (cause) => cursorError("invalid session history cursor", cause),
    });

    if (bytes.byteLength === 0) return yield* cursorError("invalid session history cursor");
    const text = new TextDecoder().decode(bytes);

    return yield* decodeCursorJson(text).pipe(
      Effect.mapError((cause) => cursorError("invalid session history cursor", cause)),
    );
  });

const terminalState = (metadata: SessionMetadata): SessionTerminalState => metadata.terminalState;

const sessionFile = (profilePath: string, metadata: SessionMetadata): string =>
  path.join(profilePath, "sessions", metadata.path);

/**
 * Read a bounded, safe projection from the Pi-owned JSONL transcript. This
 * adapter never opens a mutable Pi session and never writes the transcript.
 */
export const readSessionHistory = (
  profilePath: string,
  reference: string,
  before?: string,
): Effect.Effect<
  SessionHistoryPage,
  SessionReadFailed | SessionNotFound | SessionHistoryCursorInvalid
> =>
  Effect.gen(function* () {
    const metadata = yield* showProfileSession(profilePath, reference);
    const file = sessionFile(profilePath, metadata);
    const decodedCursor = before === undefined ? undefined : yield* decodeCursor(before);

    const activeTools = new Map<
      string,
      { readonly timestamp: string; readonly toolName: string }
    >();

    const recent: Array<SessionHistoryEntry> = [];
    const requested: Array<SessionHistoryEntry> = [];
    const requestedStart = Math.max(0, (decodedCursor?.index ?? 0) - MAX_HISTORY_ENTRIES);
    let entryCount = 0;

    const digest = yield* scanTranscriptLines(file, (line) => {
      if (line.trim().length === 0) return;
      let record: RawRecord;

      try {
        record = decodeRecord(line);
      } catch (cause) {
        throw new TranscriptLineRejected(
          readFailure(file, "decode", "invalid Pi session transcript", cause),
        );
      }

      const projected = projectRecord(record, activeTools);

      if (projected === undefined) return;

      if (decodedCursor === undefined) {
        recent.push(projected);

        if (recent.length > MAX_HISTORY_ENTRIES) recent.shift();
      } else if (entryCount >= requestedStart && entryCount < decodedCursor.index) {
        requested.push(projected);
      }

      entryCount += 1;
    });

    if (decodedCursor !== undefined) {
      if (decodedCursor.digest !== digest || decodedCursor.index > entryCount) {
        return yield* cursorError("session history cursor is stale");
      }
    }

    const end = decodedCursor?.index ?? entryCount;
    const start = Math.max(0, end - MAX_HISTORY_ENTRIES);
    const pageEntries = decodedCursor === undefined ? recent : requested;
    const hasMore = start > 0;

    const nextCursor = hasMore
      ? Buffer.from(encodeCursor({ version: 1, index: start, digest })).toString("base64url")
      : undefined;

    const page: SessionHistoryPage = {
      entries: pageEntries,
      terminalState: terminalState(metadata),
      truncated: entryCount > pageEntries.length,
      hasMore,
    };

    if (nextCursor !== undefined) return { ...page, nextCursor };

    return page;
  });

export const sessionHistoryFilePath = (profilePath: string, metadata: SessionMetadata): string =>
  sessionFile(profilePath, metadata);
