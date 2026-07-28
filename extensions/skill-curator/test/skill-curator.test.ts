/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the Pi filesystem boundary. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProfileSkills, readProfileSkill, writeProfileSkill } from "../index.ts";

const temporaryDirectories: string[] = [];

const skillBody = (name: string, description = `${name} description`): string => `---
name: ${name}
description: ${description}
---

# ${name}

Use this skill.
`;

const makeProfile = async (): Promise<string> => {
  const profilePath = await mkdtemp(join(tmpdir(), "skill-curator-profile-"));
  temporaryDirectories.push(profilePath);
  return profilePath;
};

const seedSkill = async (profilePath: string, name: string, body: string): Promise<void> => {
  const directory = join(profilePath, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Profile skill curation", () => {
  test("lists valid Profile skills in name order and reads one complete body", async () => {
    const profilePath = await makeProfile();
    await seedSkill(profilePath, "zebra-skill", skillBody("zebra-skill", "Last skill."));
    await seedSkill(profilePath, "alpha-skill", skillBody("alpha-skill", "First skill."));
    await seedSkill(profilePath, "invalid-skill", skillBody("different-name"));
    await seedSkill(profilePath, "blank-description", skillBody("blank-description", "   "));
    await seedSkill(profilePath, "oversized-skill", "x".repeat(64 * 1024 + 1));

    expect(await listProfileSkills(profilePath)).toEqual([
      { name: "alpha-skill", description: "First skill." },
      { name: "zebra-skill", description: "Last skill." },
    ]);
    expect(await readProfileSkill(profilePath, "alpha-skill")).toEqual({
      skill: { name: "alpha-skill", description: "First skill." },
      body: skillBody("alpha-skill", "First skill."),
    });
  });

  test("creates one complete Profile SKILL.md", async () => {
    const profilePath = await makeProfile();
    const body = skillBody("new-skill");

    expect(await writeProfileSkill(profilePath, "new-skill", body)).toEqual({
      name: "new-skill",
      action: "created",
    });
    expect(await readFile(join(profilePath, "skills/new-skill/SKILL.md"), "utf8")).toBe(body);
  });

  test("refuses to overwrite an existing Profile skill by default", async () => {
    const profilePath = await makeProfile();
    const original = skillBody("existing-skill", "Original.");
    await seedSkill(profilePath, "existing-skill", original);

    expect(
      writeProfileSkill(profilePath, "existing-skill", skillBody("existing-skill", "Replacement.")),
    ).rejects.toThrow(
      'Profile skill "existing-skill" already exists; set replace:true to replace it',
    );
    expect(await readFile(join(profilePath, "skills/existing-skill/SKILL.md"), "utf8")).toBe(
      original,
    );
  });

  test("permits exactly one concurrent create without clobbering it", async () => {
    const profilePath = await makeProfile();
    const bodies = Array.from({ length: 16 }, (_, index) =>
      skillBody("contended-skill", `Contender ${index}.`),
    );

    const results = await Promise.allSettled(
      bodies.map((body) => writeProfileSkill(profilePath, "contended-skill", body)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(15);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason)),
    ).toEqual(
      Array.from(
        { length: 15 },
        () =>
          'Error: Profile skill "contended-skill" already exists; set replace:true to replace it',
      ),
    );
    expect(bodies).toContain(
      await readFile(join(profilePath, "skills/contended-skill/SKILL.md"), "utf8"),
    );
  });

  test("replaces an existing Profile skill only when explicitly requested", async () => {
    const profilePath = await makeProfile();
    await seedSkill(profilePath, "existing-skill", skillBody("existing-skill", "Original."));
    const replacement = skillBody("existing-skill", "Replacement.");

    expect(await writeProfileSkill(profilePath, "existing-skill", replacement, true)).toEqual({
      name: "existing-skill",
      action: "replaced",
    });
    expect(await readFile(join(profilePath, "skills/existing-skill/SKILL.md"), "utf8")).toBe(
      replacement,
    );
  });

  test("rejects invalid or mismatched Agent Skill frontmatter", async () => {
    const profilePath = await makeProfile();
    const attempts = [
      { name: "missing-description", body: "---\nname: missing-description\n---\nBody" },
      { name: "blank-description", body: skillBody("blank-description", "   ") },
      { name: "expected-name", body: skillBody("different-name") },
    ];

    const results = await Promise.allSettled(
      attempts.map(({ name, body }) => writeProfileSkill(profilePath, name, body)),
    );

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(await listProfileSkills(profilePath)).toEqual([]);
  });
});
