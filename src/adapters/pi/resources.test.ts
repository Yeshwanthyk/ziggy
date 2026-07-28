import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { discoverPiResources } from "./resources";

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

test("discovers repository Pi extensions and skills in Profile-first order", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-resources-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const alphaPackage = join(repositoryRoot, "extensions", "alpha");
  const betaPackage = join(repositoryRoot, "extensions", "beta");

  await writeSkill(join(profilePath, "skills", "profile"), "profile", "profile skill");
  await writeSkill(join(alphaPackage, "skills", "alpha"), "alpha", "alpha skill");
  await writeSkill(join(betaPackage, "skills", "beta"), "beta", "beta skill");
  await writeSkill(join(repositoryRoot, "skills", "top"), "top", "top-level skill");
  await writeFile(join(betaPackage, "index.ts"), "export default function () {}\n", "utf8");

  const resources = await discoverPiResources(profilePath, repositoryRoot);

  expect(resources).toEqual({
    extensionPaths: [join(betaPackage, "index.ts")],
    skillPaths: [
      join(profilePath, "skills"),
      join(alphaPackage, "skills"),
      join(betaPackage, "skills"),
      join(repositoryRoot, "skills"),
    ],
  });
});

test("Pi keeps Profile skill precedence while loading package extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-resources-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const extensionPackage = join(repositoryRoot, "extensions", "alpha");
  const topLevelSkills = join(repositoryRoot, "skills");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writeSkill(join(profilePath, "skills", "shared-profile"), "shared", "profile winner");
  await writeSkill(
    join(extensionPackage, "skills", "shared-extension"),
    "shared",
    "extension loser",
  );
  await writeSkill(
    join(extensionPackage, "skills", "extension-only"),
    "extension-only",
    "extension only",
  );
  await writeSkill(join(topLevelSkills, "shared-top-level"), "shared", "top-level loser");
  await writeSkill(join(topLevelSkills, "top-level-only"), "top-level-only", "top level only");
  await writeFile(
    join(extensionPackage, "index.ts"),
    [
      'import { Type } from "typebox";',
      "export default function (pi) {",
      '  pi.registerTool({ name: "alpha_tool", label: "alpha_tool", description: "test",',
      "    parameters: Type.Object({}),",
      '    async execute() { return { content: [{ type: "text", text: "ok" }], details: undefined }; }',
      "  });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const resources = await discoverPiResources(profilePath, repositoryRoot);
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
      additionalExtensionPaths: [...resources.extensionPaths],
      additionalSkillPaths: [...resources.skillPaths],
    },
  });
  const loadedSkills = services.resourceLoader.getSkills();
  const byName = new Map(loadedSkills.skills.map((skill) => [skill.name, skill]));
  const extensionTools = services.resourceLoader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.keys()]);

  expect([...byName.keys()].sort()).toEqual(["extension-only", "shared", "top-level-only"]);
  expect(byName.get("shared")?.filePath).toBe(
    join(profilePath, "skills", "shared-profile", "SKILL.md"),
  );
  expect(
    loadedSkills.diagnostics.filter((diagnostic) => diagnostic.type === "collision"),
  ).toHaveLength(2);
  expect(extensionTools).toEqual(["alpha_tool"]);
});
