import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");
const customRuleCode = "ziggy(no-unsafe-typescript-syntax)";

interface ExpectedFixture {
  file: string;
  message: string;
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
