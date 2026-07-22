import { expect, test } from "bun:test";
import {
  decodeExtensionManifest,
  decodeExtensionManifestJson,
  type ExtensionManifest,
  isZiggyVersionCompatible,
} from "../../packages/core/src/extensions/index.ts";
import { runEffect } from "../testkit/effect.ts";

const validManifest = {
  schemaVersion: 1,
  id: "fixture-extension",
  version: "1.2.3",
  name: "Fixture Extension",
  description: "Provides a deterministic fixture capability.",
  ziggy: { requires: ">=1.0.0 <2.0.0" },
  skills: [{ id: "fixture-skill", path: "skills/fixture-skill" }],
  adapters: [],
  setup: {
    steps: [{ argv: ["bun", "setup/verify"] }],
    doctor: { argv: ["bun", "setup/doctor"] },
  },
  requires: { env: [], commands: ["bun"], os: ["darwin", "linux"] },
  permissions: { network: false, filesystem: "profile", secrets: [] },
  distribution: { source: "fixture:local", license: "Apache-2.0" },
} satisfies ExtensionManifest;

async function expectManifestRejected(input: unknown): Promise<void> {
  await expect(runEffect(decodeExtensionManifest(input))).rejects.toThrow();
}

async function expectManifestCompatibility(
  manifest: unknown,
  runningZiggyVersion: string,
  expected: boolean,
): Promise<void> {
  const decoded = await runEffect(decodeExtensionManifest(manifest));
  expect(isZiggyVersionCompatible(decoded.ziggy.requires, runningZiggyVersion)).toBe(expected);
}

test("Extension manifest schema decodes a strict Ziggy-native manifest", async () => {
  expect(await runEffect(decodeExtensionManifest(validManifest))).toEqual(validManifest);
  expect(await runEffect(decodeExtensionManifestJson(JSON.stringify(validManifest)))).toEqual(
    validManifest,
  );
});

test("Extension manifest schema accepts canonical SemVer versions", async () => {
  const acceptedVersions = [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-0A.a-1",
    "1.2.3+build.7",
    "1.2.3-alpha.1+build.7",
    "999999999999999999999999.2.3",
  ];

  for (const version of acceptedVersions) {
    expect(await runEffect(decodeExtensionManifest({ ...validManifest, version }))).toMatchObject({
      version,
    });
  }
});

test("Extension manifest schema rejects non-canonical SemVer versions", async () => {
  const rejectedVersions = [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2",
    "v1.2.3",
    "1.2.3-",
    "1.2.3-alpha..1",
    "1.2.3-01",
    "1.2.3+",
    "1.2.3+build..1",
    "1.2.3-α",
    "latest",
  ];

  for (const version of rejectedVersions) {
    await expectManifestRejected({ ...validManifest, version });
  }
});

test("Extension manifest schema accepts only strict comparator ranges", async () => {
  const acceptedRanges = [
    "1.2.3",
    "=1.2.3",
    ">1.2.3",
    ">=1.2.3",
    "<2.0.0",
    "<=2.0.0",
    ">=1.0.0 <2.0.0",
    ">=1.0.0 <2.0.0 || >=3.0.0 <4.0.0",
    ">=1.2.3-beta.1 <1.2.3",
  ];
  const rejectedRanges = [
    "^1.2.3",
    "~1.2.3",
    "*",
    "1.x",
    "1.2",
    "1.2.3 - 2.0.0",
    ">=1.0.0, <2.0.0",
    ">=1.0.0  <2.0.0",
    ">=1.0.0\t<2.0.0",
    ">=1.0.0||<2.0.0",
    ">=1.0.0 ||  <2.0.0",
    "v1.2.3",
    "",
  ];

  for (const requires of acceptedRanges) {
    expect(
      await runEffect(decodeExtensionManifest({ ...validManifest, ziggy: { requires } })),
    ).toMatchObject({ ziggy: { requires } });
  }
  for (const requires of rejectedRanges) {
    await expectManifestRejected({ ...validManifest, ziggy: { requires } });
  }
});

test("Extension compatibility uses the explicit running Ziggy version", async () => {
  await expectManifestCompatibility(validManifest, "1.0.0", true);
  await expectManifestCompatibility(validManifest, "1.9.999", true);
  await expectManifestCompatibility(validManifest, "0.9.9", false);
  await expectManifestCompatibility(validManifest, "2.0.0", false);
  await expectManifestCompatibility(validManifest, "not-a-version", false);
});

test("Extension compatibility applies the SemVer prerelease clause rule", async () => {
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.2.3" } },
    "1.2.4-alpha",
    false,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.2.3 <2.0.0" } },
    "1.5.0-alpha",
    false,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.2.3-alpha <2.0.0" } },
    "1.5.0-alpha",
    false,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.5.0-alpha <2.0.0" } },
    "1.5.0-beta",
    true,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.2.3-beta.1 <2.0.0" } },
    "1.2.3-beta.2",
    true,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.0.0 <2.0.0" } },
    "1.2.3-beta.2",
    false,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: ">=1.2.4-beta.1 <2.0.0" } },
    "1.2.3-beta.2",
    false,
  );
  await expectManifestCompatibility(
    { ...validManifest, ziggy: { requires: "=1.2.3+required-build" } },
    "1.2.3+host-build",
    true,
  );
});

test("Extension manifest schema enforces required v1 fields", async () => {
  const missingRequiredFields = [
    { ...validManifest, skills: undefined },
    { ...validManifest, adapters: undefined },
    { ...validManifest, requires: undefined },
    { ...validManifest, permissions: undefined },
    { ...validManifest, distribution: undefined },
  ];

  for (const manifest of missingRequiredFields) {
    await expect(
      runEffect(decodeExtensionManifestJson(JSON.stringify(manifest))),
    ).rejects.toThrow();
  }
});

test("Extension manifest schema enforces capability and cross-field invariants", async () => {
  const invalid = [
    { ...validManifest, skills: [] },
    { ...validManifest, tools: [] },
    {
      ...validManifest,
      defaults: { model: "fixture-model" },
    },
    {
      ...validManifest,
      requires: { ...validManifest.requires, env: [] },
      permissions: { ...validManifest.permissions, secrets: ["FIXTURE_TOKEN"] },
    },
    {
      ...validManifest,
      setup: { steps: [{ argv: ["node", "setup/verify"] }] },
    },
    {
      ...validManifest,
      skills: [{ id: "fixture-skill", path: "other/fixture-skill" }],
    },
    {
      ...validManifest,
      tools: [{ id: "fixture-tool", path: "other/fixture-tool" }],
    },
  ];

  for (const manifest of invalid) {
    await expectManifestRejected(manifest);
  }

  const toolOnly = {
    ...validManifest,
    skills: [],
    tools: [{ id: "fixture-tool", path: "tools/fixture-tool" }],
  };
  expect(await runEffect(decodeExtensionManifest(toolOnly))).toEqual(toolOnly);
});

test("Extension manifest schema rejects package-authored provenance and trust", async () => {
  const invalid = [
    {
      ...validManifest,
      provenance: { origin: "fixture", signature: "self-asserted" },
    },
    { ...validManifest, trustTier: "verified" },
  ];

  for (const manifest of invalid) {
    await expectManifestRejected(manifest);
  }
});

test("Extension manifest JSON rejects duplicate keys at every nesting depth", async () => {
  const json = JSON.stringify(validManifest);
  const duplicates = [
    json.replace('"id":"fixture-extension"', '"id":"fixture-shadow","id":"fixture-extension"'),
    json.replace('"requires":">=1.0.0 <2.0.0"', '"requires":">=1.0.0 <2.0.0","requires":">=0.0.0"'),
    json.replace('"name":"Fixture Extension"', '"name":"Fixture Extension","\\u006eame":"Shadow"'),
  ];
  for (const duplicate of duplicates) {
    await expect(runEffect(decodeExtensionManifestJson(duplicate))).rejects.toThrow();
  }
});

test("Extension manifest schema rejects malformed and unknown fields", async () => {
  const invalid = [
    { ...validManifest, schemaVersion: 2 },
    { ...validManifest, id: "Fixture-Extension" },
    { ...validManifest, extra: true },
    { ...validManifest, ziggy: {} },
    { ...validManifest, ziggy: { ...validManifest.ziggy, extra: true } },
    { ...validManifest, adapters: [{ id: "gateway" }] },
  ];

  for (const manifest of invalid) {
    await expectManifestRejected(manifest);
  }
});

test("Extension manifest schema rejects unsafe paths and resource identity mismatches", async () => {
  const invalidPaths = [
    "/skills/fixture-skill",
    "../skills/fixture-skill",
    "skills/../fixture-skill",
    "skills//fixture-skill",
    "skills/./fixture-skill",
    "skills\\fixture-skill",
    "C:/skills/fixture-skill",
    "C:skills/fixture-skill",
  ];

  for (const path of invalidPaths) {
    await expectManifestRejected({
      ...validManifest,
      skills: [{ id: "fixture-skill", path }],
    });
  }

  const invalidResources = [
    [{ id: "fixture-skill", path: "skills/not-fixture-skill" }],
    [
      { id: "fixture-skill", path: "skills/fixture-skill" },
      { id: "fixture-skill", path: "other/fixture-skill" },
    ],
  ];
  for (const skills of invalidResources) {
    await expectManifestRejected({ ...validManifest, skills });
  }
});

test("Extension manifest schema accepts argv arrays and rejects shell command strings", async () => {
  await expectManifestRejected({
    ...validManifest,
    setup: { steps: [{ command: "bun setup/verify" }] },
  });
  await expectManifestRejected({
    ...validManifest,
    setup: { steps: [{ argv: [] }] },
  });
});
