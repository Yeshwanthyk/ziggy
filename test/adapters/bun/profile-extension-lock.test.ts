/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute lock Effects */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Deferred, Effect, Fiber, Result } from "effect";
import {
  makeProfileExtensionMutationLock,
  profileExtensionLockPath,
} from "ziggy/adapters/bun/profile-extension-lock";

const roots: string[] = [];

const makeProfile = async (): Promise<{ readonly root: string; readonly profilePath: string }> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-profile-lock-"));
  roots.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath);
  return { root, profilePath };
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const expectLockFailure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("expected the Profile extension lock to fail");
  return result.failure;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Profile extension mutation lock", () => {
  test("rejects a symlinked database without mutating its target", async () => {
    const { profilePath, root } = await makeProfile();
    const runtimePath = join(profilePath, ".runtime");
    const targetPath = join(root, "outside.sqlite");
    const targetBytes = Buffer.from("target bytes\n");
    await mkdir(runtimePath);
    await writeFile(targetPath, targetBytes);
    const targetMode = (await stat(targetPath)).mode & 0o777;
    await symlink(targetPath, profileExtensionLockPath(profilePath));

    const result = await run(
      makeProfileExtensionMutationLock()
        .withLock(profilePath, Effect.succeed("must not run"))
        .pipe(Effect.result),
    );

    const failure = expectLockFailure(result);
    expect(failure).toMatchObject({
      _tag: "ProfileExtensionLockFailed",
      operation: "acquire",
    });
    expect(await readFile(targetPath)).toEqual(targetBytes);
    expect((await stat(targetPath)).mode & 0o777).toBe(targetMode);
  });

  test("rejects a symlinked SQLite sidecar before opening and without mutating its target", async () => {
    const { profilePath, root } = await makeProfile();
    const runtimePath = join(profilePath, ".runtime");
    const lockPath = profileExtensionLockPath(profilePath);
    const targetPath = join(root, "outside-journal");
    const targetBytes = Buffer.from("journal target bytes\n");
    await mkdir(runtimePath);
    await writeFile(lockPath, "");
    await writeFile(targetPath, targetBytes);
    await symlink(targetPath, `${lockPath}-journal`);

    const result = await run(
      makeProfileExtensionMutationLock()
        .withLock(profilePath, Effect.succeed("must not run"))
        .pipe(Effect.result),
    );

    const failure = expectLockFailure(result);
    expect(failure).toMatchObject({
      _tag: "ProfileExtensionLockFailed",
      operation: "acquire",
    });
    expect(await readFile(targetPath)).toEqual(targetBytes);
    expect(await readFile(lockPath, "utf8")).toBe("");
  });

  test("rejects a non-regular SQLite sidecar and a non-regular database", async () => {
    const sidecarFixture = await makeProfile();
    const sidecarRuntimePath = join(sidecarFixture.profilePath, ".runtime");
    const sidecarLockPath = profileExtensionLockPath(sidecarFixture.profilePath);
    await mkdir(sidecarRuntimePath);
    await writeFile(sidecarLockPath, "");
    await mkdir(`${sidecarLockPath}-wal`);

    const sidecarResult = await run(
      makeProfileExtensionMutationLock()
        .withLock(sidecarFixture.profilePath, Effect.succeed("must not run"))
        .pipe(Effect.result),
    );
    expect(expectLockFailure(sidecarResult)).toMatchObject({
      _tag: "ProfileExtensionLockFailed",
      operation: "acquire",
    });

    const databaseFixture = await makeProfile();
    const databaseRuntimePath = join(databaseFixture.profilePath, ".runtime");
    await mkdir(databaseRuntimePath);
    await mkdir(profileExtensionLockPath(databaseFixture.profilePath));

    const databaseResult = await run(
      makeProfileExtensionMutationLock()
        .withLock(databaseFixture.profilePath, Effect.succeed("must not run"))
        .pipe(Effect.result),
    );
    expect(expectLockFailure(databaseResult)).toMatchObject({
      _tag: "ProfileExtensionLockFailed",
      operation: "acquire",
    });
  });

  test("rejects Profile and runtime symlinks before creating an outside lock", async () => {
    const { profilePath, root } = await makeProfile();
    const linkedProfilePath = join(root, "profile-link");
    await symlink(profilePath, linkedProfilePath);

    const profileResult = await run(
      makeProfileExtensionMutationLock()
        .withLock(linkedProfilePath, Effect.succeed("must not run"))
        .pipe(Effect.result),
    );
    expect(expectLockFailure(profileResult)).toMatchObject({
      _tag: "ProfileExtensionLockFailed",
      operation: "prepare",
    });
    await expect(stat(join(profilePath, ".runtime"))).rejects.toHaveProperty("code", "ENOENT");

    const externalRuntimePath = join(root, "outside-runtime");
    await mkdir(externalRuntimePath);
    await symlink(externalRuntimePath, join(profilePath, ".runtime"));

    const runtimeResult = await run(
      makeProfileExtensionMutationLock()
        .withLock(profilePath, Effect.succeed("must not run"))
        .pipe(Effect.result),
    );
    expect(expectLockFailure(runtimeResult)).toMatchObject({
      _tag: "ProfileExtensionLockFailed",
      operation: "prepare",
    });
    await expect(
      stat(join(externalRuntimePath, "profile-extensions.sqlite")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  test("creates private runtime and lock paths", async () => {
    const { profilePath } = await makeProfile();
    const lock = makeProfileExtensionMutationLock();

    expect(await run(lock.withLock(profilePath, Effect.succeed(undefined)))).toBeUndefined();
    expect((await stat(join(profilePath, ".runtime"))).mode & 0o777).toBe(0o700);
    expect((await stat(profileExtensionLockPath(profilePath))).mode & 0o777).toBe(0o600);
  });

  test("serializes independent lock users", async () => {
    const { profilePath } = await makeProfile();
    const firstEntered = await run(Deferred.make<void>());
    const releaseFirst = await run(Deferred.make<void>());
    const secondEntered = await run(Deferred.make<void>());
    let active = 0;
    let maximumActive = 0;
    let secondStarted = false;

    const critical = (
      name: string,
      entered: Deferred.Deferred<void>,
      release?: Deferred.Deferred<void>,
    ) =>
      Effect.gen(function* () {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (name === "second") secondStarted = true;
        yield* Deferred.succeed(entered, undefined);
        if (release === undefined) yield* Effect.sleep("20 millis");
        else yield* Deferred.await(release);
        return name;
      }).pipe(Effect.ensuring(Effect.sync(() => void (active -= 1))));

    const firstFiber = Effect.runFork(
      makeProfileExtensionMutationLock().withLock(
        profilePath,
        critical("first", firstEntered, releaseFirst),
      ),
    );
    await run(Deferred.await(firstEntered));
    const secondPromise = run(
      makeProfileExtensionMutationLock().withLock(profilePath, critical("second", secondEntered)),
    );
    await run(Effect.sleep("100 millis"));
    expect(secondStarted).toBe(false);

    await run(Deferred.succeed(releaseFirst, undefined));
    expect(await run(Fiber.join(firstFiber))).toBe("first");
    expect(await secondPromise).toBe("second");
    expect(maximumActive).toBe(1);
  });

  test("times out on a held transaction, releases its connection, and can reacquire", async () => {
    const { profilePath } = await makeProfile();
    const lock = makeProfileExtensionMutationLock();
    await run(lock.withLock(profilePath, Effect.void));

    const holder = new Database(profileExtensionLockPath(profilePath), {
      create: false,
      readwrite: true,
      strict: true,
    });
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      const result = await run(
        lock.withLock(profilePath, Effect.succeed("must time out")).pipe(Effect.result),
      );
      const failure = expectLockFailure(result);
      expect(failure).toMatchObject({
        _tag: "ProfileExtensionLockFailed",
        operation: "acquire",
      });
      expect(failure.message).toContain("timed out");
    } finally {
      holder.exec("ROLLBACK");
      holder.close(false);
    }

    expect(await run(lock.withLock(profilePath, Effect.succeed("reacquired")))).toBe("reacquired");
  });

  test("interrupting a waiter closes its connection before the holder releases", async () => {
    const { profilePath } = await makeProfile();
    const lock = makeProfileExtensionMutationLock();
    await run(lock.withLock(profilePath, Effect.void));
    const holder = new Database(profileExtensionLockPath(profilePath), {
      create: false,
      readwrite: true,
      strict: true,
    });
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

    try {
      const pending = Effect.runFork(lock.withLock(profilePath, Effect.succeed("must not run")));
      await run(Effect.sleep("100 millis"));
      await run(Fiber.interrupt(pending));
    } finally {
      holder.exec("ROLLBACK");
      holder.close(false);
    }

    expect(await run(lock.withLock(profilePath, Effect.succeed("reacquired")))).toBe("reacquired");
  });

  test("releases BEGIN IMMEDIATE after a failure and after interruption", async () => {
    const { profilePath } = await makeProfile();
    const lock = makeProfileExtensionMutationLock();

    const failure = await run(
      lock.withLock(profilePath, Effect.fail("mutation failed")).pipe(Effect.result),
    );
    expect(expectLockFailure(failure)).toBe("mutation failed");
    expect(await run(lock.withLock(profilePath, Effect.succeed("after failure")))).toBe(
      "after failure",
    );

    const entered = await run(Deferred.make<void>());
    const interruptedFiber = Effect.runFork(
      lock.withLock(
        profilePath,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Effect.never;
        }),
      ),
    );
    await run(Deferred.await(entered));
    await run(Fiber.interrupt(interruptedFiber));

    expect(await run(lock.withLock(profilePath, Effect.succeed("after interruption")))).toBe(
      "after interruption",
    );
  });
});
