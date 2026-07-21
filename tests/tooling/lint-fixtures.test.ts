import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLintSkillInventory } from "../../tooling/check-lint-skills";

const repositoryRoot = resolve(import.meta.dir, "../..");
const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");
const customRuleCode = "ziggy(no-unsafe-typescript-syntax)";
const effectFixtureRoot = mkdtempSync(resolve(repositoryRoot, "packages/lint-fixtures-"));
const effectFixtureInventory: unknown = JSON.parse(
  readFileSync(resolve(repositoryRoot, "tooling/oxlint/effect-fixtures.json"), "utf8"),
);

interface ExpectedFixture {
  file: string;
  message: string;
}

interface EffectRuleFixture {
  rule: string;
  bad: string;
  good: string;
  message: string;
  diagnosticCount?: number;
  testLike?: boolean;
}

interface OxlintDiagnostic {
  code: string;
  message: string;
}

const forbiddenFixtures: ReadonlyArray<ExpectedFixture> = [
  {
    file: "as-type.ts",
    message: "Type assertions are forbidden; narrow, decode, or construct the type instead.",
  },
  {
    file: "as-generic.ts",
    message: "Type assertions are forbidden; narrow, decode, or construct the type instead.",
  },
  {
    file: "as-multiline.ts",
    message: "Type assertions are forbidden; narrow, decode, or construct the type instead.",
  },
  {
    file: "angle-bracket.ts",
    message: "Type assertions are forbidden; narrow, decode, or construct the type instead.",
  },
  {
    file: "non-null.ts",
    message: "Non-null assertions are forbidden; prove or handle nullability instead.",
  },
  {
    file: "explicit-any.ts",
    message: "Explicit any is forbidden; model the value precisely or use unknown.",
  },
];

const effectRuleFixtures: ReadonlyArray<EffectRuleFixture> = [
  {
    rule: "no-conditional-tests",
    bad: "if (enabled) expect(value);",
    good: "expect(value);",
    message: "Skill: wrdn-effect-tests",
    testLike: true,
  },
  {
    rule: "no-effect-escape-hatch",
    bad: "Effect.orDie(program);",
    good: "Effect.catchAll(program, recover);",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-effect-execution-boundary",
    bad: 'import { Effect } from "effect";\nEffect.runSync(program);',
    good: 'import { Effect } from "effect";\nEffect.succeed(1);',
    message: "Skill: wrdn-effect-runtime-boundaries",
  },
  {
    rule: "no-error-constructor",
    bad: 'const failure = new Error("failed");',
    good: "class DomainFailure {}\nconst failure = new DomainFailure();",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-inline-schema-compile",
    bad: "function decode(value) { return Schema.decodeUnknownSync(Model)(value); }",
    good: "const decodeModel = Schema.decodeUnknownSync(Model);\nfunction decode(value) { return decodeModel(value); }",
    message: "Hoist Schema.decodeUnknownSync(...) to module scope",
  },
  {
    rule: "no-instanceof-error",
    bad: "const matched = value instanceof Error;",
    good: 'const matched = Predicate.isTagged(value, "DomainFailure");',
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-instanceof-tagged-error",
    bad: "const matched = value instanceof DomainError;",
    good: 'const matched = Predicate.isTagged(value, "DomainError");',
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-json-parse",
    bad: "const value = JSON.parse(source);",
    good: "const value = decodeJson(source);",
    message: "Skill: wrdn-effect-schema-boundaries",
  },
  {
    rule: "no-manual-tag-check",
    bad: 'const matched = value._tag === "DomainError";',
    good: 'const matched = Predicate.isTagged(value, "DomainError");',
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-match-orelse",
    bad: "const fallback = Match.orElse(() => value);",
    good: "const result = Match.exhaustive(matcher);",
    message: "End the Match chain with Match.exhaustive",
  },
  {
    rule: "no-native-promise-ownership",
    bad: "const load = async () => value;",
    good: "const load = () => value;",
    message: "Skill: wrdn-effect-runtime-boundaries",
  },
  {
    rule: "no-promise-catch",
    bad: "task.catch(recover);",
    good: "Effect.catchAll(task, recover);",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-promise-client-surface",
    bad: "interface ApiClient { load(): Promise<string>; save: () => Promise<void>; }\nexport interface VendorSdk { load(): Promise<string>; save: (() => Promise<void>) | undefined; }",
    good: "interface ApiClient { load(): Effect<string>; save: () => Effect<void>; }\ninterface InternalSdk { load(): Promise<string>; }\nexport interface VendorSdk { load(): Effect<string>; }",
    message: "Skill: wrdn-effect-client-wrapper",
    diagnosticCount: 4,
  },
  {
    rule: "no-raw-fetch",
    bad: 'const response = fetch("https://example.test");',
    good: 'const response = HttpClient.get("https://example.test");',
    message: "Skill: wrdn-effect-raw-fetch-boundary",
  },
  {
    rule: "no-redundant-error-factory",
    bad: "class DomainError {}\nconst makeDomainError = (message) => new DomainError(message);",
    good: "class DomainError {}\nfunction createFailure(message) { return new DomainError(message); }",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-try-catch-or-throw",
    bad: "try { work(); } finally { cleanup(); }",
    good: "Effect.acquireUseRelease(acquire, use, release);",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-ts-nocheck",
    bad: "// @ts-nocheck\nconst value = 1;",
    good: "// @ts-expect-error fixture\nconst value = 1;",
    message: "Skill: wrdn-typescript-type-safety",
  },
  {
    rule: "no-unknown-error-message",
    bad: "const detail = String(error);",
    good: "const detail = failure.detail;",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "no-unknown-shape-probing",
    bad: 'const hasName = "name" in value;',
    good: "const hasName = isNamed(value);",
    message: "Skill: wrdn-effect-schema-boundaries",
  },
  {
    rule: "no-unsupported-effect-api",
    bad: "const task = Effect.async(register);",
    good: "const task = Effect.callback(register);",
    message: "Skill: wrdn-effect-typed-errors",
  },
  {
    rule: "prefer-effect-predicate",
    bad: 'import { Predicate } from "effect";\nconst present = (value) => value !== null;',
    good: 'import { Predicate } from "effect";\nconst present = Predicate.isNotNull;',
    message: "Use Predicate.isNotNull/isNotUndefined/isNotNullish",
  },
  {
    rule: "prefer-schema-inferred-types",
    bad: "const UserSchema = Schema.Struct({ name: Schema.String });\ninterface User { name: string; }",
    good: "const UserSchema = Schema.Struct({ name: Schema.String });\ntype User = Schema.Schema.Type<typeof UserSchema>;",
    message: "Skill: wrdn-effect-schema-inferred-types",
  },
  {
    rule: "prefer-value-inferred-extension-types",
    bad: "interface SearchExtension { name: string; }\nconst plugin = { extension: (): SearchExtension => ({ name: 'search' }) };",
    good: "const makeSearchExtension = () => ({ name: 'search' });\nconst plugin = { extension: makeSearchExtension };",
    message: "Skill: wrdn-effect-value-inferred-types",
  },
  {
    rule: "prefer-yield-tagged-error",
    bad: "function* run() { yield* Effect.fail(new DomainError()); }",
    good: "function* run() { yield* new DomainError(); }",
    message: "Skill: wrdn-effect-typed-errors",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDiagnostics(output: Uint8Array): OxlintDiagnostic[] {
  const text = new TextDecoder().decode(output);
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Oxlint did not emit valid JSON: ${text}`, { cause: error });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
    throw new Error(`Oxlint JSON did not contain a diagnostics array: ${text}`);
  }

  const diagnostics: OxlintDiagnostic[] = [];
  for (const diagnostic of parsed.diagnostics) {
    if (
      isRecord(diagnostic) &&
      typeof diagnostic.code === "string" &&
      typeof diagnostic.message === "string"
    ) {
      diagnostics.push({ code: diagnostic.code, message: diagnostic.message });
    }
  }
  return diagnostics;
}

function lintFixture(file: string) {
  return Bun.spawnSync({
    cmd: [
      oxlint,
      "--disable-nested-config",
      "--no-ignore",
      "--format",
      "json",
      `tests/fixtures/lint/${file}`,
    ],
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
}

function lintEffectSource(fixture: EffectRuleFixture, source: string, kind: "bad" | "good") {
  const suffix = fixture.testLike ? ".test.ts" : ".ts";
  const file = resolve(effectFixtureRoot, `${fixture.rule}-${kind}${suffix}`);
  const config = resolve(effectFixtureRoot, `${fixture.rule}.json`);
  writeFileSync(file, source);
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: ["../../tooling/oxlint/effect-plugin.mjs"],
      rules: { [`ziggy-effect/${fixture.rule}`]: "error" },
    }),
  );
  return Bun.spawnSync({
    cmd: [
      oxlint,
      "--disable-nested-config",
      "--no-ignore",
      "--config",
      config,
      "--allow",
      "all",
      "--format",
      "json",
      file,
    ],
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
}

afterAll(() => {
  rmSync(effectFixtureRoot, { force: true, recursive: true });
});

describe("Oxlint TypeScript syntax fixtures", () => {
  for (const fixture of forbiddenFixtures) {
    test(`${fixture.file} fails through the custom AST rule`, () => {
      const result = lintFixture(fixture.file);
      const diagnostics = parseDiagnostics(result.stdout);

      expect(result.exitCode).not.toBe(0);
      expect(diagnostics).toContainEqual({
        code: customRuleCode,
        message: fixture.message,
      });
    });
  }

  test("as-const.ts passes", () => {
    const result = lintFixture("as-const.ts");
    const diagnostics = parseDiagnostics(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(diagnostics).toEqual([]);
  });
});

describe("Oxlint Effect rule fixtures", () => {
  test("matrix exactly covers configured, registered, and fixture inventory rules", async () => {
    expect(isRecord(effectFixtureInventory)).toBe(true);
    if (!isRecord(effectFixtureInventory)) return;

    const inventory = await loadLintSkillInventory({ repositoryRoot });
    const fixtureInventoryRules = isRecord(effectFixtureInventory.rules)
      ? Object.keys(effectFixtureInventory.rules)
          .filter((rule) => rule.startsWith("ziggy-effect/"))
          .map((rule) => rule.slice("ziggy-effect/".length))
          .sort()
      : [];
    const matrixRules = effectRuleFixtures.map(({ rule }) => rule).sort();

    expect(new Set(matrixRules).size).toBe(matrixRules.length);
    expect(matrixRules).toEqual([...inventory.enabledRules].sort());
    expect(matrixRules).toEqual([...inventory.registeredRules].sort());
    expect(matrixRules).toEqual(fixtureInventoryRules);
  });

  for (const fixture of effectRuleFixtures) {
    test(`${fixture.rule} reports its own diagnostic for bad input`, () => {
      const code = `ziggy-effect(${fixture.rule})`;
      const result = lintEffectSource(fixture, fixture.bad, "bad");
      const diagnostics = parseDiagnostics(result.stdout);

      expect(result.exitCode).not.toBe(0);
      expect(diagnostics).toHaveLength(fixture.diagnosticCount ?? 1);
      expect(diagnostics.every((diagnostic) => diagnostic.code === code)).toBe(true);
      expect(diagnostics.every((diagnostic) => diagnostic.message.includes(fixture.message))).toBe(
        true,
      );
    }, 15_000);

    test(`${fixture.rule} does not report for its control`, () => {
      const result = lintEffectSource(fixture, fixture.good, "good");
      const diagnostics = parseDiagnostics(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(diagnostics).toEqual([]);
    }, 15_000);
  }
});
