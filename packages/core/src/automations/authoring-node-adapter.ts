/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node filesystem APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: Node rejects through native exceptions */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: private native conflict sentinels */
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type AutomationPublicationPoint =
  | "after-temporary-write"
  | "before-expected-read"
  | "after-expected-read";

export interface AutomationAuthoringNodeHooks {
  readonly onPublicationPoint?: (point: AutomationPublicationPoint) => void;
}

export class NodeAutomationConflictError extends Error {}
export class NodeAutomationNotFoundError extends Error {}

export function isNodeAutomationConflictError(cause: unknown): boolean {
  return cause instanceof NodeAutomationConflictError;
}

export function isNodeAutomationNotFoundError(cause: unknown): boolean {
  return cause instanceof NodeAutomationNotFoundError;
}

export interface AutomationAuthoringNodeAdapter {
  ensureDirectory(): Promise<void>;
  listNames(): Promise<ReadonlyArray<string>>;
  read(id: string): Promise<Uint8Array | undefined>;
  create(id: string, content: Uint8Array): Promise<void>;
  update(id: string, content: Uint8Array, expectedContent: Uint8Array): Promise<void>;
  delete(id: string, expectedContent: Uint8Array): Promise<void>;
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface FileSnapshot {
  readonly bytes: Uint8Array;
  readonly status: Stats;
}

export function createAutomationAuthoringNodeAdapter(
  profilePath: string,
  hooks: AutomationAuthoringNodeHooks = {},
): AutomationAuthoringNodeAdapter {
  const directory = join(profilePath, "automations");
  const pathFor = (id: string) => join(directory, `${id}.md`);
  return {
    ensureDirectory: async () => {
      await mkdir(directory, { recursive: true });
      await inspectSafeDirectory(directory);
    },
    listNames: async () => {
      try {
        const identity = await inspectSafeDirectory(directory);
        const names = (await readdir(directory)).toSorted();
        await requireDirectoryIdentity(directory, identity);
        return names;
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return [];
        throw cause;
      }
    },
    read: async (id) => {
      try {
        const identity = await inspectSafeDirectory(directory);
        return (await readSnapshot(directory, identity, pathFor(id)))?.bytes;
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return undefined;
        throw cause;
      }
    },
    create: (id, content) => publish(pathFor(id), content, undefined, hooks),
    update: (id, content, expectedContent) => publish(pathFor(id), content, expectedContent, hooks),
    delete: async (id, expectedContent) => {
      const identity = await inspectSafeDirectory(directory);
      hooks.onPublicationPoint?.("before-expected-read");
      const path = pathFor(id);
      const current = await readSnapshot(directory, identity, path);
      if (current === undefined) throw new NodeAutomationNotFoundError();
      if (!equalBytes(current.bytes, expectedContent)) throw new NodeAutomationConflictError();
      hooks.onPublicationPoint?.("after-expected-read");
      await requireDirectoryIdentity(directory, identity);
      await requirePathSnapshot(path, current.status);
      await rm(path);
      await syncDirectory(directory);
    },
  };
}

async function publish(
  path: string,
  content: Uint8Array,
  expectedContent: Uint8Array | undefined,
  hooks: AutomationAuthoringNodeHooks,
): Promise<void> {
  const directory = dirname(path);
  const identity = await inspectSafeDirectory(directory);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  await useTemporaryFile(temporaryPath, async () => {
    await useHandle(handle, async () => {
      await handle.writeFile(content);
      await handle.sync();
    });
    hooks.onPublicationPoint?.("after-temporary-write");
    const temporary = await readSnapshot(directory, identity, temporaryPath);
    if (temporary === undefined || !equalBytes(temporary.bytes, content)) {
      throw new NodeAutomationConflictError();
    }
    hooks.onPublicationPoint?.("before-expected-read");
    const current = await readSnapshot(directory, identity, path);
    if (expectedContent === undefined) {
      if (current !== undefined) throw new NodeAutomationConflictError();
    } else {
      if (current === undefined) throw new NodeAutomationNotFoundError();
      if (!equalBytes(current.bytes, expectedContent)) throw new NodeAutomationConflictError();
    }
    hooks.onPublicationPoint?.("after-expected-read");
    await requireDirectoryIdentity(directory, identity);
    await requirePathSnapshot(temporaryPath, temporary.status);
    if (expectedContent === undefined) {
      try {
        await link(temporaryPath, path);
      } catch (cause) {
        if (hasCode(cause, "EEXIST")) throw new NodeAutomationConflictError();
        throw cause;
      }
      try {
        await rm(temporaryPath);
      } catch (cause) {
        await removeIfSnapshot(path, temporary.status);
        throw cause;
      }
    } else {
      if (current === undefined) throw new NodeAutomationNotFoundError();
      await requirePathSnapshot(path, current.status);
      await rename(temporaryPath, path);
    }
    await requireDirectoryIdentity(directory, identity);
    await syncDirectory(directory);
  });
}

async function readSnapshot(
  directory: string,
  identity: DirectoryIdentity,
  path: string,
): Promise<FileSnapshot | undefined> {
  await requireDirectoryIdentity(directory, identity);
  const before = await safeLstat(path);
  if (before === undefined) {
    await requireDirectoryIdentity(directory, identity);
    return undefined;
  }
  requireSafeFile(before, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    requireSameFileIdentity(opened, before);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireSameFileSnapshot(after, opened);
    if (after.size !== bytes.byteLength) throw new NodeAutomationConflictError();
    await requirePathSnapshot(path, after);
    await requireDirectoryIdentity(directory, identity);
    return { bytes, status: after };
  } finally {
    await handle.close();
  }
}

async function inspectSafeDirectory(path: string): Promise<DirectoryIdentity> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Automation directory is not a safe directory: ${path}`);
  }
  return identityOf(status);
}

async function requireDirectoryIdentity(path: string, identity: DirectoryIdentity): Promise<void> {
  const current = await inspectSafeDirectory(path);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    throw new Error(`Automation directory identity changed: ${path}`);
  }
}

async function requirePathSnapshot(path: string, expected: Stats): Promise<void> {
  const current = await safeLstat(path);
  if (current === undefined) throw new NodeAutomationConflictError();
  requireSafeFile(current, path);
  requireSameFileSnapshot(current, expected);
}

function requireSafeFile(status: Stats, path: string): void {
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`Automation path is not an unaliased regular file: ${path}`);
  }
}

function requireSameFileIdentity(actual: Stats, expected: Stats): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new NodeAutomationConflictError();
  }
}

function requireSameFileSnapshot(actual: Stats, expected: Stats): void {
  requireSameFileIdentity(actual, expected);
  if (
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs ||
    actual.ctimeMs !== expected.ctimeMs
  ) {
    throw new NodeAutomationConflictError();
  }
}

function identityOf(status: Stats): DirectoryIdentity {
  return { device: status.dev, inode: status.ino };
}

async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfSnapshot(path: string, expected: Stats): Promise<void> {
  const current = await safeLstat(path);
  if (current === undefined) return;
  if (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size
  ) {
    await rm(path);
  }
}

async function useTemporaryFile(path: string, use: () => Promise<void>): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await use();
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    await rm(path, { force: true });
  } catch (cause) {
    if (!failed) {
      failed = true;
      failure = cause;
    }
  }
  if (failed) throw failure;
}

async function useHandle(
  handle: Awaited<ReturnType<typeof open>>,
  use: () => Promise<void>,
): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await use();
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    await handle.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      failure = cause;
    }
  }
  if (failed) throw failure;
}

function hasCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code === code
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
