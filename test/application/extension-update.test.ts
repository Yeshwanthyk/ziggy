/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Fixtures own temporary filesystem setup. */
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { makeExtensionUpdate } from "ziggy/application/extension-update";
import {
  hasPendingExtensionUpdates,
  makeExtensionUpdateStore,
  recoverExtensionUpdates,
} from "ziggy/adapters/fs/extension-update";
import {
  ExtensionCatalogInstallFailed,
  ExtensionCatalogUnavailable,
} from "ziggy/domain/extension-catalog";
import { ProfileExtensionInvalid } from "ziggy/domain/profile";
import type {
  ProfileExtensionMutationLockApi,
  ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

const lock: ProfileExtensionMutationLockApi = { withLock: (_path, use) => use };

const counts = { extensionPathCount: 1, skillPathCount: 0, extensionFactoryCount: 1 };

const archive = {
  download: () =>
    Effect.fail(
      new ExtensionCatalogUnavailable({
        operation: "download",
        message: "Unexpected download",
        cause: undefined,
      }),
    ),
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-extension-update-"));
  temporaryRoots.push(root);
  const profile = join(root, "profile");
  const source = join(root, "source");
  await mkdir(join(profile, "extensions", "weather"), { recursive: true });
  await mkdir(source);
  await writeFile(join(profile, "SOUL.md"), "Human-owned soul\n");

  const manifest = JSON.stringify({
    name: "weather",
    version: "1.0.0",
    description: "Fixture",
    pi: { extensions: ["./index.ts"] },
  });

  await writeFile(join(profile, "extensions", "weather", "package.json"), manifest);
  await writeFile(join(profile, "extensions", "weather", "index.ts"), "old bytes\n");
  await writeFile(join(source, "package.json"), manifest);
  await writeFile(join(source, "index.ts"), "new bytes\n");
  let failValidation = false;
  let stagedChecks = 0;

  const profiles: Pick<ProfileExtensionsApi, "validate"> = {
    validate: () =>
      failValidation
        ? Effect.fail(
            new ProfileExtensionInvalid({
              path: profile,
              message: "fixture preflight failure",
              cause: undefined,
            }),
          )
        : Effect.succeed({ selected: ["weather"], preflight: counts }),
  };

  const service = makeExtensionUpdate(archive, profiles, lock, {
    stage: (stagingProfile, entry) =>
      Effect.tryPromise({
        try: async () => {
          const destination = join(stagingProfile, "extensions", entry.id);
          await cp(source, destination, { recursive: true });

          return destination;
        },
        catch: (cause) =>
          new ExtensionCatalogInstallFailed({
            id: entry.id,
            path: stagingProfile,
            reason: "filesystem",
            message: "fixture copy",
            cause,
          }),
      }),
    preflight: {
      preflight: (_path, _repositoryRoot, selected) =>
        Effect.sync(() => {
          expect(selected).toEqual(["weather"]);
          stagedChecks += 1;

          return counts;
        }),
    },
  });

  return {
    profile,
    source,
    target: { name: "profile", path: profile },
    service,
    failValidation: () => {
      failValidation = true;
    },
    stagedChecks: () => stagedChecks,
  };
};

describe("bundled extension update", () => {
  test("requires explicit adoption, keeps backup, detects same-version content, rejects managed edits", async () => {
    const f = await fixture();
    await expect(Effect.runPromise(f.service.update(f.target, "weather"))).rejects.toMatchObject({
      reason: "unmanaged",
    });
    const updated = await Effect.runPromise(f.service.update(f.target, "weather", { adopt: true }));
    expect(updated.status).toBe("updated");
    expect(updated.adoptedUnknownOrigin).toBe(true);
    expect(updated.backupPath).toBeDefined();
    expect(await readFile(join(updated.backupPath ?? "", "index.ts"), "utf8")).toBe("old bytes\n");
    expect((await Effect.runPromise(f.service.update(f.target, "weather"))).status).toBe("current");
    await writeFile(join(f.source, "index.ts"), "third bytes, same version\n");
    const next = await Effect.runPromise(f.service.update(f.target, "weather"));
    expect(next.status).toBe("updated");
    expect(next.contentHash).not.toBe(updated.contentHash);
    await writeFile(join(f.profile, "extensions", "weather", "index.ts"), "human edit\n");
    await expect(
      Effect.runPromise(f.service.update(f.target, "weather", { adopt: true })),
    ).rejects.toMatchObject({ reason: "modified" });
    expect(await readFile(join(f.profile, "SOUL.md"), "utf8")).toBe("Human-owned soul\n");
    expect(f.stagedChecks()).toBe(3);
  });

  test("post-swap validation failure restores old files and retains the managed baseline", async () => {
    const f = await fixture();

    const baseline = await Effect.runPromise(
      f.service.update(f.target, "weather", { adopt: true }),
    );

    await writeFile(join(f.source, "index.ts"), "bad candidate\n");
    f.failValidation();
    await expect(Effect.runPromise(f.service.update(f.target, "weather"))).rejects.toMatchObject({
      _tag: "ProfileExtensionInvalid",
    });
    expect(await readFile(join(f.profile, "extensions", "weather", "index.ts"), "utf8")).toBe(
      "new bytes\n",
    );
    expect(await Effect.runPromise(hasPendingExtensionUpdates(f.profile))).toBe(false);

    const receipt = await Effect.runPromise(
      makeExtensionUpdateStore(f.profile, "weather").prepare(),
    );

    expect(receipt.receipt?.contentHash).toBe(baseline.contentHash);
  });

  test("blocks changes to automation definitions before replacing files", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "job.md"), "new automation\n");
    await writeFile(
      join(f.source, "package.json"),
      JSON.stringify({
        name: "weather",
        description: "Fixture",
        pi: { extensions: ["./index.ts"] },
        ziggy: { automations: [{ id: "job", path: "./job.md" }] },
      }),
    );
    await expect(
      Effect.runPromise(f.service.update(f.target, "weather", { adopt: true })),
    ).rejects.toMatchObject({ reason: "automation" });
    expect(await readFile(join(f.profile, "extensions", "weather", "index.ts"), "utf8")).toBe(
      "old bytes\n",
    );
  });

  test("recovers an interrupted prepared swap and completes a committed receipt", async () => {
    const f = await fixture();
    const store = makeExtensionUpdateStore(f.profile, "weather");
    const tx = await Effect.runPromise(store.prepare());
    const installed = join(f.profile, "extensions", "weather");
    const oldHash = await Effect.runPromise(store.hash(installed));
    await rename(installed, tx.backupPath);
    await cp(f.source, installed, { recursive: true });
    const newHash = await Effect.runPromise(store.hash(installed));
    const journal = join(f.profile, ".runtime", "extension-updates", "weather", "journal.json");

    const receipt = {
      version: 1,
      id: "weather",
      source: "bundled",
      packageVersion: "1.0.0",
      contentHash: newHash,
    };

    await writeFile(
      journal,
      JSON.stringify({
        version: 1,
        id: "weather",
        transactionId: tx.transactionId,
        phase: "prepared",
        oldHash,
        receipt,
      }),
    );
    expect(await Effect.runPromise(hasPendingExtensionUpdates(f.profile))).toBe(true);
    await Effect.runPromise(recoverExtensionUpdates(f.profile));
    expect(await readFile(join(installed, "index.ts"), "utf8")).toBe("old bytes\n");
    await rename(installed, tx.backupPath);
    await cp(f.source, installed, { recursive: true });
    await writeFile(
      journal,
      JSON.stringify({
        version: 1,
        id: "weather",
        transactionId: tx.transactionId,
        phase: "committed",
        oldHash,
        receipt,
      }),
    );
    await Effect.runPromise(recoverExtensionUpdates(f.profile));
    expect(await Effect.runPromise(hasPendingExtensionUpdates(f.profile))).toBe(false);
    const restored = await Effect.runPromise(store.prepare());
    expect(restored.receipt?.contentHash).toBe(newHash);
  });
});
