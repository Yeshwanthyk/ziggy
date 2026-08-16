/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute Pi preflight Effects */
import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices,
  type CreateAgentSessionServicesOptions,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { makeProfileExtensionPreflight } from "ziggy/adapters/pi/profile-extension-preflight";
import {
  MAX_PI_DIAGNOSTIC_MESSAGE,
  MAX_PI_DIAGNOSTIC_SOURCE,
} from "ziggy/adapters/pi/profile-extension-diagnostics";

const roots: string[] = [];

type PackageOptions = {
  readonly brokenImport?: boolean;
  readonly brokenFactory?: boolean;
  readonly skillDiagnostic?: boolean;
  readonly commandConflict?: string;
};

const makeProfile = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-profile-preflight-"));
  roots.push(root);
  await writeFile(join(root, "SOUL.md"), "# Preflight profile\n");
  return root;
};

const writePackage = async (
  profilePath: string,
  id: string,
  options: PackageOptions = {},
): Promise<void> => {
  const packagePath = join(profilePath, "extensions", id);
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify(
      {
        name: `@upstream/${id}`,
        description: `${id} preflight package`,
        pi: { extensions: ["./index.ts"], skills: ["./skills"] },
      },
      null,
      2,
    )}\n`,
  );
  const source = options.brokenImport
    ? 'import "./missing-module";\nexport default function () {}\n'
    : options.brokenFactory
      ? `export default function () { throw new Error("${id} factory failed"); }\n`
      : options.commandConflict === undefined
        ? "export default function () {}\n"
        : [
            "export default function (pi) {",
            `  pi.registerCommand("${options.commandConflict}", { description: "conflict", handler: async () => {} });`,
            "}",
            "",
          ].join("\n");
  await writeFile(join(packagePath, "index.ts"), source);
  const skillPath = join(packagePath, "skills", id);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    options.skillDiagnostic
      ? `---\nname: ${id}\ndescription:\n---\n`
      : `---\nname: ${id}\ndescription: ${id} preflight skill\n---\n`,
  );
};

const stageRequiredPackages = async (profilePath: string): Promise<void> => {
  const repositoryRoot = join(import.meta.dir, "../../..");
  for (const id of ["extension-authoring", "pi-packages", "ziggy-operations"]) {
    await cp(join(repositoryRoot, "extensions", id), join(profilePath, "extensions", id), {
      recursive: true,
    });
  }
};

const writeAgent = async (profilePath: string): Promise<void> => {
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(
    join(profilePath, "agents", "research-helper.md"),
    "---\nversion: 1\ndescription: Researches carefully\n---\n\nResearch carefully.\n",
  );
};

const failureFor = async (profilePath: string, selected: ReadonlyArray<string>) =>
  Effect.runPromise(
    makeProfileExtensionPreflight()
      .preflight(profilePath, "/repository", selected)
      .pipe(Effect.flip),
  );

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("preflight uses the production resource-loader shape for arbitrary packages", async () => {
  const profilePath = await makeProfile();
  await writeAgent(profilePath);
  await writePackage(profilePath, "alpha");
  await stageRequiredPackages(profilePath);
  const snapshots: CreateAgentSessionServicesOptions[] = [];
  const servicesSnapshots: Array<Awaited<ReturnType<typeof createAgentSessionServices>>> = [];
  const createServices = async (options: CreateAgentSessionServicesOptions) => {
    snapshots.push(options);
    const services = await createAgentSessionServices(options);
    servicesSnapshots.push(services);
    return services;
  };

  const result = await Effect.runPromise(
    makeProfileExtensionPreflight(createServices).preflight(profilePath, "/repository", ["alpha"]),
  );

  expect(result).toEqual({
    extensionPathCount: 1,
    skillPathCount: 4,
    extensionFactoryCount: 4,
  });
  const loaderOptions = snapshots[0]?.resourceLoaderOptions;
  expect(loaderOptions).toMatchObject({
    systemPrompt: expect.stringContaining("# Preflight profile"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(profilePath, "extensions", "alpha")],
  });
  expect(loaderOptions?.additionalSkillPaths).toHaveLength(4);
  expect(
    loaderOptions?.extensionFactories?.map((factory) =>
      "name" in factory ? factory.name : "function",
    ),
  ).toEqual([
    "ziggy-tui",
    "ziggy-profile-agents",
    "ziggy-profile-memory",
    "ziggy-ephemeral-prompt-context",
  ]);
  const inlineExtensions = servicesSnapshots[0]?.resourceLoader.getExtensions().extensions ?? [];
  const ziggyTui = inlineExtensions.find((extension) => extension.path === "<inline:ziggy-tui>");
  expect(ziggyTui === undefined ? [] : [...ziggyTui.commands.keys()]).toEqual([
    "agents",
    "automations",
    "extensions",
  ]);
  expect(inlineExtensions.map((extension) => extension.path)).toEqual(
    expect.arrayContaining([
      "<inline:ziggy-profile-agents>",
      "<inline:ziggy-profile-memory>",
      "<inline:ziggy-ephemeral-prompt-context>",
    ]),
  );
});

test("preflight reports extension import and factory failures as typed diagnostics", async () => {
  const profilePath = await makeProfile();
  await writePackage(profilePath, "broken-import", { brokenImport: true });
  await writePackage(profilePath, "broken-factory", { brokenFactory: true });
  await stageRequiredPackages(profilePath);

  const failure = await failureFor(profilePath, ["broken-import", "broken-factory"]);

  expect(failure).toMatchObject({
    _tag: "ProfileExtensionPreflightFailed",
    stage: "extensions",
  });
  const diagnostics = failure._tag === "ProfileExtensionPreflightFailed" ? failure.diagnostics : [];
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toEqual(
    expect.arrayContaining([
      join(profilePath, "extensions", "broken-import", "index.ts"),
      join(profilePath, "extensions", "broken-factory", "index.ts"),
    ]),
  );
});

test("preflight reports skill diagnostics independently of extension loading", async () => {
  const profilePath = await makeProfile();
  await writePackage(profilePath, "bad-skill", { skillDiagnostic: true });
  await stageRequiredPackages(profilePath);

  const failure = await failureFor(profilePath, ["bad-skill"]);

  expect(failure).toMatchObject({
    _tag: "ProfileExtensionPreflightFailed",
    stage: "skills",
  });
  const diagnostics = failure._tag === "ProfileExtensionPreflightFailed" ? failure.diagnostics : [];
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: join(profilePath, "extensions", "bad-skill", "skills", "bad-skill", "SKILL.md"),
      }),
    ]),
  );
});

test("preflight rejects a package command that conflicts with a Ziggy core registration", async () => {
  const profilePath = await makeProfile();
  await writePackage(profilePath, "conflict", { commandConflict: "agents" });
  await stageRequiredPackages(profilePath);

  const failure = await failureFor(profilePath, ["conflict"]);

  expect(failure).toMatchObject({
    _tag: "ProfileExtensionPreflightFailed",
    stage: "extensions",
  });
  const diagnostics = failure._tag === "ProfileExtensionPreflightFailed" ? failure.diagnostics : [];
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "<inline:ziggy-tui>",
        message: expect.stringContaining('Command "agents" conflicts with'),
      }),
    ]),
  );
});

test("preflight bounds aggregated extension, skill, and service diagnostics", async () => {
  const profilePath = await makeProfile();
  const selected = Array.from({ length: 20 }, (_, index) => `broken-${index}`);
  for (const id of selected) {
    await writePackage(profilePath, id, { brokenImport: true });
  }
  await stageRequiredPackages(profilePath);

  const failure = await failureFor(profilePath, selected);

  expect(failure._tag).toBe("ProfileExtensionPreflightFailed");
  if (failure._tag !== "ProfileExtensionPreflightFailed") return;
  expect(failure.diagnostics).toHaveLength(12);
  expect(
    failure.diagnostics.every((diagnostic) => diagnostic.source.length <= MAX_PI_DIAGNOSTIC_SOURCE),
  ).toBe(true);
  expect(
    failure.diagnostics.every(
      (diagnostic) => diagnostic.message.length <= MAX_PI_DIAGNOSTIC_MESSAGE,
    ),
  ).toBe(true);
  expect(failure.message).toContain("20 diagnostic");
});

test("preflight aggregates a service error without creating an AgentSession or provider turn", async () => {
  const profilePath = await makeProfile();
  await writePackage(profilePath, "alpha");
  await stageRequiredPackages(profilePath);
  let serviceCalls = 0;
  const selectionBytes = '{"extensions":["alpha"]}\n';
  await writeFile(join(profilePath, "extensions.json"), selectionBytes);
  let serviceOptions: CreateAgentSessionServicesOptions | undefined;
  const createServices = async (options: CreateAgentSessionServicesOptions) => {
    serviceCalls += 1;
    serviceOptions = options;
    const services = await createAgentSessionServices(options);
    services.diagnostics.push({
      type: "error",
      message: "synthetic service diagnostic",
    });
    return services;
  };

  const failure = await Effect.runPromise(
    makeProfileExtensionPreflight(createServices)
      .preflight(profilePath, "/repository", ["alpha"])
      .pipe(Effect.flip),
  );

  expect(failure).toMatchObject({
    _tag: "ProfileExtensionPreflightFailed",
    stage: "services",
  });
  expect(failure._tag === "ProfileExtensionPreflightFailed" && failure.diagnostics).toEqual(
    expect.arrayContaining([
      { source: "services", message: "error: synthetic service diagnostic" },
    ]),
  );
  expect(serviceCalls).toBe(1);
  expect(serviceOptions).toBeDefined();
  expect(serviceOptions).not.toHaveProperty("sessionManager");
  expect(await readFile(join(profilePath, "SOUL.md"), "utf8")).toBe("# Preflight profile\n");
  expect(await readFile(join(profilePath, "extensions.json"), "utf8")).toBe(selectionBytes);
});
