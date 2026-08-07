/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Result } from "effect";
import type { ProfileTarget } from "../../domain/profile";
import { acquireGatewayOwner, gatewayOwnerPath, type GatewayOwnerRuntime } from "./gateway-owner";

const paths: Array<string> = [];
const target = async (prefix = "ziggy-owner-"): Promise<ProfileTarget> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return { path, name: "Test" };
};
const runtime = (pidIsAlive: (pid: number) => boolean = () => true): GatewayOwnerRuntime => {
  let id = 0;
  return {
    pid: 4242,
    makeOwnerId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    pidIsAlive,
  };
};
const record = (ownerId: string, pid = 4242) =>
  `${JSON.stringify({ version: 1, ownerId, pid, acquiredAt: "2026-01-01T00:00:00.000Z" })}\n`;

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("gateway owner", () => {
  test("admits exactly one concurrent owner per Profile and independent Profiles", async () => {
    const first = await target();
    const second = await target();
    const host = runtime();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attempts = yield* Effect.all(
            Array.from({ length: 24 }, () => acquireGatewayOwner(first, host).pipe(Effect.result)),
            { concurrency: "unbounded" },
          );
          expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
          const failures = attempts.filter(Result.isFailure).map(({ failure }) => failure);
          expect(failures.every((failure) => failure.reason === "held")).toBe(true);
          expect(failures[0]?.message).toBe(`gateway already running for ${first.path} (pid 4242)`);
          yield* acquireGatewayOwner(second, host);
        }),
      ),
    );
    await Effect.runPromise(Effect.scoped(acquireGatewayOwner(first, host)));
  });

  test("interruption releases the owner for immediate reacquisition", async () => {
    const profile = await target();
    const host = runtime();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const owner = Effect.runFork(
      Effect.scoped(
        acquireGatewayOwner(profile, host).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Fiber.interrupt(owner));
    await Effect.runPromise(Effect.scoped(acquireGatewayOwner(profile, host)));
  });

  test("retries when the previous owner releases after a link conflict", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    await mkdir(join(profile.path, ".runtime"));
    await writeFile(lockPath, record("00000000-0000-4000-8000-999999999999"));
    let conflicts = 0;
    const host: GatewayOwnerRuntime = {
      ...runtime(),
      afterLinkConflict: () =>
        Effect.promise(async () => {
          conflicts += 1;
          await rm(lockPath);
        }),
    };

    await Effect.runPromise(Effect.scoped(acquireGatewayOwner(profile, host)));

    expect(conflicts).toBe(1);
  });

  test("reports an unexpected candidate cleanup failure without failing owner release", async () => {
    const profile = await target();
    const cleanupFailure = Object.assign(new Error("cleanup denied"), { code: "EPERM" });
    const reported: Array<{ readonly path: string; readonly cause: unknown }> = [];
    const host: GatewayOwnerRuntime = {
      ...runtime(),
      removeCandidate: () => Promise.reject(cleanupFailure),
      reportCleanupFailure: (path, cause) => Effect.sync(() => reported.push({ path, cause })),
    };

    await Effect.runPromise(Effect.scoped(acquireGatewayOwner(profile, host)));

    expect(reported).toHaveLength(1);
    expect(reported[0]?.cause).toBe(cleanupFailure);
    expect(
      (await readdir(join(profile.path, ".runtime"))).filter((name) => name.endsWith(".candidate")),
    ).toHaveLength(1);
  });

  test("release never removes a valid foreign owner", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    const foreign = "00000000-0000-4000-8000-999999999999";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireGatewayOwner(profile, runtime());
          yield* Effect.promise(() => writeFile(lockPath, record(foreign)));
        }),
      ),
    );
    expect(await readFile(lockPath, "utf8")).toBe(record(foreign));
  });

  test("dead and malformed records fail closed with exact copy and remain present", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    await Effect.runPromise(Effect.scoped(acquireGatewayOwner(profile, runtime())));
    await writeFile(lockPath, record("00000000-0000-4000-8000-999999999999", 31337));
    const stale = await Effect.runPromise(
      Effect.scoped(
        acquireGatewayOwner(
          profile,
          runtime(() => false),
        ).pipe(Effect.result),
      ),
    );
    expect(Result.isFailure(stale) && stale.failure.message).toBe(
      `stale gateway owner at ${lockPath} (pid 31337); remove the lock file after confirming that process is stopped`,
    );
    expect(await access(lockPath).then(() => true)).toBe(true);

    await writeFile(lockPath, "not-json\n");
    const malformed = await Effect.runPromise(
      Effect.scoped(acquireGatewayOwner(profile, runtime()).pipe(Effect.result)),
    );
    expect(Result.isFailure(malformed) && malformed.failure.message).toBe(
      `gateway ownership at ${lockPath} is unreadable; refusing to start`,
    );
    expect(await readFile(lockPath, "utf8")).toBe("not-json\n");
  });
});
