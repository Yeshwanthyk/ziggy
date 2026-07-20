import { homedir, tmpdir } from "node:os";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ProcessResult } from "../../tests/testkit/boundaries.ts";
import type { Stage } from "./manifests.ts";
import { loadSchemaCatalog } from "./schemas.ts";

const diagnosticLimit = 8_192;
const excludedWorkspaceDirectories = new Set([
  ".artifacts",
  ".git",
  ".pi",
  "node_modules",
  "vendor",
]);

interface OutputEvidence {
  readonly diagnostic: string;
  readonly diagnosticDigest: string;
  readonly truncated: boolean;
}

export interface CommandEvidence {
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: OutputEvidence;
  readonly stderr: OutputEvidence;
}

export interface PhaseEvidence {
  readonly name: "preflight" | "gate" | "scenario" | "publication";
  readonly result: "passed" | "failed" | "not-run";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly diagnostic: string;
}

export interface ScenarioEvidence {
  readonly id: string;
  readonly file: string;
  readonly result: "passed" | "failed" | "not-run";
  readonly seed: string;
  readonly schedule: string;
  readonly boundaryConfiguration: string;
}

export interface EvidenceInput {
  readonly runId: string;
  readonly stage: Stage | "all";
  readonly command: string;
  readonly scenarios: ReadonlyArray<ScenarioEvidence>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly gitRevision: string | null;
  readonly gitDirty: boolean;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly phases: ReadonlyArray<PhaseEvidence>;
  readonly commands: ReadonlyArray<CommandEvidence>;
  readonly result: "passed" | "failed";
}

export interface PublishedEvidence {
  readonly directory: string;
  readonly summaryDigest: string;
  readonly resultDigest: string;
  readonly workspaceInputDigest: string;
}

interface ReplayInput {
  readonly path: string;
  readonly digest: string;
}

interface DecodedPhase {
  readonly result: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

interface DecodedSummary {
  readonly runId: string;
  readonly command: string;
  readonly scenarios: ReadonlyArray<string>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: "passed" | "failed";
  readonly phases: ReadonlyArray<DecodedPhase>;
  readonly commands: ReadonlyArray<CommandEvidence>;
}

interface DecodedResult {
  readonly runId: string;
  readonly scenarios: ReadonlyArray<{ readonly id: string; readonly result: string }>;
}

export function digest(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function commandEvidence(
  argv: ReadonlyArray<string>,
  result: ProcessResult,
  repositoryRoot: string,
): CommandEvidence {
  return {
    argv: redactArgv(argv, repositoryRoot),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: outputEvidence(result.stdout, repositoryRoot),
    stderr: outputEvidence(result.stderr, repositoryRoot),
  };
}

export function redactValue(value: unknown, repositoryRoot: string, key = ""): unknown {
  if (typeof value === "string") {
    if (isSensitiveField(key)) {
      return `<redacted:${normalizeKey(key) || "sensitive"}>`;
    }
    return redactString(value, repositoryRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, repositoryRoot));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, repositoryRoot, entryKey),
      ]),
    );
  }
  return value;
}

export function redactString(value: string, repositoryRoot: string): string {
  let redacted = replacePaths(value, repositoryRoot);
  redacted = redactHeaders(redacted);
  redacted = redacted.replace(
    /\b(?:Bearer|Basic)\s+(?!<redacted)[A-Za-z0-9._~+/=-]+/gi,
    "<redacted:auth>",
  );
  redacted = redactSensitiveAssignments(redacted);
  redacted = redacted.replace(
    /\bProfile\s*(?:path)?\s*[:=]\s*(?!<redacted>)[^\r\n]+/gi,
    "Profile: <redacted>",
  );
  return redacted;
}

export function assertNoLeaks(serialized: string, repositoryRoot: string): void {
  if (redactString(serialized, repositoryRoot) !== serialized) {
    throw new Error("evidence redaction leak detected");
  }
}

function redactArgv(argv: ReadonlyArray<string>, repositoryRoot: string): ReadonlyArray<string> {
  const redacted: string[] = [];
  let redactNextAs: string | undefined;
  for (const argument of argv) {
    if (redactNextAs !== undefined) {
      redacted.push(`<redacted:${redactNextAs}>`);
      redactNextAs = undefined;
      continue;
    }
    const option = /^(--?)([^=]+)(?:=(.*))?$/.exec(argument);
    const optionName = option?.[2];
    if (option !== null && optionName !== undefined && isSensitiveField(optionName)) {
      const normalized = normalizeKey(optionName) || "sensitive";
      if (option[3] === undefined) {
        redacted.push(`${option[1]}${optionName}`);
        redactNextAs = normalized;
      } else {
        redacted.push(`${option[1]}${optionName}=<redacted:${normalized}>`);
      }
      continue;
    }
    redacted.push(redactString(argument, repositoryRoot));
  }
  return redacted;
}

function redactHeaders(value: string): string {
  return value.replace(
    /((?:[A-Za-z0-9_.-]*(?:authorization|cookie)|proxy-authorization|set-cookie|x-api-key)[\\"']*\s*[:=]\s*)(\\?["'](?:\\.|[^"'\\])*\\?["']|[^\r\n,}]+)/gi,
    (match, prefix: string, candidate: string) =>
      isRedacted(candidate) ? match : `${prefix}<redacted>`,
  );
}

function redactSensitiveAssignments(value: string): string {
  return value.replace(
    /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_\-.]?key|credential|auth)[A-Za-z0-9_.-]*[\\"']*\s*[=:]\s*)(\\?["'](?:\\.|[^"'\\])*\\?["']|[^\s,;&}]+)/gi,
    (match, prefix: string, candidate: string) =>
      isRedacted(candidate) ? match : `${prefix}<redacted>`,
  );
}

function isRedacted(value: string): boolean {
  return value
    .trim()
    .replace(/^[\\"']+/, "")
    .startsWith("<redacted");
}

export async function publishEvidence(
  root: string,
  input: EvidenceInput,
): Promise<PublishedEvidence> {
  const workspaceInputs = await readWorkspaceInputs(root);
  const workspaceInputDigest = digestWorkspaceInputs(workspaceInputs);
  const summary = {
    schemaVersion: 1,
    runId: input.runId,
    stage: input.stage,
    command: input.command,
    scenarios: input.scenarios.map((scenario) => scenario.id),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    git: { revision: input.gitRevision, dirty: input.gitDirty },
    toolVersions: input.toolVersions,
    result: input.result,
    phases: input.phases,
    commands: input.commands,
  };
  const results = {
    schemaVersion: 1,
    runId: input.runId,
    scenarios: input.scenarios,
  };
  const schemas = await loadSchemaCatalog(root);
  const summaryText = serializeValidated(summary, root, (value) => {
    schemas.validate("evidence-summary-v1.schema.json", value, "summary");
    decodeSummary(value);
  });
  const resultText = serializeValidated(results, root, (value) => {
    schemas.validate("evidence-result-v1.schema.json", value, "result");
    decodeResult(value);
  });
  const replay = {
    schemaVersion: 1,
    runId: input.runId,
    command: input.command,
    summaryDigest: digest(summaryText),
    resultDigest: digest(resultText),
    workspaceInputDigest,
    inputs: workspaceInputs,
  };
  const replayText = serializeValidated(replay, root, (value) => {
    schemas.validate("evidence-replay-v1.schema.json", value, "replay");
    decodeReplay(value);
  });

  const parent = join(root, ".artifacts/verification");
  const directory = join(parent, input.runId);
  const temporaryDirectory = join(
    parent,
    `.${input.runId}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(temporaryDirectory);
    await Promise.all([
      Bun.write(join(temporaryDirectory, "summary.json"), summaryText),
      Bun.write(join(temporaryDirectory, "result.json"), resultText),
      Bun.write(join(temporaryDirectory, "replay.json"), replayText),
    ]);
    await validateReplay(temporaryDirectory, root);
    if (await exists(directory)) {
      throw new Error(`evidence destination already exists: ${input.runId}`);
    }
    await rename(temporaryDirectory, directory);
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
  return {
    directory,
    summaryDigest: replay.summaryDigest,
    resultDigest: replay.resultDigest,
    workspaceInputDigest,
  };
}

export async function validateReplay(directory: string, root: string): Promise<void> {
  const summaryPath = join(directory, "summary.json");
  const resultPath = join(directory, "result.json");
  const replayPath = join(directory, "replay.json");
  await Promise.all([
    assertRegularFile(summaryPath, "summary"),
    assertRegularFile(resultPath, "result"),
    assertRegularFile(replayPath, "replay"),
  ]);
  const [summaryText, resultText, replayText] = await Promise.all([
    Bun.file(summaryPath).text(),
    Bun.file(resultPath).text(),
    Bun.file(replayPath).text(),
  ]);
  for (const text of [summaryText, resultText, replayText]) {
    assertNoLeaks(text, root);
  }
  const summaryValue = parseJson(summaryText, "summary");
  const resultValue = parseJson(resultText, "result");
  const replayValue = parseJson(replayText, "replay");
  const schemas = await loadSchemaCatalog(root);
  schemas.validate("evidence-summary-v1.schema.json", summaryValue, "summary");
  schemas.validate("evidence-result-v1.schema.json", resultValue, "result");
  schemas.validate("evidence-replay-v1.schema.json", replayValue, "replay");
  const summary = decodeSummary(summaryValue);
  const result = decodeResult(resultValue);
  const replay = decodeReplay(replayValue);
  if (replay.summaryDigest !== digest(summaryText)) {
    throw new Error("replay summary digest mismatch");
  }
  if (replay.resultDigest !== digest(resultText)) {
    throw new Error("replay result digest mismatch");
  }
  if (replay.runId !== summary.runId || replay.runId !== result.runId) {
    throw new Error("replay runId mismatch");
  }
  if (replay.command !== summary.command) {
    throw new Error("replay command mismatch");
  }
  if (
    summary.scenarios.length !== result.scenarios.length ||
    summary.scenarios.some((id, index) => id !== result.scenarios[index]?.id)
  ) {
    throw new Error("summary/result scenario mismatch");
  }
  validateTimestamps(summary);
  validateAggregateResult(summary, result);
  for (const command of summary.commands) {
    validateOutputEvidence(command.stdout, "stdout");
    validateOutputEvidence(command.stderr, "stderr");
  }
  const currentInputs = await readWorkspaceInputs(root);
  if (replay.workspaceInputDigest !== digestWorkspaceInputs(currentInputs)) {
    throw new Error("replay workspace input digest mismatch");
  }
  const currentByPath = new Map(currentInputs.map((input) => [input.path, input.digest]));
  for (const input of replay.inputs) {
    if (currentByPath.get(input.path) !== input.digest) {
      throw new Error(`replay input digest mismatch: ${input.path}`);
    }
  }
  if (replay.inputs.length !== currentInputs.length) {
    throw new Error("replay input set mismatch");
  }
}

async function readWorkspaceInputs(root: string): Promise<ReadonlyArray<ReplayInput>> {
  const paths = await walkWorkspace(root, root);
  const inputs: ReplayInput[] = [];
  for (const path of paths.sort()) {
    const absolute = join(root, path);
    await assertRegularFile(absolute, `workspace input ${path}`);
    inputs.push({ path, digest: digest(await Bun.file(absolute).text()) });
  }
  return inputs;
}

function outputEvidence(output: string, root: string): OutputEvidence {
  const redacted = redactString(output, root);
  const truncated = redacted.length > diagnosticLimit;
  const diagnostic = truncated ? redacted.slice(0, diagnosticLimit) : redacted;
  return {
    diagnostic,
    diagnosticDigest: digest(diagnostic),
    truncated,
  };
}

function validateOutputEvidence(output: OutputEvidence, label: string): void {
  if (output.diagnosticDigest !== digest(output.diagnostic)) {
    throw new Error(`${label} diagnostic digest mismatch`);
  }
  if (output.truncated && output.diagnostic.length !== diagnosticLimit) {
    throw new Error(`${label} truncation metadata mismatch`);
  }
}

function validateTimestamps(summary: DecodedSummary): void {
  const startedAt = timestamp(summary.startedAt, "summary.startedAt");
  const finishedAt = timestamp(summary.finishedAt, "summary.finishedAt");
  if (startedAt > finishedAt) {
    throw new Error("summary timestamp order mismatch");
  }
  let previousStartedAt = startedAt;
  for (const [index, phase] of summary.phases.entries()) {
    const phaseStartedAt = timestamp(phase.startedAt, `summary.phases[${index}].startedAt`);
    const phaseFinishedAt = timestamp(phase.finishedAt, `summary.phases[${index}].finishedAt`);
    if (
      phaseStartedAt < startedAt ||
      phaseStartedAt > finishedAt ||
      phaseFinishedAt < phaseStartedAt ||
      phaseFinishedAt > finishedAt
    ) {
      throw new Error(`summary phase timestamp mismatch at index ${index}`);
    }
    if (phaseStartedAt < previousStartedAt) {
      throw new Error(`summary phase timestamp order mismatch at index ${index}`);
    }
    previousStartedAt = phaseStartedAt;
  }
}

function validateAggregateResult(summary: DecodedSummary, result: DecodedResult): void {
  const hasFailure =
    summary.commands.some((command) => command.exitCode !== 0 || command.timedOut) ||
    summary.phases.some((phase) => phase.result === "failed") ||
    result.scenarios.some((scenario) => scenario.result === "failed");
  if ((summary.result === "failed") !== hasFailure) {
    throw new Error("summary aggregate result mismatch");
  }
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function serializeValidated(
  value: unknown,
  root: string,
  validate: (value: unknown) => void,
): string {
  const redacted = redactValue(value, root);
  validate(redacted);
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  assertNoLeaks(serialized, root);
  return serialized;
}

function replacePaths(value: string, repositoryRoot: string): string {
  let redacted = value.split(repositoryRoot).join("<repo>");
  for (const replacement of [
    { path: homedir(), value: "<home>" },
    { path: tmpdir(), value: "<temp>" },
  ]) {
    if (replacement.path.length > 1) {
      redacted = redacted.split(replacement.path).join(replacement.value);
    }
  }
  redacted = redacted.replace(
    /\/(?:Users|home)\/[^\s"']+|\/(?:private\/)?(?:tmp|var\/folders|var\/tmp)\/[^\s"']+/g,
    "<redacted:path>",
  );
  redacted = redacted.replace(
    /\/[A-Za-z0-9._/-]*Profile(?:\/[A-Za-z0-9._/-]*)?/g,
    "<redacted:profile-path>",
  );
  return redacted;
}

function isSensitiveField(key: string): boolean {
  const normalized = normalizeKey(key);
  if (
    [
      "password",
      "passwd",
      "passphrase",
      "secret",
      "token",
      "apikey",
      "credential",
      "authorization",
      "cookie",
    ].some((sensitive) => normalized.includes(sensitive))
  ) {
    return true;
  }
  return [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "clientsecret",
    "credential",
    "credentials",
    "bearer",
    "basic",
    "auth",
    "authorization",
    "cookie",
    "setcookie",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "apikey",
    "querytoken",
    "owner",
    "person",
    "identity",
    "message",
    "content",
    "profile",
    "profilepath",
  ].some((sensitive) => normalized === sensitive || normalized.endsWith(sensitive));
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function digestWorkspaceInputs(inputs: ReadonlyArray<ReplayInput>): string {
  return digest(inputs.map((input) => `${input.path}\0${input.digest}`).join("\n"));
}

async function walkWorkspace(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`workspace input symlink rejected: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory() && excludedWorkspaceDirectories.has(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkWorkspace(root, absolute)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute));
    }
  }
  return files;
}

function decodeSummary(value: unknown): DecodedSummary {
  const record = requireRecord(value, "summary");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "stage",
      "command",
      "scenarios",
      "startedAt",
      "finishedAt",
      "git",
      "toolVersions",
      "result",
      "phases",
      "commands",
    ],
    "summary",
  );
  requireVersion(record, "summary");
  const runId = requireString(record.runId, "summary.runId");
  const command = requireString(record.command, "summary.command");
  const startedAt = requireString(record.startedAt, "summary.startedAt");
  const finishedAt = requireString(record.finishedAt, "summary.finishedAt");
  const scenarios = requireStringArray(record.scenarios, "summary.scenarios");
  requireRecord(record.git, "summary.git");
  const tools = requireRecord(record.toolVersions, "summary.toolVersions");
  for (const version of Object.values(tools)) {
    requireString(version, "summary tool version");
  }
  if (!Array.isArray(record.phases)) {
    throw new Error("summary.phases must be an array");
  }
  const phases: DecodedPhase[] = [];
  for (const phaseValue of record.phases) {
    const phase = requireRecord(phaseValue, "summary phase");
    requireExactKeys(
      phase,
      ["name", "result", "startedAt", "finishedAt", "diagnostic"],
      "summary phase",
    );
    requireString(phase.name, "summary phase name");
    const phaseResult = requireString(phase.result, "summary phase result");
    const phaseStartedAt = requireString(phase.startedAt, "summary phase startedAt");
    const phaseFinishedAt = requireString(phase.finishedAt, "summary phase finishedAt");
    requireStringAllowEmpty(phase.diagnostic, "summary phase diagnostic");
    phases.push({ result: phaseResult, startedAt: phaseStartedAt, finishedAt: phaseFinishedAt });
  }
  if (!Array.isArray(record.commands)) {
    throw new Error("summary.commands must be an array");
  }
  return {
    runId,
    command,
    scenarios,
    startedAt,
    finishedAt,
    result: requireEvidenceResult(record.result, "summary.result"),
    phases,
    commands: record.commands.map((command, index) => decodeCommand(command, index)),
  };
}

function decodeCommand(value: unknown, index: number): CommandEvidence {
  const record = requireRecord(value, `summary.commands[${index}]`);
  requireExactKeys(
    record,
    ["argv", "exitCode", "timedOut", "stdout", "stderr"],
    `summary.commands[${index}]`,
  );
  if (!Array.isArray(record.argv) || record.argv.some((item) => typeof item !== "string")) {
    throw new Error(`summary.commands[${index}].argv must contain strings`);
  }
  const argv: string[] = [];
  for (const item of record.argv) {
    if (typeof item === "string") {
      argv.push(item);
    }
  }
  if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode)) {
    throw new Error(`summary.commands[${index}].exitCode must be an integer`);
  }
  if (typeof record.timedOut !== "boolean") {
    throw new Error(`summary.commands[${index}].timedOut must be boolean`);
  }
  return {
    argv,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    stdout: decodeOutput(record.stdout, `${index}.stdout`),
    stderr: decodeOutput(record.stderr, `${index}.stderr`),
  };
}

function decodeOutput(value: unknown, label: string): OutputEvidence {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["diagnostic", "diagnosticDigest", "truncated"], label);
  if (typeof record.truncated !== "boolean") {
    throw new Error(`${label}: invalid output metadata`);
  }
  return {
    diagnostic: requireStringAllowEmpty(record.diagnostic, `${label}.diagnostic`),
    diagnosticDigest: requireString(record.diagnosticDigest, `${label}.diagnosticDigest`),
    truncated: record.truncated,
  };
}

function decodeResult(value: unknown): DecodedResult {
  const record = requireRecord(value, "result");
  requireExactKeys(record, ["schemaVersion", "runId", "scenarios"], "result");
  requireVersion(record, "result");
  if (!Array.isArray(record.scenarios)) {
    throw new Error("result.scenarios must be an array");
  }
  const ids = new Set<string>();
  const scenarios: Array<{ id: string; result: string }> = [];
  for (const scenario of record.scenarios) {
    const scenarioRecord = requireRecord(scenario, "result scenario");
    requireExactKeys(
      scenarioRecord,
      ["id", "file", "result", "seed", "schedule", "boundaryConfiguration"],
      "result scenario",
    );
    const id = requireString(scenarioRecord.id, "result scenario id");
    requireString(scenarioRecord.file, "result scenario file");
    const scenarioResult = requireString(scenarioRecord.result, "result scenario result");
    requireString(scenarioRecord.seed, "result scenario seed");
    requireString(scenarioRecord.schedule, "result scenario schedule");
    requireString(scenarioRecord.boundaryConfiguration, "result scenario boundaryConfiguration");
    if (ids.has(id)) {
      throw new Error(`duplicate evidence scenario ${id}`);
    }
    ids.add(id);
    scenarios.push({ id, result: scenarioResult });
  }
  return { runId: requireString(record.runId, "result.runId"), scenarios };
}

function decodeReplay(value: unknown): {
  runId: string;
  command: string;
  summaryDigest: string;
  resultDigest: string;
  workspaceInputDigest: string;
  inputs: ReadonlyArray<ReplayInput>;
} {
  const record = requireRecord(value, "replay");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "command",
      "summaryDigest",
      "resultDigest",
      "workspaceInputDigest",
      "inputs",
    ],
    "replay",
  );
  requireVersion(record, "replay");
  const command = requireString(record.command, "replay.command");
  if (!Array.isArray(record.inputs)) {
    throw new Error("replay.inputs must be an array");
  }
  const inputs: ReplayInput[] = [];
  const paths = new Set<string>();
  for (const item of record.inputs) {
    const input = requireRecord(item, "replay input");
    const path = requireString(input.path, "replay input path");
    if (isAbsolute(path) || path.includes("..") || paths.has(path)) {
      throw new Error(`invalid or duplicate replay input path ${path}`);
    }
    paths.add(path);
    inputs.push({ path, digest: requireString(input.digest, "replay input digest") });
  }
  return {
    runId: requireString(record.runId, "replay.runId"),
    command,
    summaryDigest: requireString(record.summaryDigest, "replay.summaryDigest"),
    resultDigest: requireString(record.resultDigest, "replay.resultDigest"),
    workspaceInputDigest: requireString(record.workspaceInputDigest, "replay.workspaceInputDigest"),
    inputs,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: ReadonlyArray<string>,
  label: string,
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new Error(`${label} has unknown field ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!(key in record)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}

function requireVersion(record: Record<string, unknown>, label: string): void {
  if (record.schemaVersion !== 1) {
    throw new Error(`${label} has unsupported schemaVersion`);
  }
}

function requireStringArray(value: unknown, label: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const strings: string[] = [];
  for (const item of value) {
    strings.push(requireString(item, label));
  }
  return strings;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireEvidenceResult(value: unknown, label: string): "passed" | "failed" {
  if (value === "passed" || value === "failed") {
    return value;
  }
  throw new Error(`${label} must be passed or failed`);
}

function requireStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} symlink or non-file rejected`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
