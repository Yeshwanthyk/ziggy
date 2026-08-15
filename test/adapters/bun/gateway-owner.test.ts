/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Result } from "effect";
import type { ProfileTarget } from "ziggy/domain/profile";
import {
  acquireGatewayOwner,
  gatewayOwnerPath,
  inspectGatewayOwner,
  type GatewayOwnerRuntime,
} from "ziggy/adapters/bun/gateway-owner";

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

describe("gateway owner inspection", () => {
  test("reports stopped without creating the runtime directory", async () => {
    const profile = await target();
    const before = await readdir(profile.path);

    await expect(Effect.runPromise(inspectGatewayOwner(profile, runtime()))).resolves.toEqual({
      _tag: "stopped",
      path: gatewayOwnerPath(profile),
    });

    expect(await readdir(profile.path)).toEqual(before);
    expect(await Bun.file(join(profile.path, ".runtime")).exists()).toBe(false);
  });

  test("reports running and stale records without changing owner bytes", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    const source = record("00000000-0000-4000-8000-999999999999", 31337);
    await mkdir(join(profile.path, ".runtime"));
    await writeFile(lockPath, source);

    await expect(
      Effect.runPromise(
        inspectGatewayOwner(
          profile,
          runtime((pid) => pid === 31337),
        ),
      ),
    ).resolves.toEqual({
      _tag: "running",
      path: lockPath,
      pid: 31337,
      acquiredAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      Effect.runPromise(
        inspectGatewayOwner(
          profile,
          runtime(() => false),
        ),
      ),
    ).resolves.toEqual({
      _tag: "stale",
      path: lockPath,
      pid: 31337,
      acquiredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await readFile(lockPath, "utf8")).toBe(source);
    expect(await readdir(join(profile.path, ".runtime"))).toEqual(["gateway-owner.lock"]);
  });

  test("fails typed on malformed and symlinked ownership without mutation", async () => {
    const profile = await target();
    const runtimePath = join(profile.path, ".runtime");
    const lockPath = gatewayOwnerPath(profile);
    await mkdir(runtimePath);
    await writeFile(lockPath, "not-json\n");

    const malformed = await Effect.runPromise(
      inspectGatewayOwner(profile, runtime()).pipe(Effect.result),
    );
    expect(Result.isFailure(malformed) && malformed.failure.reason).toBe("unreadable");
    expect(await readFile(lockPath, "utf8")).toBe("not-json\n");

    await rm(lockPath);
    const external = join(profile.path, "external-owner");
    await writeFile(external, record("00000000-0000-4000-8000-999999999999"));
    await symlink(external, lockPath);
    const linked = await Effect.runPromise(
      inspectGatewayOwner(profile, runtime()).pipe(Effect.result),
    );
    expect(Result.isFailure(linked) && linked.failure.reason).toBe("unreadable");
    expect(await readFile(external, "utf8")).toBe(record("00000000-0000-4000-8000-999999999999"));
  });
});

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
          expect(failures[0]?.message).toBe(`gateway already running for ${first.path}`);
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

  test("a live legacy v1 projection remains a compatibility barrier", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    await mkdir(join(profile.path, ".runtime"));
    await writeFile(lockPath, record("00000000-0000-4000-8000-999999999999", 31337));

    const result = await Effect.runPromise(
      Effect.scoped(
        acquireGatewayOwner(
          profile,
          runtime((pid) => pid === 31337),
        ).pipe(Effect.result),
      ),
    );

    expect(Result.isFailure(result) && result.failure.reason).toBe("held");
    expect(await readFile(lockPath, "utf8")).toBe(
      record("00000000-0000-4000-8000-999999999999", 31337),
    );
  });

  test("the SQLite holder replaces a dead legacy projection", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    await mkdir(join(profile.path, ".runtime"));
    await writeFile(lockPath, record("00000000-0000-4000-8000-999999999999", 31337));

    await Effect.runPromise(
      Effect.scoped(
        acquireGatewayOwner(
          profile,
          runtime(() => false),
        ),
      ),
    );

    expect(await Bun.file(lockPath).exists()).toBe(false);
    expect(
      (await readdir(join(profile.path, ".runtime"))).filter((name) => name.endsWith(".candidate")),
    ).toEqual([]);
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

  test("malformed records fail closed and remain present", async () => {
    const profile = await target();
    const lockPath = gatewayOwnerPath(profile);
    await mkdir(join(profile.path, ".runtime"));
    await writeFile(lockPath, "not-json\n");
    const malformed = await Effect.runPromise(
      Effect.scoped(acquireGatewayOwner(profile, runtime()).pipe(Effect.result)),
    );
    expect(Result.isFailure(malformed) && malformed.failure.message).toBe(
      `gateway ownership at ${lockPath} is unreadable`,
    );
    expect(await readFile(lockPath, "utf8")).toBe("not-json\n");
  });
});
