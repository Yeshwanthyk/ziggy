/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute resolver Effects */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Result } from "effect";
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

const writePackage = async (
  packagePath: string,
  id: string,
  resources: {
    readonly extensions?: ReadonlyArray<string>;
    readonly skills?: ReadonlyArray<string>;
  },
) => {
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify({ name: `@ziggy/${id}`, description: `${id} package`, pi: resources }, null, 2)}\n`,
  );
};

const resolveResources = (profilePath: string, repositoryRoot: string) =>
  Effect.runPromise(discoverPiResources(profilePath, repositoryRoot));

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

  const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
  await writeSkill(join(profilePath, "skills", "profile"), "profile", "profile skill");
  await writeSkill(join(alphaPackage, "skills", "alpha"), "alpha", "alpha skill");
  await writeSkill(join(betaPackage, "skills", "beta"), "beta", "beta skill");
  await writeSkill(join(requiredPackage, "skills", "required"), "required", "required skill");
  await writeSkill(
    join(repositoryRoot, "skills", "extension-authoring"),
    "extension-authoring",
    "authoring skill",
  );
  await writePackage(alphaPackage, "alpha", { skills: ["./skills"] });
  await writePackage(betaPackage, "beta", { extensions: ["./index.ts"], skills: ["./skills"] });
  await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
  await writeFile(join(betaPackage, "index.ts"), "export default function () {}\n", "utf8");
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["beta"]}\n');

  const resources = await resolveResources(profilePath, repositoryRoot);

  expect(resources).toEqual({
    extensionPaths: [join(betaPackage, "index.ts")],
    skillPaths: [
      join(profilePath, "skills"),
      join(requiredPackage, "skills"),
      join(repositoryRoot, "skills", "extension-authoring", "SKILL.md"),
      join(betaPackage, "skills"),
    ],
  });
});

test("an unselected broken package does not block runtime discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-unselected-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
  const brokenPackage = join(repositoryRoot, "extensions", "broken");

  await mkdir(profilePath, { recursive: true });
  await writeSkill(join(requiredPackage, "skills", "required"), "required", "required skill");
  await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
  await writeSkill(
    join(repositoryRoot, "skills", "extension-authoring"),
    "extension-authoring",
    "authoring skill",
  );
  await mkdir(brokenPackage, { recursive: true });
  await writeFile(join(brokenPackage, "package.json"), "{");

  expect(await resolveResources(profilePath, repositoryRoot)).toEqual({
    extensionPaths: [],
    skillPaths: [
      join(requiredPackage, "skills"),
      join(repositoryRoot, "skills", "extension-authoring", "SKILL.md"),
    ],
  });
});

test("Pi keeps Profile skill precedence while loading package extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-resources-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const extensionPackage = join(repositoryRoot, "extensions", "alpha");
  const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
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
  await writeSkill(join(requiredPackage, "skills", "required"), "required", "required only");
  await writeSkill(
    join(topLevelSkills, "extension-authoring"),
    "extension-authoring",
    "top level only",
  );
  await writeSkill(join(topLevelSkills, "ambient"), "ambient", "must not load");
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
  await writePackage(extensionPackage, "alpha", {
    extensions: ["./index.ts"],
    skills: ["./skills"],
  });
  await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

  const resources = await resolveResources(profilePath, repositoryRoot);
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

  expect([...byName.keys()].sort()).toEqual([
    "extension-authoring",
    "extension-only",
    "required",
    "shared",
  ]);
  expect(byName.get("shared")?.filePath).toBe(
    join(profilePath, "skills", "shared-profile", "SKILL.md"),
  );
  expect(
    loadedSkills.diagnostics.filter((diagnostic) => diagnostic.type === "collision"),
  ).toHaveLength(1);
  expect(extensionTools).toEqual(["alpha_tool"]);
});

test("selection decoding fails closed for malformed, duplicate, reserved, and unknown values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-invalid-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
  const alphaPackage = join(repositoryRoot, "extensions", "alpha");
  await mkdir(profilePath, { recursive: true });
  await writeSkill(join(requiredPackage, "skills", "required"), "required", "required");
  await writeSkill(join(alphaPackage, "skills", "alpha"), "alpha", "alpha");
  await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
  await writePackage(alphaPackage, "alpha", { skills: ["./skills"] });

  for (const content of [
    "{",
    '{"wrong":[]}',
    '{"extensions":["alpha","alpha"]}',
    '{"extensions":["pi-packages"]}',
    '{"extensions":["unknown"]}',
  ]) {
    await writeFile(join(profilePath, "extensions.json"), content);
    const result = await Effect.runPromise(
      discoverPiResources(profilePath, repositoryRoot).pipe(Effect.result),
    );
    expect(
      Result.match(result, {
        onFailure: Predicate.isTagged("ProfileExtensionInvalid"),
        onSuccess: () => false,
      }),
    ).toBe(true);
  }
});

test("missing or wrong-type mandatory extension-authoring skill fails closed", async () => {
  for (const state of ["missing", "directory"] as const) {
    const root = await mkdtemp(join(tmpdir(), "ziggy-pi-mandatory-"));
    temporaryPaths.push(root);
    const profilePath = join(root, "profile");
    const repositoryRoot = join(root, "ziggy");
    const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
    const authoringSkillPath = join(repositoryRoot, "skills", "extension-authoring", "SKILL.md");
    await mkdir(profilePath, { recursive: true });
    await writeSkill(join(requiredPackage, "skills", "required"), "required", "required");
    await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
    if (state === "directory") await mkdir(authoringSkillPath, { recursive: true });

    const result = await Effect.runPromise(
      discoverPiResources(profilePath, repositoryRoot).pipe(Effect.result),
    );

    expect(
      Result.match(result, {
        onFailure: (error) =>
          Predicate.isTagged(error, "ProfileExtensionInvalid") && error.path === authoringSkillPath,
        onSuccess: () => false,
      }),
    ).toBe(true);
  }
});

test("a selected package must be a physical shelf directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-package-symlink-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
  const externalPackage = join(root, "external-alpha");

  await mkdir(profilePath, { recursive: true });
  await writeSkill(join(requiredPackage, "skills", "required"), "required", "required");
  await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
  await writeSkill(join(externalPackage, "skills", "alpha"), "alpha", "alpha");
  await writePackage(externalPackage, "alpha", { skills: ["./skills"] });
  await symlink(externalPackage, join(repositoryRoot, "extensions", "alpha"), "dir");
  await writeSkill(
    join(repositoryRoot, "skills", "extension-authoring"),
    "extension-authoring",
    "authoring",
  );
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

  const result = await Effect.runPromise(
    discoverPiResources(profilePath, repositoryRoot).pipe(Effect.result),
  );

  expect(
    Result.match(result, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileExtensionInvalid") &&
        error.message === "extension 'alpha' is not a physical shelf directory",
      onSuccess: () => false,
    }),
  ).toBe(true);
});

test("manifest-declared symlinks cannot escape their package", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-symlink-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const repositoryRoot = join(root, "ziggy");
  const alphaPackage = join(repositoryRoot, "extensions", "alpha");
  const requiredPackage = join(repositoryRoot, "extensions", "pi-packages");
  const externalSkills = join(root, "external-skills");
  await mkdir(profilePath, { recursive: true });
  await writeSkill(externalSkills, "external", "must not load");
  await mkdir(alphaPackage, { recursive: true });
  await symlink(externalSkills, join(alphaPackage, "skills"), "dir");
  await writePackage(alphaPackage, "alpha", { skills: ["./skills"] });
  await writeSkill(join(requiredPackage, "skills", "required"), "required", "required");
  await writePackage(requiredPackage, "pi-packages", { skills: ["./skills"] });
  await writeSkill(
    join(repositoryRoot, "skills", "extension-authoring"),
    "extension-authoring",
    "authoring",
  );
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

  const result = await Effect.runPromise(
    discoverPiResources(profilePath, repositoryRoot).pipe(Effect.result),
  );

  expect(
    Result.match(result, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileExtensionInvalid") &&
        error.message === "declared skill path escapes its package: './skills'",
      onSuccess: () => false,
    }),
  ).toBe(true);
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
    "apple-reminders-native",
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
  const assertCatalog = (
    services: Awaited<ReturnType<typeof loadCatalog>>,
    skillCount: number,
  ): void => {
    const loadedSkills = services.resourceLoader.getSkills();
    const loadedExtensions = services.resourceLoader.getExtensions();
    const toolNames = loadedExtensions.extensions
      .flatMap((extension) => [...extension.tools.keys()])
      .sort((left, right) => left.localeCompare(right));

    expect(loadedExtensions.errors).toEqual([]);
    expect(loadedSkills.diagnostics).toEqual([]);
    expect(loadedSkills.skills).toHaveLength(skillCount);
    expect(toolNames).toEqual(expectedTools);
  };

  await writeFile(
    join(profilePath, "extensions.json"),
    `${JSON.stringify({ extensions: packageNames.filter((name) => name !== "pi-packages") }, null, 2)}\n`,
  );
  const productionResources = await resolveResources(profilePath, repositoryRoot);
  expect(
    productionResources.extensionPaths.map((extensionPath) => basename(dirname(extensionPath))),
  ).toEqual([
    "agent-browser",
    "diffs",
    "executor",
    "github",
    "github-pr-triage",
    "linear",
    "lossless-claw",
    "open-computer-use",
    "skill-curator",
    "web-search",
  ]);
  expect(productionResources.skillPaths).toHaveLength(49);
  const productionServices = await loadCatalog(
    [...productionResources.extensionPaths],
    [...productionResources.skillPaths],
  );
  assertCatalog(productionServices, 50);
  const { session } = await createAgentSessionFromServices({
    services: productionServices,
    sessionManager: SessionManager.inMemory(),
  });
  expect(session.getActiveToolNames()).toEqual(
    expect.arrayContaining(["read", "bash", "write", ...expectedTools]),
  );
  session.dispose();

  assertCatalog(
    await loadCatalog(
      packageNames.map((name) => join(extensionsRoot, name)),
      [join(repositoryRoot, "skills")],
    ),
    58,
  );
});
