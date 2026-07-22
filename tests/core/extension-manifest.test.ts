import { expect, test } from "bun:test";
import {
  decodeExtensionManifest,
  decodeExtensionManifestJson,
  type ExtensionManifest,
} from "../../packages/core/src/extensions/index.ts";
import { runEffect } from "../testkit/effect.ts";

const validManifest = {
  schemaVersion: 1,
  id: "executor",
  version: "1.0.0",
  name: "Executor",
  description: "Runs approved skill-runner commands.",
  ziggy: { requires: ">=0.1.0 <1.0.0" },
  skills: [{ id: "executor", path: "skills/executor" }],
  adapters: [],
  setup: {
    steps: [{ argv: ["bun", "setup/verify"] }],
    doctor: { argv: ["bun", "setup/doctor"] },
  },
  requires: { env: [], commands: ["bun"], os: ["darwin", "linux"] },
  permissions: { network: false, filesystem: "profile", secrets: [] },
  distribution: { source: "builtin:executor", license: "Apache-2.0" },
} satisfies ExtensionManifest;

test("Extension manifest schema decodes a strict Ziggy-native manifest", async () => {
  expect(await runEffect(decodeExtensionManifest(validManifest))).toEqual(validManifest);
  expect(await runEffect(decodeExtensionManifestJson(JSON.stringify(validManifest)))).toEqual(
    validManifest,
  );
});

test("Extension manifest schema rejects malformed and unknown fields", async () => {
  const invalid = [
    { ...validManifest, schemaVersion: 2 },
    { ...validManifest, id: "Executor" },
    { ...validManifest, version: "latest" },
    { ...validManifest, extra: true },
    { ...validManifest, ziggy: {} },
    { ...validManifest, ziggy: { ...validManifest.ziggy, extra: true } },
    { ...validManifest, adapters: [{ id: "gateway" }] },
  ];

  for (const manifest of invalid) {
    await expect(runEffect(decodeExtensionManifest(manifest))).rejects.toThrow();
  }
});

test("Extension manifest schema rejects unsafe paths and resource identity mismatches", async () => {
  const invalidPaths = [
    "/skills/executor",
    "../skills/executor",
    "skills/../executor",
    "skills//executor",
    "skills/./executor",
    "skills\\executor",
    "C:/skills/executor",
    "C:skills/executor",
  ];

  for (const path of invalidPaths) {
    await expect(
      runEffect(
        decodeExtensionManifest({
          ...validManifest,
          skills: [{ id: "executor", path }],
        }),
      ),
    ).rejects.toThrow();
  }

  const invalidResources = [
    [{ id: "executor", path: "skills/not-executor" }],
    [
      { id: "executor", path: "skills/executor" },
      { id: "executor", path: "other/executor" },
    ],
  ];
  for (const skills of invalidResources) {
    await expect(
      runEffect(decodeExtensionManifest({ ...validManifest, skills })),
    ).rejects.toThrow();
  }
});

test("Extension manifest schema accepts argv arrays and rejects shell command strings", async () => {
  await expect(
    runEffect(
      decodeExtensionManifest({
        ...validManifest,
        setup: { steps: [{ command: "bun setup/verify" }] },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    runEffect(
      decodeExtensionManifest({
        ...validManifest,
        setup: { steps: [{ argv: [] }] },
      }),
    ),
  ).rejects.toThrow();
});
