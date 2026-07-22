import { expect, test } from "bun:test";
import {
  decodeExtensionManifestJson,
  isZiggyVersionCompatible,
} from "../../packages/core/src/extensions/index.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

const manifest = {
  schemaVersion: 1,
  id: "fixture-extension",
  version: "1.2.3+build.7",
  name: "Fixture Extension",
  description: "Provides the S4 compatibility fixture.",
  ziggy: { requires: ">=1.5.0-alpha <2.0.0" },
  skills: [{ id: "fixture-skill", path: "skills/fixture-skill" }],
  adapters: [],
  requires: { env: [], commands: [], os: [] },
  permissions: { network: false, filesystem: "none", secrets: [] },
  distribution: { source: "fixture:local", license: "Apache-2.0" },
};

test("S4 manifest version compatibility is strict, build-aware, and prerelease-gated", async () => {
  const decoded = await runEffect(decodeExtensionManifestJson(JSON.stringify(manifest)));
  expect(isZiggyVersionCompatible(decoded.ziggy.requires, "1.5.0-beta")).toBe(true);
  expect(isZiggyVersionCompatible(decoded.ziggy.requires, "2.0.0")).toBe(false);

  const json = JSON.stringify(manifest);
  const duplicates = [
    json.replace('"version":"1.2.3+build.7"', '"version":"1.2.3","version":"2.0.0"'),
    json.replace(
      '"requires":">=1.5.0-alpha <2.0.0"',
      '"requires":">=1.5.0-alpha <2.0.0","requires":"*"',
    ),
  ];
  for (const duplicate of duplicates) {
    await expect(runEffect(decodeExtensionManifestJson(duplicate))).rejects.toThrow();
  }

  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    [">=1.2.3", "1.2.4-alpha", false],
    [">=1.2.3 <2.0.0", "1.5.0-alpha", false],
    [">=1.2.3-alpha <2.0.0", "1.5.0-alpha", false],
    [">=1.5.0-alpha <2.0.0", "1.5.0-beta", true],
    ["=1.2.3+manifest", "1.2.3+running", true],
    [">999999999999999999999999999998.0.0", "999999999999999999999999999999.0.0", true],
  ];
  for (const [range, runningVersion, compatible] of cases) {
    expect(isZiggyVersionCompatible(range, runningVersion)).toBe(compatible);
  }

  emitVerificationObservation("s4.manifest-version-compatibility", emptyRuntimeObservations());
});
