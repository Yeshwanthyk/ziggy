/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute filesystem Effects */
import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Predicate, Result } from "effect";
import {
  restoreExtensionSelection,
  snapshotExtensionSelection,
} from "ziggy/adapters/fs/profile-extensions";

const roots: string[] = [];

const makeProfile = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-profile-selection-"));
  roots.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath);
  await writeFile(join(profilePath, "SOUL.md"), "# Human-owned profile\n");
  return profilePath;
};

const selectionPath = (profilePath: string): string => join(profilePath, "extensions.json");

const temporaryNames = async (profilePath: string): Promise<ReadonlyArray<string>> =>
  (await readdir(profilePath)).filter((entry) => entry.endsWith(".tmp"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("decodes once and restores compact noncanonical selection bytes exactly", async () => {
  const profilePath = await makeProfile();
  const original = Buffer.from('{ "extensions" : [ "zeta", "alpha" ] }\r\n');
  await writeFile(selectionPath(profilePath), original);

  const snapshot = await Effect.runPromise(snapshotExtensionSelection(profilePath));
  expect(snapshot.exists).toBe(true);
  expect(snapshot.selected).toEqual(["alpha", "zeta"]);
  expect(Buffer.from(snapshot.bytes)).toEqual(original);

  await writeFile(selectionPath(profilePath), '{"extensions":["changed"]}\n');
  await Effect.runPromise(restoreExtensionSelection(profilePath, snapshot));

  expect(Buffer.from(await readFile(selectionPath(profilePath)))).toEqual(original);
  expect(await temporaryNames(profilePath)).toEqual([]);
});

test("restores an originally absent selection by atomically returning to absence", async () => {
  const profilePath = await makeProfile();
  const soulPath = join(profilePath, "SOUL.md");
  const soulBytes = await readFile(soulPath);

  const snapshot = await Effect.runPromise(snapshotExtensionSelection(profilePath));
  expect(snapshot).toMatchObject({ exists: false, selected: [] });
  expect(snapshot.bytes).toHaveLength(0);

  await writeFile(selectionPath(profilePath), '{"extensions":["temporary"]}\n');
  await Effect.runPromise(restoreExtensionSelection(profilePath, snapshot));

  await expect(lstat(selectionPath(profilePath))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(soulPath)).toEqual(soulBytes);
  expect(await temporaryNames(profilePath)).toEqual([]);
});

test("fails closed on malformed selection input without creating rollback files", async () => {
  const profilePath = await makeProfile();
  const bytes = Buffer.from('{"extensions":["alpha",]}');
  await writeFile(selectionPath(profilePath), bytes);

  const result = await Effect.runPromise(
    snapshotExtensionSelection(profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(result, {
      onFailure: (failure) =>
        Predicate.isTagged(failure, "ProfileExtensionInvalid") &&
        failure.path === selectionPath(profilePath) &&
        failure.cause !== undefined,
      onSuccess: () => false,
    }),
  ).toBe(true);
  expect(Buffer.from(await readFile(selectionPath(profilePath)))).toEqual(bytes);
  expect(await temporaryNames(profilePath)).toEqual([]);
});

test("rejects symlinked and wrong-type selections without touching external files", async () => {
  const profilePath = await makeProfile();
  const path = selectionPath(profilePath);
  const externalPath = join(profilePath, "outside.json");
  const externalBytes = Buffer.from('{"extensions":["outside"]}\n');
  await writeFile(externalPath, externalBytes);
  await writeFile(path, '{"extensions":["alpha"]}\n');
  const snapshot = await Effect.runPromise(snapshotExtensionSelection(profilePath));

  await rm(path);
  await symlink(externalPath, path, "file");

  const symlinkSnapshot = await Effect.runPromise(
    snapshotExtensionSelection(profilePath).pipe(Effect.result),
  );
  const symlinkRestore = await Effect.runPromise(
    restoreExtensionSelection(profilePath, snapshot).pipe(Effect.result),
  );
  expect(
    Result.match(symlinkSnapshot, {
      onFailure: (failure) => Predicate.isTagged(failure, "ProfileExtensionInvalid"),
      onSuccess: () => false,
    }),
  ).toBe(true);
  expect(
    Result.match(symlinkRestore, {
      onFailure: (failure) => Predicate.isTagged(failure, "ProfileExtensionInvalid"),
      onSuccess: () => false,
    }),
  ).toBe(true);
  expect(Buffer.from(await readFile(externalPath))).toEqual(externalBytes);
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await temporaryNames(profilePath)).toEqual([]);

  await rm(path);
  await mkdir(path);
  const wrongType = await Effect.runPromise(
    snapshotExtensionSelection(profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(wrongType, {
      onFailure: (failure) => Predicate.isTagged(failure, "ProfileExtensionInvalid"),
      onSuccess: () => false,
    }),
  ).toBe(true);
  expect(
    Result.match(
      await Effect.runPromise(restoreExtensionSelection(profilePath, snapshot).pipe(Effect.result)),
      {
        onFailure: (failure) => Predicate.isTagged(failure, "ProfileExtensionInvalid"),
        onSuccess: () => false,
      },
    ),
  ).toBe(true);
  expect(await temporaryNames(profilePath)).toEqual([]);
});
