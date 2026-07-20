import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEnvelope, SessionEvent } from "../../packages/protocol/src/index.ts";
import {
  createDaemonKernel,
  createFilesystemWorld,
  type SessionRuntime,
} from "../../packages/core/src/index.ts";
import {
  acquireProfileLock,
  type ProfileLockFilesystem,
} from "../../packages/core/src/daemon/profile-lock.ts";
import { reconcileSession } from "../../packages/core/src/daemon/reconciliation.ts";
import { createSessionRegistry } from "../../packages/core/src/daemon/registry.ts";
import { Barrier } from "../testkit/barrier.ts";
import {
  defineProfileLockContract,
  type ProfileLockSpecimen,
} from "../testkit/profile-lock-contract.ts";

const profiles: string[] = [];

defineProfileLockContract("production Profile lock", async () => createLockSpecimen());

test("Profile lock propagates injected filesystem and process faults", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-lock-fault-"));
  profiles.push(profile);
  const failure = new Error("injected create fault");
  const filesystem = productionLikeFilesystem(profile, failure);
  await expect(
    acquireProfileLock({
      profilePath: profile,
      filesystem,
      process: { pid: 1, isAlive: async () => false, ownerToken: () => "token" },
    }),
  ).rejects.toBe(failure);

  await mkdir(join(profile, ".runtime"), { recursive: true });
  await writeFile(
    join(profile, ".runtime", "daemon.lock"),
    '{"schemaVersion":1,"pid":77,"ownerToken":"old"}',
  );
  const processFailure = new Error("injected process fault");
  await expect(
    acquireProfileLock({
      profilePath: profile,
      process: {
        pid: 1,
        isAlive: async () => {
          throw processFailure;
        },
        ownerToken: () => "token",
      },
    }),
  ).rejects.toBe(processFailure);
});

describe("Session registry", () => {
  test("deduplicates creation, retries failure, and keeps IDs independent", async () => {
    const barrier = new Barrier();
    const calls = new Map<string, number>();
    const registry = createSessionRegistry(async (id) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === "blocked") await barrier.wait();
      if (id === "retry" && calls.get(id) === 1) throw new Error("factory failed");
      return runtime().value;
    });
    const first = registry.getOrCreate("blocked");
    const second = registry.getOrCreate("blocked");
    await registry.getOrCreate("other");
    expect(calls.get("other")).toBe(1);
    barrier.release();
    await Promise.all([first, second]);
    expect(calls.get("blocked")).toBe(1);
    await expect(registry.getOrCreate("retry")).rejects.toThrow("factory failed");
    await registry.getOrCreate("retry");
    expect(calls.get("retry")).toBe(2);
    await registry.close();
  });

  test("shutdown waits for in-flight creation, closes once, and rejects gets", async () => {
    const barrier = new Barrier();
    const made = runtime();
    const registry = createSessionRegistry(async () => {
      await barrier.wait();
      return made.value;
    });
    const creation = registry.getOrCreate("s");
    await barrier.entered;
    const closing = registry.close();
    await expect(registry.getOrCreate("new")).rejects.toThrow("closed");
    barrier.release();
    await Promise.all([creation, closing, registry.close()]);
    expect(made.closeCount()).toBe(1);
  });

  test("shutdown awaits every close before reporting close failures", async () => {
    const barrier = new Barrier();
    const first = runtime({ closeError: new Error("close failed") });
    const second = runtime({ closeBarrier: barrier });
    const registry = createSessionRegistry(async (id) =>
      id === "first" ? first.value : second.value,
    );
    await Promise.all([registry.getOrCreate("first"), registry.getOrCreate("second")]);
    const closing = registry.close();
    await barrier.entered;
    let settled = false;
    void closing
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBeFalse();
    barrier.release();
    await expect(closing).rejects.toThrow("Failed to close Session runtimes");
    expect(first.closeCount()).toBe(1);
    expect(second.closeCount()).toBe(1);
  });
});

describe("startup reconciliation", () => {
  test("closes an open step before its turn and closes an open turn", async () => {
    const world = recordingWorld([event("turn-started"), event("step-started")]);
    await reconcileSession(world, "s");
    expect(world.appended.map((item) => item.type)).toEqual(["step-ended", "turn-ended"]);
    expect(world.appended.every((item) => "status" in item && item.status === "failed")).toBeTrue();
    const turnOnly = recordingWorld([event("turn-started")]);
    await reconcileSession(turnOnly, "s");
    expect(turnOnly.appended.map((item) => item.type)).toEqual(["turn-ended"]);
  });

  test("does not append for closed turns and propagates read failures", async () => {
    const closed = recordingWorld([event("turn-started"), event("turn-ended")]);
    await reconcileSession(closed, "s");
    expect(closed.appended).toEqual([]);
    const malformed = recordingWorld([]);
    malformed.readError = new Error("torn NDJSON");
    await expect(reconcileSession(malformed, "s")).rejects.toThrow("torn NDJSON");
  });

  test("fails loud without modifying a torn filesystem Session log", async () => {
    const profile = await mkdtemp(join(tmpdir(), "ziggy-recovery-"));
    profiles.push(profile);
    const world = createFilesystemWorld({ profilePath: profile });
    await world.startSession("s", { systemPrompt: "prompt", tools: [] });
    await world.appendSession("s", event("turn-started"));
    const path = join(profile, "sessions", "s.ndjson");
    const torn = `${await readFile(path, "utf8")}{"schemaVersion":1`;
    await writeFile(path, torn);
    await expect(reconcileSession(world, "s")).rejects.toThrow("torn final line");
    expect(await readFile(path, "utf8")).toBe(torn);
  });
});

test("daemon kernel binds the canonical Profile World and releases its lock after runtimes close", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-kernel-"));
  profiles.push(profile);
  const barrier = new Barrier();
  const made = runtime({ closeBarrier: barrier });
  const world = recordingWorld([]);
  let worldPath = "";
  let runtimeWorld: unknown;
  const kernel = await createDaemonKernel({
    profilePath: join(profile, "."),
    createWorld(canonicalProfilePath) {
      worldPath = canonicalProfilePath;
      return world;
    },
    async createRuntime(_sessionId, receivedWorld) {
      runtimeWorld = receivedWorld;
      return made.value;
    },
  });
  await kernel.getOrCreateSession("s");
  expect(worldPath).toBe(profile);
  expect(runtimeWorld).toBe(world);
  const closing = kernel.close();
  await barrier.entered;
  expect(await readFile(join(profile, ".runtime", "daemon.lock"), "utf8")).toContain(
    `"pid":${process.pid}`,
  );
  barrier.release();
  await Promise.all([closing, kernel.close()]);
  expect(made.closeCount()).toBe(1);
  await expect(readFile(join(profile, ".runtime", "daemon.lock"), "utf8")).rejects.toThrow();
});

afterAll(async () =>
  Promise.all(profiles.map((path) => rm(path, { recursive: true, force: true }))),
);

async function createLockSpecimen(): Promise<ProfileLockSpecimen> {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-lock-"));
  profiles.push(profile);
  const alive = new Map<number, boolean>();
  let pid = process.pid;
  let token = 0;
  const lockPath = join(profile, ".runtime", "daemon.lock");
  const takeoverPath = join(profile, ".runtime", "daemon.lock.takeover");
  return {
    acquire: () =>
      acquireProfileLock({
        profilePath: profile,
        process: {
          get pid() {
            return pid;
          },
          isAlive: async (candidate) => alive.get(candidate) ?? candidate === pid,
          ownerToken: () => `token-${++token}`,
        },
      }),
    async writeMetadata(value) {
      await mkdir(join(profile, ".runtime"), { recursive: true });
      await writeFile(lockPath, value);
    },
    async readMetadata() {
      try {
        return await readFile(lockPath, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
    },
    async writeTakeoverMetadata(value) {
      await mkdir(join(profile, ".runtime"), { recursive: true });
      await writeFile(takeoverPath, value);
    },
    async readTakeoverMetadata() {
      try {
        return await readFile(takeoverPath, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
    },
    setAlive(candidate, value) {
      alive.set(candidate, value);
    },
    setOwnerPid(value) {
      pid = value;
    },
  };
}

function productionLikeFilesystem(profile: string, createFailure: Error): ProfileLockFilesystem {
  return {
    canonicalize: async () => profile,
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async create() {
      throw createFailure;
    },
    read: (path) => readFile(path, "utf8"),
    async remove(path) {
      await rm(path);
    },
  };
}

function runtime(
  options: {
    readonly closeBarrier?: Barrier;
    readonly closeError?: Error;
  } = {},
): { readonly value: SessionRuntime; closeCount(): number } {
  let closes = 0;
  return {
    value: {
      startTurn: async () => ({ turnId: "t", disposition: "started" }),
      steer: async () => ({ turnId: "t" }),
      interrupt: async () => ({ turnId: "t" }),
      waitForIdle: async () => {},
      subscribe: async () => ({ replayThroughSeq: 0, unsubscribe() {} }),
      async close() {
        closes += 1;
        if (options.closeBarrier !== undefined) await options.closeBarrier.wait();
        if (options.closeError !== undefined) throw options.closeError;
      },
    },
    closeCount: () => closes,
  };
}

function event(type: "turn-started" | "step-started" | "turn-ended"): SessionEvent {
  if (type === "turn-started")
    return { type, sessionId: "s", turnId: "t", message: "hi", origin: "user" };
  if (type === "step-started")
    return { type, sessionId: "s", turnId: "t", stepId: "st", provider: "p", model: "m" };
  return { type, sessionId: "s", turnId: "t", status: "completed" };
}

function recordingWorld(initial: ReadonlyArray<SessionEvent>) {
  const appended: SessionEvent[] = [];
  let readError: Error | undefined;
  return {
    appended,
    get readError() {
      return readError;
    },
    set readError(value: Error | undefined) {
      readError = value;
    },
    async readSession(): Promise<ReadonlyArray<SessionEnvelope>> {
      if (readError !== undefined) throw readError;
      return initial.map((item, index) => ({
        schemaVersion: 1,
        seq: index + 1,
        emittedAt: "2026-07-20T00:00:00.000Z",
        event: item,
      }));
    },
    async appendSession(_sessionId: string, item: SessionEvent): Promise<SessionEnvelope> {
      appended.push(item);
      return {
        schemaVersion: 1,
        seq: initial.length + appended.length,
        emittedAt: "2026-07-20T00:00:00.000Z",
        event: item,
      };
    },
  };
}
