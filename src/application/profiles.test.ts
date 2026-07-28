/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises the Node filesystem adapter */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- test cleanup requires finally around temporary directories */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Predicate, Result } from "effect";
import { expect, test } from "bun:test";
import { Profiles, ProfilesLive, type ProfileSkillError, type ProfilesShape } from "./profiles";

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

const useProfiles = <Value>(
  operation: (profiles: ProfilesShape) => Effect.Effect<Value, ProfileSkillError>,
): Promise<Value> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* operation(yield* Profiles);
    }).pipe(Effect.provide(ProfilesLive)),
  );

test("addSkill prefers an extension-owned skill and copies its supporting tree", async () => {
  const fixture = await makeFixture();
  try {
    await writeSkill(path.join(fixture.repositoryRoot, "skills", "github"), "top-level\n");
    await writeSkill(
      path.join(fixture.repositoryRoot, "extensions", "github", "skills", "github"),
      "extension-owned\n",
      { "scripts/review.ts": "export const review = true;\n" },
    );

    const installed = await useProfiles((profiles) =>
      profiles.addSkill(fixture.profile, fixture.repositoryRoot, "github", fixture.root, false),
    );

    const destination = path.join(fixture.profile.path, "skills", "github");
    expect(installed).toEqual({
      id: "github",
      sourcePath: path.join(fixture.repositoryRoot, "extensions", "github", "skills", "github"),
      destinationPath: destination,
      replaced: false,
    });
    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("extension-owned\n");
    expect(await readFile(path.join(destination, "scripts", "review.ts"), "utf8")).toBe(
      "export const review = true;\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("addSkill refuses an existing destination without force and force replaces its whole tree", async () => {
  const fixture = await makeFixture();
  try {
    const source = path.join(fixture.repositoryRoot, "skills", "weather");
    await writeSkill(source, "version one\n", { "scripts/weather.ts": "v1\n" });
    await useProfiles((profiles) =>
      profiles.addSkill(fixture.profile, fixture.repositoryRoot, "weather", fixture.root, false),
    );

    const destination = path.join(fixture.profile.path, "skills", "weather");
    await writeFile(path.join(destination, "stale.txt"), "must disappear\n");
    await writeSkill(source, "version two\n", { "scripts/weather.ts": "v2\n" });

    const refusal = await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        return yield* profiles.addSkill(
          fixture.profile,
          fixture.repositoryRoot,
          "weather",
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
      profiles.addSkill(fixture.profile, fixture.repositoryRoot, "weather", fixture.root, true),
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

test("listSkills sorts IDs and gives extension-owned collisions precedence", async () => {
  const fixture = await makeFixture();
  try {
    await writeSkill(path.join(fixture.repositoryRoot, "skills", "zebra"), "zebra\n");
    await writeSkill(path.join(fixture.repositoryRoot, "skills", "github"), "top-level\n");
    await writeSkill(
      path.join(fixture.repositoryRoot, "extensions", "github", "skills", "github"),
      "extension-owned\n",
    );
    await writeSkill(path.join(fixture.profile.path, "skills", "zebra"), "installed\n");
    await mkdir(path.join(fixture.profile.path, "skills", "incomplete"), { recursive: true });

    const listing = await useProfiles((profiles) =>
      profiles.listSkills(fixture.profile, fixture.repositoryRoot),
    );

    expect(listing.installed.map((skill) => skill.id)).toEqual(["zebra"]);
    expect(listing.available.map((skill) => skill.id)).toEqual(["github", "zebra"]);
    expect(listing.available.find((skill) => skill.id === "github")?.path).toBe(
      path.join(fixture.repositoryRoot, "extensions", "github", "skills", "github"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
