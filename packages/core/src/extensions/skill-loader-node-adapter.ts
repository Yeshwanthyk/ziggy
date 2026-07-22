/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node filesystem APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: Node rejects through native exceptions */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: Node rejects through native Error values */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

export interface ExtensionFileSnapshot {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ExtensionTreeSnapshot {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<ExtensionFileSnapshot>;
}

export interface ExtensionAuthorityFiles {
  readonly stateJson: string;
  readonly provenanceJson: string;
  readonly approvalsJson: string;
}

export async function readExtensionAuthorityFiles(
  profilePath: string,
  extensionId: string,
): Promise<ExtensionAuthorityFiles> {
  const authorityPaths = [
    join(profilePath, ".runtime"),
    join(profilePath, ".runtime", "extensions"),
    join(profilePath, ".runtime", "extensions", extensionId),
  ];
  const directoriesBefore = await Promise.all(authorityPaths.map(readStableDirectoryIdentity));
  const authorityRoot = authorityPaths[2];
  if (authorityRoot === undefined) throw new Error("missing Extension authority path");
  const authority = {
    stateJson: await readStableUtf8File(join(authorityRoot, "state.json")),
    provenanceJson: await readStableUtf8File(join(authorityRoot, "provenance.json")),
    approvalsJson: await readStableUtf8File(join(authorityRoot, "approvals.json")),
  };
  const directoriesAfter = await Promise.all(authorityPaths.map(readStableDirectoryIdentity));
  for (let index = 0; index < directoriesBefore.length; index += 1) {
    const before = directoriesBefore[index];
    const after = directoriesAfter[index];
    if (before === undefined || after === undefined || !sameFileIdentity(before, after)) {
      throw new Error(`Extension authority directory changed during read: ${authorityRoot}`);
    }
  }
  return authority;
}

export async function readImmutableExtensionTree(rootPath: string): Promise<ExtensionTreeSnapshot> {
  const snapshots: ExtensionFileSnapshot[] = [];
  const directories: string[] = [];
  const collisionKeys = new Set<string>();
  await visitDirectory(rootPath, "", snapshots, directories, collisionKeys);
  return {
    directories,
    files: snapshots.sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    ),
  };
}

async function visitDirectory(
  rootPath: string,
  relativeDirectory: string,
  snapshots: ExtensionFileSnapshot[],
  directories: string[],
  collisionKeys: Set<string>,
): Promise<void> {
  const absoluteDirectory = relativeDirectory === "" ? rootPath : join(rootPath, relativeDirectory);
  const directoryBefore = await lstat(absoluteDirectory);
  if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
    throw new Error(`expected immutable Extension directory at ${absoluteDirectory}`);
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const relativePath =
      relativeDirectory === "" ? entry.name : posix.join(relativeDirectory, entry.name);
    const collisionKey = relativePath.normalize("NFC").toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new Error(`case/NFC-colliding Extension path: ${relativePath}`);
    }
    collisionKeys.add(collisionKey);
    const absolutePath = join(rootPath, relativePath);
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${relativePath}`);
    if (status.isDirectory()) {
      directories.push(relativePath);
      await visitDirectory(rootPath, relativePath, snapshots, directories, collisionKeys);
      continue;
    }
    if (!status.isFile()) throw new Error(`unsupported Extension entry: ${relativePath}`);
    if (status.nlink !== 1) throw new Error(`hard links are forbidden: ${relativePath}`);
    snapshots.push({
      path: relativePath,
      bytes: await readStableFile(absolutePath),
    });
  }
  const directoryAfter = await lstat(absoluteDirectory);
  if (!sameFileIdentity(directoryBefore, directoryAfter)) {
    throw new Error(`Extension directory changed during scan: ${absoluteDirectory}`);
  }
}

export async function readStableFile(path: string): Promise<Uint8Array> {
  const pathBefore = await lstat(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1) {
    throw new Error(`expected unaliased regular file at ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleBefore = await handle.stat();
    if (!sameFileIdentity(pathBefore, handleBefore)) {
      throw new Error(`Extension file changed before read: ${path}`);
    }
    const bytes = await handle.readFile();
    const [handleAfter, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !sameFileIdentity(handleBefore, handleAfter) ||
      !sameFileIdentity(handleAfter, pathAfter) ||
      handleAfter.size !== bytes.byteLength
    ) {
      throw new Error(`Extension file changed during read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStableUtf8File(path: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readStableFile(path));
}

export function decodeUtf8Maybe(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function decodeUriComponentMaybe(component: string): string | undefined {
  try {
    return decodeURIComponent(component);
  } catch {
    return undefined;
  }
}

async function readStableDirectoryIdentity(path: string): Promise<FileIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`expected daemon-owned Extension authority directory at ${path}`);
  }
  return status;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
