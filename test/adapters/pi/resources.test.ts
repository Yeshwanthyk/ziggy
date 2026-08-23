/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute resolver Effects */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Result } from "effect";
import type { ExtensionArchiveClientApi } from "ziggy/adapters/github/extension-catalog";
import { discoverPiResources } from "ziggy/adapters/pi/resources";
import { makeProfileExtensions } from "ziggy/application/profile-extensions";
import type {
  ProfileExtensionMutationLockApi,
  ProfileExtensionPreflightApi,
} from "ziggy/domain/profile-extension";
import { ExtensionCatalogUnavailable } from "ziggy/domain/extension-catalog";
import { bundledFilePath } from "ziggy/generated/builtin-files";
import { REQUIRED_BUNDLED_EXTENSION_IDS } from "ziggy/catalog";

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
  packageName = `@ziggy/${id}`,
) => {
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify({ name: packageName, description: `${id} package`, pi: resources }, null, 2)}\n`,
  );
};

const requiredSkill = (logicalPath: string): string => bundledFilePath(logicalPath) ?? logicalPath;

const requiredSkillPaths = [
  requiredSkill("extensions/extension-authoring/skills/extension-authoring/SKILL.md"),
  requiredSkill("extensions/pi-packages/skills/pi-packages/SKILL.md"),
  requiredSkill("extensions/ziggy-operations/skills/ziggy-operations/SKILL.md"),
];

const noDownload: ExtensionArchiveClientApi = {
  download: () =>
    Effect.fail(
      new ExtensionCatalogUnavailable({
        operation: "test download",
        message: "bundled catalogue entry must not use the network",
        cause: undefined,
      }),
    ),
};
const noPreflight: ProfileExtensionPreflightApi = {
  preflight: () =>
    Effect.succeed({ extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 }),
};
const noLock: ProfileExtensionMutationLockApi = {
  withLock: <A, E, R>(_profilePath: string, use: Effect.Effect<A, E, R>) => use,
};
const profileExtensions = makeProfileExtensions(noDownload, noPreflight, noLock);

const resolveResources = (profilePath: string, repositoryRoot = profilePath) =>
  Effect.runPromise(discoverPiResources(profilePath, repositoryRoot));

const prepareRuntime = (profilePath: string, repositoryRoot: string) =>
  Effect.runPromise(profileExtensions.prepareRuntime(profilePath, repositoryRoot));

const factoryNames = (factories: ReadonlyArray<{ readonly name: string }>) =>
  factories.map((factory) => factory.name);

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

test("discovers selected Profile folders and ignores a leftover Profile skills directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-resources-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const gammaPackage = join(profilePath, "extensions", "gamma");

  await writeSkill(join(profilePath, "skills", "profile"), "profile", "profile skill");
  await writeSkill(join(gammaPackage, "skills", "gamma"), "gamma", "gamma skill");
  await writePackage(gammaPackage, "gamma", {
    extensions: ["./index.ts"],
    skills: ["./skills"],
  });
  await writeFile(join(gammaPackage, "index.ts"), "export default function () {}\n", "utf8");
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["gamma"]}\n');

  const resources = await resolveResources(profilePath);

  expect(resources.extensionPaths).toEqual([gammaPackage]);
  expect(factoryNames(resources.extensionFactories)).toEqual([]);
  expect(resources.skillPaths).toEqual([join(gammaPackage, "skills"), ...requiredSkillPaths]);
});

test("a selected approved extension fails closed until it exists as a Profile folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-missing-selected-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["github"]}\n');

  const result = await Effect.runPromise(
    discoverPiResources(profilePath, profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(result, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileExtensionInvalid") &&
        error.message.includes("selected extension 'github' is not installed"),
      onSuccess: () => false,
    }),
  ).toBe(true);
});

test("an unselected broken package does not block runtime discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-unselected-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });
  await mkdir(join(profilePath, "extensions", "broken"), { recursive: true });
  await writeFile(join(profilePath, "extensions", "broken", "package.json"), "{");

  expect(await resolveResources(profilePath)).toEqual({
    extensionPaths: [],
    skillPaths: requiredSkillPaths,
    extensionFactories: [],
  });
});

test("runtime rejects an unapproved ID but accepts the same Profile-local ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-approval-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const profilePackage = join(profilePath, "extensions", "stray");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["stray"]}\n');

  const rejected = await Effect.runPromise(
    discoverPiResources(profilePath, profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(rejected, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileExtensionInvalid") &&
        error.message.includes("neither approved nor Profile-local"),
      onSuccess: () => false,
    }),
  ).toBe(true);

  await writeSkill(join(profilePackage, "skills", "stray"), "stray", "Profile-local skill");
  await writePackage(profilePackage, "stray", { skills: ["./skills"] });

  const accepted = await resolveResources(profilePath);
  expect(accepted.skillPaths).toContain(join(profilePackage, "skills"));
  expect(factoryNames(accepted.extensionFactories)).toEqual([]);
});

test("Pi loads a selected Profile-owned extension and ignores leftover Profile skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-resources-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const extensionPackage = join(profilePath, "extensions", "alpha");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writeSkill(join(profilePath, "skills", "shared-profile"), "shared", "must not load");
  await writeSkill(
    join(extensionPackage, "skills", "shared-extension"),
    "shared",
    "extension skill",
  );
  await writeSkill(
    join(extensionPackage, "skills", "extension-only"),
    "extension-only",
    "extension only",
  );
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
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');
  await prepareRuntime(profilePath, "/does-not-exist");

  const resources = await resolveResources(profilePath);
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
      extensionFactories: [...resources.extensionFactories],
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
    "pi-packages",
    "shared",
    "ziggy-operations",
  ]);
  expect(byName.get("shared")?.filePath).toBe(
    join(extensionPackage, "skills", "shared-extension", "SKILL.md"),
  );
  expect(
    loadedSkills.diagnostics.filter((diagnostic) => diagnostic.type === "collision"),
  ).toHaveLength(0);
  expect(extensionTools).toEqual(["alpha_tool"]);
});

test("loads an upstream package name independently from its computer-use shelf ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-upstream-name-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const extensionPackage = join(profilePath, "extensions", "computer-use");

  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writePackage(
    extensionPackage,
    "computer-use",
    { extensions: ["./index.ts"] },
    "@injaneity/pi-computer-use",
  );
  await writeFile(
    join(extensionPackage, "index.ts"),
    [
      'import { Type } from "typebox";',
      "export default function (pi) {",
      '  pi.registerTool({ name: "computer_use", label: "computer_use", description: "test",',
      "    parameters: Type.Object({}),",
      '    async execute() { return { content: [{ type: "text", text: "ok" }], details: undefined }; }',
      "  });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["computer-use"]}\n');
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  await prepareRuntime(profilePath, repositoryRoot);

  const resources = await resolveResources(profilePath, repositoryRoot);
  expect(resources.extensionPaths).toEqual([extensionPackage]);

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
      extensionFactories: [...resources.extensionFactories],
    },
  });
  const loadedExtensions = services.resourceLoader.getExtensions();
  const loadedSkills = services.resourceLoader.getSkills();
  const extensionTools = loadedExtensions.extensions.flatMap((extension) => [
    ...extension.tools.keys(),
  ]);

  expect(loadedExtensions.errors).toEqual([]);
  expect(loadedSkills.diagnostics).toEqual([]);
  expect(extensionTools).toEqual(["computer_use"]);
});

test("rejects a blank package name", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-blank-package-name-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const extensionPackage = join(profilePath, "extensions", "blank-name");

  await mkdir(profilePath, { recursive: true });
  await writePackage(extensionPackage, "blank-name", { extensions: ["./index.ts"] }, "   ");
  await writeFile(join(extensionPackage, "index.ts"), "export default function () {}\n", "utf8");
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["blank-name"]}\n');

  const result = await Effect.runPromise(
    discoverPiResources(profilePath, profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(result, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileExtensionInvalid") &&
        error.path === join(extensionPackage, "package.json") &&
        error.message === `invalid extension manifest: ${join(extensionPackage, "package.json")}`,
      onSuccess: () => false,
    }),
  ).toBe(true);
});

test("selection decoding fails closed for malformed, duplicate, reserved, and unknown values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-invalid-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });

  for (const content of [
    "{",
    '{"wrong":[]}',
    '{"extensions":["weather","weather"]}',
    '{"extensions":["pi-packages"]}',
    '{"extensions":["extension-authoring"]}',
    '{"extensions":["ziggy-operations"]}',
    '{"extensions":["unknown"]}',
  ]) {
    await writeFile(join(profilePath, "extensions.json"), content);
    const result = await Effect.runPromise(
      discoverPiResources(profilePath, profilePath).pipe(Effect.result),
    );
    expect(
      Result.match(result, {
        onFailure: Predicate.isTagged("ProfileExtensionInvalid"),
        onSuccess: () => false,
      }),
    ).toBe(true);
  }
});

test("a selected Profile-owned package must be a physical shelf directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-package-symlink-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const externalPackage = join(root, "external-alpha");

  await mkdir(profilePath, { recursive: true });
  await writeSkill(join(externalPackage, "skills", "alpha"), "alpha", "alpha");
  await writePackage(externalPackage, "alpha", { skills: ["./skills"] });
  await mkdir(join(profilePath, "extensions"), { recursive: true });
  await symlink(externalPackage, join(profilePath, "extensions", "alpha"), "dir");
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

  const result = await Effect.runPromise(
    discoverPiResources(profilePath, profilePath).pipe(Effect.result),
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

test("manifest-declared symlinks cannot escape their Profile-owned package", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-pi-symlink-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  const alphaPackage = join(profilePath, "extensions", "alpha");
  const externalSkills = join(root, "external-skills");
  await mkdir(profilePath, { recursive: true });
  await writeSkill(externalSkills, "external", "must not load");
  await mkdir(alphaPackage, { recursive: true });
  await symlink(externalSkills, join(alphaPackage, "skills"), "dir");
  await writePackage(alphaPackage, "alpha", { skills: ["./skills"] });
  await writeFile(join(profilePath, "extensions.json"), '{"extensions":["alpha"]}\n');

  const result = await Effect.runPromise(
    discoverPiResources(profilePath, profilePath).pipe(Effect.result),
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

test("the complete bundled catalog copies onto the Profile and loads from those folders", async () => {
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const profilePath = await mkdtemp(join(repositoryRoot, ".ziggy-pi-catalog-"));
  temporaryPaths.push(profilePath);
  const extensionsRoot = join(repositoryRoot, "extensions");
  expect(existsSync(join(repositoryRoot, "skills"))).toBe(false);
  const expectedPackages = [
    "acp-router",
    "agent-browser",
    "apple-notes",
    "apple-reminders",
    "codemode",
    "codex",
    "coding-agent",
    "diffs",
    "executor",
    "extension-authoring",
    "gh-issues",
    "github",
    "gog",
    "goplaces",
    "here-now",
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
    "pi-packages",
    "qmd",
    "self-improvement",
    "things-mac",
    "tmux",
    "wacli",
    "weather",
    "web-search",
    "xurl",
    "ziggy-operations",
  ];
  const expectedTools = [
    "agent_browser",
    "apple_reminders_complete",
    "apple_reminders_create",
    "apple_reminders_delete",
    "apple_reminders_list_due",
    "apple_reminders_list_incomplete",
    "apple_reminders_move",
    "apple_reminders_reschedule",
    "codemode_execute",
    "diffs",
    "executor_call",
    "executor_resume",
    "executor_tools_describe",
    "executor_tools_search",
    "executor_tools_sources",
    "github",
    "lcm_describe",
    "lcm_expand_query",
    "lcm_grep",
    "lcm_sessions",
    "linear",
    "open_computer_use",
    "self_improvement_extension_write",
    "self_improvement_log",
    "self_improvement_status",
    "web_search",
  ];
  const executablePackages = [
    "agent-browser",
    "apple-reminders",
    "codemode",
    "diffs",
    "executor",
    "github",
    "linear",
    "lossless-claw",
    "open-computer-use",
    "self-improvement",
    "web-search",
  ];
  const packageNames = (await readdir(extensionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  expect(packageNames).toEqual(expectedPackages);
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  await writeFile(
    join(profilePath, "extensions.json"),
    `${JSON.stringify({ extensions: packageNames.filter((name) => !REQUIRED_BUNDLED_EXTENSION_IDS.has(name)) }, null, 2)}\n`,
  );
  await prepareRuntime(profilePath, repositoryRoot);

  const loadCatalog = (
    additionalExtensionPaths: string[],
    additionalSkillPaths: string[],
    extensionFactories: InlineExtension[] = [],
  ) =>
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
        extensionFactories,
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

  const productionResources = await resolveResources(profilePath, repositoryRoot);
  expect(factoryNames(productionResources.extensionFactories)).toEqual([]);
  expect(productionResources.extensionPaths).toEqual(
    executablePackages.map((id) => join(profilePath, "extensions", id)),
  );
  expect(productionResources.skillPaths).toHaveLength(35);
  expect(
    productionResources.skillPaths.every((skillPath) => skillPath.startsWith(profilePath)),
  ).toBe(true);
  const productionServices = await loadCatalog(
    [...productionResources.extensionPaths],
    [...productionResources.skillPaths],
    [...productionResources.extensionFactories],
  );
  assertCatalog(productionServices, 35);
  const { session } = await createAgentSessionFromServices({
    services: productionServices,
    sessionManager: SessionManager.inMemory(),
  });
  expect(session.getActiveToolNames()).toEqual(
    expect.arrayContaining(["read", "bash", "write", ...expectedTools]),
  );
  session.dispose();
});
