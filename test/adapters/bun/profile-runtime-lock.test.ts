/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute boundary Effects. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import {
  acquireProfileRuntimeLease,
  withProfileUpdateLock,
} from "ziggy/adapters/bun/profile-runtime-lock";
import { leaseProfileRuntime } from "ziggy/adapters/pi/profile-runtime-lease";
import { ProfileExtensionRollbackFailed } from "ziggy/domain/profile-extension";

const roots: string[] = [];

const profile = async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-runtime-lock-"));
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("multiple runtime readers block activation until every lease is released", async () => {
  const root = await profile();
  const first = await Effect.runPromise(acquireProfileRuntimeLease(root));
  const second = await Effect.runPromise(acquireProfileRuntimeLease(root));
  let activated = false;

  const activate = withProfileUpdateLock(
    root,
    Effect.sync(() => {
      activated = true;
    }),
  );

  expect(await Effect.runPromise(activate.pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileExtensionLockFailed" },
  });
  first.release();
  expect(await Effect.runPromise(activate.pipe(Effect.result))).toMatchObject({ _tag: "Failure" });
  expect(activated).toBeFalse();
  second.release();
  second.release();
  await Effect.runPromise(activate);
  expect(activated).toBeTrue();
});

test("exclusive activation blocks runtime admission and releases after failure", async () => {
  const root = await profile();

  const result = await Effect.runPromise(
    withProfileUpdateLock(root, acquireProfileRuntimeLease(root).pipe(Effect.result)),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileExtensionLockFailed" },
  });
  await Effect.runPromise(
    withProfileUpdateLock(root, Effect.fail("update failed")).pipe(Effect.result),
  );
  const lease = await Effect.runPromise(acquireProfileRuntimeLease(root));
  lease.release();
});

test("a separate process reader excludes activation and SIGKILL releases its lease", async () => {
  const root = await profile();

  const modulePath = new URL("../../../src/adapters/bun/profile-runtime-lock.ts", import.meta.url)
    .pathname;

  const script = `import { Effect } from "effect";
    import { acquireProfileRuntimeLease } from ${JSON.stringify(modulePath)};
    const lease = await Effect.runPromise(acquireProfileRuntimeLease(process.argv[1]));
    console.log("ready"); setInterval(() => void lease, 1000);`;

  const child = Bun.spawn([process.execPath, "-e", script, root], {
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    expect(
      await Effect.runPromise(withProfileUpdateLock(root, Effect.void).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProfileExtensionLockFailed" } });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }

  await Effect.runPromise(withProfileUpdateLock(root, Effect.void));
});

test("construction failure releases its lease and successful disposal releases only once", async () => {
  const root = await profile();
  expect(
    await Effect.runPromise(
      leaseProfileRuntime(root, Effect.fail("construction failed")).pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: "construction failed" });
  await Effect.runPromise(withProfileUpdateLock(root, Effect.void));
  let disposed = 0;
  let aborted = 0;

  const runtime = await Effect.runPromise(
    leaseProfileRuntime(
      root,
      Effect.succeed({
        session: {
          abort: async () => {
            aborted += 1;
          },
        },
        dispose: async () => {
          disposed += 1;
        },
      }),
    ),
  );

  expect(
    await Effect.runPromise(withProfileUpdateLock(root, Effect.void).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure" });
  await Promise.all([runtime.dispose(), runtime.dispose()]);
  expect({ disposed, aborted }).toEqual({ disposed: 1, aborted: 1 });
  await Effect.runPromise(withProfileUpdateLock(root, Effect.void));
});

test("cancellation waits for construction to settle, then disposes before releasing", async () => {
  const root = await profile();
  const started = Deferred.makeUnsafe<void>();
  const finish = Deferred.makeUnsafe<void>();
  let disposed = false;
  const controller = new AbortController();

  const constructing = Effect.runPromise(
    leaseProfileRuntime(
      root,
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);

        return {
          session: { abort: async () => {} },
          dispose: async () => {
            disposed = true;
          },
        };
      }),
    ),
    { signal: controller.signal },
  );

  const settled = constructing.then(
    () => "success",
    () => "interrupted",
  );

  await Effect.runPromise(Deferred.await(started));
  controller.abort();
  expect(
    await Effect.runPromise(withProfileUpdateLock(root, Effect.void).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure" });
  await Effect.runPromise(Deferred.succeed(finish, undefined));
  expect(await settled).toBe("interrupted");
  expect(disposed).toBeTrue();
  await Effect.runPromise(withProfileUpdateLock(root, Effect.void));
});

test("pending update journal prevents construction and does not retain a reader lease", async () => {
  const root = await profile();
  const journalRoot = join(root, ".runtime", "extension-updates", "test-extension");
  await mkdir(journalRoot, { recursive: true });
  await writeFile(join(journalRoot, "journal.json"), "{}");
  let constructed = false;

  const result = await Effect.runPromise(
    leaseProfileRuntime(
      root,
      Effect.sync(() => {
        constructed = true;

        return { session: { abort: async () => {} }, dispose: async () => {} };
      }),
    ).pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileExtensionLockFailed" },
  });
  expect(constructed).toBeFalse();
  await Effect.runPromise(withProfileUpdateLock(root, Effect.void));
});

test("failed construction shutdown retains its lease until process exit", async () => {
  const root = await profile();

  const failure = new ProfileExtensionRollbackFailed({
    profilePath: root,
    operation: "activate-runtime",
    message: "runtime shutdown failed",
    originalFailure: undefined,
    rollbackFailures: [],
    cause: undefined,
  });

  expect(
    await Effect.runPromise(leaseProfileRuntime(root, Effect.fail(failure)).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProfileExtensionRollbackFailed" } });
  expect(
    await Effect.runPromise(withProfileUpdateLock(root, Effect.void).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProfileExtensionLockFailed" } });
});
