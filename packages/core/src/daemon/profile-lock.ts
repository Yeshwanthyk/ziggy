import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProfileLockFilesystem {
  canonicalize(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

interface ProfileLockProcess {
  readonly pid: number;
  isAlive(pid: number): Promise<boolean>;
  ownerToken(): string;
}

export interface ProfileLock {
  readonly profilePath: string;
  readonly pid: number;
  close(): Promise<void>;
}

export interface AcquireProfileLockOptions {
  readonly profilePath: string;
  readonly filesystem?: ProfileLockFilesystem;
  readonly process?: ProfileLockProcess;
}

interface LockMetadata {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly ownerToken: string;
}

const acquisitionGates = new Map<string, Promise<void>>();

export async function acquireProfileLock(options: AcquireProfileLockOptions): Promise<ProfileLock> {
  const filesystem = options.filesystem ?? productionFilesystem;
  const processOperations = options.process ?? productionProcess;
  const profilePath = await filesystem.canonicalize(options.profilePath);
  return withGate(profilePath, async () => {
    const runtimePath = join(profilePath, ".runtime");
    const lockPath = join(runtimePath, "daemon.lock");
    const takeoverPath = join(runtimePath, "daemon.lock.takeover");
    await filesystem.mkdir(runtimePath);
    const metadata: LockMetadata = {
      schemaVersion: 1,
      pid: processOperations.pid,
      ownerToken: processOperations.ownerToken(),
    };

    while (true) {
      try {
        await filesystem.create(lockPath, `${JSON.stringify(metadata)}\n`);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        await takeOverStaleLock(filesystem, processOperations, lockPath, takeoverPath, metadata);
        break;
      }
      if ((await readMetadataIfPresent(filesystem, takeoverPath)) === undefined) {
        break;
      }
      await removeIfOwned(filesystem, lockPath, metadata.ownerToken);
    }

    let closing: Promise<void> | undefined;
    return {
      profilePath,
      pid: metadata.pid,
      close() {
        if (closing === undefined) {
          closing = removeIfOwned(filesystem, lockPath, metadata.ownerToken);
        }
        return closing;
      },
    };
  });
}

async function takeOverStaleLock(
  filesystem: ProfileLockFilesystem,
  processOperations: ProfileLockProcess,
  lockPath: string,
  takeoverPath: string,
  metadata: LockMetadata,
): Promise<void> {
  try {
    await filesystem.create(takeoverPath, `${JSON.stringify(metadata)}\n`);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const contender = decodeMetadata(await filesystem.read(takeoverPath));
    if (await processOperations.isAlive(contender.pid)) {
      throw new Error(`Profile lock takeover is already in progress by PID ${contender.pid}`);
    }
    await removeIfOwned(filesystem, takeoverPath, contender.ownerToken);
    return takeOverStaleLock(filesystem, processOperations, lockPath, takeoverPath, metadata);
  }

  try {
    const existing = await readMetadataIfPresent(filesystem, lockPath);
    if (existing !== undefined) {
      // PID reuse can make a stale lock appear live; no portable process identity is available.
      if (await processOperations.isAlive(existing.pid)) {
        throw new Error(`Profile is already owned by live daemon PID ${existing.pid}`);
      }
      await removeIfOwned(filesystem, lockPath, existing.ownerToken);
    }
    await filesystem.create(lockPath, `${JSON.stringify(metadata)}\n`);
  } finally {
    await removeIfOwned(filesystem, takeoverPath, metadata.ownerToken);
  }
}

async function readMetadataIfPresent(
  filesystem: ProfileLockFilesystem,
  path: string,
): Promise<LockMetadata | undefined> {
  try {
    return decodeMetadata(await filesystem.read(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function removeIfOwned(
  filesystem: ProfileLockFilesystem,
  path: string,
  ownerToken: string,
): Promise<void> {
  const current = await readMetadataIfPresent(filesystem, path);
  if (current?.ownerToken === ownerToken) await filesystem.remove(path);
}

const productionFilesystem: ProfileLockFilesystem = {
  canonicalize: realpath,
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async create(path, content) {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  read: (path) => readFile(path, "utf8"),
  async remove(path) {
    await rm(path);
  },
};

const productionProcess: ProfileLockProcess = {
  pid: process.pid,
  async isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (hasCode(error, "ESRCH")) return false;
      if (hasCode(error, "EPERM")) return true;
      throw error;
    }
  },
  ownerToken: () => randomBytes(32).toString("hex"),
};

function decodeMetadata(text: string): LockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Malformed Profile lock metadata", { cause: error });
  }
  if (!isRecord(value)) throw new Error("Malformed Profile lock metadata");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "ownerToken,pid,schemaVersion") {
    throw new Error("Malformed Profile lock metadata: expected exact fields");
  }
  if (value.schemaVersion !== 1) throw new Error("Unsupported Profile lock schemaVersion");
  if (!Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0) {
    throw new Error("Malformed Profile lock PID");
  }
  if (typeof value.ownerToken !== "string" || value.ownerToken.length === 0) {
    throw new Error("Malformed Profile lock owner token");
  }
  return { schemaVersion: 1, pid: value.pid, ownerToken: value.ownerToken };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function withGate<A>(key: string, operation: () => Promise<A>): Promise<A> {
  const previous = acquisitionGates.get(key) ?? Promise.resolve();
  const completion = Promise.withResolvers<void>();
  const current = previous.then(() => completion.promise);
  acquisitionGates.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    completion.resolve();
    if (acquisitionGates.get(key) === current) acquisitionGates.delete(key);
  }
}
