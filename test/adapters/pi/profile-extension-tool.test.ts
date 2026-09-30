import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Value } from "typebox/value";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { makeProfileExtensionMutationLock } from "ziggy/adapters/bun/profile-extension-lock";
import { makeProfileExtensions } from "ziggy/application/profile-extensions";
import { makeProfileExtensionPreflight } from "ziggy/adapters/pi/profile-extension-preflight";
import {
  createProfileExtensionTool,
  profileExtensionToolDetailsSchema,
  profileExtensionsParameters,
  type ProfileExtensionToolDetails,
  type ProfileExtensionsAction,
} from "ziggy/adapters/pi/profile-extension-tool";
import { ProfileExtensionInvalid, type ProfileTarget } from "ziggy/domain/profile";
import {
  ProfileExtensionPreflightFailed,
  type ProfileExtensionListing,
  type ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";

const temporaryPaths: Array<string> = [];

const unused = (): Effect.Effect<never, ProfileExtensionInvalid> =>
  Effect.fail(
    new ProfileExtensionInvalid({
      path: "/unused",
      message: "unused test operation",
      cause: undefined,
    }),
  );

const context = Object.create(null);

const invoke = async (
  tool: ReturnType<typeof createProfileExtensionTool>,
  input: ProfileExtensionsAction,
): Promise<AgentToolResult<ProfileExtensionToolDetails>> =>
  tool.execute("call-1", input, undefined, undefined, context);

const makeProfileFixture = async (): Promise<{
  readonly root: string;
  readonly profilePath: string;
  readonly target: ProfileTarget;
}> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-profile-extension-tool-"));
  temporaryPaths.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Test profile\n", "utf8");
  await writeFile(join(profilePath, "extensions.json"), '{\n  "extensions": []\n}\n', "utf8");

  return {
    root,
    profilePath,
    target: { path: profilePath, name: "Profile" },
  };
};

const writeShelfPackage = async (profilePath: string, id: string): Promise<void> => {
  const packagePath = join(profilePath, "extensions", id);
  await mkdir(join(packagePath, "skills", id), { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify({
      name: "@upstream/profile-tool-fixture",
      description: "Profile extension tool fixture",
      pi: { skills: ["./skills"] },
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(packagePath, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${id} fixture skill\n---\n\n# ${id}\n`,
    "utf8",
  );
};

const makeStub = (calls: Array<ReadonlyArray<unknown>>): ProfileExtensionsApi => {
  const listing: ProfileExtensionListing = {
    available: [
      { id: "alpha", description: "Alpha shelf package", kind: "skill", source: "profile" },
      { id: "weather", description: "Bundled weather package", kind: "skill", source: "bundled" },
    ],
    selected: ["alpha"],
  };

  return {
    list: unused,
    show: unused,
    listForProfile: (profilePath) => {
      calls.push(["list", profilePath]);

      return Effect.succeed(listing);
    },
    add: (target, id) => {
      calls.push(["add", target, id]);

      return Effect.succeed({ id, profilePath: target.path, changed: true, selected: true });
    },
    remove: (target, id) => {
      calls.push(["remove", target, id]);

      return Effect.succeed({ id, profilePath: target.path, changed: true, selected: false });
    },
    setSelected: unused,
    validate: (target) => {
      calls.push(["validate", target]);

      return Effect.succeed({
        selected: ["alpha"],
        preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
      });
    },
    prepareRuntime: unused,
    activateRuntime: unused,
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("profile_extensions input and result contract", () => {
  test("uses a strict object schema and admits only Slice 3 IDs", () => {
    expect(Value.Check(profileExtensionsParameters, { action: "list" })).toBe(true);
    expect(Value.Check(profileExtensionsParameters, { action: "add", id: "alpha" })).toBe(true);
    expect(Value.Check(profileExtensionsParameters, { action: "remove", id: "alpha" })).toBe(true);
    expect(Value.Check(profileExtensionsParameters, { action: "validate" })).toBe(true);
    expect(
      Value.Check(profileExtensionsParameters, { action: "add", id: "alpha", unexpected: true }),
    ).toBe(false);
    expect(
      Value.Check(profileExtensionsParameters, { action: "add", id: "https://github.com/a/b" }),
    ).toBe(false);
    expect(JSON.stringify(profileExtensionsParameters)).toContain('"type":"object"');
  });

  test("delegates each action directly and returns bounded structured success details", async () => {
    const calls: Array<ReadonlyArray<unknown>> = [];
    const profilePath = "/trusted/profile";

    const tool = createProfileExtensionTool(profilePath, makeStub(calls), () => Effect.succeed([]));

    const listed = await invoke(tool, { action: "list" });
    const added = await invoke(tool, { action: "add", id: "alpha", source: "shelf" });
    const removed = await invoke(tool, { action: "remove", id: "alpha", source: "shelf" });
    const validated = await invoke(tool, { action: "validate" });

    expect(calls).toEqual([
      ["list", profilePath],
      ["add", { path: profilePath, name: "profile" }, "alpha"],
      ["remove", { path: profilePath, name: "profile" }, "alpha"],
      ["validate", { path: profilePath, name: "profile" }],
    ]);
    expect(listed.details).toMatchObject({
      ok: true,
      operation: "list",
      stage: "complete",
      code: "listed",
      selectionChanged: false,
      result: {
        available: [
          {
            id: "alpha",
            description: "Alpha shelf package",
            kind: "skill",
            source: "profile",
          },
          {
            id: "weather",
            description: "Bundled weather package",
            kind: "skill",
            source: "bundled",
          },
        ],
        selected: ["alpha"],
        truncated: false,
      },
    });
    expect(added.details).toMatchObject({
      ok: true,
      operation: "add",
      stage: "complete",
      id: "alpha",
      source: "shelf",
      code: "selected",
      selectionChanged: true,
      result: { id: "alpha", changed: true, selected: true },
    });
    expect(removed.details).toMatchObject({
      ok: true,
      operation: "remove",
      stage: "complete",
      id: "alpha",
      source: "shelf",
      code: "removed",
      selectionChanged: true,
      result: { id: "alpha", changed: true, selected: false },
    });
    expect(validated.details).toMatchObject({
      ok: true,
      operation: "validate",
      stage: "complete",
      code: "validated",
      selectionChanged: false,
      result: {
        selected: ["alpha"],
        preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
        truncated: false,
      },
    });
    expect(Value.Check(profileExtensionToolDetailsSchema, listed.details)).toBe(true);
    expect(Value.Check(profileExtensionToolDetailsSchema, added.details)).toBe(true);
  });

  test("warns and returns an empty broken list when health inspection fails", async () => {
    const tool = createProfileExtensionTool("/trusted/profile", makeStub([]), () =>
      Effect.fail(
        new ProfileExtensionPreflightFailed({
          profilePath: "/trusted/profile",
          stage: "extensions",
          message: "inspection failed",
          diagnostics: [],
          cause: undefined,
        }),
      ),
    );

    const listed = await invoke(tool, { action: "list" });

    expect(listed.details).toMatchObject({
      ok: true,
      result: { broken: [], healthWarning: true },
    });
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining("WARNING") });
  });

  test("projects typed failures without exposing causes or unbounded text", async () => {
    const failure = new ProfileExtensionPreflightFailed({
      profilePath: "/trusted/profile",
      stage: "skills",
      message: `bad skill\n${"x".repeat(600)}`,
      diagnostics: [{ source: "skills/broken", message: "missing entrypoint" }],
      cause: new Error("private cause"),
    });

    const profileExtensions: ProfileExtensionsApi = {
      ...makeStub([]),
      add: () => Effect.fail(failure),
    };

    const tool = createProfileExtensionTool("/trusted/profile", profileExtensions);

    const response = await invoke(tool, { action: "add", id: "alpha", source: "shelf" });

    expect(response.content[0]).toMatchObject({ type: "text" });
    expect(response.content[0]?.type === "text" ? response.content[0].text : "").toContain(
      "ERROR: add failed [stage=skills; code=preflight_failed]",
    );
    expect(response.details).toMatchObject({
      ok: false,
      operation: "add",
      stage: "skills",
      code: "preflight_failed",
      id: "alpha",
      source: "shelf",
      selectionChanged: false,
      diagnostics: [{ source: "skills/broken", message: "missing entrypoint" }],
    });

    if (response.details.ok) throw new Error("expected a structured tool failure");
    expect(response.details.message.length).toBeLessThanOrEqual(360);
    expect(response.details.message).not.toContain("\n");
    expect(response.details).not.toHaveProperty("cause");
    expect(Value.Check(profileExtensionToolDetailsSchema, response.details)).toBe(true);
  });
});

describe("profile_extensions real service boundary", () => {
  test("adds an existing shelf package with an empty PATH and no process-spawn seam", async () => {
    const fixture = await makeProfileFixture();
    await writeShelfPackage(fixture.profilePath, "local");

    const service = makeProfileExtensions(
      makeProfileExtensionPreflight(),
      makeProfileExtensionMutationLock(),
    );

    const tool = createProfileExtensionTool(fixture.profilePath, service);

    const previousPath = process.env.PATH;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let spawnCalls = 0;
    Bun.spawn = (...args) => {
      spawnCalls += 1;
      void args;
      throw new Error("process spawning is forbidden in profile_extensions");
    };

    Bun.spawnSync = (...args) => {
      spawnCalls += 1;
      void args;
      throw new Error("process spawning is forbidden in profile_extensions");
    };

    process.env.PATH = "";

    try {
      const response = await invoke(tool, { action: "add", id: "local", source: "shelf" });
      expect(response.details).toMatchObject({
        ok: true,
        operation: "add",
        stage: "complete",
        id: "local",
        source: "shelf",
        code: "selected",
        selectionChanged: true,
      });
      expect(spawnCalls).toBe(0);
      expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(
        '{\n  "extensions": [\n    "local"\n  ]\n}\n',
      );
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;

      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("list names skipped broken packages and their diagnostic", async () => {
  const tool = createProfileExtensionTool("/profile", makeStub([]), () =>
    Effect.succeed([
      {
        id: "broken",
        diagnostics: [{ source: "/profile/extensions/broken/index.ts", message: "missing module" }],
      },
    ]),
  );

  const result = await invoke(tool, { action: "list" });

  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("BROKEN skipped=broken: missing module"),
  });
  expect(result.details).toMatchObject({
    ok: true,
    result: { broken: [{ id: "broken", diagnostics: [{ message: "missing module" }] }] },
  });
});
