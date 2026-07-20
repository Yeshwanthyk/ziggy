import { describe, expect, test } from "bun:test";
import { cp, link, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenarioRegistry } from "../scenarios/registry.ts";
import {
  decodeManifest,
  loadManifests,
  transitiveManifests,
  validateManifestRegistry,
  validateSchemaFiles,
  type VerificationManifest,
} from "../../tooling/verification/manifests.ts";

const root = new URL("../..", import.meta.url).pathname;

async function validManifests(): Promise<ReadonlyArray<VerificationManifest>> {
  return loadManifests(root);
}

describe("verification manifest integrity", () => {
  test("tracked schemas, exact manifests, and registry are valid and bijective", async () => {
    const manifests = await validManifests();
    await expect(
      validateManifestRegistry(root, manifests, scenarioRegistry),
    ).resolves.toBeUndefined();
    await expect(validateSchemaFiles(root)).resolves.toBeUndefined();
  });

  test("wrong primitive types, unsupported versions, unknown stages, fields, and gates fail", () => {
    expect(() => decodeManifest(manifestValue({ schemaVersion: "1" }))).toThrow();
    expect(() => decodeManifest(manifestValue({ schemaVersion: 2 }))).toThrow("unsupported");
    expect(() => decodeManifest(manifestValue({ stage: "s8" }))).toThrow("unknown stage");
    expect(() => decodeManifest(manifestValue({ gates: ["invented"] }))).toThrow("unknown gate");
    expect(() => decodeManifest(manifestValue({ extra: true }))).toThrow("unknown field");
  });

  test("malformed registry primitives fail through schema validation with index labels", async () => {
    const manifests = await validManifests();
    for (const malformed of [null, true, 7, "scenario"]) {
      await expect(validateManifestRegistry(root, manifests, [malformed])).rejects.toThrow(
        "scenario registry[0]: schema validation failed: data must be object",
      );
    }
  });

  test("missing and duplicate manifest sets fail closed", async () => {
    const manifests = await validManifests();
    await expect(
      validateManifestRegistry(root, manifests.slice(1), scenarioRegistry),
    ).rejects.toThrow("missing manifest");
    const first = manifests[0];
    if (first === undefined) {
      throw new Error("missing manifest fixture");
    }
    await expect(
      validateManifestRegistry(root, [...manifests, first], scenarioRegistry),
    ).rejects.toThrow("duplicate manifest");
  });

  test("self, missing, future, cyclic, and out-of-order predecessor declarations fail", async () => {
    const manifests = await validManifests();
    const s1 = requireManifest(manifests, "s1");
    const s2 = requireManifest(manifests, "s2");
    for (const predecessors of [["s1"], [], ["s0", "s3"], ["s0", "s2"], ["s1", "s0"]]) {
      const replacement = { ...s2, predecessors: decodeStages(predecessors) };
      await expect(
        validateManifestRegistry(root, replaceManifest(manifests, replacement), scenarioRegistry),
      ).rejects.toThrow("predecessors");
    }
    await expect(
      validateManifestRegistry(
        root,
        replaceManifest(manifests, { ...s1, predecessors: ["s1"] }),
        scenarioRegistry,
      ),
    ).rejects.toThrow("predecessors");
  });

  test("duplicate and undeclared scenarios and duplicate paths fail closed", async () => {
    const manifests = await validManifests();
    const s0 = requireManifest(manifests, "s0");
    const unknown = replaceManifest(manifests, {
      ...s0,
      scenarios: [...s0.scenarios, "s0.unknown"],
    });
    await expect(validateManifestRegistry(root, unknown, scenarioRegistry)).rejects.toThrow(
      "unknown",
    );

    const firstScenario = scenarioRegistry[0];
    const secondScenario = scenarioRegistry[1];
    if (firstScenario === undefined || secondScenario === undefined) {
      throw new Error("missing registry fixtures");
    }
    await expect(
      validateManifestRegistry(root, manifests, [...scenarioRegistry, firstScenario]),
    ).rejects.toThrow("duplicate registry scenario");
    await expect(
      validateManifestRegistry(root, manifests, [
        firstScenario,
        { ...secondScenario, file: firstScenario.file },
        ...scenarioRegistry.slice(2),
      ]),
    ).rejects.toThrow("duplicate registry scenario path");
    await expect(
      validateManifestRegistry(root, manifests, scenarioRegistry.slice(1)),
    ).rejects.toThrow("unknown");
  });

  test("missing, outside, non-test, and non-normalized scenario paths fail", async () => {
    const manifests = await validManifests();
    const first = scenarioRegistry[0];
    if (first === undefined) {
      throw new Error("missing registry fixture");
    }
    for (const file of [
      "tests/scenarios/missing.test.ts",
      "tests/scenarios/registry.ts",
      "../outside.test.ts",
      "tests/scenarios/../scenarios/s0.scenarios.test.ts",
    ]) {
      await expect(
        validateManifestRegistry(root, manifests, [
          { ...first, file },
          ...scenarioRegistry.slice(1),
        ]),
      ).rejects.toThrow();
    }
  });

  test("rejects a regular scenario file reached through an escaping directory symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ziggy-manifest-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "ziggy-manifest-outside-"));
    try {
      await mkdir(join(directory, "verification"), { recursive: true });
      await cp(join(root, "verification/schemas"), join(directory, "verification/schemas"), {
        recursive: true,
      });
      await mkdir(join(outside, "testkit"), { recursive: true });
      await Bun.write(join(outside, "testkit/boundaries.test.ts"), "export {};\n");
      await symlink(outside, join(directory, "tests"), "dir");

      const manifests = await validManifests();
      const first = scenarioRegistry[0];
      if (first === undefined) {
        throw new Error("missing registry fixture");
      }
      await expect(validateManifestRegistry(directory, manifests, [first])).rejects.toThrow(
        "scenario path must not contain symbolic links",
      );
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  test("rejects a scenario file reached through an internal directory symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ziggy-manifest-internal-symlink-"));
    try {
      await mkdir(join(directory, "verification"), { recursive: true });
      await cp(join(root, "verification/schemas"), join(directory, "verification/schemas"), {
        recursive: true,
      });
      await mkdir(join(directory, "tests/actual"), { recursive: true });
      await Bun.write(join(directory, "tests/actual/boundaries.test.ts"), "export {};\n");
      await symlink("actual", join(directory, "tests/testkit"), "dir");

      const manifests = await validManifests();
      const first = scenarioRegistry[0];
      if (first === undefined) {
        throw new Error("missing registry fixture");
      }
      await expect(validateManifestRegistry(directory, manifests, [first])).rejects.toThrow(
        "scenario path must not contain symbolic links",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects duplicate scenario registrations through physical file aliases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ziggy-manifest-alias-duplicate-"));
    try {
      await mkdir(join(directory, "verification"), { recursive: true });
      await cp(join(root, "verification/schemas"), join(directory, "verification/schemas"), {
        recursive: true,
      });
      await mkdir(join(directory, "tests/scenarios"), { recursive: true });
      const original = join(directory, "tests/scenarios/original.test.ts");
      await Bun.write(original, "export {};\n");
      await link(original, join(directory, "tests/scenarios/alias.test.ts"));

      const manifests = await validManifests();
      const first = scenarioRegistry[0];
      const second = scenarioRegistry[1];
      if (first === undefined || second === undefined) {
        throw new Error("missing registry fixtures");
      }
      await expect(
        validateManifestRegistry(directory, manifests, [
          { ...first, file: "tests/scenarios/original.test.ts" },
          { ...second, file: "tests/scenarios/alias.test.ts" },
        ]),
      ).rejects.toThrow("duplicate registry scenario path");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("status/content contradictions and duplicate requirements fail closed", async () => {
    const manifests = await validManifests();
    const s0 = requireManifest(manifests, "s0");
    const s1 = requireManifest(manifests, "s1");
    const s2 = requireManifest(manifests, "s2");
    await expect(
      validateManifestRegistry(
        root,
        replaceManifest(manifests, { ...s0, gates: [] }),
        scenarioRegistry,
      ),
    ).rejects.toThrow("declare gates");
    await expect(
      validateManifestRegistry(
        root,
        replaceManifest(manifests, { ...s2, gates: ["test"] }),
        scenarioRegistry,
      ),
    ).rejects.toThrow("manifest-empty");
    const requirement = s1.requirements[0];
    if (requirement === undefined) {
      throw new Error("missing requirement fixture");
    }
    await expect(
      validateManifestRegistry(
        root,
        replaceManifest(manifests, { ...s1, requirements: [requirement, requirement] }),
        scenarioRegistry,
      ),
    ).rejects.toThrow("duplicate");
  });

  test("transitive selection follows declarations and de-duplicates", async () => {
    const manifests = await validManifests();
    expect(transitiveManifests(manifests, ["s3"]).map((manifest) => manifest.stage)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
    ]);
    expect(transitiveManifests(manifests, ["s2", "s3"]).map((manifest) => manifest.stage)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
    ]);
  });
});

function manifestValue(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    stage: "s0",
    status: "implemented",
    predecessors: [],
    scenarios: ["s0.fixture"],
    gates: ["test"],
    requirements: [],
    ...overrides,
  };
}

function requireManifest(
  manifests: ReadonlyArray<VerificationManifest>,
  stage: VerificationManifest["stage"],
): VerificationManifest {
  const manifest = manifests.find((candidate) => candidate.stage === stage);
  if (manifest === undefined) {
    throw new Error(`missing ${stage} fixture`);
  }
  return manifest;
}

function replaceManifest(
  manifests: ReadonlyArray<VerificationManifest>,
  replacement: VerificationManifest,
): ReadonlyArray<VerificationManifest> {
  return manifests.map((manifest) =>
    manifest.stage === replacement.stage ? replacement : manifest,
  );
}

function decodeStages(values: ReadonlyArray<string>): ReadonlyArray<VerificationManifest["stage"]> {
  return values.map((value) => decodeManifest(manifestValue({ stage: value })).stage);
}
