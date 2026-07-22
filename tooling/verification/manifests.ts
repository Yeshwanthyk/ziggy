import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ScenarioDeclaration } from "../../tests/scenarios/registry.ts";
import { loadSchemaCatalog } from "./schemas.ts";

export { validateSchemaFiles } from "./schemas.ts";

export const stages = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"] as const;
export type Stage = (typeof stages)[number];

const gateNames = [
  "manifest-integrity",
  "extension-integrity",
  "package-graph",
  "lint",
  "lint-fixtures",
  "fmt-check",
  "typecheck",
  "scenarios",
  "test",
  "knip",
  "compile-smoke",
] as const;
export type GateName = (typeof gateNames)[number];

export const gateCommands: Readonly<Record<GateName, ReadonlyArray<string> | null>> = {
  "manifest-integrity": null,
  "extension-integrity": ["bun", "tooling/verification/extension-integrity.ts"],
  "package-graph": ["bun", "run", "package-graph"],
  lint: ["bun", "run", "lint"],
  "lint-fixtures": ["bun", "run", "lint:fixtures"],
  "fmt-check": ["bun", "run", "fmt:check"],
  typecheck: ["bun", "run", "typecheck"],
  scenarios: null,
  test: ["bun", "test"],
  knip: ["bun", "run", "knip"],
  "compile-smoke": ["bun", "run", "compile:smoke"],
};

interface VerificationRequirement {
  readonly id: string;
  readonly status: "pending" | "implemented";
  readonly description: string;
}

export interface VerificationManifest {
  readonly schemaVersion: 1;
  readonly stage: Stage;
  readonly status: "pending" | "implemented" | "manifest-empty";
  readonly predecessors: ReadonlyArray<Stage>;
  readonly scenarios: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<GateName>;
  readonly requirements: ReadonlyArray<VerificationRequirement>;
}

export async function loadManifests(root: string): Promise<ReadonlyArray<VerificationManifest>> {
  const directory = join(root, "verification/manifests");
  const expectedFiles = stages.map((stage) => `${stage}.json`);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  if (
    files.length !== expectedFiles.length ||
    files.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error("verification manifests must be exactly s0.json through s7.json");
  }
  const schemas = await loadSchemaCatalog(root);
  const manifests: VerificationManifest[] = [];
  for (const [index, file] of files.entries()) {
    const value = parseJson(await Bun.file(join(directory, file)).text(), file);
    schemas.validate("manifest-v1.schema.json", value, file);
    const manifest = decodeManifest(value, file);
    const expectedStage = stages[index];
    if (manifest.stage !== expectedStage) {
      throw new Error(`${file}: filename/stage mismatch`);
    }
    manifests.push(manifest);
  }
  return manifests;
}

export function decodeManifest(value: unknown, source = "manifest"): VerificationManifest {
  const record = requireRecord(value, source);
  requireExactKeys(
    record,
    ["schemaVersion", "stage", "status", "predecessors", "scenarios", "gates", "requirements"],
    source,
  );
  if (record.schemaVersion !== 1) {
    throw new Error(`${source}: unsupported schemaVersion`);
  }
  const stage = requireStage(record.stage, `${source}.stage`);
  const status = record.status;
  if (status !== "pending" && status !== "implemented" && status !== "manifest-empty") {
    throw new Error(`${source}: invalid status`);
  }
  return {
    schemaVersion: 1,
    stage,
    status,
    predecessors: requireArray(record.predecessors, `${source}.predecessors`, requireStage),
    scenarios: requireArray(record.scenarios, `${source}.scenarios`, requireString),
    gates: requireArray(record.gates, `${source}.gates`, requireGate),
    requirements: requireRequirements(record.requirements, `${source}.requirements`),
  };
}

export async function validateManifestRegistry(
  root: string,
  manifests: ReadonlyArray<VerificationManifest>,
  registry: ReadonlyArray<unknown>,
): Promise<void> {
  const schemas = await loadSchemaCatalog(root);
  const manifestsByStage = new Map<Stage, VerificationManifest>();
  const declaredScenarios = new Map<string, Stage>();
  for (const manifest of manifests) {
    if (manifestsByStage.has(manifest.stage)) {
      throw new Error(`duplicate manifest for ${manifest.stage}`);
    }
    manifestsByStage.set(manifest.stage, manifest);
    requireUnique(manifest.predecessors, `${manifest.stage} predecessors`);
    requireUnique(manifest.scenarios, `${manifest.stage} scenarios`);
    requireUnique(manifest.gates, `${manifest.stage} gates`);
    requireUnique(
      manifest.requirements.map((requirement) => requirement.id),
      `${manifest.stage} requirements`,
    );
    validatePredecessors(manifest);
    if (manifest.status === "implemented" && manifest.gates.length === 0) {
      throw new Error(`${manifest.stage}: implemented manifest must declare gates`);
    }
    if (
      manifest.status === "manifest-empty" &&
      (manifest.scenarios.length !== 0 || manifest.gates.length !== 0)
    ) {
      throw new Error(`${manifest.stage}: manifest-empty stage cannot declare scenarios or gates`);
    }
    for (const scenario of manifest.scenarios) {
      if (declaredScenarios.has(scenario)) {
        throw new Error(`scenario ${scenario} is declared by multiple manifests`);
      }
      declaredScenarios.set(scenario, manifest.stage);
    }
  }

  for (const stage of stages) {
    if (!manifestsByStage.has(stage)) {
      throw new Error(`missing manifest for ${stage}`);
    }
  }
  if (manifests.length !== stages.length) {
    throw new Error("unknown stage manifest present");
  }

  const registeredIds = new Set<string>();
  const registeredFilePaths = new Set<string>();
  const registeredFileIdentities = new Set<string>();
  for (const [index, scenarioValue] of registry.entries()) {
    const source = `scenario registry[${index}]`;
    schemas.validate("scenario-v1.schema.json", scenarioValue, source);
    const scenario = decodeScenario(scenarioValue, source);
    if (registeredIds.has(scenario.id)) {
      throw new Error(`duplicate registry scenario ${scenario.id}`);
    }
    registeredIds.add(scenario.id);
    const file = await validateScenarioPath(root, scenario.file);
    if (
      registeredFilePaths.has(file.canonicalPath) ||
      registeredFileIdentities.has(file.physicalIdentity)
    ) {
      throw new Error(`duplicate registry scenario path ${file.canonicalPath}`);
    }
    registeredFilePaths.add(file.canonicalPath);
    registeredFileIdentities.add(file.physicalIdentity);
    const declaredStage = declaredScenarios.get(scenario.id);
    if (declaredStage === undefined) {
      throw new Error(`registry scenario ${scenario.id} is undeclared`);
    }
    if (declaredStage !== scenario.stage) {
      throw new Error(`registry scenario ${scenario.id} has a stage mismatch`);
    }
  }
  for (const scenario of declaredScenarios.keys()) {
    if (!registeredIds.has(scenario)) {
      throw new Error(`manifest scenario ${scenario} is unknown`);
    }
  }
}

export function transitiveManifests(
  manifests: ReadonlyArray<VerificationManifest>,
  targets: ReadonlyArray<Stage>,
): ReadonlyArray<VerificationManifest> {
  const byStage = new Map(manifests.map((manifest) => [manifest.stage, manifest]));
  const selected = new Set<Stage>();
  const visit = (stage: Stage): void => {
    if (selected.has(stage)) {
      return;
    }
    const manifest = byStage.get(stage);
    if (manifest === undefined) {
      throw new Error(`missing manifest for ${stage}`);
    }
    for (const predecessor of manifest.predecessors) {
      visit(predecessor);
    }
    selected.add(stage);
  };
  for (const target of targets) {
    visit(target);
  }
  return stages
    .filter((stage) => selected.has(stage))
    .map((stage) => {
      const manifest = byStage.get(stage);
      if (manifest === undefined) {
        throw new Error(`missing manifest for ${stage}`);
      }
      return manifest;
    });
}

interface ValidatedScenarioPath {
  readonly canonicalPath: string;
  readonly physicalIdentity: string;
}

async function validateScenarioPath(root: string, file: string): Promise<ValidatedScenarioPath> {
  if (isAbsolute(file) || normalize(file) !== file || file.includes("\\")) {
    throw new Error(`scenario path must be normalized and relative: ${file}`);
  }
  if (!file.endsWith(".test.ts")) {
    throw new Error(`scenario path must name a .test.ts module: ${file}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, file);
  const contained = relative(absoluteRoot, absolute);
  if (contained.startsWith(`..${sep}`) || contained === ".." || isAbsolute(contained)) {
    throw new Error(`scenario path escapes repository: ${file}`);
  }

  const components = contained.split(sep);
  let current = absoluteRoot;
  let finalStat: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (error) {
      throw new Error(`scenario file is missing: ${file}`, { cause: error });
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`scenario path must not contain symbolic links: ${file}`);
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new Error(`scenario path component must be a directory: ${file}`);
    }
    finalStat = stat;
  }
  if (finalStat === undefined || !finalStat.isFile()) {
    throw new Error(`scenario path must name a regular test module: ${file}`);
  }

  const [realRoot, realFile] = await Promise.all([realpath(absoluteRoot), realpath(absolute)]);
  const realContained = relative(realRoot, realFile);
  if (realContained.startsWith(`..${sep}`) || realContained === ".." || isAbsolute(realContained)) {
    throw new Error(`scenario path resolves outside repository: ${file}`);
  }
  return {
    canonicalPath: realFile,
    physicalIdentity: `${finalStat.dev}:${finalStat.ino}`,
  };
}

function decodeScenario(value: unknown, source: string): ScenarioDeclaration {
  const record = requireRecord(value, source);
  requireExactKeys(
    record,
    ["schemaVersion", "id", "stage", "file", "seed", "schedule", "boundaryConfiguration"],
    source,
  );
  if (record.schemaVersion !== 1) {
    throw new Error(`${source}: unsupported schemaVersion`);
  }
  return {
    schemaVersion: 1,
    id: requireString(record.id, `${source}.id`),
    stage: requireStage(record.stage, `${source}.stage`),
    file: requireString(record.file, `${source}.file`),
    seed: requireString(record.seed, `${source}.seed`),
    schedule: requireString(record.schedule, `${source}.schedule`),
    boundaryConfiguration: requireString(
      record.boundaryConfiguration,
      `${source}.boundaryConfiguration`,
    ),
  };
}

function validatePredecessors(manifest: VerificationManifest): void {
  const index = stages.indexOf(manifest.stage);
  const expected = stages.slice(0, index);
  if (
    manifest.predecessors.length !== expected.length ||
    manifest.predecessors.some((stage, predecessorIndex) => stage !== expected[predecessorIndex])
  ) {
    throw new Error(
      `${manifest.stage}: predecessors must be the strict ordered transitive stage closure`,
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new Error(`${label}: unknown field ${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw new Error(`${label}: missing field ${key}`);
    }
  }
}

function requireStage(value: unknown, label: string): Stage {
  for (const stage of stages) {
    if (value === stage) {
      return stage;
    }
  }
  throw new Error(`${label}: unknown stage`);
}

function requireGate(value: unknown, label: string): GateName {
  for (const gate of gateNames) {
    if (value === gate) {
      return gate;
    }
  }
  throw new Error(`${label}: unknown gate`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: expected non-empty string`);
  }
  return value;
}

function requireArray<Value>(
  value: unknown,
  label: string,
  decode: (item: unknown, label: string) => Value,
): ReadonlyArray<Value> {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected array`);
  }
  return value.map((item) => decode(item, label));
}

function requireRequirements(
  value: unknown,
  label: string,
): ReadonlyArray<VerificationRequirement> {
  return requireArray(value, label, (item, itemLabel) => {
    const record = requireRecord(item, itemLabel);
    requireExactKeys(record, ["id", "status", "description"], itemLabel);
    const status = record.status;
    if (status !== "pending" && status !== "implemented") {
      throw new Error(`${itemLabel}: invalid requirement status`);
    }
    return {
      id: requireString(record.id, `${itemLabel}.id`),
      status,
      description: requireString(record.description, `${itemLabel}.description`),
    };
  });
}

function requireUnique(values: ReadonlyArray<string>, label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label}: duplicate value`);
  }
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${source}`, { cause: error });
  }
}
