/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node filesystem APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: Node rejects through native exceptions */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: Node rejects through native Error values */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { readStableFile } from "./extensions/skill-loader-node-adapter.ts";

const isErrnoException = Schema.is(Schema.Struct({ code: Schema.String }));

/** Raw Node boundary. Provider composition wraps this Promise immediately with Effect.tryPromise. */
export async function readProfileSoul(profilePath: string): Promise<string> {
  return readRegularFile(join(profilePath, "SOUL.md"));
}

export interface InstalledExtensionManifestFile {
  readonly directoryName: string;
  readonly rootPath: string;
  readonly contents: Uint8Array;
}

/** Raw Node boundary. A missing extensions directory means the Profile has no installed Extensions. */
export async function readInstalledExtensionManifests(
  profilePath: string,
): Promise<ReadonlyArray<InstalledExtensionManifestFile>> {
  const extensionsPath = join(profilePath, "extensions");
  let entries;
  let directoryBefore;
  try {
    directoryBefore = await lstat(extensionsPath);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(`expected Extensions directory at ${extensionsPath}`);
    }
    entries = await readdir(extensionsPath, { withFileTypes: true });
  } catch (cause) {
    if (isMissingPath(cause)) return [];
    throw cause;
  }
  const manifests: InstalledExtensionManifestFile[] = [];
  for (const entry of entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unexpected entry in Extensions directory: ${entry.name}`);
    }
    const rootPath = join(extensionsPath, entry.name);
    manifests.push({
      directoryName: entry.name,
      rootPath,
      contents: await readStableFile(join(rootPath, "extension.json")),
    });
  }
  const directoryAfter = await lstat(extensionsPath);
  if (!sameFileIdentity(directoryBefore, directoryAfter)) {
    throw new Error(`Extensions directory changed during discovery: ${extensionsPath}`);
  }
  return manifests;
}

async function readRegularFile(path: string): Promise<string> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`expected regular file at ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function isMissingPath(cause: unknown): boolean {
  return isErrnoException(cause) && cause.code === "ENOENT";
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
