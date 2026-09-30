import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import type {
  ProfileSessionSummary,
  SessionMetadata,
  SessionModelChange,
  SessionReferenceMetadata,
  SessionTerminalState,
  SessionThinkingChange,
  SessionUsage,
} from "../../domain/session";
import { SessionNotFound, SessionReadFailed } from "../../domain/session";
import { fileSystemCauseDetails } from "../../platform/cause";
import { scanTranscriptLines, TranscriptLineRejected } from "./transcript-lines";

const isOversizedLineCause = Schema.is(Schema.Struct({ kind: Schema.Literal("line-too-large") }));

const UsageCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  total: Schema.Finite,
});

const Usage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  reasoning: Schema.optional(Schema.Finite),
  totalTokens: Schema.Finite,
  cost: UsageCost,
});

const RawMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
});

const SessionHeader = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.String,
  parentSession: Schema.optional(Schema.String),
});

const SessionEntry = Schema.Struct({
  type: Schema.String,
  customType: Schema.optional(Schema.String),
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  provider: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
  message: Schema.optional(RawMessage),
});

const decodeHeaderLine = Schema.decodeUnknownSync(Schema.fromJsonString(SessionHeader));

const decodeEntryLine = Schema.decodeUnknownSync(Schema.fromJsonString(SessionEntry));

type Header = typeof SessionHeader.Type;

type Entry = typeof SessionEntry.Type;

type PiUsage = typeof Usage.Type;

interface ParsedSession {
  readonly file: string;
  readonly relativePath: string;
  readonly header: Header;
  readonly name: string | undefined;
  readonly firstUserMessage: string | undefined;
  readonly activityAt: string;
  readonly entryCount: number;
  readonly modelChanges: ReadonlyArray<SessionModelChange>;
  readonly thinkingChanges: ReadonlyArray<SessionThinkingChange>;
  readonly usage: SessionUsage;
  readonly terminalState: SessionTerminalState;
}

const failure = (
  path: string,
  operation: SessionReadFailed["operation"],
  message: string,
  cause: unknown,
) => new SessionReadFailed({ path, operation, message, cause });

const missingPath = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";

const io = <A>(
  filePath: string,
  operation: SessionReadFailed["operation"],
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, SessionReadFailed> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => failure(filePath, operation, `failed to ${operation} ${filePath}`, cause),
  });

const zeroUsage = (): SessionUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

const addUsage = (total: SessionUsage, next: PiUsage): SessionUsage => {
  const combined = {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
    cost: total.cost + next.cost.total,
  };

  if (total.reasoning !== undefined || next.reasoning !== undefined) {
    return { ...combined, reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) };
  }

  return combined;
};

const inspectRegularPath = (
  targetPath: string,
  kind: "directory" | "file",
): Effect.Effect<void, SessionReadFailed> =>
  io(targetPath, "inspect-root", () => lstat(targetPath)).pipe(
    Effect.flatMap((status) => {
      if (status.isSymbolicLink()) {
        return Effect.fail(
          failure(
            targetPath,
            "inspect-root",
            `session ${kind} must not be a symlink: ${targetPath}`,
            {
              kind: "symlink",
            },
          ),
        );
      }

      const valid = kind === "directory" ? status.isDirectory() : status.isFile();

      return valid
        ? Effect.void
        : Effect.fail(
            failure(
              targetPath,
              "inspect-root",
              `session ${kind} has the wrong file type: ${targetPath}`,
              { kind: "wrong-type" },
            ),
          );
    }),
  );

const discoverFiles = (
  root: string,
  skipInvalid = false,
): Effect.Effect<ReadonlyArray<string>, SessionReadFailed> =>
  Effect.gen(function* () {
    const status = yield* io(root, "inspect-root", () => lstat(root)).pipe(Effect.result);

    if (status._tag === "Failure") {
      if (missingPath(status.failure.cause)) return [];

      return yield* status.failure;
    }

    if (status.success.isSymbolicLink() || !status.success.isDirectory()) {
      return yield* failure(
        root,
        "inspect-root",
        status.success.isSymbolicLink()
          ? `session root must not be a symlink: ${root}`
          : `session root must be a directory: ${root}`,
        { kind: status.success.isSymbolicLink() ? "symlink" : "wrong-type" },
      );
    }

    const files: Array<string> = [];
    const pending = [root];

    while (pending.length > 0) {
      const directory = pending.pop();

      if (directory === undefined) break;

      const children = yield* io(directory, "walk", () =>
        readdir(directory, { withFileTypes: true }),
      );

      children.sort((left, right) => left.name.localeCompare(right.name));

      for (const child of children) {
        const childPath = path.join(directory, child.name);

        if (child.isSymbolicLink()) {
          if (skipInvalid) {
            yield* Effect.logWarning("Skipped symlinked session transcript", { path: childPath });
            continue;
          }

          return yield* failure(
            childPath,
            "walk",
            `session tree must not contain symlinks: ${childPath}`,
            { kind: "symlink" },
          );
        }

        if (child.isDirectory()) pending.push(childPath);
        else if (child.name.endsWith(".jsonl")) {
          yield* inspectRegularPath(childPath, "file");
          files.push(childPath);
        }
      }
    }

    return files.sort((left, right) => left.localeCompare(right));
  });

const decodeFailure = (file: string, cause: unknown) =>
  failure(file, "decode", `invalid Pi session metadata in ${file}`, cause);

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const isTextPart = Schema.is(TextPart);

const isString = Schema.is(Schema.String);

const TextContent = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);

const isTextContent = Schema.is(TextContent);

const firstUserText = (content: typeof TextContent.Type): string | undefined => {
  const text = isString(content)
    ? content
    : content !== undefined
      ? content
          .filter(isTextPart)
          .map((part) => part.text)
          .join(" ")
      : "";

  const normalized = text.replace(/\s+/gu, " ").trim();

  return normalized.length === 0 ? undefined : [...normalized].slice(0, 160).join("");
};

const terminalState = (message: Entry["message"]): SessionTerminalState => {
  if (message?.role !== "assistant") return "incomplete";

  if (message.stopReason === "aborted") return "aborted";

  if (message.stopReason === "error") return "failed";

  return message.stopReason === "stop" || message.stopReason === "length"
    ? "completed"
    : "incomplete";
};

const parseSession = (
  root: string,
  file: string,
): Effect.Effect<ParsedSession, SessionReadFailed> =>
  Effect.gen(function* () {
    let header: Header | undefined;
    let entryCount = 0;
    const modelChanges: Array<SessionModelChange> = [];
    const thinkingChanges: Array<SessionThinkingChange> = [];
    let usage = zeroUsage();
    let lastMessage: Entry["message"];
    let name: string | undefined;
    let firstUserMessage: string | undefined;
    let activityAt: string | undefined;

    const reject = (cause: unknown): never => {
      throw new TranscriptLineRejected(decodeFailure(file, cause));
    };

    const decodeLine = <A>(decode: (line: string) => A, line: string): A => {
      try {
        return decode(line);
      } catch (cause) {
        return reject(cause);
      }
    };

    yield* scanTranscriptLines(file, (line) => {
      if (line.trim().length === 0) return;

      if (header === undefined) {
        const decodedHeader = decodeLine(decodeHeaderLine, line);

        if (
          decodedHeader.id.length === 0 ||
          !Number.isFinite(Date.parse(decodedHeader.timestamp))
        ) {
          reject({ kind: "invalid-header-metadata" });
        }

        header = decodedHeader;

        return;
      }

      const entry = decodeLine(decodeEntryLine, line);

      if (entry.type === "session") reject({ kind: "duplicate-header" });

      if (
        entry.id.length === 0 ||
        entry.type.length === 0 ||
        !Number.isFinite(Date.parse(entry.timestamp))
      ) {
        reject({ kind: "invalid-entry-metadata" });
      }

      entryCount += 1;

      if (entry.type === "model_change") {
        const provider = entry.provider;
        const modelId = entry.modelId;

        if (provider === undefined || modelId === undefined) {
          reject({ kind: "invalid-model-change", entryId: entry.id });
        } else {
          modelChanges.push({ at: entry.timestamp, provider, model: modelId });
        }
      } else if (entry.type === "thinking_level_change") {
        const thinkingLevel = entry.thinkingLevel;

        if (thinkingLevel === undefined) {
          reject({ kind: "invalid-thinking-change", entryId: entry.id });
        } else {
          thinkingChanges.push({ at: entry.timestamp, level: thinkingLevel });
        }
      } else if (entry.type === "session_info") {
        const candidate = entry.name?.replace(/[\r\n]+/gu, " ").trim();
        name = candidate === undefined || candidate.length === 0 ? undefined : candidate;
      }

      if (entry.type === "message" && entry.message === undefined)
        reject({ kind: "invalid-message", entryId: entry.id });
      const message = entry.message;

      if (
        firstUserMessage === undefined &&
        entry.type === "message" &&
        message?.role === "user" &&
        isTextContent(message.content)
      )
        firstUserMessage = firstUserText(message.content);

      if (
        entry.type === "message" ||
        (entry.type === "custom_message" && entry.customType === "ziggy.automation-result")
      ) {
        activityAt = entry.timestamp;
      }

      if (entry.type === "message") {
        lastMessage = message;
      }

      if (entry.type === "message" && message?.role === "assistant") {
        const provider = message.provider;
        const model = message.model;
        const stopReason = message.stopReason;
        const messageUsage = message.usage;

        if (
          provider === undefined ||
          model === undefined ||
          stopReason === undefined ||
          messageUsage === undefined
        ) {
          reject({ kind: "invalid-assistant", entryId: entry.id });
        } else {
          usage = addUsage(usage, messageUsage);
        }
      } else if (entry.type === "message" && message?.role === "toolResult") {
        if (message.usage !== undefined) usage = addUsage(usage, message.usage);
      } else if (
        (entry.type === "usage" ||
          entry.type === "compaction" ||
          entry.type === "branch_summary") &&
        entry.usage !== undefined
      ) {
        usage = addUsage(usage, entry.usage);
      }
    });

    const parsedHeader = header;

    if (parsedHeader === undefined) return yield* decodeFailure(file, { kind: "empty" });

    return {
      file,
      relativePath: path.relative(root, file),
      header: parsedHeader,
      name,
      activityAt: activityAt ?? parsedHeader.timestamp,
      firstUserMessage,
      entryCount,
      modelChanges,
      thinkingChanges,
      usage,
      terminalState: terminalState(lastMessage),
    };
  });

const projectSessions = (
  parsed: ReadonlyArray<ParsedSession>,
): Effect.Effect<ReadonlyArray<SessionMetadata>, SessionReadFailed> =>
  Effect.gen(function* () {
    const byFile = new Map<string, ParsedSession>();
    const byId = new Map<string, ParsedSession>();

    for (const session of parsed) {
      const normalizedFile = path.resolve(session.file);

      if (byFile.has(normalizedFile) || byId.has(session.header.id)) {
        return yield* failure(session.file, "resolve", "duplicate Pi session path or ID", {
          id: session.header.id,
        });
      }

      byFile.set(normalizedFile, session);
      byId.set(session.header.id, session);
    }

    const children = new Map<string, Array<SessionReferenceMetadata>>();

    for (const session of parsed) {
      const parentPath = session.header.parentSession;

      if (parentPath === undefined) continue;
      const parent = byFile.get(path.resolve(parentPath));

      if (parent === undefined) continue;
      const references = children.get(parent.header.id) ?? [];
      references.push({ id: session.header.id, path: session.relativePath });
      children.set(parent.header.id, references);
    }

    return parsed
      .map((session): SessionMetadata => {
        const parentPath = session.header.parentSession;
        const parent = parentPath === undefined ? undefined : byFile.get(path.resolve(parentPath));

        const metadata: SessionMetadata = {
          path: session.relativePath,
          id: session.header.id,
          kind: parentPath === undefined ? "root" : "child",
          createdAt: session.header.timestamp,
          activityAt: session.activityAt,
          entryCount: session.entryCount,
          parent:
            parent === undefined ? undefined : { id: parent.header.id, path: parent.relativePath },
          parentUnknown: parentPath !== undefined && parent === undefined,
          children: (children.get(session.header.id) ?? []).sort((left, right) =>
            left.path.localeCompare(right.path),
          ),
          modelChanges: session.modelChanges,
          thinkingChanges: session.thinkingChanges,
          usage: session.usage,
          terminalState: session.terminalState,
        };

        return session.name === undefined ? metadata : { ...metadata, name: session.name };
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.path.localeCompare(right.path),
      );
  });

const readParsedProfileSessions = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<ParsedSession>, SessionReadFailed> =>
  Effect.gen(function* () {
    const root = path.join(profilePath, "sessions");
    const files = yield* discoverFiles(root);

    const parsed = yield* Effect.forEach(
      files,
      (file) =>
        parseSession(root, file).pipe(
          Effect.catch((error) =>
            error.operation === "read" && isOversizedLineCause(error.cause)
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        ),
      { concurrency: 1 },
    );

    return parsed.filter((session): session is ParsedSession => session !== undefined);
  });

export const listProfileSessions = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<SessionMetadata>, SessionReadFailed> =>
  readParsedProfileSessions(profilePath).pipe(Effect.flatMap(projectSessions));

const summaryCacheLimit = 512;

const summaryCache = new Map<
  string,
  { mtimeMs: number; size: number; summary: ProfileSessionSummary }
>();

/** Reads transcripts without SessionManager.open. Lease state is probed separately per displayed row. */
export const listProfileSessionSummaries = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<ProfileSessionSummary>, SessionReadFailed> =>
  Effect.gen(function* () {
    const root = path.join(profilePath, "sessions");
    const files = yield* discoverFiles(root, true);
    const seen = new Set<string>();
    const summaries: Array<ProfileSessionSummary> = [];
    const present = new Set(files.map((file) => path.resolve(file)));

    for (const cached of summaryCache.keys()) {
      const relative = path.relative(root, cached);

      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        continue;

      if (!present.has(cached)) summaryCache.delete(cached);
    }

    for (const file of files) {
      const canonical = path.resolve(file);
      const status = yield* Effect.result(io(file, "read", () => lstat(file)));

      if (status._tag === "Failure") {
        summaryCache.delete(canonical);
        yield* Effect.logWarning("Skipped unreadable session transcript", {
          path: file,
          message: status.failure.message,
        });
        continue;
      }

      const cached = summaryCache.get(canonical);
      let summary: ProfileSessionSummary;

      if (
        cached !== undefined &&
        cached.mtimeMs === status.success.mtimeMs &&
        cached.size === status.success.size
      ) {
        summaryCache.delete(canonical);
        summaryCache.set(canonical, cached);
        summary = cached.summary;
      } else {
        summaryCache.delete(canonical);
        const parsed = yield* Effect.result(parseSession(root, file));

        if (parsed._tag === "Failure") {
          yield* Effect.logWarning("Skipped unreadable session transcript", {
            path: file,
            message: parsed.failure.message,
          });
          continue;
        }

        const session = parsed.success;
        summary = {
          id: session.header.id,
          path: session.relativePath,
          title: session.name ?? session.firstUserMessage,
          updatedAt: session.activityAt,
        };
        summaryCache.set(canonical, {
          mtimeMs: status.success.mtimeMs,
          size: status.success.size,
          summary,
        });

        if (summaryCache.size > summaryCacheLimit) {
          const oldest = summaryCache.keys().next().value;

          if (oldest !== undefined) summaryCache.delete(oldest);
        }
      }

      if (seen.has(summary.id)) {
        yield* Effect.logWarning("Skipped duplicate session transcript", {
          path: file,
          id: summary.id,
        });
        continue;
      }

      seen.add(summary.id);
      summaries.push(summary);
    }

    return summaries.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path),
    );
  });

export const showProfileSession = (
  profilePath: string,
  reference: string,
): Effect.Effect<SessionMetadata, SessionReadFailed | SessionNotFound> =>
  Effect.gen(function* () {
    const root = path.join(profilePath, "sessions");
    const files = yield* discoverFiles(root, true);
    const sessions: Array<ParsedSession> = [];
    const seen = new Set<string>();
    const ambiguous = new Set<string>();
    const invalid = new Map<string, SessionReadFailed>();
    const duplicatePaths = new Map<string, string>();

    for (const file of files) {
      const parsed = yield* Effect.result(parseSession(root, file));

      if (parsed._tag === "Failure") {
        invalid.set(path.relative(root, file), parsed.failure);
        yield* Effect.logWarning("Skipped unreadable session transcript", {
          path: file,
          message: parsed.failure.message,
        });
        continue;
      }

      const session = parsed.success;

      if (seen.has(session.header.id)) {
        ambiguous.add(session.header.id);
        duplicatePaths.set(session.relativePath, session.header.id);
        yield* Effect.logWarning("Skipped duplicate session transcript", {
          path: file,
          id: session.header.id,
        });
        continue;
      }

      seen.add(session.header.id);
      sessions.push(session);
    }

    if (ambiguous.has(reference))
      return yield* failure(root, "resolve", `ambiguous Pi session ID: ${reference}`, {
        id: reference,
      });

    let selected = sessions.find((session) => session.header.id === reference);

    if (selected === undefined) {
      if (path.isAbsolute(reference)) {
        return yield* new SessionNotFound({
          reference,
          message: "session path must be relative to the Profile sessions directory",
        });
      }

      const normalized = path.normalize(reference);

      if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
        return yield* new SessionNotFound({
          reference,
          message: "session path must stay inside the Profile sessions directory",
        });
      }

      selected = sessions.find((session) => path.normalize(session.relativePath) === normalized);

      if (selected === undefined) {
        const addressedFailure = invalid.get(normalized);

        if (addressedFailure !== undefined) return yield* addressedFailure;
        const duplicateId = duplicatePaths.get(normalized);

        if (duplicateId !== undefined)
          return yield* failure(root, "resolve", `ambiguous Pi session ID: ${duplicateId}`, {
            id: duplicateId,
          });
      }
    }

    if (selected === undefined) {
      return yield* new SessionNotFound({
        reference,
        message: `session not found: ${reference}`,
      });
    }

    if (ambiguous.has(selected.header.id))
      return yield* failure(
        selected.file,
        "resolve",
        `ambiguous Pi session ID: ${selected.header.id}`,
        {
          id: selected.header.id,
        },
      );

    const projected = yield* projectSessions(
      sessions.filter((session) => !ambiguous.has(session.header.id)),
    );

    const metadata = projected.find((session) => session.path === selected.relativePath);

    if (metadata !== undefined) return metadata;

    return yield* failure(selected.file, "resolve", "selected Pi session was not projected", {
      id: selected.header.id,
    });
  });
