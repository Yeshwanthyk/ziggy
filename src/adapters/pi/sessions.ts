import { lstat, readdir } from "node:fs/promises";
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

const decodeHeaderLine = Schema.decodeUnknownSync(Schema.fromJsonString(SessionHeader));

const decodeEntryLine = Schema.decodeUnknownSync(Schema.fromJsonString(SessionEntry));

type Header = typeof SessionHeader.Type;

type Entry = typeof SessionEntry.Type;

type PiUsage = typeof Usage.Type;

interface ParsedSession {
  readonly file: string;
  readonly relativePath: string;
  readonly header: Header;
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
      }

      if (entry.type === "message" && entry.message === undefined)
        reject({ kind: "invalid-message", entryId: entry.id });
      const message = entry.message;

      if (entry.type === "message") lastMessage = message;

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
        (entry.type === "compaction" || entry.type === "branch_summary") &&
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
      entryCount,
      modelChanges,
      thinkingChanges,
      usage,
      terminalState: terminalState(lastMessage),
    };
  });

const parseSessionHeader = (
  root: string,
  file: string,
): Effect.Effect<ParsedSession, SessionReadFailed> =>
  Effect.gen(function* () {
    let header: Header | undefined;

    yield* scanTranscriptLines(file, (line) => {
      if (line.trim().length === 0) return;
      let decodedHeader: Header;

      try {
        decodedHeader = decodeHeaderLine(line);
      } catch (cause) {
        throw new TranscriptLineRejected(decodeFailure(file, cause));
      }

      if (decodedHeader.id.length === 0 || !Number.isFinite(Date.parse(decodedHeader.timestamp))) {
        throw new TranscriptLineRejected(decodeFailure(file, { kind: "invalid-header-metadata" }));
      }

      header = decodedHeader;

      return false;
    });

    const parsedHeader = header;

    if (parsedHeader === undefined) return yield* decodeFailure(file, { kind: "empty" });

    return {
      file,
      relativePath: path.relative(root, file),
      header: parsedHeader,
      entryCount: 0,
      modelChanges: [],
      thinkingChanges: [],
      usage: zeroUsage(),
      terminalState: "incomplete",
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
            error.operation === "read" && isOversizedLineCause(error.cause)
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
    const root = path.join(profilePath, "sessions");
    const files = yield* discoverFiles(root);

    const headers = yield* Effect.forEach(files, (file) => parseSessionHeader(root, file), {
      concurrency: 1,
    });

    let selected = headers.find((session) => session.header.id === reference);

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

      selected = headers.find((session) => path.normalize(session.relativePath) === normalized);
    }

    if (selected === undefined) {
      return yield* new SessionNotFound({
        reference,
        message: `session not found: ${reference}`,
      });
    }

    const parsed = yield* parseSession(root, selected.file);

    const projected = yield* projectSessions(
      headers.map((session) => (session.file === selected.file ? parsed : session)),
    );

    const metadata = projected.find((session) => session.path === parsed.relativePath);

    if (metadata !== undefined) return metadata;

    return yield* failure(selected.file, "resolve", "selected Pi session was not projected", {
      id: selected.header.id,
    });
  });
