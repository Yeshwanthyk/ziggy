/* oxlint-disable ziggy-effect/no-json-parse -- The synchronous fixture process emits a bounded JSON report. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const oxlintCli = join(repositoryRoot, "node_modules/oxlint/bin/oxlint");
const roots: string[] = [];

const fixture = `export type ObjectAlias = object;
export type UnknownAlias = unknown;

function moduleObject(value: ObjectAlias) {} // report-object-module-alias
function moduleUnknown(): UnknownAlias { return input; } // report-unknown-module-alias
function genericObject<ObjectAlias>(value: ObjectAlias) {} // valid-nested-generic
function genericUnknown<UnknownAlias>(): UnknownAlias { return value; } // valid-nested-generic

function nestedObject<ObjectAlias>() {
  return (value: ObjectAlias) => value; // valid-nested-function
}
function nestedUnknown<UnknownAlias>() {
  return (): UnknownAlias => value; // valid-nested-function
}

type MappedObject<Input> = { [Key in keyof Input]: (value: Key) => void }; // valid-mapped-type-annotation
type MappedUnknown<Input> = { [Key in keyof Input]: () => Key }; // valid-mapped-type-annotation
type MappedNameObject<Input> = { [Key in keyof Input as ((value: Key) => string) extends infer Renamed ? Renamed : never]: string }; // valid-mapped-name-type
type MappedNameUnknown<Input> = { [Key in keyof Input as (() => Key) extends infer Renamed ? Renamed : never]: string }; // valid-mapped-name-type
type MappedConstraintObject<Input> = { [Key in ((value: ObjectAlias) => string) extends infer Renamed ? Renamed : never]: string }; // report-mapped-constraint-object
type MappedConstraintUnknown<Input> = { [Key in (() => UnknownAlias) extends infer Renamed ? Renamed : never]: string }; // report-mapped-constraint-unknown

type InferTrueObject<Input> = Input extends infer ObjectAlias ? (value: ObjectAlias) => void : never; // valid-infer-true
type InferTrueUnknown<Input> = Input extends infer UnknownAlias ? () => UnknownAlias : never; // valid-infer-true
type InferFalseObject<Input> = Input extends infer ObjectAlias ? string : (value: ObjectAlias) => void; // report-infer-false-object
type InferFalseUnknown<Input> = Input extends infer UnknownAlias ? string : () => UnknownAlias; // report-infer-false-unknown

type NestedInferObject<Input> = Input extends (Input extends infer ObjectAlias ? ObjectAlias : never) ? (value: ObjectAlias) => void : never; // valid-nested-infer
type NestedInferUnknown<Input> = Input extends (Input extends infer UnknownAlias ? UnknownAlias : never) ? () => UnknownAlias : never; // valid-nested-infer
`;

const expected = [
  ["report-object-module-alias", "ziggy(no-object-parameters)"],
  ["report-unknown-module-alias", "ziggy(no-unknown-returns)"],
  ["report-mapped-constraint-object", "ziggy(no-object-parameters)"],
  ["report-mapped-constraint-unknown", "ziggy(no-unknown-returns)"],
  ["report-infer-false-object", "ziggy(no-object-parameters)"],
  ["report-infer-false-unknown", "ziggy(no-unknown-returns)"],
];

const lineFor = (marker: string) => {
  const line = fixture.split("\n").findIndex((value) => value.includes(marker));
  return line + 1;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("preserves lexical mapped, infer, nested, and module-alias type ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "ziggy-lexical-type-parameters-"));
  roots.push(root);
  const fixturePath = join(root, "fixture.ts");
  const configPath = join(root, "oxlint.json");
  writeFileSync(fixturePath, fixture);
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [join(repositoryRoot, "tooling/oxlint/ziggy-plugin.mjs")],
      rules: {
        "ziggy/no-object-parameters": "error",
        "ziggy/no-unknown-returns": "error",
      },
    }),
  );

  const result = Bun.spawnSync({
    cmd: [oxlintCli, "-A", "all", "--format=json", "--config", configPath, fixturePath],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode).toBe(1);
  expect(stderr).toBe("");

  const report = JSON.parse(stdout);
  expect(
    report.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.labels[0].span.line]),
  ).toEqual(expected.map(([marker, code]) => [code, lineFor(marker)]));
  expect(report.number_of_files).toBe(1);
  expect(report.number_of_rules).toBe(2);
});
