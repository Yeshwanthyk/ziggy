/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-error-constructor, ziggy-effect/no-promise-catch, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-instanceof-tagged-error, ziggy-effect/no-unknown-shape-probing, ziggy-effect/no-unknown-error-message, ziggy-effect/no-instanceof-error, ziggy-effect/no-json-parse -- Bun test callbacks, injected faults, and filesystem fixtures are runtime boundaries. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "../../packages/core/node_modules/effect/dist/index.js";
import type { SessionEnvelope, SessionEvent } from "../../packages/protocol/src/index.ts";
import {
  createDaemonKernel,
  createFilesystemWorld,
  inspectProfileLock,
  ProfileLockCoordinator,
  type SessionRuntime,
} from "../../packages/core/src/index.ts";
import { SessionRuntimeError } from "../../packages/core/src/agent/runtime.ts";
import {
  acquireProfileLock,
  ProfileLockError,
  type ProfileLockFilesystem,
} from "../../packages/core/src/daemon/profile-lock.ts";
import { DaemonKernelCleanupError } from "../../packages/core/src/daemon/kernel.ts";
import { reconcileSession } from "../../packages/core/src/daemon/reconciliation.ts";
import {
  createSessionRegistry,
  SessionRegistryCleanupError,
} from "../../packages/core/src/daemon/registry.ts";
import { Barrier } from "../testkit/barrier.ts";
import {
  defineProfileLockContract,
  type ProfileLockSpecimen,
} from "../testkit/profile-lock-contract.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";
import { runEffect } from "../testkit/effect.ts";

const profiles: string[] = [];

defineProfileLockContract("production Profile lock", async () => createLockSpecimen());

test("production Profile lock atomically publishes one claim across independent coordinators", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-lock-independent-"));
  profiles.push(profile);
  const left = await runEffect(ProfileLockCoordinator.make);
  const right = await runEffect(ProfileLockCoordinator.make);
  const acquire = (coordinator: ProfileLockCoordinator["Service"]) =>
    runEffect(
      acquireProfileLock({ profilePath: profile }).pipe(
        Effect.provideService(ProfileLockCoordinator, coordinator),
      ),
    );
  const results = await Promise.allSettled([acquire(left), acquire(right)]);
  const owners = results.filter((result) => result.status === "fulfilled");
  expect(owners).toHaveLength(1);
  expect(
    JSON.parse(await readFile(join(profile, ".runtime", "daemon.lock"), "utf8")),
  ).toMatchObject({ schemaVersion: 1, pid: process.pid });
  expect((await readdir(join(profile, ".runtime"))).sort()).toEqual(["daemon.lock"]);
  const owner = owners[0];
  if (owner?.status === "fulfilled") await runEffect(owner.value.close);
});

test("Profile lock propagates injected filesystem and process faults", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-lock-fault-"));
  profiles.push(profile);
  const failure = new Error("injected create fault");
  const filesystem = productionLikeFilesystem(profile, failure);
  await expect(
    runEffect(
      acquireProfileLock({
        profilePath: profile,
        filesystem,
        process: {
          pid: 1,
          isAlive: () => Effect.succeed(false),
          ownerToken: Effect.succeed("token"),
        },
      }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
    ),
  ).rejects.toMatchObject({ cause: failure });

  await mkdir(join(profile, ".runtime"), { recursive: true });
  await writeFile(
    join(profile, ".runtime", "daemon.lock"),
    '{"schemaVersion":1,"pid":77,"ownerToken":"old"}',
  );
  const processFailure = new Error("injected process fault");
  await expect(
    runEffect(
      acquireProfileLock({
        profilePath: profile,
        process: {
          pid: 1,
          isAlive: () =>
            Effect.fail(
              new ProfileLockError({
                operation: "inspect-process",
                message: processFailure.message,
                cause: processFailure,
              }),
            ),
          ownerToken: Effect.succeed("token"),
        },
      }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
    ),
  ).rejects.toMatchObject({ cause: processFailure });
});

test("Profile lock inspection distinguishes absent, live, and stale ownership and rejects schemas", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-lock-inspection-"));
  profiles.push(profile);
  const lockPath = join(profile, ".runtime", "daemon.lock");
  await mkdir(join(profile, ".runtime"), { recursive: true });

  expect(await runEffect(inspectProfileLock({ profilePath: profile }))).toEqual({
    state: "absent",
  });
  await writeFile(lockPath, '{"schemaVersion":1,"pid":77,"ownerToken":"fixture-owner"}\n');
  expect(
    await runEffect(
      inspectProfileLock({ profilePath: profile, isAlive: (pid) => Effect.succeed(pid === 77) }),
    ),
  ).toEqual({ state: "live", pid: 77 });
  expect(
    await runEffect(
      inspectProfileLock({ profilePath: profile, isAlive: () => Effect.succeed(false) }),
    ),
  ).toEqual({
    state: "stale",
    pid: 77,
  });

  await writeFile(lockPath, '{"schemaVersion":2,"pid":77,"ownerToken":"fixture-owner"}\n');
  await expect(runEffect(inspectProfileLock({ profilePath: profile }))).rejects.toThrow(
    "Unsupported Profile lock schemaVersion",
  );
});

describe("Session registry", () => {
  test("deduplicates creation, retries failure, and keeps IDs independent", async () => {
    const barrier = new Barrier();
    const calls = new Map<string, number>();
    const registry = await runEffect(
      createSessionRegistry((id) =>
        Effect.gen(function* () {
          calls.set(id, (calls.get(id) ?? 0) + 1);
          if (id === "blocked") yield* Effect.promise(() => barrier.wait());
          if (id === "retry" && calls.get(id) === 1)
            return yield* new SessionRuntimeError({ message: "factory failed" });
          return runtime().value;
        }),
      ),
    );
    const first = runEffect(registry.getOrCreate("blocked"));
    const second = runEffect(registry.getOrCreate("blocked"));
    await runEffect(registry.getOrCreate("other"));
    expect(calls.get("other")).toBe(1);
    barrier.release();
    await Promise.all([first, second]);
    expect(calls.get("blocked")).toBe(1);
    await expect(runEffect(registry.getOrCreate("retry"))).rejects.toThrow("factory failed");
    await runEffect(registry.getOrCreate("retry"));
    expect(calls.get("retry")).toBe(2);
    await runEffect(registry.close);
  });

  test("shutdown waits for in-flight creation, closes once, and rejects gets", async () => {
    const barrier = new Barrier();
    const made = runtime();
    const registry = await runEffect(
      createSessionRegistry(() => Effect.promise(() => barrier.wait()).pipe(Effect.as(made.value))),
    );
    const creation = runEffect(registry.getOrCreate("s"));
    await barrier.entered;
    const closing = runEffect(registry.close);
    await expect(runEffect(registry.getOrCreate("new"))).rejects.toThrow("closed");
    barrier.release();
    await Promise.all([creation, closing, runEffect(registry.close)]);
    expect(made.closeCount()).toBe(1);
  });

  test("shutdown awaits every close before reporting close failures", async () => {
    const barrier = new Barrier();
    const first = runtime({ closeError: new Error("close failed") });
    const second = runtime({ closeBarrier: barrier });
    const registry = await runEffect(
      createSessionRegistry((id) => Effect.succeed(id === "first" ? first.value : second.value)),
    );
    await Promise.all([
      runEffect(registry.getOrCreate("first")),
      runEffect(registry.getOrCreate("second")),
    ]);
    const closing = runEffect(registry.close);
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

  test("shutdown aggregates every close failure and remains idempotent", async () => {
    const firstFailure = new Error("first close failed");
    const secondFailure = new Error("second close failed");
    const first = runtime({ closeError: firstFailure });
    const second = runtime({ closeError: secondFailure });
    const registry = await runEffect(
      createSessionRegistry((id) => Effect.succeed(id === "first" ? first.value : second.value)),
    );
    await Promise.all([
      runEffect(registry.getOrCreate("first")),
      runEffect(registry.getOrCreate("second")),
    ]);

    const firstClose = runEffect(registry.close);
    const secondClose = runEffect(registry.close);
    try {
      await firstClose;
      throw new Error("Expected registry close to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionRegistryCleanupError);
      expect(
        error instanceof SessionRegistryCleanupError
          ? error.failures.map((failure) =>
              failure instanceof SessionRuntimeError ? failure.cause : failure,
            )
          : [],
      ).toEqual([firstFailure, secondFailure]);
    }
    await expect(secondClose).rejects.toBeInstanceOf(SessionRegistryCleanupError);
    expect(first.closeCount()).toBe(1);
    expect(second.closeCount()).toBe(1);
  });

  test("shutdown closes each runtime before its acquisition Scope", async () => {
    const operations: string[] = [];
    const made = runtime({ beforeClose: () => operations.push("runtime") });
    const registry = await runEffect(
      createSessionRegistry(() =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            operations.push("scope");
          }),
        ).pipe(Effect.as(made.value)),
      ),
    );
    await runEffect(registry.getOrCreate("s"));
    await runEffect(registry.close);
    expect(operations).toEqual(["runtime", "scope"]);
  });
});

describe("startup reconciliation", () => {
  test("closes an open step before its turn and closes an open turn", async () => {
    const world = recordingWorld([event("turn-started"), event("step-started")]);
    await runEffect(reconcileSession(world, "s"));
    expect(world.appended.map((item) => item.type)).toEqual(["step-ended", "turn-ended"]);
    expect(world.appended.every((item) => "status" in item && item.status === "failed")).toBeTrue();
    const turnOnly = recordingWorld([event("turn-started")]);
    await runEffect(reconcileSession(turnOnly, "s"));
    expect(turnOnly.appended.map((item) => item.type)).toEqual(["turn-ended"]);
  });

  test("does not append for closed turns and propagates read failures", async () => {
    const closed = recordingWorld([event("turn-started"), event("turn-ended")]);
    await runEffect(reconcileSession(closed, "s"));
    expect(closed.appended).toEqual([]);
    const malformed = recordingWorld([]);
    malformed.readError = new Error("torn NDJSON");
    await expect(runEffect(reconcileSession(malformed, "s"))).rejects.toThrow("torn NDJSON");
  });

  test("fails loud without modifying a torn filesystem Session log", async () => {
    const profile = await mkdtemp(join(tmpdir(), "ziggy-recovery-"));
    profiles.push(profile);
    const world = createFilesystemWorld({ profilePath: profile });
    await runEffect(world.startSession("s", { systemPrompt: "prompt", tools: [] }));
    await runEffect(world.appendSession("s", event("turn-started")));
    const path = join(profile, "sessions", "s.ndjson");
    const torn = `${await readFile(path, "utf8")}{"schemaVersion":1`;
    await writeFile(path, torn);
    const sessionWorld = {
      readSession: (sessionId: string, afterSeq: number) =>
        world
          .readSession(sessionId, afterSeq)
          .pipe(
            Effect.mapError((cause) => new SessionRuntimeError({ message: cause.message, cause })),
          ),
      appendSession: (sessionId: string, item: SessionEvent) =>
        world
          .appendSession(sessionId, item)
          .pipe(
            Effect.mapError((cause) => new SessionRuntimeError({ message: cause.message, cause })),
          ),
    };
    await expect(runEffect(reconcileSession(sessionWorld, "s"))).rejects.toThrow("torn final line");
    expect(await readFile(path, "utf8")).toBe(torn);
  });
});

test("daemon kernel reserves absent main for the ensure authority", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-kernel-main-authority-"));
  profiles.push(profile);
  const world = recordingWorld([]);
  let runtimeCreations = 0;
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: () => world,
      createRuntime: () =>
        Effect.sync(() => {
          runtimeCreations += 1;
          return runtime().value;
        }),
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );

  await expect(runEffect(kernel.getOrCreateSession("main"))).rejects.toMatchObject({
    operation: "get-or-create-session",
  });
  expect(runtimeCreations).toBe(0);
  expect(await runEffect(kernel.getSessionSummary("main"))).toBeUndefined();
  expect(await runEffect(kernel.listSessions)).toEqual([]);
  await runEffect(kernel.close);
});

test("daemon kernel binds the canonical Profile World and releases its lock after runtimes close", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-kernel-"));
  profiles.push(profile);
  const canonicalProfile = await realpath(profile);
  const barrier = new Barrier();
  const made = runtime({ closeBarrier: barrier });
  const world = recordingWorld([]);
  let worldPath = "";
  let runtimeWorld: unknown;
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: join(profile, "."),
      createWorld(canonicalProfilePath) {
        worldPath = canonicalProfilePath;
        return world;
      },
      createRuntime(_sessionId, receivedWorld) {
        runtimeWorld = receivedWorld;
        return Effect.succeed(made.value);
      },
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  await runEffect(kernel.getOrCreateSession("s"));
  expect(worldPath).toBe(canonicalProfile);
  expect(runtimeWorld).toBe(world);
  const closing = runEffect(kernel.close);
  await barrier.entered;
  expect(await readFile(join(profile, ".runtime", "daemon.lock"), "utf8")).toContain(
    `"pid":${process.pid}`,
  );
  barrier.release();
  await Promise.all([closing, runEffect(kernel.close)]);
  expect(made.closeCount()).toBe(1);
  await expect(readFile(join(profile, ".runtime", "daemon.lock"), "utf8")).rejects.toThrow();
});

test("daemon kernel rolls acquisition back when World construction fails", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-kernel-rollback-"));
  profiles.push(profile);
  const startupFailure = new Error("World construction failed");

  await expect(
    runEffect(
      createDaemonKernel({
        profilePath: profile,
        createWorld() {
          throw startupFailure;
        },
        createRuntime: () => Effect.succeed(runtime().value),
      }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
    ),
  ).rejects.toMatchObject({ cause: startupFailure });
  await expect(readFile(join(profile, ".runtime", "daemon.lock"), "utf8")).rejects.toThrow();
});

test("daemon kernel rolls acquisition back when runtime factory construction fails", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-kernel-factory-rollback-"));
  profiles.push(profile);
  const startupFailure = new SessionRuntimeError({ message: "runtime factory failed" });

  await expect(
    runEffect(
      createDaemonKernel({
        profilePath: profile,
        createWorld: () => recordingWorld([]),
        createRuntimeFactory: () => Effect.fail(startupFailure),
      }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
    ),
  ).rejects.toBe(startupFailure);
  await expect(readFile(join(profile, ".runtime", "daemon.lock"), "utf8")).rejects.toThrow();
});

test("daemon kernel releases the Profile lock last and aggregates cleanup failures", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-kernel-finalizers-"));
  profiles.push(profile);
  const operations: string[] = [];
  const runtimeFailure = new Error("runtime cleanup failed");
  const lockFailure = new Error("lock cleanup failed");
  const filesystem = productionLikeFilesystem(profile, undefined, {
    beforeRemove() {
      operations.push("lock");
    },
    removeFailure: lockFailure,
  });
  const made = runtime({
    beforeClose() {
      operations.push("runtime");
    },
    closeError: runtimeFailure,
  });
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: () => recordingWorld([]),
      createRuntime: () => Effect.succeed(made.value),
      lock: {
        filesystem,
        process: {
          pid: 1,
          isAlive: () => Effect.succeed(false),
          ownerToken: Effect.succeed("token"),
        },
      },
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  await runEffect(kernel.getOrCreateSession("s"));

  try {
    await runEffect(kernel.close);
    throw new Error("Expected kernel close to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DaemonKernelCleanupError);
    expect(
      error instanceof DaemonKernelCleanupError
        ? error.failures.map((failure) =>
            failure instanceof SessionRuntimeError || failure instanceof ProfileLockError
              ? failure.cause
              : failure,
          )
        : [],
    ).toEqual([runtimeFailure, lockFailure]);
  }
  expect(operations).toEqual(["runtime", "lock"]);
  expect(made.closeCount()).toBe(1);
});

afterAll(async () => {
  await Promise.all(profiles.map((path) => rm(path, { recursive: true, force: true })));
  emitVerificationObservation("s2.daemon-kernel", emptyRuntimeObservations());
});

async function createLockSpecimen(): Promise<ProfileLockSpecimen> {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-lock-"));
  profiles.push(profile);
  const alive = new Map<number, boolean>();
  let pid = process.pid;
  let token = 0;
  const lockPath = join(profile, ".runtime", "daemon.lock");
  const takeoverPath = join(profile, ".runtime", "daemon.lock.takeover");
  const coordinator = await runEffect(ProfileLockCoordinator.make);
  return {
    acquire: acquireProfileLock({
      profilePath: profile,
      process: {
        get pid() {
          return pid;
        },
        isAlive: (candidate) => Effect.succeed(alive.get(candidate) ?? candidate === pid),
        get ownerToken() {
          return Effect.sync(() => `token-${++token}`);
        },
      },
    }).pipe(Effect.provideService(ProfileLockCoordinator, coordinator)),
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

function productionLikeFilesystem(
  profile: string,
  createFailure: Error | undefined,
  options: {
    readonly beforeRemove?: () => void;
    readonly removeFailure?: Error;
  } = {},
): ProfileLockFilesystem {
  return {
    canonicalize: () => Effect.succeed(profile),
    mkdir: (path) =>
      filesystemEffect("mkdir", () => mkdir(path, { recursive: true }).then(() => undefined)),
    create: (path, content) =>
      filesystemEffect("create", () => {
        if (createFailure !== undefined) return Promise.reject(createFailure);
        return writeFile(path, content, { flag: "wx" });
      }),
    read: (path) => filesystemEffect("read", () => readFile(path, "utf8")),
    remove: (path) =>
      filesystemEffect("remove", () => {
        options.beforeRemove?.();
        if (options.removeFailure !== undefined) return Promise.reject(options.removeFailure);
        return rm(path);
      }),
  };
}

function runtime(
  options: {
    readonly closeBarrier?: Barrier;
    readonly closeError?: Error;
    readonly beforeClose?: () => void;
  } = {},
): { readonly value: SessionRuntime; closeCount(): number } {
  let closes = 0;
  return {
    value: {
      startTurn: () => Effect.succeed({ turnId: "t", disposition: "started" }),
      steer: () => Effect.succeed({ turnId: "t" }),
      interrupt: () => Effect.succeed({ turnId: "t" }),
      resolveApproval: () => Effect.succeed({ outcome: "already-resolved" }),
      waitForIdle: Effect.void,
      subscribe: () => Effect.succeed({ replayThroughSeq: 0, unsubscribe: Effect.void }),
      close: Effect.gen(function* () {
        closes += 1;
        options.beforeClose?.();
        if (options.closeBarrier !== undefined) {
          yield* Effect.promise(() => options.closeBarrier?.wait() ?? Promise.resolve());
        }
        if (options.closeError !== undefined) {
          return yield* new SessionRuntimeError({
            message: options.closeError.message,
            cause: options.closeError,
          });
        }
      }),
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
    readSession: (): Effect.Effect<ReadonlyArray<SessionEnvelope>, SessionRuntimeError> =>
      Effect.gen(function* () {
        if (readError !== undefined) {
          return yield* new SessionRuntimeError({ message: readError.message, cause: readError });
        }
        return initial.map((item, index) => ({
          schemaVersion: 1,
          seq: index + 1,
          emittedAt: "2026-07-20T00:00:00.000Z",
          event: item,
        }));
      }),
    listSessions: Effect.sync(() =>
      initial.length === 0 ? [] : [{ sessionId: "s", lastSeq: initial.length }],
    ),
    appendSession: (
      _sessionId: string,
      item: SessionEvent,
    ): Effect.Effect<SessionEnvelope, SessionRuntimeError> =>
      Effect.sync(() => {
        appended.push(item);
        return {
          schemaVersion: 1,
          seq: initial.length + appended.length,
          emittedAt: "2026-07-20T00:00:00.000Z",
          event: item,
        };
      }),
  };
}

function filesystemEffect<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, ProfileLockError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ProfileLockError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}
