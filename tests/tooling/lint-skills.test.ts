import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  inspectLintSkillInventory,
  loadLintSkillInventory,
  type LintSkillInventory,
} from "../../tooling/check-lint-skills";

const mappedRule = "mapped-rule";
const intentionallyUnmappedRule = "intentional-rule";
const installedSkill = "wrdn-mapped";
const mappedIdentifier = "mappedRule";
const intentionalIdentifier = "intentionalRule";

function closedInventory(overrides: Partial<LintSkillInventory> = {}): LintSkillInventory {
  const rules = new Set([intentionallyUnmappedRule, mappedRule]);
  return {
    enabledRules: rules,
    fixtureRules: rules,
    sourceRules: rules,
    importedRules: rules,
    registeredRules: rules,
    pluginImports: new Map([
      [mappedRule, mappedIdentifier],
      [intentionallyUnmappedRule, intentionalIdentifier],
    ]),
    registrationIdentifiers: new Map([
      [mappedRule, mappedIdentifier],
      [intentionallyUnmappedRule, intentionalIdentifier],
    ]),
    ruleSkills: new Map([
      [mappedRule, new Set([installedSkill])],
      [intentionallyUnmappedRule, new Set()],
    ]),
    referencedSkills: new Set([installedSkill]),
    installedSkills: new Set([installedSkill]),
    intentionallyUnmappedRules: new Set([intentionallyUnmappedRule]),
    ...overrides,
  };
}

function expectDeterministicDiagnostics(
  inventory: LintSkillInventory,
  expected: readonly string[],
): void {
  const first = inspectLintSkillInventory(inventory).diagnostics;
  const second = inspectLintSkillInventory(inventory).diagnostics;

  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
}

describe("Effect lint skill inventory closure", () => {
  test("accepts a valid closed inventory", () => {
    const result = inspectLintSkillInventory(closedInventory());

    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toBe(
      "Verified closed Effect lint inventory: 2 rules across config, sources, plugin, and fixtures; 1 remediation skills; 1 intentionally unmapped rules.",
    );
  });

  test("reports sorted missing and orphan rule sources deterministically", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        sourceRules: new Set([intentionallyUnmappedRule, "z-orphan", "a-orphan"]),
      }),
      [
        "Enabled rules missing source files: mapped-rule",
        "Orphan rule source files: a-orphan, z-orphan",
      ],
    );
  });

  test("reports sorted missing and orphan fixture entries deterministically", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        fixtureRules: new Set([intentionallyUnmappedRule, "z-orphan", "a-orphan"]),
      }),
      [
        "Enabled rules missing fixture inventory entries: mapped-rule",
        "Orphan fixture inventory entries: a-orphan, z-orphan",
      ],
    );
  });

  test("reports sorted missing and orphan plugin imports", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        importedRules: new Set([intentionallyUnmappedRule, "z-orphan", "a-orphan"]),
      }),
      [
        "Enabled rules missing plugin imports: mapped-rule",
        "Orphan plugin imports: a-orphan, z-orphan",
      ],
    );
  });

  test("reports sorted missing and orphan plugin registrations", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        registeredRules: new Set([intentionallyUnmappedRule, "z-orphan", "a-orphan"]),
      }),
      [
        "Enabled rules missing plugin registrations: mapped-rule",
        "Orphan plugin registrations: a-orphan, z-orphan",
      ],
    );
  });

  test("reports sorted import-registration identifier mismatches", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        registrationIdentifiers: new Map([
          [mappedRule, "differentMappedIdentifier"],
          [intentionallyUnmappedRule, "differentIntentionalIdentifier"],
        ]),
      }),
      ["Plugin import/registration identifier mismatches: intentional-rule, mapped-rule"],
    );
  });

  test("reports sorted referenced and installed skill drift", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        referencedSkills: new Set([installedSkill, "wrdn-z-missing", "wrdn-a-missing"]),
        installedSkills: new Set([installedSkill, "wrdn-z-orphan", "wrdn-a-orphan"]),
      }),
      [
        "Referenced remediation skills not installed: wrdn-a-missing, wrdn-z-missing",
        "Installed remediation skills not referenced: wrdn-a-orphan, wrdn-z-orphan",
      ],
    );
  });

  test("reports sorted enabled rules without remediation mappings", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        ruleSkills: new Map([
          [mappedRule, new Set()],
          [intentionallyUnmappedRule, new Set()],
        ]),
        intentionallyUnmappedRules: new Set(),
      }),
      ["Rules missing remediation references: intentional-rule, mapped-rule"],
    );
  });

  test("reports sorted stale intentionally-unmapped allowlist entries", () => {
    expectDeterministicDiagnostics(
      closedInventory({
        ruleSkills: new Map([
          [mappedRule, new Set([installedSkill])],
          [intentionallyUnmappedRule, new Set([installedSkill])],
        ]),
        intentionallyUnmappedRules: new Set([mappedRule, intentionallyUnmappedRule]),
      }),
      ["Stale intentionally-unmapped rules: intentional-rule, mapped-rule"],
    );
  });

  test("loads the repository inventory consumed by the CLI", async () => {
    const inventory = await loadLintSkillInventory({
      repositoryRoot: resolve(import.meta.dir, "../.."),
    });

    expect(inspectLintSkillInventory(inventory).diagnostics).toEqual([]);
  });
});
