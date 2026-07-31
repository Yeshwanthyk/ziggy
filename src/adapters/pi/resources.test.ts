import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
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

test("discovers repository catalog IDs but admits only Profile skills", async () => {
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
    skillPaths: [join(profilePath, "skills")],
    catalogSkillIds: ["alpha", "beta", "top"],
  });
});

test("Pi loads only Profile-added extensions and skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-resources-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const extensionPackage = join(profilePath, "extensions", "alpha");
  const catalogPackage = join(repositoryRoot, "extensions", "alpha");
  const topLevelSkills = join(repositoryRoot, "skills");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writeSkill(join(profilePath, "skills", "shared-profile"), "shared", "profile winner");
  await writeSkill(
    join(catalogPackage, "skills", "shared-extension"),
    "shared",
    "extension loser",
  );
  await writeSkill(
    join(catalogPackage, "skills", "extension-only"),
    "extension-only",
    "extension only",
  );
  await writeSkill(join(topLevelSkills, "shared-top-level"), "shared", "top-level loser");
  await writeSkill(join(topLevelSkills, "top-level-only"), "top-level-only", "top level only");
  await mkdir(extensionPackage, { recursive: true });
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
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: [...resources.skillPaths],
    },
  });
  const loadedSkills = services.resourceLoader.getSkills();
  const byName = new Map(loadedSkills.skills.map((skill) => [skill.name, skill]));
  const extensionTools = services.resourceLoader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.keys()]);

  expect([...byName.keys()].sort()).toEqual(["shared"]);
  expect(byName.get("shared")?.filePath).toBe(
    join(profilePath, "skills", "shared-profile", "SKILL.md"),
  );
  expect(loadedSkills.diagnostics).toEqual([]);
  expect(extensionTools).toEqual(["alpha_tool"]);
  expect(resources.catalogSkillIds).toEqual([
    "extension-only",
    "shared-extension",
    "shared-top-level",
    "top-level-only",
  ]);
});

test("the complete repository catalog loads through production paths and Pi manifests", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-pi-catalog-"));
  temporaryPaths.push(profilePath);
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const extensionsRoot = join(repositoryRoot, "extensions");
  const expectedPackages = [
    "acp-router",
    "agent-browser",
    "apple-notes",
    "apple-reminders",
    "architecture-diagram",
    "blogwatcher",
    "codex",
    "coding-agent",
    "diffs",
    "discord",
    "executor",
    "gh-issues",
    "github",
    "github-issues",
    "github-pr-triage",
    "gog",
    "goplaces",
    "here-now",
    "humanizer",
    "hyperframes",
    "imsg",
    "linear",
    "lossless-claw",
    "mcporter",
    "nano-pdf",
    "notion",
    "obsidian",
    "onepassword",
    "open-computer-use",
    "openai-whisper",
    "peekaboo",
    "pi-packages",
    "qmd",
    "self-improving-agent",
    "session-logs",
    "skill-creator",
    "skill-curator",
    "slack",
    "smart-memory",
    "summarize",
    "telephony",
    "things-mac",
    "tmux",
    "wacli",
    "weather",
    "web-search",
    "xurl",
  ];
  const expectedTools = [
    "agent_browser",
    "diffs",
    "executor_call",
    "executor_resume",
    "executor_tools_describe",
    "executor_tools_search",
    "executor_tools_sources",
    "gh_prs",
    "github",
    "lcm_describe",
    "lcm_expand_query",
    "lcm_grep",
    "lcm_sessions",
    "linear",
    "open_computer_use",
    "skill_curator_list",
    "skill_curator_read",
    "skill_curator_write",
    "web_search",
  ];
  const packageNames = (await readdir(extensionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  expect(packageNames).toEqual(expectedPackages);
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");

  const loadCatalog = (additionalExtensionPaths: string[], additionalSkillPaths: string[]) =>
    createAgentSessionServices({
      cwd: profilePath,
      agentDir: profilePath,
      resourceLoaderOptions: {
        systemPrompt: join(profilePath, "SOUL.md"),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths,
        additionalSkillPaths,
      },
    });
  const loadProduction = () =>
    createAgentSessionServices({
      cwd: profilePath,
      agentDir: profilePath,
      resourceLoaderOptions: {
        systemPrompt: join(profilePath, "SOUL.md"),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
  const assertExtensions = (services: Awaited<ReturnType<typeof loadCatalog>>): void => {
    const loadedSkills = services.resourceLoader.getSkills();
    const loadedExtensions = services.resourceLoader.getExtensions();
    const toolNames = loadedExtensions.extensions
      .flatMap((extension) => [...extension.tools.keys()])
      .sort((left, right) => left.localeCompare(right));

    expect(loadedExtensions.errors).toEqual([]);
    expect(loadedSkills.diagnostics).toEqual([]);
    expect(toolNames).toEqual(expectedTools);
  };

  const productionResources = await discoverPiResources(profilePath, repositoryRoot);
  expect(productionResources.skillPaths).toEqual([
    join(repositoryRoot, "src", "adapters", "pi", "skills"),
  ]);
  expect(productionResources.catalogSkillIds).toHaveLength(57);
  const policyServices = await loadCatalog([], [...productionResources.skillPaths]);
  expect(
    policyServices.resourceLoader
      .getSkills()
      .skills.map((skill) => skill.name),
  ).toEqual(["automation-authoring"]);
  const productionServices = await loadProduction();
  expect(productionServices.resourceLoader.getExtensions().errors).toEqual([]);
  expect(productionServices.resourceLoader.getExtensions().extensions).toEqual([]);
  expect(productionServices.resourceLoader.getSkills().skills).toEqual([]);
  const { session } = await createAgentSessionFromServices({
    services: productionServices,
    sessionManager: SessionManager.inMemory(),
  });
  expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
  session.dispose();

  const manifestServices = await loadCatalog(
    packageNames.map((name) => join(extensionsRoot, name)),
    [join(repositoryRoot, "skills")],
  );
  assertExtensions(manifestServices);
  expect(manifestServices.resourceLoader.getSkills().skills).toHaveLength(57);
});
