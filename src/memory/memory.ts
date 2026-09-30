import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { writeFileAtomic } from "../platform/atomic-write";
import { fileSystemCauseDetails } from "../platform/cause";
import { withFileLock } from "../platform/file-lock";
import { codePointLength } from "../platform/text";
import { readPhysicalFile } from "../platform/tree";
import type { ProfileTarget } from "../profile";
import {
  applyMemoryOperations,
  documentForScope,
  documentFromRelativePath,
  memoryEntries,
  MemoryDocumentInvalid,
  MemoryFileError,
  type ApplyMemoryOperationsResult,
  type MemoryDocument,
  type MemoryOperation,
  type MemoryScopeSelection,
} from "./types";

/** How many earlier versions of each document `update` keeps under `.runtime/memory-backups/`. */
export const MEMORY_BACKUPS_KEPT = 5;

type FileOperation = MemoryFileError["operation"];

const fileError = (operation: FileOperation, path: string, cause: unknown): MemoryFileError =>
  new MemoryFileError({
    operation,
    path,
    message: `could not ${operation} Profile memory at ${path}: ${fileSystemCauseDetails(cause).message}`,
    cause,
  });

const invalidDirectory = (path: string): MemoryDocumentInvalid =>
  new MemoryDocumentInvalid({
    path,
    message: `${path} must be a regular directory, not a symlink`,
    cause: "invalid memory directory",
  });

const invalidBackupDirectory = (path: string): MemoryFileError =>
  new MemoryFileError({
    operation: "backup",
    path,
    message: `${path} must be a regular directory, not a symlink`,
    cause: "invalid backup directory",
  });

/** Whether `path` is a physical directory. Missing is false; a symlink or a file is `invalid`. */
const inspectDirectory = <E>(
  path: string,
  operation: FileOperation,
  invalid: (path: string) => E,
): Effect.Effect<boolean, E | MemoryFileError> =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => fileError(operation, path, cause),
  }).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed(false)
          : Effect.fail(failure),
      onSuccess: (status) =>
        status.isSymbolicLink() || !status.isDirectory()
          ? Effect.fail(invalid(path))
          : Effect.succeed(true),
    }),
  );

/** Create a private directory unless a physical one is already there. */
const ensureDirectory = <E>(
  path: string,
  operation: FileOperation,
  invalid: (path: string) => E,
): Effect.Effect<void, E | MemoryFileError> =>
  inspectDirectory(path, operation, invalid).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.tryPromise({
            try: () => mkdir(path, { mode: 0o700 }),
            catch: (cause) => fileError(operation, path, cause),
          }).pipe(
            Effect.catch((failure) =>
              fileSystemCauseDetails(failure.cause).code === "EEXIST"
                ? Effect.void
                : Effect.fail(failure),
            ),
            Effect.andThen(inspectDirectory(path, operation, invalid)),
            Effect.asVoid,
          ),
    ),
  );

/** The directories above a document, outermost first; each must be physical. */
const parents = (profilePath: string, document: MemoryDocument): ReadonlyArray<string> =>
  document.scope === "shared"
    ? [profilePath]
    : [profilePath, join(profilePath, "memory"), dirname(document.absolutePath)];

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A document's bytes, or undefined when it or a parent directory is missing. */
const readDocument = (
  profilePath: string,
  document: MemoryDocument,
): Effect.Effect<Uint8Array | undefined, MemoryDocumentInvalid | MemoryFileError> =>
  Effect.gen(function* () {
    for (const parent of parents(profilePath, document)) {
      if (!(yield* inspectDirectory(parent, "read", invalidDirectory))) return undefined;
    }

    return yield* readPhysicalFile(document.absolutePath).pipe(
      Effect.mapError((failure) =>
        failure.refused
          ? new MemoryDocumentInvalid({
              path: failure.path,
              message: `${failure.path} must be a regular file, not a symlink`,
              cause: failure,
            })
          : fileError("read", document.absolutePath, failure),
      ),
    );
  });

/** Every document a Profile has a file for; ids memory would not admit are ignored. */
const listDocuments = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<MemoryDocument>, MemoryDocumentInvalid | MemoryFileError> =>
  Effect.gen(function* () {
    const found: Array<MemoryDocument> = [];
    const shared = documentFromRelativePath(profilePath, "MEMORY.md");

    if (shared !== undefined) found.push(shared);

    if (!(yield* inspectDirectory(join(profilePath, "memory"), "list", invalidDirectory))) {
      return found;
    }

    for (const directory of ["users", "groups"]) {
      const root = join(profilePath, "memory", directory);

      if (!(yield* inspectDirectory(root, "list", invalidDirectory))) continue;

      const names = yield* Effect.tryPromise({
        try: () => readdir(root),
        catch: (cause) => fileError("list", root, cause),
      });

      for (const name of names) {
        const document = documentFromRelativePath(profilePath, join("memory", directory, name));

        if (document !== undefined) found.push(document);
      }
    }

    return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  });

/** Keep the newest `MEMORY_BACKUPS_KEPT` backups; names start with an ISO time, so they sort. */
const pruneBackups = (directory: string): Effect.Effect<void, MemoryFileError> =>
  Effect.tryPromise({
    try: () => readdir(directory, { withFileTypes: true }),
    catch: (cause) => fileError("backup", directory, cause),
  }).pipe(
    Effect.flatMap((entries) => {
      const backups = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort()
        .reverse();

      return Effect.forEach(
        backups.slice(MEMORY_BACKUPS_KEPT),
        (name) =>
          Effect.tryPromise({
            try: () => rm(join(directory, name)),
            catch: (cause) => fileError("backup", join(directory, name), cause),
          }),
        { discard: true },
      );
    }),
  );

const backup = (
  profilePath: string,
  document: MemoryDocument,
  bytes: Uint8Array,
): Effect.Effect<void, MemoryFileError> =>
  Effect.gen(function* () {
    const runtime = join(profilePath, ".runtime");
    const root = join(runtime, "memory-backups");

    const directory = join(
      root,
      document.relativePath.replaceAll("/", "__").replaceAll("\\", "__"),
    );

    for (const path of [runtime, root, directory]) {
      yield* ensureDirectory(path, "backup", invalidBackupDirectory);
    }

    const name = `${new Date().toISOString()}-${randomBytes(3).toString("hex")}.md`;

    yield* writeFileAtomic(join(directory, name), bytes).pipe(
      Effect.mapError((failure) => fileError("backup", failure.path, failure)),
    );
    yield* pruneBackups(directory);
  });

const writeDocument = (
  profilePath: string,
  document: MemoryDocument,
  content: string,
): Effect.Effect<void, MemoryDocumentInvalid | MemoryFileError> =>
  Effect.gen(function* () {
    for (const parent of parents(profilePath, document)) {
      yield* ensureDirectory(parent, "write", invalidDirectory);
    }

    yield* writeFileAtomic(document.absolutePath, content).pipe(
      Effect.mapError((failure) => fileError("write", failure.path, failure)),
    );
  });

/**
 * Apply a batch to one document under its lock. The previous version is backed up before the
 * write; a rejected or no-op batch touches nothing.
 */
export const updateDocument = (
  profilePath: string,
  document: MemoryDocument,
  operations: ReadonlyArray<MemoryOperation>,
): Effect.Effect<ApplyMemoryOperationsResult, MemoryDocumentInvalid | MemoryFileError> =>
  withFileLock(
    {
      root: profilePath,
      file: join(".runtime", "memory-locks", `${encodeURIComponent(document.relativePath)}.sqlite`),
      waitMs: 2_000,
    },
    Effect.gen(function* () {
      const bytes = yield* readDocument(profilePath, document);

      const applied = applyMemoryOperations(
        bytes === undefined ? "" : decode(bytes),
        operations,
        document.cap,
      );

      if (!applied.ok || !applied.changed) return applied;

      if (bytes !== undefined) yield* backup(profilePath, document, bytes);

      yield* writeDocument(profilePath, document, applied.content);

      return applied;
    }),
    (failure) => fileError("lock", failure.path, failure),
  );

/** What a document holds, and whether its file exists. */
export interface MemoryDocumentView {
  readonly document: MemoryDocument;
  readonly state: "empty" | "present" | "missing";
  readonly entries: ReadonlyArray<string>;
  readonly codePoints: number;
  readonly cap: number;
  readonly content: string;
}

/** Read one document; a missing file is the empty document in state `missing`. */
export const viewDocument = (
  profilePath: string,
  document: MemoryDocument,
): Effect.Effect<MemoryDocumentView, MemoryDocumentInvalid | MemoryFileError> =>
  readDocument(profilePath, document).pipe(
    Effect.map((bytes) => {
      const content = bytes === undefined ? "" : decode(bytes);
      const entries = memoryEntries(content);

      return {
        document,
        state: bytes === undefined ? "missing" : entries.length === 0 ? "empty" : "present",
        entries,
        codePoints: codePointLength(content),
        cap: document.cap,
        content,
      };
    }),
  );

/** A Profile's memory, read without writing. */
export class Memory extends Context.Service<Memory>()("ziggy/Memory", {
  make: Effect.succeed({
    /** The documents that exist, in path order. */
    list: Effect.fn("Memory.list")(function* (target: ProfileTarget) {
      const documents = yield* listDocuments(target.path);

      const views = yield* Effect.forEach(documents, (document) =>
        viewDocument(target.path, document),
      );

      return views.filter((view) => view.state !== "missing");
    }),
    show: Effect.fn("Memory.show")(function* (
      target: ProfileTarget,
      selection: MemoryScopeSelection,
    ) {
      const document = yield* Effect.fromResult(documentForScope(target.path, selection));

      return yield* viewDocument(target.path, document);
    }),
  } as const),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type MemoryApi = (typeof Memory)["Service"];
