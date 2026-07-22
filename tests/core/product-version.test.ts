import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ZIGGY_VERSION } from "../../packages/core/src/product-version.ts";
import rootPackage from "../../package.json";
import corePackage from "../../packages/core/package.json";
import protocolPackage from "../../packages/protocol/package.json";
import tuiPackage from "../../packages/tui/package.json";
import ziggyPackage from "../../packages/ziggy/package.json";

test("root package version is the product authority and workspace versions mirror it", () => {
  expect(ZIGGY_VERSION).toBe(rootPackage.version);
  expect([
    corePackage.version,
    protocolPackage.version,
    tuiPackage.version,
    ziggyPackage.version,
  ]).toEqual(Array.from({ length: 4 }, () => rootPackage.version));
});

test("product surfaces do not embed a second Ziggy version literal", () => {
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["packages/ziggy/src/auth-client.ts", "version: ZIGGY_VERSION"],
    ["packages/ziggy/src/cli-client.ts", "version: ZIGGY_VERSION"],
    ["packages/ziggy/src/cli.ts", "dependencies.output(ZIGGY_VERSION)"],
    ["packages/ziggy/src/daemon.ts", "version: ZIGGY_VERSION"],
    ["tooling/verification/compile-smoke.ts", "version.stdout.trim() !== ZIGGY_VERSION"],
  ];
  for (const [path, rootVersionUse] of surfaces) {
    const source = readFileSync(path, "utf8");
    expect(source).toContain(rootVersionUse);
    expect(source.match(/"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"/g)).toBeNull();
  }
});
