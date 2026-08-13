import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  STANDALONE_TARGET,
  assertSafeStandaloneOutputPath,
  assertStandaloneWorktreePolicy,
  compileArguments,
  decodeStandaloneBuildReport,
  parseStandaloneBuildArguments,
  sandboxProfile,
} from "./standalone-executable.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "ziggy-standalone-helper-"));
  roots.push(root);
  return root;
};

test("refuses unsafe standalone output paths and accepts a regular file or new path", () => {
  const root = tempRoot();
  const filePath = path.join(root, "ziggy");
  writeFileSync(filePath, "ok");
  mkdirSync(path.join(root, "dir"));

  expect(() => assertSafeStandaloneOutputPath(root, root)).toThrow(
    "refusing unsafe standalone output path",
  );
  expect(() => assertSafeStandaloneOutputPath("/", root)).toThrow(
    "refusing unsafe standalone output path",
  );
  expect(() => assertSafeStandaloneOutputPath(path.join(root, "dir"), root)).toThrow(
    "standalone output must be a regular file or a new path",
  );
  expect(assertSafeStandaloneOutputPath(filePath, root)).toBe(filePath);
  expect(assertSafeStandaloneOutputPath(path.join(root, "missing"), root)).toBe(
    path.join(root, "missing"),
  );
});

test("release builds require a clean worktree and development builds record dirty entries", () => {
  expect(() => assertStandaloneWorktreePolicy(false, [" M src/main.ts"])).toThrow(
    "release build requires a clean worktree",
  );
  expect(() => assertStandaloneWorktreePolicy(true, [" M src/main.ts"])).not.toThrow();
  expect(() => assertStandaloneWorktreePolicy(false, [])).not.toThrow();
});

test("parses development and output flags and pins compile autoload isolation", () => {
  const root = "/repo";
  expect(parseStandaloneBuildArguments(["--development", "--output", "dist/custom"], root)).toEqual(
    {
      development: true,
      outputPath: path.join(root, "dist", "custom"),
    },
  );
  expect(() => parseStandaloneBuildArguments(["--ziggy-source-entry", "x"], root)).toThrow(
    "usage:",
  );
  expect(compileArguments()).toEqual([
    "build",
    "src/main.ts",
    "--compile",
    `--target=${STANDALONE_TARGET}`,
    "--root=.",
    "--asset-naming=[dir]/[name].[ext]",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
  ]);
});

test("sandbox profile denies every worktree and the network", () => {
  expect(sandboxProfile(["/Users/yesh/code/personal/ziggy", '/tmp/quote"path'], false)).toBe(
    [
      "(version 1)",
      "(allow default)",
      '(deny file-read* (subpath "/Users/yesh/code/personal/ziggy"))',
      '(deny file-write* (subpath "/Users/yesh/code/personal/ziggy"))',
      '(deny file-read* (subpath "/tmp/quote\\"path"))',
      '(deny file-write* (subpath "/tmp/quote\\"path"))',
      "(deny network*)",
    ].join("\n"),
  );
});

test("build report decode requires catalog and Pi docs fingerprints", () => {
  const report = {
    formatVersion: 1,
    artifact: "dist/ziggy",
    artifactBytes: 12,
    artifactSha256: "a".repeat(64),
    buildMode: "development",
    releaseReady: false,
    sourceCommit: "abc",
    sourceDirty: true,
    dirtyEntries: [" M src/main.ts"],
    bunVersion: "1.3.13",
    target: STANDALONE_TARGET,
    buildArguments: compileArguments(),
    lockSha256: "b".repeat(64),
    catalogFingerprint: "c".repeat(64),
    piDocsFingerprint: "d".repeat(64),
    piVersion: "0.84.1",
    piDocsCount: 31,
  };
  expect(decodeStandaloneBuildReport(`${JSON.stringify(report)}\n`)).toEqual(report);
  const { piDocsFingerprint: _omitted, ...missingFingerprint } = report;
  expect(() => decodeStandaloneBuildReport(`${JSON.stringify(missingFingerprint)}\n`)).toThrow();
});
