import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { discoverSkillRoots } from "./skill-roots";

const temporaryPaths: Array<string> = [];

const writeSkill = async (
  directoryPath: string,
  name: string,
  description: string,
): Promise<void> => {
  await mkdir(directoryPath, { recursive: true });
  await writeFile(
    join(directoryPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

test("Pi loads Profile skills before every Merlin skill root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-skill-roots-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const merlinRoot = join(root, "merlin");
  const extensionSkills = join(merlinRoot, "extensions", "alpha", "skills");
  const topLevelSkills = join(merlinRoot, "skills");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writeSkill(join(profilePath, "skills", "shared-profile"), "shared", "profile winner");
  await writeSkill(join(extensionSkills, "shared-extension"), "shared", "extension loser");
  await writeSkill(join(extensionSkills, "extension-only"), "extension-only", "extension only");
  await writeSkill(join(topLevelSkills, "shared-top-level"), "shared", "top-level loser");
  await writeSkill(join(topLevelSkills, "top-level-only"), "top-level-only", "top level only");

  const skillRoots = await discoverSkillRoots(profilePath, merlinRoot);
  expect(skillRoots).toEqual([join(profilePath, "skills"), extensionSkills, topLevelSkills]);

  const services = await createAgentSessionServices({
    cwd: profilePath,
    agentDir: profilePath,
    resourceLoaderOptions: {
      systemPrompt: join(profilePath, "SOUL.md"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: [...skillRoots],
    },
  });
  const loaded = services.resourceLoader.getSkills();
  const byName = new Map(loaded.skills.map((skill) => [skill.name, skill]));

  expect([...byName.keys()].sort()).toEqual(["extension-only", "shared", "top-level-only"]);
  expect(byName.get("shared")?.filePath).toBe(
    join(profilePath, "skills", "shared-profile", "SKILL.md"),
  );
  expect(loaded.diagnostics.filter((diagnostic) => diagnostic.type === "collision")).toHaveLength(
    2,
  );
});

test("Merlin extension skills win top-level collisions when the Profile has no override", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-skill-roots-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const merlinRoot = join(root, "merlin");
  const extensionSkill = join(merlinRoot, "extensions", "alpha", "skills", "shared-extension");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writeSkill(extensionSkill, "shared", "extension winner");
  await writeSkill(join(merlinRoot, "skills", "shared-top-level"), "shared", "top-level loser");

  const skillRoots = await discoverSkillRoots(profilePath, merlinRoot);
  const services = await createAgentSessionServices({
    cwd: profilePath,
    agentDir: profilePath,
    resourceLoaderOptions: {
      systemPrompt: join(profilePath, "SOUL.md"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: [...skillRoots],
    },
  });
  const shared = services.resourceLoader
    .getSkills()
    .skills.find((skill) => skill.name === "shared");

  expect(shared?.filePath).toBe(join(extensionSkill, "SKILL.md"));
});
