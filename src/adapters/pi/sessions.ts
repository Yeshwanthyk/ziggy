import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import type {
  SessionMetadata,
  SessionModelChange,
  SessionReferenceMetadata,
  SessionTerminalState,
  SessionThinkingChange,
  SessionUsage,
} from "../../domain/session";
import { SessionNotFound, SessionReadFailed } from "../../domain/session";
import { fileSystemCauseDetails } from "../fs/cause";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const isTooLargeTranscriptCause = Schema.is(Schema.Struct({ kind: Schema.Literal("too-large") }));

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
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  provider: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
  message: Schema.optional(RawMessage),
});

const decodeHeaderLine = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionHeader));
const decodeEntryLine = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionEntry));

type Header = typeof SessionHeader.Type;
type Entry = typeof SessionEntry.Type;
type PiUsage = typeof Usage.Type;

interface ParsedSession {
  readonly file: string;
  readonly relativePath: string;
  readonly header: Header;
  readonly entries: ReadonlyArray<Entry>;
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

const discoverFiles = (root: string): Effect.Effect<ReadonlyArray<string>, SessionReadFailed> =>
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

const readRegularFile = (file: string): Effect.Effect<string, SessionReadFailed> =>
  Effect.acquireUseRelease(
    io(file, "read", () => open(file, constants.O_RDONLY | constants.O_NOFOLLOW)),
    (handle) =>
      io(file, "read", () => handle.stat()).pipe(
        Effect.flatMap((status) =>
          status.isFile() && status.size <= MAX_TRANSCRIPT_BYTES
            ? io(file, "read", (signal) => handle.readFile({ encoding: "utf8", signal }))
            : Effect.fail(
                failure(file, "read", `session file is not a regular bounded transcript: ${file}`, {
                  kind: status.isFile() ? "too-large" : "wrong-type",
                  size: status.size,
                  maximum: MAX_TRANSCRIPT_BYTES,
                }),
              ),
        ),
      ),
    (handle) => io(file, "read", () => handle.close()),
  );

const terminalState = (entries: ReadonlyArray<Entry>): SessionTerminalState => {
  const lastMessage = entries.findLast((entry) => entry.type === "message");
  const message = lastMessage?.message;
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
    const text = yield* readRegularFile(file);
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const headerLine = lines[0];
    if (headerLine === undefined) return yield* decodeFailure(file, { kind: "empty" });
    const header = yield* decodeHeaderLine(headerLine).pipe(
      Effect.mapError((cause) => decodeFailure(file, cause)),
    );
    if (header.id.length === 0 || !Number.isFinite(Date.parse(header.timestamp)))
      return yield* decodeFailure(file, { kind: "invalid-header-metadata" });
    const entries = yield* Effect.forEach(
      lines.slice(1),
      (line) => decodeEntryLine(line).pipe(Effect.mapError((cause) => decodeFailure(file, cause))),
      { concurrency: 1 },
    );
    if (entries.some((entry) => entry.type === "session")) {
      return yield* decodeFailure(file, { kind: "duplicate-header" });
    }
    if (
      entries.some(
        (entry) =>
          entry.id.length === 0 ||
          entry.type.length === 0 ||
          !Number.isFinite(Date.parse(entry.timestamp)),
      )
    )
      return yield* decodeFailure(file, { kind: "invalid-entry-metadata" });

    const modelChanges: Array<SessionModelChange> = [];
    const thinkingChanges: Array<SessionThinkingChange> = [];
    let usage = zeroUsage();
    for (const entry of entries) {
      if (entry.type === "model_change") {
        if (entry.provider === undefined || entry.modelId === undefined)
          return yield* decodeFailure(file, { kind: "invalid-model-change", entryId: entry.id });
        modelChanges.push({ at: entry.timestamp, provider: entry.provider, model: entry.modelId });
      } else if (entry.type === "thinking_level_change") {
        if (entry.thinkingLevel === undefined)
          return yield* decodeFailure(file, { kind: "invalid-thinking-change", entryId: entry.id });
        thinkingChanges.push({ at: entry.timestamp, level: entry.thinkingLevel });
      }

      if (entry.type === "message" && entry.message === undefined)
        return yield* decodeFailure(file, { kind: "invalid-message", entryId: entry.id });
      const message = entry.message;
      if (entry.type === "message" && message?.role === "assistant") {
        if (
          message.provider === undefined ||
          message.model === undefined ||
          message.stopReason === undefined ||
          message.usage === undefined
        )
          return yield* decodeFailure(file, { kind: "invalid-assistant", entryId: entry.id });
        usage = addUsage(usage, message.usage);
      } else if (entry.type === "message" && message?.role === "toolResult") {
        if (message.usage !== undefined) usage = addUsage(usage, message.usage);
      } else if (
        (entry.type === "compaction" || entry.type === "branch_summary") &&
        entry.usage !== undefined
      ) {
        usage = addUsage(usage, entry.usage);
      }
    }

    return {
      file,
      relativePath: path.relative(root, file),
      header,
      entries,
      modelChanges,
      thinkingChanges,
      usage,
      terminalState: terminalState(entries),
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
        return {
          path: session.relativePath,
          id: session.header.id,
          kind: parentPath === undefined ? "root" : "child",
          createdAt: session.header.timestamp,
          entryCount: session.entries.length,
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
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.path.localeCompare(right.path),
      );
  });

export const listProfileSessions = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<SessionMetadata>, SessionReadFailed> =>
  Effect.gen(function* () {
    const root = path.join(profilePath, "sessions");
    const files = yield* discoverFiles(root);
    const parsed = yield* Effect.forEach(
      files,
      (file) =>
        parseSession(root, file).pipe(
          Effect.catch((error) =>
            error.operation === "read" && isTooLargeTranscriptCause(error.cause)
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        ),
      { concurrency: 1 },
    );
    return yield* projectSessions(
      parsed.filter((session): session is ParsedSession => session !== undefined),
    );
  });

export const showProfileSession = (
  profilePath: string,
  reference: string,
): Effect.Effect<SessionMetadata, SessionReadFailed | SessionNotFound> =>
  Effect.gen(function* () {
    const sessions = yield* listProfileSessions(profilePath);
    const byId = sessions.find((session) => session.id === reference);
    if (byId !== undefined) return byId;

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
    const byPath = sessions.find((session) => path.normalize(session.path) === normalized);
    if (byPath !== undefined) return byPath;
    return yield* new SessionNotFound({
      reference,
      message: `session not found: ${reference}`,
    });
  });
