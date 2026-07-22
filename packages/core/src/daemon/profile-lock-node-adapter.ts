/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node filesystem APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: Node rejects through native exceptions */
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface RawProfileLockFilesystem {
  canonicalize(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export const rawProductionProfileLockFilesystem: RawProfileLockFilesystem = {
  canonicalize: realpath,
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  create: atomicCreate,
  read: (path) => readFile(path, "utf8"),
  remove: (path) => rm(path),
};

async function atomicCreate(path: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
    published = true;
    await rm(temporaryPath);
  } catch (cause) {
    await Promise.allSettled([
      rm(temporaryPath, { force: true }),
      ...(published ? [rm(path, { force: true })] : []),
    ]);
    throw cause;
  }
}
