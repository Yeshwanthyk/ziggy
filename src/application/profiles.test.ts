/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises the Node filesystem adapter */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- test cleanup requires finally around temporary directories */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Predicate, Result } from "effect";
import { expect, test } from "bun:test";
import { bundledFilePath } from "../generated/builtin-files";
import { Profiles, ProfilesLive, type ProfilesApi } from "./profiles";

const makeFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ziggy-profiles-test-"));
  const profilePath = path.join(root, "profile");
  const repositoryRoot = path.join(root, "repository");
  await mkdir(profilePath, { recursive: true });
  await writeFile(path.join(profilePath, "SOUL.md"), "# Profile\n");

  return {
    root,
    profile: { path: profilePath, name: "Profile" },
    repositoryRoot,
  };
};

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

const writeSkill = async (skillPath: string, body: string, assets: Record<string, string> = {}) => {
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), body);
  await Promise.all(
    Object.entries(assets).map(async ([relativePath, content]) => {
      const assetPath = path.join(skillPath, relativePath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, content);
    }),
  );
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("addSkill copies a bundled skill tree without scanning a checkout", async () => {
  const fixture = await makeFixture();
  try {
    const installed = await useProfiles((profiles) =>
      profiles.addSkill(fixture.profile, "/does-not-exist", "here-now", fixture.root, false),
    );

    const destination = path.join(fixture.profile.path, "skills", "here-now");
    expect(installed).toEqual({
      id: "here-now",
      sourcePath: "extensions/here-now/skills/here-now/SKILL.md",
      destinationPath: destination,
      replaced: false,
    });
    const skillMd = bundledFilePath("extensions/here-now/skills/here-now/SKILL.md") ?? "";
    const driveSh = bundledFilePath("extensions/here-now/skills/here-now/scripts/drive.sh") ?? "";
    expect(skillMd.length).toBeGreaterThan(0);
    expect(driveSh.length).toBeGreaterThan(0);
    expect(await readFile(path.join(destination, "SKILL.md"))).toEqual(await readFile(skillMd));
    expect(await readFile(path.join(destination, "scripts", "drive.sh"))).toEqual(
      await readFile(driveSh),
    );
    expect((await stat(path.join(destination, "scripts", "drive.sh"))).mode & 0o777).toBe(
      (await stat(driveSh)).mode & 0o777,
    );

    const curator = await useProfiles((profiles) =>
      profiles.addSkill(fixture.profile, "/does-not-exist", "curator", fixture.root, false),
    );
    const curatorDestination = path.join(fixture.profile.path, "skills", "curator");
    const curatorEmbed =
      bundledFilePath("extensions/self-improvement/skills/curator/SKILL.md") ?? "";
    expect(curatorEmbed.length).toBeGreaterThan(0);
    expect(curator).toEqual({
      id: "curator",
      sourcePath: "extensions/self-improvement/skills/curator/SKILL.md",
      destinationPath: curatorDestination,
      replaced: false,
    });
    expect(await readFile(path.join(curatorDestination, "SKILL.md"))).toEqual(
      await readFile(curatorEmbed),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("addSkill refuses an existing destination without force and force replaces its whole tree", async () => {
  const fixture = await makeFixture();
  try {
    const source = path.join(fixture.root, "weather");
    await writeSkill(source, "version one\n", { "scripts/weather.ts": "v1\n" });
    await useProfiles((profiles) =>
      profiles.addSkill(fixture.profile, "/does-not-exist", source, fixture.root, false),
    );

    const destination = path.join(fixture.profile.path, "skills", "weather");
    await writeFile(path.join(destination, "stale.txt"), "must disappear\n");
    await writeSkill(source, "version two\n", { "scripts/weather.ts": "v2\n" });

    const refusal = await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        return yield* profiles.addSkill(
          fixture.profile,
          "/does-not-exist",
          source,
          fixture.root,
          false,
        );
      }).pipe(Effect.provide(ProfilesLive), Effect.result),
    );
    expect(
      Result.match(refusal, {
        onFailure: Predicate.isTagged("ProfileSkillExists"),
        onSuccess: () => false,
      }),
    ).toBe(true);
    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("version one\n");
    expect(await readFile(path.join(destination, "stale.txt"), "utf8")).toBe("must disappear\n");

    const replaced = await useProfiles((profiles) =>
      profiles.addSkill(fixture.profile, "/does-not-exist", source, fixture.root, true),
    );
    expect(replaced).toEqual({
      id: "weather",
      sourcePath: source,
      destinationPath: destination,
      replaced: true,
    });
    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("version two\n");
    expect(await readFile(path.join(destination, "scripts", "weather.ts"), "utf8")).toBe("v2\n");
    await expect(readFile(path.join(destination, "stale.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("extension selection writes canonically and preserves bytes on no-op or invalid input", async () => {
  const fixture = await makeFixture();
  try {
    const profilePackage = path.join(fixture.profile.path, "extensions", "gamma");
    await writeSkill(
      path.join(profilePackage, "skills", "gamma"),
      "---\nname: gamma\ndescription: Profile-owned gamma.\n---\n",
    );
    await writeFile(
      path.join(profilePackage, "package.json"),
      JSON.stringify({
        name: "@ziggy/gamma",
        description: "Profile-owned gamma",
        pi: { skills: ["./skills"] },
      }),
    );

    const selectionPath = path.join(fixture.profile.path, "extensions.json");
    expect(
      (
        await useProfiles((profiles) =>
          profiles.addExtension(fixture.profile, fixture.repositoryRoot, "weather"),
        )
      ).changed,
    ).toBe(true);
    await useProfiles((profiles) =>
      profiles.addExtension(fixture.profile, fixture.repositoryRoot, "github"),
    );
    const canonical = '{\n  "extensions": [\n    "github",\n    "weather"\n  ]\n}\n';
    expect(await readFile(selectionPath, "utf8")).toBe(canonical);
    expect(
      (
        await useProfiles((profiles) =>
          profiles.addExtension(fixture.profile, fixture.repositoryRoot, "github"),
        )
      ).changed,
    ).toBe(false);
    expect(await readFile(selectionPath, "utf8")).toBe(canonical);
    await useProfiles((profiles) =>
      profiles.removeExtension(fixture.profile, fixture.repositoryRoot, "weather"),
    );
    await useProfiles((profiles) =>
      profiles.removeExtension(fixture.profile, fixture.repositoryRoot, "github"),
    );
    expect(await readFile(selectionPath, "utf8")).toBe('{\n  "extensions": []\n}\n');
    await useProfiles((profiles) =>
      profiles.addExtension(fixture.profile, fixture.repositoryRoot, "gamma"),
    );
    expect(await readFile(selectionPath, "utf8")).toBe(
      '{\n  "extensions": [\n    "gamma"\n  ]\n}\n',
    );
    await useProfiles((profiles) =>
      profiles.removeExtension(fixture.profile, fixture.repositoryRoot, "gamma"),
    );

    await writeFile(selectionPath, '{"extensions":["retired-package"]}\n');
    expect(
      await useProfiles((profiles) =>
        profiles.removeExtension(fixture.profile, fixture.repositoryRoot, "retired-package"),
      ),
    ).toEqual({
      id: "retired-package",
      profilePath: fixture.profile.path,
      changed: true,
      selected: false,
    });
    expect(await readFile(selectionPath, "utf8")).toBe('{\n  "extensions": []\n}\n');

    await writeFile(selectionPath, '{"extensions":["weather","weather"]}\n');
    const invalidBytes = await readFile(selectionPath, "utf8");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        return yield* profiles.addExtension(fixture.profile, fixture.repositoryRoot, "github");
      }).pipe(Effect.provide(ProfilesLive), Effect.result),
    );
    expect(
      Result.match(result, {
        onFailure: Predicate.isTagged("ProfileExtensionInvalid"),
        onSuccess: () => false,
      }),
    ).toBe(true);
    expect(await readFile(selectionPath, "utf8")).toBe(invalidBytes);
    expect((await readdir(fixture.profile.path)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("listSkills reads bundled metadata and ignores a checkout folder", async () => {
  const fixture = await makeFixture();
  try {
    await writeSkill(path.join(fixture.repositoryRoot, "skills", "zebra"), "zebra\n");
    await writeSkill(path.join(fixture.profile.path, "skills", "zebra"), "installed\n");
    await mkdir(path.join(fixture.profile.path, "skills", "incomplete"), { recursive: true });

    const listing = await useProfiles((profiles) =>
      profiles.listSkills(fixture.profile, "/does-not-exist"),
    );

    expect(listing.installed.map((skill) => skill.id)).toEqual(["zebra"]);
    expect(listing.available.map((skill) => skill.id)).toContain("github");
    expect(listing.available.map((skill) => skill.id)).toContain("curator");
    expect(listing.available.map((skill) => skill.id)).toContain("ziggy-operations");
    expect(listing.available.map((skill) => skill.id)).not.toContain("zebra");
    expect(listing.available.find((skill) => skill.id === "github")?.path).toBe(
      "extensions/github/skills/github/SKILL.md",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("addSkill refuses to copy a skill that is already built into Ziggy", async () => {
  const fixture = await makeFixture();
  try {
    const refusal = await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        return yield* profiles.addSkill(
          fixture.profile,
          "/does-not-exist",
          "ziggy-operations",
          fixture.root,
          false,
        );
      }).pipe(Effect.provide(ProfilesLive), Effect.result),
    );
    expect(
      Result.match(refusal, {
        onFailure: (error) =>
          Predicate.isTagged("ProfileSkillInvalid")(error) &&
          error.message.includes("built into Ziggy"),
        onSuccess: () => false,
      }),
    ).toBe(true);
    await expect(
      readFile(path.join(fixture.profile.path, "skills", "ziggy-operations", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
