import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const defaultIntentionallyUnmappedRules: ReadonlySet<string> = new Set([
  "no-inline-schema-compile",
  "no-match-orelse",
  "prefer-effect-predicate",
]);

export interface LintSkillInventory {
  readonly enabledRules: ReadonlySet<string>;
  readonly fixtureRules: ReadonlySet<string>;
  readonly sourceRules: ReadonlySet<string>;
  readonly importedRules: ReadonlySet<string>;
  readonly registeredRules: ReadonlySet<string>;
  readonly pluginImports: ReadonlyMap<string, string>;
  readonly registrationIdentifiers: ReadonlyMap<string, string>;
  readonly ruleSkills: ReadonlyMap<string, ReadonlySet<string>>;
  readonly referencedSkills: ReadonlySet<string>;
  readonly installedSkills: ReadonlySet<string>;
  readonly intentionallyUnmappedRules: ReadonlySet<string>;
}

export interface LintSkillCheckResult {
  readonly diagnostics: readonly string[];
  readonly summary: string;
}

export interface LoadLintSkillInventoryOptions {
  readonly repositoryRoot?: string;
  readonly intentionallyUnmappedRules?: ReadonlySet<string>;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((entry) => !right.has(entry)).sort();
}

function addMatches(source: string, pattern: RegExp, destination: Set<string>): void {
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined) destination.add(value);
  }
}

function addProblem(problems: string[], label: string, entries: string[]): void {
  if (entries.length > 0) problems.push(`${label}: ${entries.join(", ")}`);
}

export function inspectLintSkillInventory(inventory: LintSkillInventory): LintSkillCheckResult {
  const registrationMismatches = [...inventory.registeredRules]
    .filter(
      (rule) => inventory.pluginImports.get(rule) !== inventory.registrationIdentifiers.get(rule),
    )
    .sort();
  const unmappedRules = [...inventory.enabledRules]
    .filter(
      (rule) =>
        (inventory.ruleSkills.get(rule)?.size ?? 0) === 0 &&
        !inventory.intentionallyUnmappedRules.has(rule),
    )
    .sort();
  const staleAllowlist = [...inventory.intentionallyUnmappedRules]
    .filter(
      (rule) =>
        !inventory.enabledRules.has(rule) || (inventory.ruleSkills.get(rule)?.size ?? 0) > 0,
    )
    .sort();

  const diagnostics: string[] = [];
  addProblem(
    diagnostics,
    "Enabled rules missing source files",
    difference(inventory.enabledRules, inventory.sourceRules),
  );
  addProblem(
    diagnostics,
    "Orphan rule source files",
    difference(inventory.sourceRules, inventory.enabledRules),
  );
  addProblem(
    diagnostics,
    "Enabled rules missing fixture inventory entries",
    difference(inventory.enabledRules, inventory.fixtureRules),
  );
  addProblem(
    diagnostics,
    "Orphan fixture inventory entries",
    difference(inventory.fixtureRules, inventory.enabledRules),
  );
  addProblem(
    diagnostics,
    "Enabled rules missing plugin imports",
    difference(inventory.enabledRules, inventory.importedRules),
  );
  addProblem(
    diagnostics,
    "Orphan plugin imports",
    difference(inventory.importedRules, inventory.enabledRules),
  );
  addProblem(
    diagnostics,
    "Enabled rules missing plugin registrations",
    difference(inventory.enabledRules, inventory.registeredRules),
  );
  addProblem(
    diagnostics,
    "Orphan plugin registrations",
    difference(inventory.registeredRules, inventory.enabledRules),
  );
  addProblem(
    diagnostics,
    "Plugin import/registration identifier mismatches",
    registrationMismatches,
  );
  addProblem(diagnostics, "Rules missing remediation references", unmappedRules);
  addProblem(diagnostics, "Stale intentionally-unmapped rules", staleAllowlist);
  addProblem(
    diagnostics,
    "Referenced remediation skills not installed",
    difference(inventory.referencedSkills, inventory.installedSkills),
  );
  addProblem(
    diagnostics,
    "Installed remediation skills not referenced",
    difference(inventory.installedSkills, inventory.referencedSkills),
  );

  return {
    diagnostics,
    summary: `Verified closed Effect lint inventory: ${inventory.enabledRules.size} rules across config, sources, plugin, and fixtures; ${inventory.referencedSkills.size} remediation skills; ${inventory.intentionallyUnmappedRules.size} intentionally unmapped rules.`,
  };
}

export async function loadLintSkillInventory(
  options: LoadLintSkillInventoryOptions = {},
): Promise<LintSkillInventory> {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const intentionallyUnmappedRules =
    options.intentionallyUnmappedRules ?? defaultIntentionallyUnmappedRules;
  const rulesRoot = path.resolve(repositoryRoot, "tooling/oxlint/effect/rules");
  const skillsRoot = path.resolve(repositoryRoot, ".agents/skills");
  const configPath = path.resolve(repositoryRoot, ".oxlintrc.json");
  const pluginPath = path.resolve(repositoryRoot, "tooling/oxlint/effect-plugin.mjs");
  const fixtureInventoryPath = path.resolve(repositoryRoot, "tooling/oxlint/effect-fixtures.json");

  const enabledRules = new Set<string>();
  addMatches(
    await readFile(configPath, "utf8"),
    /"ziggy-effect\/([a-z0-9-]+)"\s*:\s*(?:"(?:error|warn)"|[12]|\[\s*(?:"(?:error|warn)"|[12]))/g,
    enabledRules,
  );

  const fixtureRules = new Set<string>();
  addMatches(
    await readFile(fixtureInventoryPath, "utf8"),
    /"ziggy-effect\/([a-z0-9-]+)"\s*:\s*(?:"(?:error|warn)"|[12]|\[\s*(?:"(?:error|warn)"|[12]))/g,
    fixtureRules,
  );

  const sourceRules = new Set(
    (await readdir(rulesRoot))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => name.slice(0, -4)),
  );

  const pluginSource = await readFile(pluginPath, "utf8");
  const pluginImports = new Map<string, string>();
  for (const match of pluginSource.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+"\.\/effect\/rules\/([a-z0-9-]+)\.mjs";/g,
  )) {
    const identifier = match[1];
    const rule = match[2];
    if (identifier !== undefined && rule !== undefined) pluginImports.set(rule, identifier);
  }
  const importedRules = new Set(pluginImports.keys());

  const registeredRules = new Set<string>();
  const registrationIdentifiers = new Map<string, string>();
  for (const match of pluginSource.matchAll(/"([a-z0-9-]+)"\s*:\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    const rule = match[1];
    const identifier = match[2];
    if (rule !== undefined && identifier !== undefined) {
      registeredRules.add(rule);
      registrationIdentifiers.set(rule, identifier);
    }
  }

  const ruleSkills = new Map<string, ReadonlySet<string>>();
  const referencedSkills = new Set<string>();
  for (const rule of [...sourceRules].sort()) {
    const source = await readFile(path.join(rulesRoot, `${rule}.mjs`), "utf8");
    const skills = new Set<string>();
    addMatches(source, /\b(wrdn-[a-z0-9-]+)\b/g, skills);
    ruleSkills.set(rule, skills);
    for (const skill of skills) referencedSkills.add(skill);
  }

  const installedSkills = new Set<string>();
  for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith("wrdn-") &&
      (await Bun.file(path.join(skillsRoot, entry.name, "SKILL.md")).exists())
    ) {
      installedSkills.add(entry.name);
    }
  }

  return {
    enabledRules,
    fixtureRules,
    sourceRules,
    importedRules,
    registeredRules,
    pluginImports,
    registrationIdentifiers,
    ruleSkills,
    referencedSkills,
    installedSkills,
    intentionallyUnmappedRules,
  };
}

export async function checkLintSkills(
  options: LoadLintSkillInventoryOptions = {},
): Promise<LintSkillCheckResult> {
  return inspectLintSkillInventory(await loadLintSkillInventory(options));
}

if (import.meta.main) {
  const result = await checkLintSkills();
  if (result.diagnostics.length > 0) {
    console.error(result.diagnostics.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(result.summary);
  }
}
