/**
 * Read-only Sessions: a Profile's Pi transcripts listed, shown, located and paged back.
 * Every read streams through `transcript.ts`; nothing here writes a transcript.
 */
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { AUTOMATION_RESULT_CUSTOM_TYPE, AutomationResultDetails } from "../domain/automation";
import type { ProfileTarget } from "../profile";
import { isSessionHeld } from "./lease";
import {
  decodeFailure,
  readTranscriptHeader,
  scanTranscript,
  transcriptFiles,
  type TranscriptContent,
  type TranscriptEntry,
  type TranscriptHeader,
  type TranscriptUsage,
} from "./transcript";
import {
  SessionHistoryCursorInvalid,
  SessionNotFound,
  SessionReadFailed,
  type ProfileSessionSummary,
  type SessionHistoryEntry,
  type SessionHistoryPage,
  type SessionMetadata,
  type SessionModelChange,
  type SessionReferenceMetadata,
  type SessionTerminalState,
  type SessionThinkingChange,
  type SessionUsage,
} from "./types";

const HISTORY_PAGE = 8;

const HISTORY_TEXT_CODE_POINTS = 1_024;

const CACHE_LIMIT = 512;

/** One transcript, read once: everything list, show and summaries project from. */
interface Transcript {
  readonly file: string;
  /** Relative to the Profile's `sessions/` directory. */
  readonly path: string;
  readonly header: TranscriptHeader;
  readonly name: string | undefined;
  readonly title: string | undefined;
  readonly activityAt: string;
  readonly entryCount: number;
  readonly modelChanges: ReadonlyArray<SessionModelChange>;
  readonly thinkingChanges: ReadonlyArray<SessionThinkingChange>;
  readonly usage: SessionUsage;
  readonly terminalState: SessionTerminalState;
}

/** Parsed transcripts by file, reused while size and mtime hold; oldest evicted past the limit. */
type TranscriptCache = Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly transcript: Transcript }
>;

const sessionsRoot = (profilePath: string) => path.join(profilePath, "sessions");

const failure = (
  path: string,
  operation: SessionReadFailed["operation"],
  message: string,
  cause: unknown,
) => new SessionReadFailed({ path, operation, message, cause });

const notFound = (reference: string, message = `session not found: ${reference}`) =>
  new SessionNotFound({ reference, message });

const ambiguous = (at: string, id: string) =>
  failure(at, "resolve", `ambiguous Pi session ID: ${id}`, { id });

const isAutomationResultDetails = Schema.is(AutomationResultDetails);

const isText = Schema.is(Schema.String);

const textOf = (content: TranscriptContent | undefined, separator: string): string =>
  content === undefined
    ? ""
    : isText(content)
      ? content
      : content
          .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
          .join(separator);

const bounded = (text: string, limit: number) => [...text].slice(0, limit).join("");

const addUsage = (total: SessionUsage, next: TranscriptUsage): SessionUsage => {
  const sum = {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
    cost: total.cost + next.cost.total,
  };

  return total.reasoning === undefined && next.reasoning === undefined
    ? sum
    : { ...sum, reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) };
};

const terminalState = (message: TranscriptEntry["message"]): SessionTerminalState => {
  if (message?.role !== "assistant") return "incomplete";

  if (message.stopReason === "aborted") return "aborted";

  if (message.stopReason === "error") return "failed";

  return message.stopReason === "stop" || message.stopReason === "length"
    ? "completed"
    : "incomplete";
};

const isAutomationResult = (entry: TranscriptEntry) =>
  entry.type === "custom_message" && entry.customType === AUTOMATION_RESULT_CUSTOM_TYPE;

/** Parse one transcript strictly: any entry Pi would not write rejects the file. */
const parseTranscript = (root: string, file: string) =>
  Effect.gen(function* () {
    let header: TranscriptHeader | undefined;
    let name: string | undefined;
    let title: string | undefined;
    let activityAt: string | undefined;
    let entryCount = 0;

    let usage: SessionUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    };

    let lastMessage: TranscriptEntry["message"];
    const modelChanges: Array<SessionModelChange> = [];
    const thinkingChanges: Array<SessionThinkingChange> = [];
    const reject = (kind: string, entryId: string) => decodeFailure(file, { kind, entryId });

    yield* scanTranscript(file, {
      header: (decoded) => {
        header = decoded;

        return undefined;
      },
      entry: (entry) => {
        entryCount += 1;
        const message = entry.message;

        if (entry.type === "model_change") {
          if (entry.provider === undefined || entry.modelId === undefined)
            return reject("invalid-model-change", entry.id);
          modelChanges.push({
            at: entry.timestamp,
            provider: entry.provider,
            model: entry.modelId,
          });
        } else if (entry.type === "thinking_level_change") {
          if (entry.thinkingLevel === undefined) return reject("invalid-thinking-change", entry.id);
          thinkingChanges.push({ at: entry.timestamp, level: entry.thinkingLevel });
        } else if (entry.type === "session_info") {
          const candidate = entry.name?.replace(/[\r\n]+/gu, " ").trim();
          name = candidate === undefined || candidate.length === 0 ? undefined : candidate;
        } else if (entry.type === "message") {
          if (message === undefined) return reject("invalid-message", entry.id);
          activityAt = entry.timestamp;
          lastMessage = message;

          if (title === undefined && message.role === "user") {
            const text = textOf(message.content, " ").replace(/\s+/gu, " ").trim();
            title = text.length === 0 ? undefined : bounded(text, 160);
          }

          if (message.role === "assistant") {
            if (
              message.provider === undefined ||
              message.model === undefined ||
              message.stopReason === undefined ||
              message.usage === undefined
            )
              return reject("invalid-assistant", entry.id);
            usage = addUsage(usage, message.usage);
          } else if (message.role === "toolResult" && message.usage !== undefined) {
            usage = addUsage(usage, message.usage);
          }
        } else if (isAutomationResult(entry)) {
          activityAt = entry.timestamp;
        } else if (
          (entry.type === "usage" ||
            entry.type === "compaction" ||
            entry.type === "branch_summary") &&
          entry.usage !== undefined
        ) {
          usage = addUsage(usage, entry.usage);
        }

        return undefined;
      },
    });

    if (header === undefined) return yield* decodeFailure(file, { kind: "empty" });

    const transcript: Transcript = {
      file,
      path: path.relative(root, file),
      header,
      name,
      title,
      activityAt: activityAt ?? header.timestamp,
      entryCount,
      modelChanges,
      thinkingChanges,
      usage,
      terminalState: terminalState(lastMessage),
    };

    return transcript;
  });

const readTranscript = (root: string, file: string, cache: TranscriptCache | undefined) =>
  Effect.gen(function* () {
    if (cache === undefined) return yield* parseTranscript(root, file);

    const status = yield* Effect.tryPromise({
      try: () => lstat(file),
      catch: (cause) => failure(file, "read", `could not inspect ${file}`, cause),
    });

    const hit = cache.get(file);
    cache.delete(file);

    if (hit !== undefined && hit.mtimeMs === status.mtimeMs && hit.size === status.size) {
      cache.set(file, hit);

      return hit.transcript;
    }

    const transcript = yield* parseTranscript(root, file);
    cache.set(file, { mtimeMs: status.mtimeMs, size: status.size, transcript });

    for (const oldest of cache.keys()) {
      if (cache.size <= CACHE_LIMIT) break;
      cache.delete(oldest);
    }

    return transcript;
  });

interface ProfileScan {
  readonly root: string;
  /** Readable transcripts, the first file per id. */
  readonly transcripts: ReadonlyArray<Transcript>;
  /** Ids more than one file claims. */
  readonly ambiguous: ReadonlySet<string>;
  /** Why each unreadable or duplicate file, by relative path, was left out. */
  readonly skipped: ReadonlyMap<string, SessionReadFailed>;
}

/** Read every transcript leniently: bad files are logged and set aside, never fatal. */
const scanProfile = (profilePath: string, cache: TranscriptCache | undefined) =>
  Effect.gen(function* () {
    const root = sessionsRoot(profilePath);
    const { files, refused } = yield* transcriptFiles(root);
    const transcripts: Array<Transcript> = [];
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    const skipped = new Map<string, SessionReadFailed>();

    for (const file of refused)
      yield* Effect.logWarning("Skipped symlinked session transcript", { path: file });

    for (const file of files) {
      const read = yield* Effect.result(readTranscript(root, file, cache));

      if (Result.isFailure(read)) {
        skipped.set(path.relative(root, file), read.failure);
        yield* Effect.logWarning("Skipped unreadable session transcript", {
          path: file,
          message: read.failure.message,
        });
        continue;
      }

      const transcript = read.success;

      if (seen.has(transcript.header.id)) {
        duplicated.add(transcript.header.id);
        skipped.set(transcript.path, ambiguous(file, transcript.header.id));
        yield* Effect.logWarning("Skipped duplicate session transcript", {
          path: file,
          id: transcript.header.id,
        });
        continue;
      }

      seen.add(transcript.header.id);
      transcripts.push(transcript);
    }

    const scan: ProfileScan = { root, transcripts, ambiguous: duplicated, skipped };

    return scan;
  });

/** Attach parents and children, which may live in any directory of the tree. */
const project = (transcripts: ReadonlyArray<Transcript>): ReadonlyArray<SessionMetadata> => {
  const byFile = new Map(transcripts.map((transcript) => [transcript.file, transcript]));
  const children = new Map<string, Array<SessionReferenceMetadata>>();

  const parentOf = (transcript: Transcript) => {
    const parentPath = transcript.header.parentSession;

    return parentPath === undefined ? undefined : byFile.get(path.resolve(parentPath));
  };

  for (const transcript of transcripts) {
    const parent = parentOf(transcript);

    if (parent === undefined) continue;
    const references = children.get(parent.header.id) ?? [];
    references.push({ id: transcript.header.id, path: transcript.path });
    children.set(parent.header.id, references);
  }

  return transcripts
    .map((transcript): SessionMetadata => {
      const parent = parentOf(transcript);
      const hasParent = transcript.header.parentSession !== undefined;

      const metadata: SessionMetadata = {
        path: transcript.path,
        id: transcript.header.id,
        kind: hasParent ? "child" : "root",
        createdAt: transcript.header.timestamp,
        activityAt: transcript.activityAt,
        entryCount: transcript.entryCount,
        parent: parent === undefined ? undefined : { id: parent.header.id, path: parent.path },
        parentUnknown: hasParent && parent === undefined,
        children: (children.get(transcript.header.id) ?? []).sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
        modelChanges: transcript.modelChanges,
        thinkingChanges: transcript.thinkingChanges,
        usage: transcript.usage,
        terminalState: transcript.terminalState,
      };

      return transcript.name === undefined ? metadata : { ...metadata, name: transcript.name };
    })
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.path.localeCompare(right.path),
    );
};

/** Every readable session, newest first. Unreadable files are logged and left out. */
export const listSessions = (profilePath: string, cache?: TranscriptCache) =>
  scanProfile(profilePath, cache).pipe(Effect.map((scan) => project(scan.transcripts)));

/** Every readable session plus how many files were left out, for health checks. */
export const inspectSessions = (profilePath: string) =>
  scanProfile(profilePath, undefined).pipe(
    Effect.map((scan) => ({ sessions: project(scan.transcripts), skipped: scan.skipped.size })),
  );

/** The session list the UI shows: id, title and last activity, most recent first. */
export const sessionSummaries = (profilePath: string, cache?: TranscriptCache) =>
  scanProfile(profilePath, cache).pipe(
    Effect.map((scan) =>
      scan.transcripts
        .map(
          (transcript): ProfileSessionSummary => ({
            id: transcript.header.id,
            path: transcript.path,
            title: transcript.name ?? transcript.title,
            updatedAt: transcript.activityAt,
          }),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path),
        ),
    ),
  );

/** One session by id or by path under `sessions/`, strictly: an unreadable addressed file fails. */
export const showSession = (profilePath: string, reference: string, cache?: TranscriptCache) =>
  Effect.gen(function* () {
    const scan = yield* scanProfile(profilePath, cache);

    if (scan.ambiguous.has(reference)) return yield* ambiguous(scan.root, reference);

    let selected = scan.transcripts.find((transcript) => transcript.header.id === reference);

    if (selected === undefined) {
      if (path.isAbsolute(reference))
        return yield* notFound(
          reference,
          "session path must be relative to the Profile sessions directory",
        );

      const relative = path.normalize(reference);

      if (relative === ".." || relative.startsWith(`..${path.sep}`))
        return yield* notFound(
          reference,
          "session path must stay inside the Profile sessions directory",
        );

      selected = scan.transcripts.find(
        (transcript) => path.normalize(transcript.path) === relative,
      );

      const skipped = scan.skipped.get(relative);

      if (selected === undefined && skipped !== undefined) return yield* skipped;
    }

    if (selected === undefined) return yield* notFound(reference);

    if (scan.ambiguous.has(selected.header.id))
      return yield* ambiguous(selected.file, selected.header.id);

    const shown = project(
      scan.transcripts.filter((transcript) => !scan.ambiguous.has(transcript.header.id)),
    ).find((session) => session.path === selected.path);

    return shown ?? (yield* notFound(reference));
  });

export interface SessionLocation {
  readonly id: string;
  /** Absolute transcript file. */
  readonly file: string;
  /** Relative to the Profile's `sessions/` directory. */
  readonly path: string;
}

/** Find a session's transcript by id from headers alone. */
export const locateSession = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    const root = sessionsRoot(profilePath);
    const { files } = yield* transcriptFiles(root);
    const matches: Array<string> = [];

    for (const file of files) {
      const header = yield* readTranscriptHeader(file).pipe(Effect.option);

      if (header._tag === "Some" && header.value.id === id) matches.push(file);
    }

    const [file, ...others] = matches;

    if (file === undefined) return yield* notFound(id);

    if (others.length > 0) return yield* ambiguous(root, id);

    const location: SessionLocation = { id, file, path: path.relative(root, file) };

    return location;
  });

/**
 * Locate a session and read its whole transcript strictly, before handing the file to Pi,
 * whose SessionManager may rewrite a file it cannot fully parse.
 */
export const locateValidSession = (profilePath: string, id: string) =>
  Effect.gen(function* () {
    const location = yield* locateSession(profilePath, id);
    yield* parseTranscript(sessionsRoot(profilePath), location.file);

    return location;
  });

/** A page boundary: history before the projected entry at `index`, which must still be `id`. */
const Cursor = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  id: Schema.NonEmptyString,
});

const CursorJson = Schema.fromJsonString(Cursor);

const encodeCursorJson = Schema.encodeSync(CursorJson);

const decodeCursorJson = Schema.decodeUnknownEffect(CursorJson);

const encodeCursor = (cursor: typeof Cursor.Type) =>
  Buffer.from(encodeCursorJson(cursor)).toString("base64url");

const invalidCursor = (message: string, cause?: unknown) =>
  cause === undefined
    ? new SessionHistoryCursorInvalid({ message })
    : new SessionHistoryCursorInvalid({ message, cause });

const decodeCursor = (cursor: string) =>
  decodeCursorJson(Buffer.from(cursor, "base64url").toString("utf8")).pipe(
    Effect.mapError((cause) => invalidCursor("invalid session history cursor", cause)),
  );

const historyEntry = (entry: TranscriptEntry): SessionHistoryEntry | undefined => {
  const message = entry.message;
  const timestamp = entry.timestamp;

  if (isAutomationResult(entry)) {
    const text = bounded(textOf(entry.content, ""), HISTORY_TEXT_CODE_POINTS);

    return isAutomationResultDetails(entry.details) && text.length > 0
      ? {
          kind: "automation-result",
          timestamp,
          automationId: entry.details.automationId,
          runId: entry.details.runId,
          text,
        }
      : undefined;
  }

  if (entry.type !== "message" || message === undefined) return undefined;

  if (message.role === "user" || message.role === "assistant") {
    const text = bounded(textOf(message.content, ""), HISTORY_TEXT_CODE_POINTS);

    return text.length > 0 ? { kind: message.role, timestamp, text } : undefined;
  }

  // Pi writes a tool call inside the assistant message; only its result is an entry.
  if (message.role === "toolResult" && message.toolCallId !== undefined)
    return {
      kind: "tool",
      timestamp,
      phase: "end",
      toolName: bounded(message.toolName ?? "tool", 48),
      failed: message.isError ?? false,
    };

  return undefined;
};

/**
 * The last page of a session's conversation, or the page before `before`. The cursor names
 * the entry it stops at, so appends never invalidate it; a rewritten transcript does.
 */
export const sessionHistory = (profilePath: string, id: string, before?: string) =>
  Effect.gen(function* () {
    const cursor = before === undefined ? undefined : yield* decodeCursor(before);
    const { file } = yield* locateSession(profilePath, id);
    const page: Array<{ readonly id: string; readonly entry: SessionHistoryEntry }> = [];
    let boundaryId: string | undefined;
    let lastMessage: TranscriptEntry["message"];
    let count = 0;

    yield* scanTranscript(file, {
      header: () => undefined,
      entry: (entry) => {
        if (entry.type === "message") lastMessage = entry.message;
        const projected = historyEntry(entry);

        if (projected === undefined) return undefined;

        if (cursor === undefined) {
          page.push({ id: entry.id, entry: projected });

          if (page.length > HISTORY_PAGE) page.shift();
        } else if (count === cursor.index) {
          boundaryId = entry.id;
        } else if (count >= cursor.index - HISTORY_PAGE && count < cursor.index) {
          page.push({ id: entry.id, entry: projected });
        }

        count += 1;

        return undefined;
      },
    });

    if (cursor !== undefined && boundaryId !== cursor.id)
      return yield* invalidCursor("session history cursor is stale");

    const end = cursor?.index ?? count;
    const start = end - page.length;
    const first = page[0];

    const result: SessionHistoryPage = {
      entries: page.map((item) => item.entry),
      terminalState: terminalState(lastMessage),
      truncated: count > page.length,
      hasMore: start > 0,
    };

    return start > 0 && first !== undefined
      ? { ...result, nextCursor: encodeCursor({ index: start, id: first.id }) }
      : result;
  });

/** Read-only sessions for any Profile, sharing one parse cache. */
export class Sessions extends Context.Service<Sessions>()("ziggy/Sessions", {
  make: Effect.sync(() => {
    const cache: TranscriptCache = new Map();

    return {
      list: Effect.fn("Sessions.list")((target: ProfileTarget) => listSessions(target.path, cache)),
      summaries: Effect.fn("Sessions.summaries")((target: ProfileTarget) =>
        sessionSummaries(target.path, cache),
      ),
      show: Effect.fn("Sessions.show")((target: ProfileTarget, reference: string) =>
        showSession(target.path, reference, cache),
      ),
      locate: Effect.fn("Sessions.locate")((target: ProfileTarget, id: string) =>
        locateSession(target.path, id),
      ),
      history: Effect.fn("Sessions.history")((target: ProfileTarget, id: string, before?: string) =>
        sessionHistory(target.path, id, before),
      ),
      /** A momentary lease observation, not a reservation; callers probe only rows they display. */
      held: Effect.fn("Sessions.held")((target: ProfileTarget, id: string) =>
        Effect.fromResult(isSessionHeld(target.path, id)),
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type SessionsApi = (typeof Sessions)["Service"];
