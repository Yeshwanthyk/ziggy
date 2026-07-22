import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { ExtensionLifecycle } from "../../packages/core/src/index.ts";
import { withExtensionLifecyclePermit } from "../../packages/core/src/extensions/lifecycle-coordinator.ts";
import {
  activateStagedExtension,
  cleanupStagedExtension,
  type ExtensionLifecycleNodeCheckpoint,
  type ExtensionLifecycleNodeHooks,
  replaceExtensionAuthorityJson,
  runExtensionProcess,
  stageLocalExtensionPackage,
} from "../../packages/core/src/extensions/lifecycle-node-adapter.ts";
import { runEffect, runScopedEffect } from "../testkit/effect.ts";

const roots: string[] = [];

test("every activation rename cut point rolls back package and all authorities exactly", async () => {
  const fixture = await installedFixture("activation-faults");
  const mutableRoot = join(fixture.profile, ".runtime", "extensions", "fixture", "state");
  await mkdir(mutableRoot);
  await writeFile(join(mutableRoot, "owner.json"), '{"schemaVersion":1,"value":"old"}\n');
  const checkpoints: ReadonlyArray<ExtensionLifecycleNodeCheckpoint> = [
    "activation-after-package-backup",
    "activation-after-authority-backup",
    "activation-before-package-publish",
    "activation-after-package-publish",
    "activation-before-authority-publish",
    "activation-after-authority-publish",
  ];
  for (const point of checkpoints) {
    const before = await profileSnapshot(fixture.profile);
    const staged = await stageLocalExtensionPackage(fixture.profile, fixture.source);
    const authority = await authorityJson(fixture.profile);
    try {
      await expect(
        activateStagedExtension({
          profilePath: fixture.profile,
          extensionId: "fixture",
          staged: staged.staged,
          ...authority,
          hooks: failingAt(point),
        }),
      ).rejects.toThrow(`fault:${point}`);
    } finally {
      await cleanupStagedExtension(staged.staged);
    }
    expect(await profileSnapshot(fixture.profile)).toEqual(before);
    expect(await quarantineEntries(fixture.profile)).toEqual([]);
  }
});

test("state and approval authority writes roll back at every publication cut point", async () => {
  const fixture = await installedFixture("authority-faults");
  const points: ReadonlyArray<ExtensionLifecycleNodeCheckpoint> = [
    "authority-after-temporary-write",
    "authority-before-target-publish",
    "authority-after-target-publish",
  ];
  const authorityNames: ReadonlyArray<"state.json" | "approvals.json"> = [
    "state.json",
    "approvals.json",
  ];
  for (const name of authorityNames) {
    for (const point of points) {
      const before = await profileSnapshot(fixture.profile);
      await expect(
        replaceExtensionAuthorityJson(
          fixture.profile,
          "fixture",
          name,
          '{"schemaVersion":1,"replacement":true}\n',
          failingAt(point),
        ),
      ).rejects.toThrow(`fault:${point}`);
      expect(await profileSnapshot(fixture.profile)).toEqual(before);
      expect(await authorityTemporaryEntries(fixture.profile)).toEqual([]);
    }
  }
});

test("copy interruption cleans quarantine without publishing package or authority", async () => {
  const fixture = await bareFixture("copy-interruption");
  await writeSource(fixture.source, "skills/fixture/references/one.md", "one\n");
  const barrier = promiseBarrier();
  const controller = new AbortController();
  let blocked = false;
  const hooks: ExtensionLifecycleNodeHooks = {
    checkpoint: (point) => {
      if (point !== "copy-before-file" || blocked) return Promise.resolve();
      blocked = true;
      barrier.entered.resolve();
      return barrier.release.promise;
    },
  };
  const copying = stageLocalExtensionPackage(
    fixture.profile,
    fixture.source,
    controller.signal,
    hooks,
  );
  await barrier.entered.promise;
  controller.abort();
  barrier.release.resolve();
  await expect(copying).rejects.toThrow("interrupted");
  expect(await quarantineEntries(fixture.profile)).toEqual([]);
  expect(await Bun.file(join(fixture.profile, "extensions", "fixture")).exists()).toBeFalse();
  expect(
    await Bun.file(
      join(fixture.profile, ".runtime", "extensions", "fixture", "provenance.json"),
    ).exists(),
  ).toBeFalse();
});

test("setup interruption kills the supervised process before later side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-s4-process-interruption-"));
  roots.push(root);
  const executable = join(root, "setup");
  const sentinel = join(root, "ran-after-interrupt");
  await writeFile(executable, `#!/bin/sh\nsleep 1\nprintf late > ${sentinel}\n`);
  await chmod(executable, 0o700);
  const barrier = promiseBarrier();
  const controller = new AbortController();
  const running = runExtensionProcess({
    executablePath: executable,
    argv: [executable],
    cwd: root,
    environment: {},
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
    signal: controller.signal,
    hooks: {
      checkpoint: (point) => {
        if (point !== "process-after-spawn") return Promise.resolve();
        barrier.entered.resolve();
        return barrier.release.promise;
      },
    },
  });
  await barrier.entered.promise;
  controller.abort();
  barrier.release.resolve();
  await expect(running).rejects.toThrow("interrupted");
  await Bun.sleep(50);
  expect(await Bun.file(sentinel).exists()).toBeFalse();
});

test("activation interruption rolls back while its caller cleans quarantine", async () => {
  const fixture = await installedFixture("activation-interruption");
  const before = await profileSnapshot(fixture.profile);
  const staged = await stageLocalExtensionPackage(fixture.profile, fixture.source);
  const authority = await authorityJson(fixture.profile);
  const barrier = promiseBarrier();
  const controller = new AbortController();
  const activation = activateStagedExtension({
    profilePath: fixture.profile,
    extensionId: "fixture",
    staged: staged.staged,
    ...authority,
    signal: controller.signal,
    hooks: {
      checkpoint: (point) => {
        if (point !== "activation-after-package-backup") return Promise.resolve();
        barrier.entered.resolve();
        return barrier.release.promise;
      },
    },
  });
  await barrier.entered.promise;
  controller.abort();
  barrier.release.resolve();
  try {
    await expect(activation).rejects.toThrow("interrupted");
  } finally {
    await cleanupStagedExtension(staged.staged);
  }
  expect(await profileSnapshot(fixture.profile)).toEqual(before);
  expect(await quarantineEntries(fixture.profile)).toEqual([]);
});

test("the lifecycle barrier serializes one ID while a different ID completes independently", async () => {
  const profile = join(tmpdir(), "ziggy-s4-lifecycle-barrier-profile");
  const trace = await runScopedEffect(
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const sameEntered = yield* Deferred.make<void>();
      const otherCompleted = yield* Deferred.make<void>();
      const append = (event: string) => Ref.update(events, (current) => [...current, event]);
      const first = yield* Effect.forkScoped(
        withExtensionLifecyclePermit(
          profile,
          "same",
          append("same:first:start").pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(append("same:first:end")),
          ),
        ),
      );
      yield* Deferred.await(firstEntered);
      const second = yield* Effect.forkScoped(
        withExtensionLifecyclePermit(
          profile,
          "same",
          append("same:second:start").pipe(
            Effect.andThen(Deferred.succeed(sameEntered, undefined)),
            Effect.andThen(append("same:second:end")),
          ),
        ),
      );
      const other = yield* Effect.forkScoped(
        withExtensionLifecyclePermit(
          profile,
          "other",
          append("other:start").pipe(
            Effect.andThen(append("other:end")),
            Effect.andThen(Deferred.succeed(otherCompleted, undefined)),
          ),
        ),
      );
      yield* Deferred.await(otherCompleted);
      const beforeRelease = yield* Ref.get(events);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(sameEntered);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(other);
      return { beforeRelease, afterRelease: yield* Ref.get(events) };
    }),
  );
  expect(trace.beforeRelease).toEqual(["same:first:start", "other:start", "other:end"]);
  expect(trace.afterRelease).toEqual([
    "same:first:start",
    "other:start",
    "other:end",
    "same:first:end",
    "same:second:start",
    "same:second:end",
  ]);
});

test("fresh Layer recovery resolves real process death at every durable publication phase", async () => {
  const commonPoints: ReadonlyArray<ExtensionLifecycleNodeCheckpoint> = [
    "activation-after-transaction-durable",
    "activation-after-new-package-publish",
    "activation-after-state-publish",
    "activation-after-provenance-publish",
    "activation-after-approvals-publish",
    "activation-before-commit",
    "activation-after-commit",
    "cleanup-after-tombstone-publish",
  ];
  for (const point of commonPoints) {
    const fixture = await bareFixture(`initial-crash-${point}`);
    await crashLifecycleInstall(fixture.profile, fixture.source, point);
    const expectedVersion =
      point === "activation-after-commit" || point === "cleanup-after-tombstone-publish"
        ? "1.0.0"
        : undefined;
    expect(await recoveredVersion(fixture.profile)).toBe(expectedVersion);
    expect(await recoveredVersion(fixture.profile)).toBe(expectedVersion);
    expect(await transactionArtifacts(fixture.profile)).toEqual([]);
  }

  const reinstallPoints: ReadonlyArray<ExtensionLifecycleNodeCheckpoint> = [
    ...commonPoints,
    "activation-after-old-package-move",
  ];
  for (const point of reinstallPoints) {
    const fixture = await installedFixture(`reinstall-crash-${point}`);
    const mutableRoot = join(fixture.profile, ".runtime", "extensions", "fixture", "state");
    const mutableFile = join(mutableRoot, "owner.json");
    await mkdir(mutableRoot);
    await writeFile(mutableFile, "durable mutable state\n");
    const inode = (await stat(mutableFile)).ino;
    const manifestPath = join(fixture.source, "extension.json");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace('"version":"1.0.0"', '"version":"1.0.1"'),
    );
    await crashLifecycleInstall(fixture.profile, fixture.source, point);
    const expectedVersion =
      point === "activation-after-commit" || point === "cleanup-after-tombstone-publish"
        ? "1.0.1"
        : "1.0.0";
    expect(await recoveredVersion(fixture.profile)).toBe(expectedVersion);
    expect(await recoveredVersion(fixture.profile)).toBe(expectedVersion);
    expect(await readFile(mutableFile, "utf8")).toBe("durable mutable state\n");
    expect((await stat(mutableFile)).ino).toBe(inode);
    expect(await transactionArtifacts(fixture.profile)).toEqual([]);
  }
});

test("recovery deletes an atomically detached transaction cleanup tombstone", async () => {
  const fixture = await installedFixture("cleanup-tombstone");
  const tombstone = join(
    fixture.profile,
    ".runtime",
    "extensions",
    ".transactions",
    `.cleanup-${"a".repeat(32)}`,
  );
  await mkdir(tombstone, { recursive: true });
  await writeFile(join(tombstone, "commit.json"), "partially removed committed transaction\n");
  expect(await recoveredVersion(fixture.profile)).toBe("1.0.0");
  expect(await Bun.file(tombstone).exists()).toBeFalse();
});

async function installedFixture(name: string) {
  const fixture = await bareFixture(name);
  await runEffect(
    Effect.gen(function* () {
      const lifecycle = yield* ExtensionLifecycle;
      yield* lifecycle.install({ sourcePath: fixture.source, approvals: [] });
    }).pipe(Effect.provide(ExtensionLifecycle.layer({ profilePath: fixture.profile }))),
  );
  return fixture;
}

async function bareFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `ziggy-s4-lifecycle-fault-${name}-`));
  roots.push(root);
  const profile = join(root, "profile");
  const source = join(root, "source");
  await mkdir(profile);
  await mkdir(source);
  await writeSource(
    source,
    "extension.json",
    `${JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      version: "1.0.0",
      name: "Fixture",
      description: "Fault fixture.",
      ziggy: { requires: ">=0.0.0 <=9.0.0" },
      skills: [{ id: "fixture", path: "skills/fixture" }],
      adapters: [],
      requires: { env: [], commands: [], os: [] },
      permissions: { network: false, filesystem: "none", secrets: [] },
      distribution: { source: "fixture", license: "MIT" },
    })}\n`,
  );
  await writeSource(
    source,
    "skills/fixture/SKILL.md",
    "---\nname: fixture\ndescription: Fault fixture\n---\n\nFixture.\n",
  );
  return { root, profile, source };
}

async function authorityJson(profile: string) {
  const root = join(profile, ".runtime", "extensions", "fixture");
  return {
    stateJson: await readFile(join(root, "state.json"), "utf8"),
    provenanceJson: await readFile(join(root, "provenance.json"), "utf8"),
    approvalsJson: await readFile(join(root, "approvals.json"), "utf8"),
  };
}

function failingAt(target: ExtensionLifecycleNodeCheckpoint): ExtensionLifecycleNodeHooks {
  return {
    checkpoint: (point) =>
      point === target ? Promise.reject(new Error(`fault:${point}`)) : Promise.resolve(),
  };
}

function promiseBarrier() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
}

async function profileSnapshot(profile: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  for (const root of ["extensions", ".runtime/extensions"]) {
    const absoluteRoot = join(profile, root);
    if (!(await Bun.file(absoluteRoot).exists())) continue;
    for await (const path of new Bun.Glob("**/*").scan({ cwd: absoluteRoot, onlyFiles: true })) {
      snapshot[`${root}/${path}`] = Buffer.from(await readFile(join(absoluteRoot, path))).toString(
        "hex",
      );
    }
  }
  return snapshot;
}

async function quarantineEntries(profile: string): Promise<ReadonlyArray<string>> {
  const root = join(profile, ".runtime", "extensions");
  if (!(await Bun.file(root).exists())) return [];
  return Array.fromAsync(new Bun.Glob(".quarantine-*").scan({ cwd: root, onlyFiles: false }));
}

async function authorityTemporaryEntries(profile: string): Promise<ReadonlyArray<string>> {
  const root = join(profile, ".runtime", "extensions", "fixture");
  return (await readdir(root)).filter(
    (entry) => entry.includes(".tmp") || entry.includes(".restore"),
  );
}

async function crashLifecycleInstall(
  profilePath: string,
  sourcePath: string,
  checkpoint: ExtensionLifecycleNodeCheckpoint,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "fixtures", "extension-lifecycle-crash-child.ts"),
    ],
    {
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        ZIGGY_CRASH_PROFILE: profilePath,
        ZIGGY_CRASH_SOURCE: sourcePath,
        ZIGGY_CRASH_CHECKPOINT: checkpoint,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await Promise.race([
      readUntilReady(child.stdout),
      Bun.sleep(5_000).then(() => Promise.reject(new Error(`child missed ${checkpoint}`))),
    ]);
  } catch (cause) {
    child.kill(9);
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Crash child failed at ${checkpoint}: ${stderr}`, { cause });
  }
  child.kill(9);
  await child.exited;
}

async function readUntilReady(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  let output = "";
  while (!output.includes("READY\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Crash child exited before READY");
    output += new TextDecoder().decode(next.value);
  }
}

async function recoveredVersion(profilePath: string): Promise<string | undefined> {
  const observations = await runEffect(
    Effect.gen(function* () {
      const lifecycle = yield* ExtensionLifecycle;
      return yield* lifecycle.list();
    }).pipe(Effect.provide(ExtensionLifecycle.layer({ profilePath }))),
  );
  return observations[0]?.version;
}

async function transactionArtifacts(profilePath: string): Promise<ReadonlyArray<string>> {
  const authorityRoot = join(profilePath, ".runtime", "extensions");
  if (!(await Bun.file(authorityRoot).exists())) return [];
  const entries: string[] = [];
  for await (const path of new Bun.Glob(
    "{.transactions/**,.quarantine-*,**/*.tmp,**/*.restore}",
  ).scan({ cwd: authorityRoot, onlyFiles: false })) {
    entries.push(path);
  }
  return entries.sort();
}

async function writeSource(root: string, path: string, contents: string): Promise<void> {
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory !== "") await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, path), contents, { mode: 0o700 });
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
