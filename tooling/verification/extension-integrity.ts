import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import {
  type ExtensionManifest,
  ExtensionManifestSchema,
} from "../../packages/core/src/extensions/manifest.ts";
import {
  decodeUtf8Maybe,
  readImmutableExtensionTree,
} from "../../packages/core/src/extensions/skill-loader-node-adapter.ts";
import { validateExtensionPackageContent } from "../../packages/core/src/extensions/skill-loader.ts";
import { isStrictJson } from "../../packages/core/src/extensions/strict-json.ts";
import { scenarioRegistry } from "../../tests/scenarios/registry.ts";
import { loadSchemaCatalog } from "./schemas.ts";

const ledgerPath = "docs/plans/s4-merlin-migration.json";
const reviewDirectory = "docs/plans/s4-extension-reviews";
const decodeExtensionManifest = Schema.decodeUnknownSync(ExtensionManifestSchema, {
  errors: "all",
  onExcessProperty: "error",
});
const expectedCandidateIds = [
  "acp-router",
  "agent-browser",
  "apple-notes",
  "apple-reminders",
  "architecture-diagram",
  "blogwatcher",
  "clawhub",
  "codex",
  "coding-agent",
  "diffs",
  "discord",
  "executor",
  "gh-issues",
  "github",
  "github-issues",
  "github-pr-triage",
  "gog",
  "goplaces",
  "here-now",
  "humanizer",
  "hyperframes",
  "imsg",
  "linear",
  "lossless-claw",
  "mcporter",
  "nano-pdf",
  "notion",
  "obsidian",
  "onepassword",
  "open-computer-use",
  "openai-whisper",
  "peekaboo",
  "qmd",
  "self-improving-agent",
  "session-logs",
  "skill-creator",
  "skill-curator",
  "slack",
  "smart-memory",
  "summarize",
  "telephony",
  "things-mac",
  "tmux",
  "wacli",
  "weather",
  "web-search",
  "xurl",
];

export interface ExtensionIntegrityResult {
  readonly candidateCount: number;
  readonly landedReviewCount: number;
  readonly ledgerDigest: string;
}

export async function verifyExtensionIntegrity(root: string): Promise<ExtensionIntegrityResult> {
  const schemas = await loadSchemaCatalog(root);
  const ledgerText = await Bun.file(join(root, ledgerPath)).text();
  const ledgerValue = parseStrictJson(ledgerText, ledgerPath);
  schemas.validate("s4-merlin-migration-v1.schema.json", ledgerValue, ledgerPath);
  const candidates = validateS4Ledger(ledgerValue);

  const requiredReviews = new Map<string, Record<string, unknown>>();
  for (const candidate of candidates) {
    if (requiresLandedReview(candidate)) {
      requiredReviews.set(string(candidate.id, "candidate.id"), candidate);
    }
  }

  const actualReviewFiles = (await readdir(join(root, reviewDirectory)))
    .filter((file) => file.endsWith(".json"))
    .sort(compareUtf8);
  const expectedReviewFiles = [...requiredReviews.keys()]
    .map((id) => `${id}.json`)
    .sort(compareUtf8);
  requireExactList(actualReviewFiles, expectedReviewFiles, "S4 landed review file set");

  for (const file of actualReviewFiles) {
    const path = join(reviewDirectory, file);
    const text = await Bun.file(join(root, path)).text();
    const value = parseStrictJson(text, path);
    schemas.validate("s4-extension-review-v1.schema.json", value, path);
    const review = record(value, path);
    const id = string(review.id, `${path}.id`);
    if (file !== `${id}.json`) throw new Error(`${path}: filename and review id must match`);
    const candidate = requiredReviews.get(id);
    if (candidate === undefined) throw new Error(`${path}: review is not required by a landed row`);
    await validateLandedReview(root, review, candidate);
  }

  return {
    candidateCount: candidates.length,
    landedReviewCount: requiredReviews.size,
    ledgerDigest: sha256(ledgerText),
  };
}

export function validateS4Ledger(value: unknown): ReadonlyArray<Record<string, unknown>> {
  const ledger = record(value, "S4 migration ledger");
  const corpus = record(ledger.corpus, "S4 migration ledger.corpus");
  if (
    corpus.candidateCount !== 47 ||
    corpus.regularFileCount !== 175 ||
    corpus.totalBytes !== 17_631_635 ||
    corpus.inventoryDigest !== "e629623273623eb3672adbe0523a33d2bab275dcdabf8abe75cdd38a9921b791"
  ) {
    throw new Error("S4 migration ledger: closed Merlin corpus proof mismatch");
  }
  const candidates = array(ledger.candidates, "S4 migration ledger.candidates").map((item, index) =>
    record(item, `S4 migration ledger.candidates[${index}]`),
  );
  const ids = candidates.map((candidate) => string(candidate.id, "candidate.id"));
  requireExactList(ids, expectedCandidateIds, "S4 migration candidate IDs");

  for (const candidate of candidates) validateCandidate(candidate);
  return candidates;
}

async function validateLandedReview(
  root: string,
  review: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Promise<void> {
  const id = string(review.id, "review.id");
  const candidateId = string(candidate.id, "candidate.id");
  if (id !== candidateId) throw new Error(`${id}: review and ledger candidate IDs differ`);
  if (review.userOutcome !== record(candidate.capability, `${id}.capability`).userOutcome) {
    throw new Error(`${id}: reviewed user outcome differs from ledger`);
  }

  const ledgerTarget = record(candidate.target, `${id}.target`);
  const reviewTarget = record(review.target, `${id}.review.target`);
  for (const key of ["mechanism", "id"]) {
    if (reviewTarget[key] !== ledgerTarget[key])
      throw new Error(`${id}: review target ${key} differs`);
  }
  if (ledgerTarget.mechanism === "extension" && reviewTarget.trustTier !== ledgerTarget.trustTier)
    throw new Error(`${id}: review trust tier differs`);
  if (ledgerTarget.mechanism !== "extension" && "trustTier" in reviewTarget)
    throw new Error(`${id}: non-Extension review must not declare a trust tier`);

  if (review.disposition !== "accepted") throw new Error(`${id}: landed review must be accepted`);
  const assertions = record(review.assertions, `${id}.assertions`);
  for (const key of [
    "lowestTrustTier",
    "noDuplicateAuthority",
    "noCompatibilityShim",
    "noInactiveVendoredMaterial",
  ]) {
    if (assertions[key] !== true)
      throw new Error(`${id}: accepted review assertion ${key} is false`);
  }

  const findings = array(review.findings, `${id}.findings`).map((item, index) =>
    record(item, `${id}.findings[${index}]`),
  );
  requireUnique(
    findings.map((finding) => string(finding.id, `${id}.finding.id`)),
    `${id} finding IDs`,
  );
  const registeredScenarios = new Set(
    scenarioRegistry.filter((item) => item.stage === "s4").map((item) => item.id),
  );
  for (const finding of findings) {
    const disposition = string(finding.disposition, `${id}.finding.disposition`);
    if (disposition === "open") throw new Error(`${id}: accepted review contains an open finding`);
    const regression = finding.regressionScenarioId;
    if (
      disposition === "fixed" &&
      (typeof regression !== "string" || !registeredScenarios.has(regression))
    ) {
      throw new Error(`${id}: fixed finding lacks a registered S4 regression scenario`);
    }
    if (
      disposition === "accepted" &&
      (typeof finding.rationale !== "string" || finding.rationale.length === 0)
    ) {
      throw new Error(`${id}: accepted finding lacks rationale`);
    }
  }

  const contract = record(review.capabilityContract, `${id}.capabilityContract`);
  const scenarioIds = stringArray(contract.scenarioIds, `${id}.scenarioIds`);
  requireSortedUnique(scenarioIds, `${id} capability scenario IDs`);
  for (const scenarioId of scenarioIds) {
    if (!registeredScenarios.has(scenarioId))
      throw new Error(`${id}: unregistered scenario ${scenarioId}`);
  }

  const metadata = record(review.review, `${id}.review`);
  await validateReviewContexts(root, metadata, id);
  const budgets = record(review.budgets, `${id}.budgets`);
  await validateBudgets(root, budgets, candidate, id);
  const digest = await reviewedInputDigest(root, candidate, budgets);
  if (metadata.reviewedInputDigest !== digest) throw new Error(`${id}: stale reviewedInputDigest`);
}

async function validateReviewContexts(
  root: string,
  review: Record<string, unknown>,
  id: string,
): Promise<void> {
  const contexts = record(review.contexts, `${id}.review.contexts`);
  const scout = record(contexts.scout, `${id}.review.contexts.scout`);
  const implementer = record(contexts.implementer, `${id}.review.contexts.implementer`);
  const verifier = record(contexts.verifier, `${id}.review.contexts.verifier`);
  const contextIds = [scout.id, implementer.id, verifier.id].map((item) =>
    string(item, `${id}.context.id`),
  );
  requireUnique(contextIds, `${id} review context IDs`);
  const scoutCompleted = Date.parse(string(scout.completedAt, `${id}.scout.completedAt`));
  const implementerCompleted = Date.parse(
    string(implementer.completedAt, `${id}.implementer.completedAt`),
  );
  const verifierStarted = Date.parse(string(verifier.startedAt, `${id}.verifier.startedAt`));
  const reviewedAt = Date.parse(string(review.reviewedAt, `${id}.review.reviewedAt`));
  if (!(scoutCompleted <= implementerCompleted && implementerCompleted <= verifierStarted)) {
    throw new Error(`${id}: review contexts are not chronologically ordered`);
  }
  if (verifierStarted > reviewedAt) throw new Error(`${id}: review predates its verifier context`);
  const revision = string(review.gitRevision, `${id}.review.gitRevision`);
  const ancestor = await Bun.$`git merge-base --is-ancestor ${revision} HEAD`
    .cwd(root)
    .quiet()
    .nothrow();
  if (ancestor.exitCode !== 0) throw new Error(`${id}: review gitRevision is not in current HEAD`);
  const excludedReviews = ":(exclude)docs/plans/s4-extension-reviews";
  const implementationDiff = await Bun.$`git diff --quiet ${revision} HEAD -- . ${excludedReviews}`
    .cwd(root)
    .quiet()
    .nothrow();
  if (implementationDiff.exitCode !== 0) {
    throw new Error(`${id}: implementation changed after the reviewed gitRevision`);
  }
  const status = (await Bun.$`git status --porcelain`.cwd(root).quiet()).text().trim();
  if (status.length > 0) throw new Error(`${id}: landed review requires a clean checkout`);
}

async function validateBudgets(
  root: string,
  budgets: Record<string, unknown>,
  candidate: Record<string, unknown>,
  id: string,
): Promise<void> {
  validateReviewBudgetContract(budgets, candidate);
  const production = record(budgets.production, `${id}.budgets.production`);
  const allowedFiles = stringArray(production.allowedFiles, `${id}.allowedFiles`);
  requireSortedUnique(allowedFiles, `${id} allowed production files`);
  let lines = 0;
  for (const path of allowedFiles) {
    await validateRepositoryFile(root, path);
    const text = await Bun.file(join(root, path)).text();
    lines += physicalLineCount(text);
  }
  const maximumLines = integer(production.maximumLines, `${id}.maximumLines`);
  if (lines > maximumLines) throw new Error(`${id}: production line budget exceeded`);

  const support = record(budgets.supportMaterial, `${id}.supportMaterial`);
  const supportFiles = array(support.files, `${id}.supportMaterial.files`).map((item, index) =>
    record(item, `${id}.supportMaterial.files[${index}]`),
  );
  const supportPaths = supportFiles.map((item) => string(item.path, `${id}.support.path`));
  requireSortedUnique(supportPaths, `${id} support paths`);
  let supportBytes = 0;
  for (const file of supportFiles) {
    const path = string(file.path, `${id}.support.path`);
    await validateRepositoryFile(root, path);
    const bytes = await Bun.file(join(root, path)).arrayBuffer();
    supportBytes += bytes.byteLength;
    if (file.bytes !== bytes.byteLength || file.sha256 !== sha256(bytes)) {
      throw new Error(`${id}: support digest or byte count mismatch for ${path}`);
    }
    if (!path.includes("/skills/")) throw new Error(`${id}: support file is outside a Skill root`);
  }
  if (supportFiles.length > integer(support.maximumFiles, `${id}.support.maximumFiles`)) {
    throw new Error(`${id}: support file budget exceeded`);
  }
  if (supportBytes > integer(support.maximumBytes, `${id}.support.maximumBytes`)) {
    throw new Error(`${id}: support byte budget exceeded`);
  }

  const reviewedFiles = [...allowedFiles, ...supportPaths].sort(compareUtf8);
  const implementationFiles = await discoverImplementationFiles(root, candidate);
  validateImplementationFileSet(reviewedFiles, implementationFiles, id);

  await validateExtensionImplementation(root, candidate, budgets, implementationFiles, id);
}

export function validateReviewBudgetContract(
  budgets: Record<string, unknown>,
  candidate: Record<string, unknown>,
): void {
  const id = string(candidate.id, "candidate.id");
  const runtimeDependencies = stringArray(budgets.runtimeDependencies, `${id}.runtimeDependencies`);
  requireSortedUnique(runtimeDependencies, `${id} runtime dependencies`);
  const expectedDependencies = array(candidate.dependencies, `${id}.candidate.dependencies`)
    .map((item) => string(record(item, `${id}.candidate.dependency`).name, `${id}.dependency.name`))
    .sort(compareUtf8);
  requireExactList(
    runtimeDependencies,
    expectedDependencies,
    `${id} reviewed runtime dependencies`,
  );

  const subprocesses = array(budgets.subprocesses, `${id}.subprocesses`).map((item, index) =>
    stringArray(record(item, `${id}.subprocesses[${index}]`).argv, `${id}.subprocess.argv`),
  );
  const subprocessKeys = subprocesses.map((argv) => argv.join("\0"));
  requireSortedUnique(subprocessKeys, `${id} subprocess argv`);
  const reviewedExecutables = [
    ...new Set(subprocesses.map((argv) => argv[0]).filter(isString)),
  ].sort(compareUtf8);
  const candidatePermissions = record(candidate.permissions, `${id}.candidate.permissions`);
  const expectedExecutables = [
    ...stringArray(candidatePermissions.subprocesses, `${id}.subprocesses`),
  ].sort(compareUtf8);
  requireExactList(
    reviewedExecutables,
    expectedExecutables,
    `${id} reviewed subprocess executables`,
  );

  const persistedStatePaths = stringArray(budgets.persistedStatePaths, `${id}.persistedStatePaths`);
  requireSortedUnique(persistedStatePaths, `${id} persisted state paths`);
  const stateAuthority = record(candidate.stateAuthority, `${id}.stateAuthority`);
  const expectedStatePaths = array(stateAuthority.persistedPaths, `${id}.candidate.persistedPaths`)
    .map((item) => string(record(item, `${id}.candidate.persistedPath`).path, `${id}.state.path`))
    .sort(compareUtf8);
  requireExactList(persistedStatePaths, expectedStatePaths, `${id} reviewed persisted state paths`);

  const reviewedPermissions = record(budgets.permissions, `${id}.review.permissions`);
  if (
    canonicalJson(reviewedPermissions) !==
    canonicalJson({
      network: candidatePermissions.network,
      filesystem: candidatePermissions.filesystem,
      secrets: candidatePermissions.secrets,
      externalAuthorities: candidatePermissions.externalAuthorities,
    })
  ) {
    throw new Error(`${id}: reviewed permissions differ from ledger`);
  }
}

export function validateImplementationFileSet(
  reviewedFiles: ReadonlyArray<string>,
  implementationFiles: ReadonlyArray<string>,
  id: string,
): void {
  requireSortedUnique(reviewedFiles, `${id} reviewed implementation files`);
  requireSortedUnique(implementationFiles, `${id} discovered implementation files`);
  requireExactList(
    implementationFiles,
    reviewedFiles,
    `${id} implementation files outside reviewed production/support allowlist`,
  );
}

async function discoverImplementationFiles(
  root: string,
  candidate: Record<string, unknown>,
): Promise<ReadonlyArray<string>> {
  const id = string(candidate.id, "candidate.id");
  const target = record(candidate.target, `${id}.target`);
  const targetId = string(target.id, `${id}.target.id`);
  if (target.mechanism === "blueprint") {
    const path = `blueprints/${targetId}.md`;
    await validateRepositoryFile(root, path);
    return [path];
  }
  const directory =
    target.mechanism === "extension"
      ? `extensions/${targetId}`
      : `packages/core/src/skills/${targetId}`;
  return collectRegularFiles(root, directory);
}

async function collectRegularFiles(
  root: string,
  directory: string,
): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const walk = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const path = `${relativeDirectory}/${entry.name}`;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`implementation contains a symlink: ${path}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && info.nlink === 1) files.push(path);
      else throw new Error(`implementation contains a non-regular or hardlinked file: ${path}`);
    }
  };
  await walk(directory);
  return files.sort(compareUtf8);
}

async function validateExtensionImplementation(
  root: string,
  candidate: Record<string, unknown>,
  budgets: Record<string, unknown>,
  implementationFiles: ReadonlyArray<string>,
  id: string,
): Promise<void> {
  const target = record(candidate.target, `${id}.target`);
  if (target.mechanism !== "extension") return;
  const targetId = string(target.id, `${id}.target.id`);
  const extensionDirectory = `extensions/${targetId}`;
  const manifestPath = `${extensionDirectory}/extension.json`;
  const tree = await readImmutableExtensionTree(join(root, extensionDirectory));
  const manifestFile = tree.files.find((file) => file.path === "extension.json");
  const manifestText = manifestFile === undefined ? undefined : decodeUtf8Maybe(manifestFile.bytes);
  if (manifestText === undefined) throw new Error(`${manifestPath}: invalid Extension manifest`);
  const manifest = decodeLandedExtensionManifest(
    parseStrictJson(manifestText, manifestPath),
    manifestPath,
  );
  if (manifest.id !== targetId) {
    throw new Error(`${id}: Extension manifest identity differs from its ledger target`);
  }
  const packageValidation = validateExtensionPackageContent(manifest, tree);
  if (!packageValidation.valid) {
    throw new Error(`${id}: invalid Extension package content: ${packageValidation.message}`);
  }
  const treeFiles = tree.files.map((file) => `${extensionDirectory}/${file.path}`);
  requireExactList(
    treeFiles,
    implementationFiles,
    `${id} stable Extension tree differs from reviewed implementation files`,
  );
  const setup = manifest.setup;
  const actual: ReadonlyArray<ReadonlyArray<string>> =
    setup === undefined
      ? []
      : setupArgv(record(setup, `${id}.manifest.setup`), `${id}.manifest.setup`);
  const reviewed = array(budgets.subprocesses, `${id}.subprocesses`).map((item, index) =>
    stringArray(record(item, `${id}.subprocesses[${index}]`).argv, `${id}.subprocess.argv`),
  );
  const reviewedKeys = new Set(reviewed.map((argv) => argv.join("\0")));
  for (const argv of actual) {
    if (!reviewedKeys.has(argv.join("\0"))) {
      throw new Error(
        `${id}: manifest setup/doctor argv is outside the reviewed subprocess budget`,
      );
    }
  }
}

function decodeLandedExtensionManifest(value: unknown, path: string): ExtensionManifest {
  try {
    return decodeExtensionManifest(value);
  } catch {
    throw new Error(`${path}: invalid Extension manifest`);
  }
}

function setupArgv(
  setup: Record<string, unknown>,
  label: string,
): ReadonlyArray<ReadonlyArray<string>> {
  const steps = array(setup.steps, `${label}.steps`).map((item, index) =>
    stringArray(record(item, `${label}.steps[${index}]`).argv, `${label}.steps.argv`),
  );
  const doctor = setup.doctor;
  return doctor === undefined
    ? steps
    : [...steps, stringArray(record(doctor, `${label}.doctor`).argv, `${label}.doctor.argv`)];
}

async function reviewedInputDigest(
  root: string,
  candidate: Record<string, unknown>,
  budgets: Record<string, unknown>,
): Promise<string> {
  const id = string(candidate.id, "candidate.id");
  const production = record(budgets.production, `${id}.production`);
  const support = record(budgets.supportMaterial, `${id}.support`);
  const paths = new Set<string>([
    "package.json",
    "bun.lock",
    ...stringArray(production.allowedFiles, `${id}.allowedFiles`),
    ...array(support.files, `${id}.support.files`).map((item) =>
      string(record(item, `${id}.support.file`).path, `${id}.support.path`),
    ),
  ]);
  const target = record(candidate.target, `${id}.target`);
  if (target.mechanism === "extension")
    paths.add(`extensions/${string(target.id, `${id}.target.id`)}/extension.json`);
  for (const path of [...paths]) {
    const components = path.split("/");
    if (components[0] === "packages" && components[1] !== undefined) {
      paths.add(`packages/${components[1]}/package.json`);
    }
  }
  const inputs = [];
  const row = canonicalJson(candidate);
  inputs.push({
    path: `${ledgerPath}#candidate/${id}`,
    bytes: new TextEncoder().encode(row).byteLength,
    sha256: sha256(row),
  });
  for (const path of [...paths].sort(compareUtf8)) {
    await validateRepositoryFile(root, path);
    const bytes = await Bun.file(join(root, path)).arrayBuffer();
    inputs.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  inputs.sort((left, right) => compareUtf8(left.path, right.path));
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      candidateId: id,
      deliveryStatus: candidate.deliveryStatus,
      ledgerRowDigest: sha256(row),
      inputs,
    }),
  );
}

function validateCandidate(candidate: Record<string, unknown>): void {
  const id = string(candidate.id, "candidate.id");
  const evidence = array(
    record(candidate.capability, `${id}.capability`).evidence,
    `${id}.evidence`,
  ).map((item) => record(item, `${id}.evidence`));
  const evidencePaths = evidence.map((item) => string(item.path, `${id}.evidence.path`));
  requireSortedUnique(evidencePaths, `${id} evidence paths`);
  if (!evidencePaths.every((path) => path.startsWith(`extensions/${id}/`))) {
    throw new Error(`${id}: evidence must be source-relative to its Merlin candidate`);
  }
  const overlaps = array(candidate.overlap, `${id}.overlap`).map((item) =>
    record(item, `${id}.overlap`),
  );
  requireSortedUnique(
    overlaps.map((item) => string(item.with, `${id}.overlap.with`)),
    `${id} overlap IDs`,
  );
  const permissions = record(candidate.permissions, `${id}.permissions`);
  for (const key of ["secrets", "subprocesses", "externalAuthorities"]) {
    requireSortedUnique(
      stringArray(permissions[key], `${id}.permissions.${key}`),
      `${id} permission ${key}`,
    );
  }
  const disposition = string(candidate.disposition, `${id}.disposition`);
  if (disposition === "drop") {
    if (candidate.target !== null || candidate.deliveryStatus !== "not-applicable") {
      throw new Error(`${id}: drop alone is not-applicable and has no target`);
    }
    return;
  }
  if (candidate.deliveryStatus !== "planned" && candidate.deliveryStatus !== "landed") {
    throw new Error(`${id}: every non-dropped row must be planned or landed`);
  }
  const target = record(candidate.target, `${id}.target`);
  if (disposition === "blueprint" && target.mechanism !== "blueprint")
    throw new Error(`${id}: blueprint target mismatch`);
  if (
    disposition === "defer-to-S5" &&
    (target.mechanism !== "automation" || target.ownerStage !== "s5")
  )
    throw new Error(`${id}: S5 deferral target mismatch`);
  if (disposition === "defer-to-S6/S7" && target.ownerStage !== "s6" && target.ownerStage !== "s7")
    throw new Error(`${id}: S6/S7 deferral target mismatch`);
  if (target.mechanism === "extension") {
    const executionMode = target.executionMode;
    if (
      executionMode !== "skill-only" &&
      executionMode !== "supervised-command" &&
      executionMode !== "define-tool"
    ) {
      throw new Error(`${id}: invalid Extension execution mode`);
    }
  }
}

function requiresLandedReview(candidate: Record<string, unknown>): boolean {
  if (candidate.deliveryStatus !== "landed") return false;
  const disposition = candidate.disposition;
  if (disposition !== "port" && disposition !== "merge" && disposition !== "blueprint")
    return false;
  const target = candidate.target;
  if (target === null) return false;
  return record(target, "candidate.target").ownerStage === "s4";
}

async function validateRepositoryFile(root: string, path: string): Promise<void> {
  if (!isSafeRepositoryPath(path)) throw new Error(`unsafe repository path: ${path}`);
  const absoluteRoot = resolve(root);
  let current = absoluteRoot;
  const components = path.split("/");
  let final: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    final = await lstat(current);
    if (final.isSymbolicLink()) throw new Error(`repository input contains a symlink: ${path}`);
    if (index < components.length - 1 && !final.isDirectory())
      throw new Error(`repository path component is not a directory: ${path}`);
  }
  if (final === undefined || !final.isFile() || final.nlink !== 1)
    throw new Error(`repository input is not a single-linked regular file: ${path}`);
  const realRoot = await realpath(absoluteRoot);
  const realFile = await realpath(resolve(absoluteRoot, path));
  const contained = relative(realRoot, realFile);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained))
    throw new Error(`repository input escapes root: ${path}`);
}

function isSafeRepositoryPath(path: string): boolean {
  if (isAbsolute(path) || normalize(path) !== path || path.includes("\\") || path.includes("\0"))
    return false;
  const parts = path.split("/");
  return (
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !parts.some(
      (part) =>
        part === ".git" || part === ".artifacts" || part === "vendor" || part === "node_modules",
    )
  );
}

function parseStrictJson(text: string, source: string): unknown {
  if (!isStrictJson(text))
    throw new Error(`${source}: invalid strict JSON or duplicate object key`);
  return JSON.parse(text);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label}: expected object`);
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label}: expected non-empty string`);
  return value;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label}: expected non-negative safe integer`);
  return value;
}

function stringArray(value: unknown, label: string): ReadonlyArray<string> {
  return array(value, label).map((item) => string(item, label));
}

function requireExactList(
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  label: string,
): void {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(
      `${label}: expected exactly ${expected.join(", ")}; received ${actual.join(", ")}`,
    );
  }
}

function requireSortedUnique(values: ReadonlyArray<string>, label: string): void {
  requireUnique(values, label);
  const sorted = [...values].sort(compareUtf8);
  requireExactList(values, sorted, `${label} canonical ordering`);
}

function requireUnique(values: ReadonlyArray<string>, label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}: duplicate value`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareUtf8(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

if (import.meta.main) {
  const root = new URL("../..", import.meta.url).pathname;
  const result = await verifyExtensionIntegrity(root);
  console.log(
    `extension integrity: ${result.candidateCount} candidates, ${result.landedReviewCount} landed reviews, ledger ${result.ledgerDigest}`,
  );
}
