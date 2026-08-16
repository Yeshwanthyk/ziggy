import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../..");
const oxlint = join(repositoryRoot, "node_modules/.bin/oxlint");
const temporaryRoots: Array<string> = [];

const config = `{
  "jsPlugins": ["./tooling/oxlint/ziggy-plugin.mjs"],
  "rules": {
    "ziggy/no-module-mocking": "error",
    "ziggy/no-reflect-apply": "error",
    "ziggy/no-reflect-get": "error",
    "ziggy/no-runtime-typeof": "error",
    "ziggy/no-unknown-parameters": "error",
    "ziggy/no-unsafe-dictionary-type": "error",
    "ziggy/no-unsafe-typescript-syntax": "error",
    "ziggy/require-safety-comment-for-type-assertion": "error"
  }
}`;

const diagnostic = (rule: string, message: string): string => `${rule}|${message}`;

const parseDiagnostics = (output: string): Array<string> => {
  const diagnostics: Array<string> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^\d+ problems?$/u.test(trimmed)) continue;
    const match = trimmed.match(/^.+:\d+:\d+: (.+) \[(Error|Warning)\/(.+)\]$/u);
    expect(match).not.toBeNull();
    if (match === null) continue;
    const message = match[1] ?? "";
    const rawRule = match[3] ?? "";
    expect(message).not.toBe("");
    expect(rawRule).not.toBe("");
    const rule = rawRule.replace(/^ziggy\((.+)\)$/u, "ziggy/$1");
    diagnostics.push(diagnostic(rule, message));
  }
  return diagnostics.sort();
};

const lintFixture = (source: string): Array<string> => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ziggy-oxlint-parity-fixture-"));
  const configRoot = mkdtempSync(join(repositoryRoot, ".ziggy-oxlint-parity-config-"));
  const configPath = join(repositoryRoot, `.${basename(configRoot)}.json`);
  temporaryRoots.push(fixtureRoot, configRoot, configPath);

  const fixturePath = join(fixtureRoot, "fixture.ts");
  writeFileSync(fixturePath, source);
  writeFileSync(configPath, config);

  const result = Bun.spawnSync([oxlint, "-c", configPath, "-A", "all", "-f", "unix", fixturePath], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(stderr).toBe("");

  const diagnostics = parseDiagnostics(stdout);
  expect(result.exitCode).toBe(diagnostics.length === 0 ? 0 : 1);
  return diagnostics;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("reports global Reflect methods but not shadowed owners", () => {
  expect(
    lintFixture(`Reflect.get(value, "key");
Reflect.apply(fn, receiver, args);
function local(Reflect: { get: Function; apply: Function }) {
  Reflect.get(value, "key");
  Reflect.apply(fn, receiver, args);
}`),
  ).toEqual([
    diagnostic(
      "ziggy/no-reflect-apply",
      "Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
    ),
    diagnostic(
      "ziggy/no-reflect-get",
      "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    ),
  ]);
});

test("reports runtime typeof checks, including type guards", () => {
  expect(
    lintFixture(`if (typeof value === "string") value.trim();
function isString(value: string | number): value is string {
  return typeof value === "string";
}`),
  ).toEqual([
    diagnostic(
      "ziggy/no-runtime-typeof",
      "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
    ),
    diagnostic(
      "ziggy/no-runtime-typeof",
      "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
    ),
  ]);
});

test("keeps unsafe TypeScript syntax separate from safety-comment exemptions", () => {
  expect(
    lintFixture(`const loose: any = value;
const missing = value as string;
// SAFETY: value was decoded by the boundary schema.
const safe = value as string;
const nonNull = value!;
const literal = value as const;`),
  ).toEqual([
    diagnostic(
      "ziggy/no-unsafe-typescript-syntax",
      "Explicit any is forbidden; model the value precisely or use unknown.",
    ),
    diagnostic(
      "ziggy/no-unsafe-typescript-syntax",
      "Non-null assertions are forbidden; prove or handle nullability instead.",
    ),
    diagnostic(
      "ziggy/no-unsafe-typescript-syntax",
      "Type assertions are forbidden; narrow, decode, or construct the type instead.",
    ),
    diagnostic(
      "ziggy/no-unsafe-typescript-syntax",
      "Type assertions are forbidden; narrow, decode, or construct the type instead.",
    ),
    diagnostic(
      "ziggy/require-safety-comment-for-type-assertion",
      "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    ),
  ]);
});

test("exempts cause while rejecting other unknown parameters", () => {
  expect(
    lintFixture(`function read(input: unknown) {}
function preserve(cause: unknown) {}`),
  ).toEqual([
    diagnostic(
      "ziggy/no-unknown-parameters",
      "Parameter `input` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    ),
  ]);
});

test("reports nested unsafe dictionaries but accepts a concrete cause struct", () => {
  expect(
    lintFixture(`type UnsafeNested = Record<string, Record<string, unknown>>;
type SafeCauses = Record<string, { readonly cause: unknown }>;
type UnsafeAlias = Record<string, unknown>;
type Consumer = Record<string, UnsafeAlias>;`),
  ).toEqual([
    diagnostic(
      "ziggy/no-unsafe-dictionary-type",
      "This dictionary's unknown value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
    ),
    diagnostic(
      "ziggy/no-unsafe-dictionary-type",
      "This dictionary's unknown value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
    ),
    diagnostic(
      "ziggy/no-unsafe-dictionary-type",
      "This dictionary's unknown value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
    ),
  ]);
});

test("reports vi and jest mocking but not shadowed owners", () => {
  expect(
    lintFixture(`vi.mock("global");
jest.doMock("global");
vi["unstable_mockModule"]("global");
import { vi as importedVi } from "vitest";
import { jest as importedJest } from "@jest/globals";
importedVi.mock("imported");
importedJest.unstable_mockModule("imported");
function local(vi: { mock: Function }, jest: { doMock: Function }) {
  vi.mock("local");
  jest.doMock("local");
}`),
  ).toEqual([
    diagnostic(
      "ziggy/no-module-mocking",
      "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    ),
    diagnostic(
      "ziggy/no-module-mocking",
      "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    ),
    diagnostic(
      "ziggy/no-module-mocking",
      "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    ),
    diagnostic(
      "ziggy/no-module-mocking",
      "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    ),
    diagnostic(
      "ziggy/no-module-mocking",
      "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    ),
  ]);
});
