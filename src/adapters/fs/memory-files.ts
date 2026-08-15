import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  MemoryDocumentInvalid,
  MemoryFileSystemError,
  memoryDocumentFromRelativePath,
  type MemoryDocument,
} from "../../domain/memory";
import { fileSystemCauseDetails } from "./cause";

export interface MemoryDocumentRead {
  readonly document: MemoryDocument;
  readonly exists: boolean;
  readonly content: string;
}

export interface MemoryFilesApi {
  readonly list: (
    profilePath: string,
  ) => Effect.Effect<ReadonlyArray<MemoryDocument>, MemoryFileSystemError | MemoryDocumentInvalid>;
  readonly read: (
    document: MemoryDocument,
  ) => Effect.Effect<MemoryDocumentRead, MemoryFileSystemError | MemoryDocumentInvalid>;
}

export class MemoryFiles extends Context.Service<MemoryFiles, MemoryFilesApi>()(
  "ziggy/MemoryFiles",
) {}

const isMissing = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";

const invalidDocument = (documentPath: string, detail: string): MemoryDocumentInvalid =>
  new MemoryDocumentInvalid({
    path: documentPath,
    message: `${documentPath} is not a physical memory path: ${detail}`,
    cause: detail,
  });

const assertPhysicalDirectory = async (directoryPath: string): Promise<void> => {
  const status = await lstat(directoryPath);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw invalidDocument(directoryPath, "expected a regular directory");
  }
};

const readPhysicalFile = async (filePath: string): Promise<string> => {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
};

const listExpectedDocuments = async (
  profilePath: string,
): Promise<ReadonlyArray<MemoryDocument>> => {
  await assertPhysicalDirectory(profilePath);
  const found: MemoryDocument[] = [];
  const sharedPath = path.join(profilePath, "MEMORY.md");
  try {
    const status = await lstat(sharedPath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw invalidDocument(sharedPath, "expected a regular file");
    }
    const document = memoryDocumentFromRelativePath(profilePath, "MEMORY.md");
    if (document !== undefined) found.push(document);
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }

  const memoryRoot = path.join(profilePath, "memory");
  try {
    const status = await lstat(memoryRoot);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw invalidDocument(memoryRoot, "expected a regular directory");
    }
  } catch (cause) {
    if (isMissing(cause)) return found;
    throw cause;
  }

  for (const directory of ["users", "groups"] as const) {
    const relativeRoot = path.join("memory", directory);
    const rootPath = path.join(profilePath, relativeRoot);
    let entries: ReadonlyArray<Dirent>;
    try {
      const status = await lstat(rootPath);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw invalidDocument(rootPath, "expected a regular directory");
      }
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch (cause) {
      if (isMissing(cause)) continue;
      throw cause;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      const relativePath = path.join(relativeRoot, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw invalidDocument(path.join(profilePath, relativePath), "expected a regular file");
      }
      const document = memoryDocumentFromRelativePath(profilePath, relativePath);
      if (document !== undefined) found.push(document);
    }
  }
  return found.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.absolutePath.localeCompare(right.absolutePath),
  );
};

const readDocument = async (document: MemoryDocument): Promise<MemoryDocumentRead> => {
  const parentPaths =
    document.scope === "shared"
      ? [path.dirname(document.absolutePath)]
      : [
          path.dirname(document.absolutePath),
          path.dirname(path.dirname(document.absolutePath)),
          path.dirname(path.dirname(path.dirname(document.absolutePath))),
        ];
  for (const parentPath of parentPaths) {
    try {
      await assertPhysicalDirectory(parentPath);
    } catch (cause) {
      if (isMissing(cause)) return { document, exists: false, content: "" };
      throw cause;
    }
  }
  try {
    const status = await lstat(document.absolutePath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw invalidDocument(document.absolutePath, "expected a regular file");
    }
    return { document, exists: true, content: await readPhysicalFile(document.absolutePath) };
  } catch (cause) {
    if (isMissing(cause)) return { document, exists: false, content: "" };
    throw cause;
  }
};

const fileError = (
  operation: "list" | "read",
  targetPath: string,
  cause: unknown,
): MemoryFileSystemError | MemoryDocumentInvalid => {
  if (cause instanceof MemoryDocumentInvalid) return cause;
  return new MemoryFileSystemError({
    operation,
    path: targetPath,
    message: `could not ${operation} Profile memory at ${targetPath}`,
    cause,
  });
};

export const memoryFiles: MemoryFilesApi = {
  list: (profilePath) =>
    Effect.tryPromise({
      try: () => listExpectedDocuments(profilePath),
      catch: (cause) => fileError("list", profilePath, cause),
    }),
  read: (document) =>
    Effect.tryPromise({
      try: () => readDocument(document),
      catch: (cause) => fileError("read", document.absolutePath, cause),
    }),
};

export const MemoryFilesLive = Layer.succeed(MemoryFiles, memoryFiles);
