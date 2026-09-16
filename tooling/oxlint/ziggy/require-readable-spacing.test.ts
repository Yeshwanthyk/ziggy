/* oxlint-disable ziggy-effect/no-json-parse -- The Oxlint CLI emits a bounded JSON diagnostic report. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

const oxlintCli = join(repositoryRoot, "node_modules/oxlint/bin/oxlint");

const temporaryRoots: string[] = [];

const source = `import { first } from "first";
import { second } from "second";
export const total = first + second;
function read(value: string) {
  const local = value.trim();
  const next = local;
  return next;
}
function overloaded(value: string): string;
function overloaded(value: number): number;
function overloaded(value: string | number) {
  return String(value);
}
`;

const fixedSource = `import { first } from "first";
import { second } from "second";

export const total = first + second;

function read(value: string) {
  const local = value.trim();
  const next = local;

  return next;
}

function overloaded(value: string): string;
function overloaded(value: number): number;
function overloaded(value: string | number) {
  return String(value);
}
`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("enforces readable spacing and reaches a stable autofixed result", () => {
  const root = mkdtempSync(join(tmpdir(), "ziggy-readable-spacing-"));
  temporaryRoots.push(root);
  const fixturePath = join(root, "fixture.ts");
  const configPath = join(root, "oxlint.json");
  writeFileSync(fixturePath, source);
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [join(repositoryRoot, "tooling/oxlint/ziggy-plugin.mjs")],
      rules: { "ziggy/require-readable-spacing": "error" },
    }),
  );

  const run = (...args: string[]) =>
    Bun.spawnSync({
      cmd: [oxlintCli, "-A", "all", ...args, "--config", configPath, fixturePath],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

  const rejected = run("--format=json");
  const rejectedStdout = new TextDecoder().decode(rejected.stdout);
  const rejectedStderr = new TextDecoder().decode(rejected.stderr);
  expect(rejected.exitCode).toBe(1);
  expect(rejectedStderr).toBe("");
  const report = JSON.parse(rejectedStdout);
  expect(report.diagnostics.length).toBe(4);
  expect(
    report.diagnostics.every(
      (diagnostic: { code: string }) => diagnostic.code === "ziggy(require-readable-spacing)",
    ),
  ).toBe(true);

  const fixed = run("--fix");
  expect(fixed.exitCode).toBe(0);
  expect(new TextDecoder().decode(fixed.stderr)).toBe("");
  expect(readFileSync(fixturePath, "utf8")).toBe(fixedSource);

  const stable = readFileSync(fixturePath, "utf8");
  const clean = run("--format=json");
  expect(clean.exitCode).toBe(0);
  const repeated = run("--fix");
  expect(repeated.exitCode).toBe(0);
  expect(readFileSync(fixturePath, "utf8")).toBe(stable);
});
