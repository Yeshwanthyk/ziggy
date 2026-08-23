/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises the Node filesystem adapter */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- test cleanup requires finally around temporary directories */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { Profiles, ProfilesLive, type ProfilesApi } from "ziggy/application/profiles";

const snapshotTree = async (root: string): Promise<ReadonlyArray<string>> => {
  const snapshot: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot.push(`${relative}/`);
        await visit(absolute);
      } else {
        snapshot.push(`${relative}:${Buffer.from(await readFile(absolute)).toString("base64")}`);
      }
    }
  };
  await visit(root);
  return snapshot;
};

const useProfiles = <Value, Error>(
  operation: (profiles: ProfilesApi) => Effect.Effect<Value, Error>,
): Promise<Value> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* operation(yield* Profiles);
    }).pipe(Effect.provide(ProfilesLive)),
  );

test("init creates safe starter folders idempotently without changing human-owned bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ziggy-init-test-"));
  const profilePath = path.join(root, "profile");
  const target = { path: profilePath, name: "Profile" };
  try {
    const first = await useProfiles((profiles) =>
      profiles.initProfile(target, { createStarterDirectories: true }),
    );
    const soul = await readFile(path.join(profilePath, "SOUL.md"));
    await writeFile(path.join(profilePath, "agents", "human.md"), "human agent bytes\n");
    await writeFile(path.join(profilePath, "automations", "human.md"), "human automation bytes\n");
    const beforeSecond = await snapshotTree(profilePath);

    const second = await useProfiles((profiles) =>
      profiles.initProfile(target, { createStarterDirectories: true }),
    );

    expect(first).toEqual({
      path: profilePath,
      created: true,
      createdDirectories: ["agents", "automations"],
    });
    expect(second).toEqual({ path: profilePath, created: false, createdDirectories: [] });
    expect(await snapshotTree(profilePath)).toEqual(beforeSecond);
    expect(await readFile(path.join(profilePath, "SOUL.md"))).toEqual(soul);
    expect(await readFile(path.join(profilePath, "agents", "human.md"), "utf8")).toBe(
      "human agent bytes\n",
    );
    expect(await readFile(path.join(profilePath, "automations", "human.md"), "utf8")).toBe(
      "human automation bytes\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("minimal init creates only SOUL.md and rejects non-regular or symlinked SOUL.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ziggy-minimal-init-test-"));
  try {
    const minimalPath = path.join(root, "minimal");
    await useProfiles((profiles) => profiles.initProfile({ path: minimalPath, name: "Minimal" }));
    expect(await readdir(minimalPath)).toEqual(["SOUL.md"]);

    const directorySoul = path.join(root, "directory-soul");
    await mkdir(path.join(directorySoul, "SOUL.md"), { recursive: true });
    await expect(
      useProfiles((profiles) =>
        profiles.initProfile(
          { path: directorySoul, name: "Directory" },
          { createStarterDirectories: true },
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ProfileTargetNotDirectory" });
    expect(await readdir(directorySoul)).toEqual(["SOUL.md"]);

    const symlinkSoul = path.join(root, "symlink-soul");
    await mkdir(symlinkSoul);
    await writeFile(path.join(root, "human-soul.md"), "do not touch\n");
    await symlink(path.join(root, "human-soul.md"), path.join(symlinkSoul, "SOUL.md"));
    await expect(
      useProfiles((profiles) =>
        profiles.initProfile(
          { path: symlinkSoul, name: "Symlink" },
          { createStarterDirectories: true },
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ProfileTargetNotDirectory" });
    expect(await readFile(path.join(root, "human-soul.md"), "utf8")).toBe("do not touch\n");
    expect(await readdir(symlinkSoul)).toEqual(["SOUL.md"]);

    const physicalProfile = path.join(root, "physical-profile");
    const linkedProfile = path.join(root, "linked-profile");
    await mkdir(physicalProfile);
    await symlink(physicalProfile, linkedProfile);
    await expect(
      useProfiles((profiles) => profiles.initProfile({ path: linkedProfile, name: "Linked" })),
    ).rejects.toMatchObject({ _tag: "ProfileTargetNotDirectory", path: linkedProfile });
    expect(await readdir(physicalProfile)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing admits only physical Profiles with a regular SOUL.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ziggy-profile-list-test-"));
  const profilesDirectory = path.join(root, "profiles");
  const registryPath = path.join(root, "profiles.list");
  try {
    await mkdir(profilesDirectory);
    const validProfile = path.join(root, "valid");
    const directorySoul = path.join(root, "directory-soul");
    const symlinkSoul = path.join(root, "symlink-soul");
    const physicalProfile = path.join(root, "physical-profile");
    const linkedProfile = path.join(root, "linked-profile");
    await mkdir(validProfile);
    await writeFile(path.join(validProfile, "SOUL.md"), "# Valid\n");
    await mkdir(path.join(directorySoul, "SOUL.md"), { recursive: true });
    await mkdir(symlinkSoul);
    await writeFile(path.join(root, "external-soul.md"), "# External\n");
    await symlink(path.join(root, "external-soul.md"), path.join(symlinkSoul, "SOUL.md"));
    await mkdir(physicalProfile);
    await writeFile(path.join(physicalProfile, "SOUL.md"), "# Physical\n");
    await symlink(physicalProfile, linkedProfile);
    await writeFile(
      registryPath,
      `${directorySoul}\n${linkedProfile}\n${symlinkSoul}\n${validProfile}\n`,
    );

    const listings = await useProfiles((profiles) =>
      profiles.listProfiles(profilesDirectory, registryPath),
    );

    expect(listings).toEqual([{ name: "valid", path: validProfile }]);
    expect(await readFile(registryPath, "utf8")).toBe(`${validProfile}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-minimal init scaffolds private memory files and preserves them on rerun", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ziggy-memory-scaffold-test-"));
  const profilePath = path.join(root, "profile");
  const target = { path: profilePath, name: "Profile" };
  try {
    await useProfiles((profiles) =>
      profiles.initProfile(target, { createStarterDirectories: true }),
    );
    const sharedMemoryPath = path.join(profilePath, "MEMORY.md");
    const memoryReadmePath = path.join(profilePath, "memory", "README.md");
    const paths = [sharedMemoryPath, memoryReadmePath];
    expect(await readFile(sharedMemoryPath, "utf8")).toBe("");
    expect(await readFile(memoryReadmePath, "utf8")).toContain("docs/operations/memory.md");
    for (const directory of [
      path.join(profilePath, "memory"),
      path.join(profilePath, "memory", "users"),
      path.join(profilePath, "memory", "groups"),
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of paths) expect((await stat(file)).mode & 0o777).toBe(0o600);

    await writeFile(sharedMemoryPath, "human memory\n");
    await writeFile(memoryReadmePath, "human README\n");
    const before = await snapshotTree(profilePath);
    const rerun = await useProfiles((profiles) =>
      profiles.initProfile(target, { createStarterDirectories: true }),
    );
    expect(rerun).toEqual({ path: profilePath, created: false, createdDirectories: [] });
    expect(await snapshotTree(profilePath)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
