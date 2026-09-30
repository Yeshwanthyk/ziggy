/**
 * Read-only access to Pi's JSONL transcripts. Records stream through the bounded line reader;
 * nothing here builds Pi's SessionManager, whose open can rewrite a file.
 */
import { lstat, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Result, Schema } from "effect";
import { fileSystemCauseDetails } from "../platform/cause";
import { scanLines, type LineReadFailed } from "../platform/lines";
import { SessionReadFailed } from "./types";

/** A transcript may grow without bound, but one record may not, so a bad file cannot pin memory. */
export const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;

const Timestamp = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), { expected: "a timestamp" }),
);

const Usage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  reasoning: Schema.optional(Schema.Finite),
  totalTokens: Schema.Finite,
  cost: Schema.Struct({ total: Schema.Finite }),
});

export type TranscriptUsage = typeof Usage.Type;

/** Message content: plain text, or parts of which only text is ever read. */
const Content = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
]);

export type TranscriptContent = typeof Content.Type;

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.NonEmptyString,
  timestamp: Timestamp,
  cwd: Schema.String,
  parentSession: Schema.optional(Schema.String),
});

export type TranscriptHeader = typeof Header.Type;

/** The fields Ziggy reads from Pi's `SessionEntry` union; everything else passes through unread. */
const Entry = Schema.Struct({
  type: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Timestamp,
  customType: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
  content: Schema.optional(Content),
  details: Schema.optional(Schema.Unknown),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      content: Schema.optional(Content),
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      stopReason: Schema.optional(Schema.String),
      usage: Schema.optional(Usage),
      toolCallId: Schema.optional(Schema.String),
      toolName: Schema.optional(Schema.String),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
});

export type TranscriptEntry = typeof Entry.Type;

const decodeHeader = Schema.decodeUnknownResult(Schema.fromJsonString(Header));

const decodeEntry = Schema.decodeUnknownResult(Schema.fromJsonString(Entry));

/** What a visitor returns: nothing to go on, `"stop"` to end early, or a failure to reject the file. */
export type Visit = SessionReadFailed | "stop" | undefined;

export interface TranscriptVisitor {
  readonly header: (header: TranscriptHeader) => Visit;
  readonly entry?: ((entry: TranscriptEntry) => Visit) | undefined;
}

const failure = (
  path: string,
  operation: SessionReadFailed["operation"],
  message: string,
  cause: unknown,
) => new SessionReadFailed({ path, operation, message, cause });

export const decodeFailure = (file: string, cause: unknown) =>
  failure(file, "decode", `invalid Pi session transcript: ${file}`, cause);

const readFailure = (file: string, cause: LineReadFailed) =>
  cause.reason === "line-too-large"
    ? failure(file, "read", `Pi session transcript has an oversized record: ${file}`, {
        kind: "line-too-large",
        line: cause.line,
        maximum: MAX_TRANSCRIPT_LINE_BYTES,
      })
    : cause.reason === "wrong-type"
      ? failure(file, "read", `Pi session transcript is not a regular file: ${file}`, {
          kind: "wrong-type",
        })
      : failure(file, "read", `could not read Pi session transcript: ${file}`, cause.cause);

/** Stream a transcript's header, then its entries, stopping when a visitor says so. */
export const scanTranscript = (
  file: string,
  visitor: TranscriptVisitor,
): Effect.Effect<void, SessionReadFailed> =>
  Effect.gen(function* () {
    let headerSeen = false;

    yield* scanLines(file, MAX_TRANSCRIPT_LINE_BYTES, (text): Visit => {
      if (text.trim().length === 0) return undefined;

      if (!headerSeen) {
        const header = decodeHeader(text);

        if (Result.isFailure(header)) return decodeFailure(file, header.failure);
        headerSeen = true;

        return visitor.header(header.success);
      }

      if (visitor.entry === undefined) return "stop";
      const entry = decodeEntry(text);

      if (Result.isFailure(entry)) return decodeFailure(file, entry.failure);

      if (entry.success.type === "session") return decodeFailure(file, { kind: "second-header" });

      return visitor.entry(entry.success);
    }).pipe(Effect.catchTag("LineReadFailed", (cause) => Effect.fail(readFailure(file, cause))));

    if (!headerSeen) return yield* decodeFailure(file, { kind: "empty" });
  });

/** Only the header line: the cheap way to learn a transcript's id, cwd and parent. */
export const readTranscriptHeader = (file: string) =>
  Effect.gen(function* () {
    let found: TranscriptHeader | undefined;

    yield* scanTranscript(file, {
      header: (header) => {
        found = header;

        return "stop";
      },
    });

    if (found === undefined) return yield* decodeFailure(file, { kind: "empty" });

    return found;
  });

export interface TranscriptFiles {
  readonly files: ReadonlyArray<string>;
  /** Paths the walk refused to follow: symlinks inside the tree. */
  readonly refused: ReadonlyArray<string>;
}

/**
 * Every `.jsonl` regular file under `root`, sorted. A missing root is empty; a symlinked or
 * non-directory root fails; symlinks inside the tree are refused, never followed.
 */
export const transcriptFiles = (root: string): Effect.Effect<TranscriptFiles, SessionReadFailed> =>
  Effect.gen(function* () {
    const status = yield* Effect.tryPromise({
      try: () => lstat(root),
      catch: (cause) => failure(root, "inspect-root", `could not inspect ${root}`, cause),
    }).pipe(Effect.result);

    if (Result.isFailure(status)) {
      if (fileSystemCauseDetails(status.failure.cause).code === "ENOENT")
        return { files: [], refused: [] };

      return yield* status.failure;
    }

    if (status.success.isSymbolicLink() || !status.success.isDirectory())
      return yield* failure(
        root,
        "inspect-root",
        status.success.isSymbolicLink()
          ? `session root must not be a symlink: ${root}`
          : `session root must be a directory: ${root}`,
        { kind: status.success.isSymbolicLink() ? "symlink" : "wrong-type" },
      );

    const files: Array<string> = [];
    const refused: Array<string> = [];
    const pending = [root];

    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const at = directory;

      const children = yield* Effect.tryPromise({
        try: () => readdir(at, { withFileTypes: true }),
        catch: (cause) => failure(at, "walk", `could not list ${at}`, cause),
      });

      for (const child of children) {
        const path = join(at, child.name);

        if (child.isSymbolicLink()) refused.push(path);
        else if (child.isDirectory()) pending.push(path);
        else if (child.isFile() && child.name.endsWith(".jsonl")) files.push(path);
      }
    }

    return { files: files.sort(), refused: refused.sort() };
  });

/** Pi's newest-readable-file choice for `continue`, over one directory, without a SessionManager. */
export const findRecentTranscript = (cwd: string, directory: string) =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (cause) => failure(directory, "walk", `could not list ${directory}`, cause),
    }).pipe(
      Effect.catchIf(
        (error) => fileSystemCauseDetails(error.cause).code === "ENOENT",
        () => Effect.succeed([]),
      ),
    );

    const candidates = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".jsonl")),
      (name) => {
        const file = join(directory, name);

        return Effect.tryPromise(() => stat(file)).pipe(
          Effect.map((info) => ({ file, mtime: info.mtimeMs })),
          Effect.orElseSucceed(() => undefined),
        );
      },
    );

    for (const candidate of candidates
      .filter((item) => item !== undefined)
      .sort((a, b) => b.mtime - a.mtime)) {
      const header = yield* readTranscriptHeader(candidate.file).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (header !== undefined && resolve(header.cwd) === resolve(cwd)) return candidate.file;
    }

    return undefined;
  });
