import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFauxCore, createModels, createProvider } from "@earendil-works/pi-ai";
import type { JsonValue } from "../../packages/protocol/src/index.ts";
import { Effect } from "effect";
import {
  decodeExtensionApprovalsJson,
  createFilesystemWorld,
  createProviderRuntimeComposition,
  ExtensionToolLoadError,
  loadInstalledExtensionTools,
  type SessionTool,
} from "../../packages/core/src/index.ts";
import {
  createS4ExtensionFixture,
  installS4Fixture,
  requireApprovalRequirements,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";
import { runEffect, runScopedEffect } from "../testkit/effect.ts";

const VALID_TOOL = `
export default {
  name: "fixture",
  description: "Fixture Tool",
  inputSchema: { type: "object", additionalProperties: false },
  async execute(input, context) {
    return { input, contextKeys: Object.keys(context).sort() };
  },
};
`;

test("Extension Tool code isn't imported before exact approval and enable", async () => {
  const fixture = await createToolFixture("approval", {
    "tools/fixture/tool.ts": VALID_TOOL,
  });
  const marker = join(fixture.profile, "MARKER");
  await writeFile(
    join(fixture.source, "tools", "fixture", "tool.ts"),
    `await Bun.write(${JSON.stringify(marker)}, "imported");\n${VALID_TOOL}`,
  );
  const requirements = requireApprovalRequirements(
    await installS4Fixture(fixture.profile, fixture.source, []),
  );
  expect(await Bun.file(marker).exists()).toBeFalse();
  expect(requirements).toHaveLength(1);
  expect(requirements[0]).toMatchObject({
    entryKind: "tool",
    entryId: "fixture",
    executablePath: expect.stringContaining("/extensions/fixture/tools/fixture/tool.ts"),
  });
  await installS4Fixture(
    fixture.profile,
    fixture.source,
    requirements.map((requirement) => requirement.fingerprint),
  );
  expect(await runScopedEffect(loadInstalledExtensionTools(fixture.profile, "0.0.0"))).toEqual([]);
  expect(await Bun.file(marker).exists()).toBeFalse();
  await enable(
    fixture.profile,
    requirements.map((requirement) => requirement.fingerprint),
  );
  const output = await executeOnlyTool(fixture.profile);
  expect(output).toEqual({
    input: {},
    contextKeys: ["sessionId", "signal", "stepId", "toolCallId", "turnId"],
  });
  expect(await Bun.file(marker).exists()).toBeTrue();
});

test("Tool loader rejects incompatible, invalidated, mutated, and missing exact approval state", async () => {
  const incompatible = await createToolFixture(
    "incompatible",
    {
      "tools/fixture/tool.ts": VALID_TOOL,
    },
    "99.0.0",
  );
  const incompatibleApprovals = requireApprovalRequirements(
    await installS4Fixture(incompatible.profile, incompatible.source, [], {
      runningZiggyVersion: "99.0.0",
    }),
  );
  const incompatibleFingerprints = incompatibleApprovals.map((entry) => entry.fingerprint);
  await installS4Fixture(incompatible.profile, incompatible.source, incompatibleFingerprints, {
    runningZiggyVersion: "99.0.0",
  });
  await useS4Lifecycle(
    incompatible.profile,
    (service) => service.enable({ extensionId: "fixture", approvals: incompatibleFingerprints }),
    { runningZiggyVersion: "99.0.0" },
  );
  expect(incompatibleApprovals).toHaveLength(1);
  await expect(
    runScopedEffect(loadInstalledExtensionTools(incompatible.profile, "0.0.0")),
  ).rejects.toThrow("requires Ziggy");

  const fixture = await createToolFixture("mutated", { "tools/fixture/tool.ts": VALID_TOOL });
  await installAndEnable(fixture.profile, fixture.source);
  const installedTool = join(
    fixture.profile,
    "extensions",
    "fixture",
    "tools",
    "fixture",
    "tool.ts",
  );
  await writeFile(installedTool, `${VALID_TOOL}\n// mutation\n`);
  await expect(
    runScopedEffect(loadInstalledExtensionTools(fixture.profile, "0.0.0")),
  ).rejects.toThrow("mutated");
  const approvalsPath = join(
    fixture.profile,
    ".runtime",
    "extensions",
    "fixture",
    "approvals.json",
  );
  const invalidated = await runEffect(
    decodeExtensionApprovalsJson(await readFile(approvalsPath, "utf8")),
  );
  expect(invalidated).toMatchObject({ epoch: 1, invalidated: true, approvals: [] });
  await expect(
    runScopedEffect(loadInstalledExtensionTools(fixture.profile, "0.0.0")),
  ).rejects.toThrow("reinstall");

  const unapproved = await createToolFixture("unapproved", { "tools/fixture/tool.ts": VALID_TOOL });
  const exact = await installAndEnable(unapproved.profile, unapproved.source);
  await writeFile(
    join(unapproved.profile, ".runtime", "extensions", "fixture", "approvals.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        extensionId: "fixture",
        epoch: exact[0]?.epoch ?? 0,
        invalidated: false,
        approvals: [],
      },
      undefined,
      2,
    )}\n`,
  );
  await expect(
    runScopedEffect(loadInstalledExtensionTools(unapproved.profile, "0.0.0")),
  ).rejects.toThrow("Exact execution approval is missing");
});

test("Tool loader validates exact module shape, identity, schema, and JSON result", async () => {
  const fixture = await createToolFixture("shape", { "tools/fixture/tool.ts": VALID_TOOL });
  await installAndEnable(fixture.profile, fixture.source);
  const modules: ReadonlyArray<readonly [unknown, string]> = [
    [{ default: validDefinition(), named: true }, "one default export"],
    [{ default: { ...validDefinition(), extra: true } }, "Invalid Extension Tool definition"],
    [{ default: { ...validDefinition(), name: "other" } }, "name must match"],
    [{ default: { ...validDefinition(), inputSchema: [] } }, "JSON object schema"],
    [{ default: { ...validDefinition(), execute: "no" } }, "execute must be a function"],
  ];
  for (const [module, message] of modules) {
    await expect(
      runScopedEffect(
        loadInstalledExtensionTools(fixture.profile, "0.0.0", {
          importModule: () => Effect.succeed(module),
        }),
      ),
    ).rejects.toThrow(message);
  }

  await expect(
    runScopedEffect(
      Effect.gen(function* () {
        const tools = yield* loadInstalledExtensionTools(fixture.profile, "0.0.0", {
          importModule: () =>
            Effect.succeed({ default: { ...validDefinition(), execute: () => undefined } }),
        });
        return yield* onlyTool(tools).execute(toolInput());
      }),
    ),
  ).rejects.toThrow("non-JSON");
});

test("Tool loader rejects duplicate names, including the builtin memory Tool", async () => {
  const memory = await createToolFixture("memory-name", {
    "tools/fixture/tool.ts": VALID_TOOL,
  });
  await installAndEnable(memory.profile, memory.source);
  await expect(
    runScopedEffect(
      loadInstalledExtensionTools(memory.profile, "0.0.0", {
        importModule: () => Effect.succeed({ default: { ...validDefinition(), name: "memory" } }),
      }),
    ),
  ).rejects.toThrow("name must match");

  const duplicate = await createS4ExtensionFixture("duplicate", {
    skills: [],
    tools: [
      { id: "alpha", path: "tools/alpha" },
      { id: "beta", path: "tools/beta" },
    ],
    files: {
      "tools/alpha/tool.ts": VALID_TOOL,
      "tools/beta/tool.ts": VALID_TOOL,
    },
  });
  await installAndEnable(duplicate.profile, duplicate.source);
  await expect(
    runScopedEffect(
      loadInstalledExtensionTools(duplicate.profile, "0.0.0", {
        importModule: () => Effect.succeed({ default: validDefinition("alpha") }),
      }),
    ),
  ).rejects.toThrow("name must match manifest Tool id beta");

  const builtinCollision = await createS4ExtensionFixture("builtin-collision", {
    skills: [],
    tools: [{ id: "memory", path: "tools/memory" }],
    files: { "tools/memory/tool.ts": VALID_TOOL },
  });
  await installAndEnable(builtinCollision.profile, builtinCollision.source);
  await expect(
    runScopedEffect(
      loadInstalledExtensionTools(builtinCollision.profile, "0.0.0", {
        importModule: () => Effect.succeed({ default: validDefinition("memory") }),
      }),
    ),
  ).rejects.toThrow("collide with memory");
});

test("Tool snapshot preserves relative dependencies and closes both mutation races", async () => {
  const fixture = await createToolFixture("snapshot", {
    "tools/fixture/dependency.ts": `export const value = "sealed";\n`,
    "tools/fixture/tool.ts": `
export default {
  name: "fixture",
  description: "Fixture Tool",
  inputSchema: { type: "object", additionalProperties: false },
  async execute() {
    const dependency = await import("./dependency.ts");
    return { value: dependency.value };
  },
};
`,
  });
  await installAndEnable(fixture.profile, fixture.source);
  const lazyOutput = await runScopedEffect(
    Effect.gen(function* () {
      const tools = yield* loadInstalledExtensionTools(fixture.profile, "0.0.0");
      return yield* onlyTool(tools).execute(toolInput());
    }),
  );
  expect(lazyOutput).toEqual({ value: "sealed" });
  const liveRoot = join(fixture.profile, "extensions", "fixture", "tools", "fixture");
  let importerCalls = 0;
  await expect(
    runScopedEffect(
      loadInstalledExtensionTools(fixture.profile, "0.0.0", {
        beforeFinalLiveSealCheck: () =>
          Effect.tryPromise({
            try: () => writeFile(join(liveRoot, "dependency.ts"), `export const value = "bad";\n`),
            catch: (cause) =>
              new ExtensionToolLoadError({ message: "fixture mutation failed", cause }),
          }),
        importModule: () => {
          importerCalls += 1;
          return Effect.succeed({ default: validDefinition() });
        },
      }),
    ),
  ).rejects.toThrow("mutated");
  expect(importerCalls).toBe(0);

  const safe = await createToolFixture("snapshot-cutpoint", {
    "tools/fixture/dependency.ts": `export const value = "sealed";\n`,
    "tools/fixture/tool.ts": `
import { value } from "./dependency.ts";
export default {
  name: "fixture",
  description: "Fixture Tool",
  inputSchema: { type: "object", additionalProperties: false },
  async execute() { return { value }; },
};
`,
  });
  await installAndEnable(safe.profile, safe.source);
  const safeRoot = join(safe.profile, "extensions", "fixture", "tools", "fixture");
  const sealedMarker = join(safe.root, "sealed-marker");
  await writeFile(
    join(safe.source, "tools", "fixture", "dependency.ts"),
    `await Bun.write(${JSON.stringify(sealedMarker)}, "sealed");\nexport const value = "sealed";\n`,
  );
  const refreshed = await installAndEnable(safe.profile, safe.source);
  expect(refreshed).toHaveLength(1);
  await expect(
    runScopedEffect(
      loadInstalledExtensionTools(safe.profile, "0.0.0", {
        beforeImport: () =>
          Effect.tryPromise({
            try: () => writeFile(join(safeRoot, "dependency.ts"), `export const value = "bad";\n`),
            catch: (cause) =>
              new ExtensionToolLoadError({ message: "fixture mutation failed", cause }),
          }),
      }),
    ),
  ).rejects.toThrow("loaded Tools were discarded");
  expect(await readFile(sealedMarker, "utf8")).toBe("sealed");
});

test("production Provider composition freezes loaded Extension Tools into the Session snapshot", async () => {
  const fixture = await createToolFixture("provider-composition", {
    "tools/fixture/tool.ts": VALID_TOOL,
  });
  await Promise.all([
    Bun.write(join(fixture.profile, "SOUL.md"), "fixture soul\n"),
    Bun.write(
      join(fixture.profile, "ziggy.jsonc"),
      '{"schemaVersion":1,"defaultProvider":"fixture-provider","defaultModel":"fixture-model","thinkingLevel":"medium","cacheRetention":"short"}\n',
    ),
  ]);
  await Promise.all(
    ["credentials", "sessions", "memory"].map((directory) =>
      mkdir(join(fixture.profile, directory), directory === "credentials" ? { mode: 0o700 } : {}),
    ),
  );
  await installAndEnable(fixture.profile, fixture.source);
  const faux = createFauxCore({
    provider: "fixture-provider",
    models: [{ id: "fixture-model", name: "Fixture Model" }],
  });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "fixture-provider",
      auth: {},
      models: faux.models,
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  const toolNames = await runScopedEffect(
    Effect.gen(function* () {
      const composition = yield* createProviderRuntimeComposition({
        profilePath: fixture.profile,
        config: {
          defaultProvider: "fixture-provider",
          defaultModel: "fixture-model",
          thinkingLevel: "medium",
          cacheRetention: "short",
        },
        models,
      });
      const world = createFilesystemWorld({ profilePath: fixture.profile });
      const runtime = yield* composition.createRuntime("provider-tool-session", world);
      const envelopes = yield* world.readSession("provider-tool-session", 0);
      yield* runtime.close;
      const started = envelopes[0]?.event;
      return started?.type === "session-started"
        ? started.snapshot.tools.map((tool) => tool.name)
        : [];
    }),
  );
  expect(toolNames).toEqual(["memory", "fixture"]);
});

function validDefinition(name = "fixture") {
  return {
    name,
    description: "Fixture Tool",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => ({ ok: true }),
  };
}

function toolInput() {
  return {
    sessionId: "session",
    turnId: "turn",
    stepId: "step",
    toolCallId: "call",
    toolName: "fixture",
    input: {},
    signal: new AbortController().signal,
  };
}

function onlyTool(tools: ReadonlyArray<SessionTool>): SessionTool {
  const tool = tools[0];
  if (tool === undefined) throw new Error("Expected one loaded Tool");
  return tool;
}

function executeOnlyTool(profilePath: string): Promise<JsonValue> {
  return runScopedEffect(
    Effect.gen(function* () {
      const tools = yield* loadInstalledExtensionTools(profilePath, "0.0.0");
      return yield* onlyTool(tools).execute(toolInput());
    }),
  );
}

async function createToolFixture(
  name: string,
  files: Readonly<Record<string, string>>,
  minimumVersion = "0.0.0",
) {
  return createS4ExtensionFixture(name, {
    skills: [],
    tools: [{ id: "fixture", path: "tools/fixture" }],
    files,
    version: "1.0.0",
  }).then(async (fixture) => {
    if (minimumVersion === "0.0.0") return fixture;
    const manifestPath = join(fixture.source, "extension.json");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, manifest.replace(">=0.0.0 <=9.0.0", `>=${minimumVersion}`));
    return fixture;
  });
}

async function installAndEnable(profilePath: string, sourcePath: string) {
  const requirements = requireApprovalRequirements(
    await installS4Fixture(profilePath, sourcePath, []),
  );
  const fingerprints = requirements.map((requirement) => requirement.fingerprint);
  await installS4Fixture(profilePath, sourcePath, fingerprints);
  await enable(profilePath, fingerprints);
  return requirements;
}

async function enable(profilePath: string, approvals: ReadonlyArray<string>): Promise<void> {
  const result = await useS4Lifecycle(profilePath, (service) =>
    service.enable({ extensionId: "fixture", approvals }),
  );
  expect(result).toMatchObject({ status: "enabled" });
}
