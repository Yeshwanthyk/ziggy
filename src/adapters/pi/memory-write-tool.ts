import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionTools } from "../../session";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import {
  applyMemoryOperations,
  codePointLength,
  MemoryBackupError,
  MemoryDocumentInvalid,
  memoryFilePaths,
  type ChatContext,
  type MemoryScope,
  type MemoryDocument,
} from "../../domain/memory";
import { fileSystemCauseDetails } from "../../platform/cause";
import { writeFileAtomic } from "../../platform/atomic-write";
import { withFileLock } from "../../platform/file-lock";

const memoryOperationParameters = Type.Union([
  Type.Object({
    action: Type.Literal("add"),
    content: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("replace"),
    oldText: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    oldText: Type.String(),
  }),
]);

const memoryWriteParameters = Type.Object({
  scope: Type.Union([Type.Literal("shared"), Type.Literal("person"), Type.Literal("group")]),
  operations: Type.Array(memoryOperationParameters),
});

const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

const toolError = (message: string) => toolResult(`ERROR: ${message}`);

class MemoryWriteIoError extends Schema.TaggedErrorClass<MemoryWriteIoError>()(
  "MemoryWriteIoError",
  {
    operation: Schema.Literals(["lock", "read", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type LoadedMemoryDocument = {
  readonly content: string;
  readonly bytes: Uint8Array;
};

const isMissingMemoryPath = (cause: unknown): boolean =>
  fileSystemCauseDetails(cause).code === "ENOENT";

const memoryParentPaths = (document: MemoryDocument): ReadonlyArray<string> => {
  const parent = dirname(document.absolutePath);

  return document.scope === "shared"
    ? [parent]
    : [dirname(dirname(parent)), dirname(parent), parent];
};

const ensureMemoryDirectory = async (directoryPath: string): Promise<void> => {
  try {
    const status = await lstat(directoryPath);

    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new MemoryDocumentInvalid({
        path: directoryPath,
        message: `${directoryPath} must be a regular non-symlink directory`,
        cause: "invalid memory directory",
      });
    }
  } catch (cause) {
    if (!isMissingMemoryPath(cause)) throw cause;

    try {
      await mkdir(directoryPath, { mode: 0o700 });
    } catch (createCause) {
      if (
        !isMissingMemoryPath(createCause) &&
        fileSystemCauseDetails(createCause).code !== "EEXIST"
      )
        throw createCause;
      const status = await lstat(directoryPath);

      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new MemoryDocumentInvalid({
          path: directoryPath,
          message: `${directoryPath} must be a regular non-symlink directory`,
          cause: "invalid memory directory",
        });
      }
    }
  }
};

const ensureMemoryParentDirectories = async (document: MemoryDocument): Promise<void> => {
  for (const directoryPath of memoryParentPaths(document)) {
    await ensureMemoryDirectory(directoryPath);
  }
};

const checkMemoryDirectory = async (directoryPath: string): Promise<void> => {
  const status = await lstat(directoryPath);

  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new MemoryDocumentInvalid({
      path: directoryPath,
      message: `${directoryPath} must be a regular non-symlink directory`,
      cause: "invalid memory directory",
    });
  }
};

const inspectMemoryFile = async (
  document: MemoryDocument,
): Promise<LoadedMemoryDocument | undefined> => {
  for (const directoryPath of memoryParentPaths(document)) {
    try {
      await checkMemoryDirectory(directoryPath);
    } catch (cause) {
      if (isMissingMemoryPath(cause)) return undefined;
      throw cause;
    }
  }

  try {
    const status = await lstat(document.absolutePath);

    if (status.isSymbolicLink() || !status.isFile()) {
      throw new MemoryDocumentInvalid({
        path: document.absolutePath,
        message: `${document.absolutePath} must be a regular non-symlink file`,
        cause: "invalid memory file",
      });
    }

    const file = await open(document.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const bytes = await file.readFile();

      return { content: bytes.toString("utf8"), bytes };
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (isMissingMemoryPath(cause)) return undefined;
    throw cause;
  }
};

const memoryFileExists = (
  documentPath: string,
): Effect.Effect<void, MemoryWriteIoError | MemoryDocumentInvalid> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const status = await lstat(documentPath);

        if (status.isSymbolicLink() || !status.isFile()) {
          throw new MemoryDocumentInvalid({
            path: documentPath,
            message: `${documentPath} must be a regular non-symlink file`,
            cause: "invalid memory file",
          });
        }
      } catch (cause) {
        if (!isMissingMemoryPath(cause)) throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof MemoryDocumentInvalid
        ? cause
        : new MemoryWriteIoError({ operation: "write", path: documentPath, cause }),
  });

const backupDirectoryPath = (profilePath: string, document: MemoryDocument): string =>
  join(
    profilePath,
    ".runtime",
    "memory-backups",
    document.relativePath.replaceAll("/", "__").replaceAll("\\", "__"),
  );

const ensureBackupDirectory = async (directoryPath: string): Promise<void> => {
  try {
    const status = await lstat(directoryPath);

    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new MemoryBackupError({
        operation: "inspect",
        path: directoryPath,
        message: `${directoryPath} must be a regular non-symlink backup directory`,
        cause: "invalid backup directory",
      });
    }
  } catch (cause) {
    if (!isMissingMemoryPath(cause)) throw cause;

    try {
      await mkdir(directoryPath, { mode: 0o700 });
    } catch (createCause) {
      if (fileSystemCauseDetails(createCause).code !== "EEXIST") throw createCause;
      const status = await lstat(directoryPath);

      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new MemoryBackupError({
          operation: "inspect",
          path: directoryPath,
          message: `${directoryPath} must be a regular non-symlink backup directory`,
          cause: "invalid backup directory",
        });
      }
    }
  }
};

const createMemoryBackup = async (
  profilePath: string,
  document: MemoryDocument,
  bytes: Uint8Array,
): Promise<string> => {
  const directoryPath = backupDirectoryPath(profilePath, document);
  await ensureBackupDirectory(join(profilePath, ".runtime"));
  await ensureBackupDirectory(join(profilePath, ".runtime", "memory-backups"));
  await ensureBackupDirectory(directoryPath);
  const temporaryPath = join(directoryPath, `.${randomUUID()}.backup.tmp`);
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let backupPath: string | undefined;
  let failure: unknown;

  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    await temporaryFile.writeFile(bytes);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    const base = new Date().toISOString();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const timestamp = attempt === 0 ? base : `${base}-${attempt.toString().padStart(2, "0")}`;
      const candidatePath = join(directoryPath, `${timestamp}.md`);

      try {
        await link(temporaryPath, candidatePath);
        backupPath = candidatePath;
        break;
      } catch (cause) {
        if (fileSystemCauseDetails(cause).code !== "EEXIST") throw cause;
        let status;

        try {
          status = await lstat(candidatePath);
        } catch (inspectCause) {
          if (!isMissingMemoryPath(inspectCause)) throw inspectCause;
          continue;
        }

        if (status.isSymbolicLink() || !status.isFile()) {
          throw new MemoryBackupError({
            operation: "inspect",
            path: candidatePath,
            message: `${candidatePath} must be a regular non-symlink backup file`,
            cause: "invalid backup file",
          });
        }
      }
    }

    if (backupPath === undefined) {
      throw new Error(`could not allocate a unique memory backup timestamp in ${directoryPath}`);
    }
  } catch (cause) {
    failure = cause;
  }

  let cleanupFailure: unknown;

  if (temporaryFile !== undefined) {
    try {
      await temporaryFile.close();
    } catch (cause) {
      cleanupFailure = cause;
    }
  }

  if (temporaryCreated) {
    try {
      await rm(temporaryPath);
    } catch (cause) {
      if (!isMissingMemoryPath(cause) && cleanupFailure === undefined) cleanupFailure = cause;
    }
  }

  if (cleanupFailure !== undefined) {
    throw new MemoryBackupError({
      operation: "create",
      path: temporaryPath,
      message: `could not clean up temporary memory backup at ${temporaryPath}`,
      cause: cleanupFailure,
    });
  }

  if (failure !== undefined) throw failure;

  if (backupPath === undefined) {
    throw new MemoryBackupError({
      operation: "create",
      path: directoryPath,
      message: `memory backup was not published for ${document.relativePath}`,
      cause: "missing published backup path",
    });
  }

  return backupPath;
};

const pruneMemoryBackups = async (directoryPath: string): Promise<void> => {
  let entries: ReadonlyArray<Dirent>;

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (cause) {
    throw new MemoryBackupError({
      operation: "inspect",
      path: directoryPath,
      message: `could not inspect memory backups at ${directoryPath}`,
      cause,
    });
  }

  const backups: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".md")) {
      throw new MemoryBackupError({
        operation: "inspect",
        path: entryPath,
        message: `${entryPath} must be a regular non-symlink .md backup file`,
        cause: "invalid backup entry",
      });
    }

    backups.push(entry.name);
  }

  backups.sort((left, right) => right.localeCompare(left));

  for (const name of backups.slice(10)) {
    const backupPath = join(directoryPath, name);

    try {
      await rm(backupPath);
    } catch (cause) {
      throw new MemoryBackupError({
        operation: "prune",
        path: backupPath,
        message: `could not prune memory backup at ${backupPath}`,
        cause,
      });
    }
  }
};

const backupExistingMemoryDocument = (
  profilePath: string,
  document: MemoryDocument,
  bytes: Uint8Array,
): Effect.Effect<void, MemoryBackupError> =>
  Effect.tryPromise({
    try: async () => {
      const directoryPath = backupDirectoryPath(profilePath, document);
      await createMemoryBackup(profilePath, document, bytes);
      await pruneMemoryBackups(directoryPath);
    },
    catch: (cause) =>
      cause instanceof MemoryBackupError
        ? cause
        : new MemoryBackupError({
            operation: "create",
            path: backupDirectoryPath(profilePath, document),
            message: `could not create or prune memory backup for ${document.relativePath}`,
            cause,
          }),
  });

const atomicReplace = (
  document: MemoryDocument,
  content: string,
): Effect.Effect<void, MemoryWriteIoError | MemoryDocumentInvalid> =>
  Effect.tryPromise({
    try: () => ensureMemoryParentDirectories(document),
    catch: (cause) =>
      cause instanceof MemoryDocumentInvalid
        ? cause
        : new MemoryWriteIoError({
            operation: "write",
            path: dirname(document.absolutePath),
            cause,
          }),
  }).pipe(
    Effect.andThen(memoryFileExists(document.absolutePath)),
    Effect.andThen(
      writeFileAtomic(document.absolutePath, content).pipe(
        Effect.mapError(
          (failure) =>
            new MemoryWriteIoError({ operation: "write", path: failure.path, cause: failure }),
        ),
      ),
    ),
  );

const withMemoryLock = <A, E>(
  profilePath: string,
  document: MemoryDocument,
  use: Effect.Effect<A, E>,
): Effect.Effect<A, E | MemoryWriteIoError> =>
  withFileLock(
    {
      root: profilePath,
      file: join(".runtime", "memory-locks", `${encodeURIComponent(document.relativePath)}.sqlite`),
      waitMs: 2_000,
    },
    use,
    (failure) => new MemoryWriteIoError({ operation: "lock", path: failure.path, cause: failure }),
  );

const writableMemoryDocument = (
  profilePath: string,
  context: ChatContext,
  scope: MemoryScope,
):
  | { readonly ok: true; readonly document: MemoryDocument }
  | { readonly ok: false; readonly message: string } => {
  const paths = memoryFilePaths(profilePath, context);

  if (!paths.ok) {
    return { ok: false, message: paths.error.message };
  }

  if (scope === "person" && context.kind === "group") {
    return { ok: false, message: "person memory is not writable in group chats" };
  }

  if (scope === "group" && context.kind !== "group") {
    return { ok: false, message: "group memory is not writable in 1:1 chats" };
  }

  const document = paths.documents.find((candidate) => candidate.scope === scope);

  if (document === undefined) {
    return { ok: false, message: `${scope} memory is not available in this chat` };
  }

  return { ok: true, document };
};

export const createMemoryWriteTool = (
  profilePath: string,
  context: ChatContext,
): ToolDefinition<typeof memoryWriteParameters> => ({
  name: "memory_write",
  label: "memory_write",
  description:
    "Apply an all-or-nothing batch of entry-based add, replace, or remove operations to curated memory. Use shared for assistant-wide facts (2200 code points), person for the current 1:1 person (1375), or group for the current group (1375). Add is idempotent; replace/remove oldText must match exactly one entry. Person memory is unavailable in groups; group memory is unavailable in 1:1 chats.",
  parameters: memoryWriteParameters,
  execute(_toolCallId, { scope, operations }, signal) {
    const target = writableMemoryDocument(profilePath, context, scope);

    if (!target.ok) return Promise.resolve(toolError(target.message));

    const program = withMemoryLock(
      profilePath,
      target.document,
      Effect.gen(function* () {
        const loaded = yield* readMemoryDocument(target.document);

        const applied = applyMemoryOperations(
          loaded?.content ?? "",
          operations,
          target.document.cap,
        );

        if (!applied.ok) return toolError(applied.message);

        if (!applied.changed) return toolResult("no change");

        if (loaded !== undefined) {
          yield* backupExistingMemoryDocument(profilePath, target.document, loaded.bytes);
        }

        yield* atomicReplace(target.document, applied.content);

        return toolResult(
          `applied ${operations.length} operation(s); ${codePointLength(applied.content)}/${target.document.cap} code points in ${target.document.relativePath}`,
        );
      }),
    ).pipe(
      Effect.catch((failure) =>
        Effect.succeed(
          toolError(
            failure._tag === "MemoryBackupError"
              ? "memory backup failed"
              : failure._tag === "MemoryWriteIoError" && failure.operation === "read"
                ? "memory read failed"
                : "memory write failed",
          ),
        ),
      ),
    );

    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning tool callback; this is the single adapter bridge.
    return Effect.runPromise(program, { signal });
  },
});

const readMemoryDocument = (
  document: MemoryDocument,
): Effect.Effect<LoadedMemoryDocument | undefined, MemoryWriteIoError | MemoryDocumentInvalid> =>
  Effect.tryPromise({
    try: () => inspectMemoryFile(document),
    catch: (cause) =>
      cause instanceof MemoryDocumentInvalid
        ? cause
        : new MemoryWriteIoError({ operation: "read", path: document.absolutePath, cause }),
  });

/** Contributes `memory_write` to every Profile session. */
export const memoryTools: SessionTools = ({ profilePath, context }) => [
  createMemoryWriteTool(profilePath, context),
];
