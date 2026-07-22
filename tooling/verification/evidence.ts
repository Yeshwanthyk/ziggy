import { homedir, tmpdir } from "node:os";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProcessResult } from "../../tests/testkit/boundaries.ts";
import type { RuntimeObservations } from "../../tests/testkit/verification-observations.ts";
import type { Stage } from "./manifests.ts";
import { loadSchemaCatalog } from "./schemas.ts";

const diagnosticLimit = 8_192;
const multilineValueByteLimit = 65_536;
const multilineValueLineLimit = 256;
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
  readonly observations: RuntimeObservations;
}

export interface AgentFindingEvidence {
  readonly id: string;
  readonly role: "scout" | "review";
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly review: {
    readonly workspaceDigest: string;
    readonly gitRevision: string | null;
    readonly reviewedAt: string;
  };
  readonly disposition: {
    readonly status: "open" | "accepted" | "fixed" | "not-applicable";
    readonly rationale: string;
    readonly regressionScenarioId: string | null;
  };
}

export interface EvidenceInput {
  readonly runId: string;
  readonly stage: Stage | "all";
  readonly command: string;
  readonly scenarios: ReadonlyArray<ScenarioEvidence>;
  readonly agentFindings?: ReadonlyArray<AgentFindingEvidence>;
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
  readonly schemaVersion: 1 | 2;
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
  readonly schemaVersion: 1 | 2;
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

export async function readAgentFindings(
  repositoryRoot: string,
  inputPath: string,
): Promise<ReadonlyArray<AgentFindingEvidence>> {
  const path = resolve(inputPath);
  const relativePath = relative(repositoryRoot, path);
  if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`)) {
    throw new Error("agent findings input must be an untracked file outside the repository");
  }
  await assertRegularFile(path, "agent findings input");
  const file = Bun.file(path);
  if (file.size > 65_536) {
    throw new Error("agent findings input exceeds 65536 bytes");
  }
  const parsed = parseJson(await file.text(), "agent findings input");
  const schemas = await loadSchemaCatalog(repositoryRoot);
  schemas.validate("agent-findings-v1.schema.json", parsed, "agent findings input");
  const redacted = redactValue(parsed, repositoryRoot);
  schemas.validate("agent-findings-v1.schema.json", redacted, "redacted agent findings input");
  const findings = decodeAgentFindings(redacted);
  const currentDigest = await currentWorkspaceInputDigest(repositoryRoot);
  for (const finding of findings) {
    if (finding.review.workspaceDigest !== currentDigest) {
      throw new Error(`agent finding ${finding.id} does not review the current workspace`);
    }
  }
  return findings;
}

export function redactValue(value: unknown, repositoryRoot: string, key = ""): unknown {
  if (isSensitiveField(key)) {
    return redactSensitiveTree(value, normalizeKey(key) || "sensitive");
  }
  if (typeof value === "string") return redactString(value, repositoryRoot);
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

function redactSensitiveTree(value: unknown, label: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveTree(item, label));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitiveTree(entryValue, label),
      ]),
    );
  }
  return `<redacted:${label}>`;
}

export function redactString(value: string, repositoryRoot: string): string {
  let redacted = replacePaths(value, repositoryRoot);
  redacted = redactPemBlocks(redacted);
  redacted = redactHeaders(redacted);
  redacted = redacted.replace(
    /\b(?:Bearer|Basic)\s+(?!<redacted)[A-Za-z0-9._~+/=-]+/gi,
    "<redacted:auth>",
  );
  redacted = redactJsonSensitiveFields(redacted);
  redacted = redactSensitiveAssignments(redacted);
  redacted = redactFixtureCanaries(redacted);
  redacted = redacted.replace(
    /\bProfile\s*(?:path)?\s*[:=]\s*(?!<redacted>)[^\r\n]+/gi,
    "Profile: <redacted>",
  );
  return redacted;
}

export function assertNoLeaks(serialized: string, repositoryRoot: string): void {
  const parsed = tryParseJson(serialized);
  const containsLeak =
    parsed === undefined
      ? containsSensitiveLexicalLeak(serialized) ||
        redactString(serialized, repositoryRoot) !== serialized
      : containsStructuredLeak(parsed, repositoryRoot);
  if (containsLeak) throw new Error("evidence redaction leak detected");
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function containsStructuredLeak(value: unknown, repositoryRoot: string, key = ""): boolean {
  if (isSensitiveField(key)) return !isRedactedTree(value);
  if (typeof value === "string") {
    return containsSensitiveLexicalLeak(value) || redactString(value, repositoryRoot) !== value;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsStructuredLeak(entry, repositoryRoot));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([entryKey, entryValue]) =>
      containsStructuredLeak(entryValue, repositoryRoot, entryKey),
    );
  }
  return false;
}

function isRedactedTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isRedactedTree);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).every(isRedactedTree);
  }
  return typeof value === "string" && isRedacted(value);
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
    /((?:[A-Za-z0-9_.-]*(?:authorization|cookie)|proxy-authorization|set-cookie|x-api-key)[\\"']*\s*[:=]\s*)(\\?["'](?:\\.|[^"'\\])*\\?["']|[^\r\n,}\\]+)/gi,
    (match, prefix: string, candidate: string) =>
      isRedacted(candidate) ? match : `${prefix}<redacted>`,
  );
}

function redactJsonSensitiveFields(value: string): string {
  return redactSensitiveValues(
    value,
    /("(?:\\.|[^"\\])*"\s*:\s*)/g,
    (prefix) => {
      const keyLiteral = /^("(?:\\.|[^"\\])*")/.exec(prefix)?.[1];
      return keyLiteral === undefined ? undefined : decodeJsonString(keyLiteral);
    },
    "json",
  );
}

function decodeJsonString(value: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function redactSensitiveAssignments(value: string): string {
  return redactSensitiveValues(
    value,
    /\b(?![A-Za-z0-9_.-]*\.(?:test|spec)\.ts\s*:)([A-Za-z0-9_.-]+)[\\"']*\s*[=:]\s*/gi,
    (prefix) => prefix,
    "assignment",
  );
}

function redactPemBlocks(value: string): string {
  const begin = /-----BEGIN ([A-Z0-9][A-Z0-9 ._/-]{0,80})-----/g;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(begin)) {
    const index = match.index;
    const label = match[1];
    if (index < cursor || label === undefined) continue;
    const endToken = `-----END ${label}-----`;
    const tokenIndex = value.indexOf(endToken, index + match[0].length);
    if (tokenIndex < 0) throw new Error("unclosed PEM credential block");
    const end = tokenIndex + endToken.length;
    assertMultilineBounds(value, index, end);
    output += `${value.slice(cursor, index)}<redacted:pem>`;
    cursor = end;
  }
  return cursor === 0 ? value : `${output}${value.slice(cursor)}`;
}

function redactFixtureCanaries(value: string): string {
  return value.replace(
    /\b(?:auth|credential)(?:[-_.][a-z0-9]+)*[-_.]canary\b/gi,
    "<redacted:fixture-canary>",
  );
}

function isRedacted(value: string): boolean {
  const trimmed = value.trim();
  const token = /^<redacted(?::[A-Za-z0-9_.-]+)?>$/;
  if (token.test(trimmed)) return true;
  const decoded = decodeJsonString(trimmed);
  if (decoded !== undefined && token.test(decoded)) return true;
  return token.test(trimmed.replace(/^[\\"']+|[\\"']+$/g, ""));
}

function redactSensitiveValues(
  value: string,
  pattern: RegExp,
  keyFromPrefix: (prefix: string) => string | undefined,
  boundary: "json" | "assignment",
): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    const prefix = match[1] ?? match[0];
    const key = keyFromPrefix(prefix);
    if (index < cursor || key === undefined || !isSensitiveField(key)) continue;
    const start = index + match[0].length;
    const end = consumeSensitiveValue(value, start, boundary);
    output += value.slice(cursor, start);
    const candidate = value.slice(start, end);
    output += isExactRedaction(value, start, end, boundary) ? candidate : "<redacted>";
    cursor = end;
  }
  return cursor === 0 ? value : `${output}${value.slice(cursor)}`;
}

function consumeSensitiveValue(
  value: string,
  start: number,
  boundary: "json" | "assignment",
): number {
  let index = start;
  while (index < value.length && (value[index] === " " || value[index] === "\t")) index += 1;
  if (boundary === "assignment") {
    const multilineEnd = consumeAssignmentMultiline(value, start, index);
    if (multilineEnd !== undefined) return multilineEnd;
  }
  while (boundary === "json" && index < value.length && /\s/.test(value[index] ?? "")) index += 1;
  const first = value[index];
  if (first === '"' || first === "'") return consumeQuoted(value, index, first);
  if (first === "[" || first === "{") return consumeBalanced(value, index);
  if (value.startsWith("<redacted", index)) {
    const tokenEnd = value.indexOf(">", index);
    if (tokenEnd < 0) return value.length;
    const end = tokenEnd + 1;
    return isExactRedaction(value, index, end, boundary)
      ? end
      : consumeMalformedSensitiveValue(value, end, boundary);
  }
  while (index < value.length) {
    const character = value[index];
    if (
      character === undefined ||
      character === "," ||
      character === ";" ||
      character === "&" ||
      character === "}" ||
      (boundary === "assignment" && (character === "\n" || character === "\r")) ||
      (boundary === "json" && /\s/.test(character))
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

function consumeAssignmentMultiline(
  value: string,
  assignmentStart: number,
  valueStart: number,
): number | undefined {
  const continuationEnd = consumeShellContinuations(value, valueStart);
  if (continuationEnd !== undefined) return continuationEnd;
  const lineEnd = lineEndingIndex(value, valueStart);
  const firstLine = value.slice(valueStart, lineEnd).trimEnd();
  if (/^[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)$/.test(firstLine)) {
    const bodyStart = skipLineEnding(value, lineEnd);
    const end = consumeIndentedLines(value, bodyStart, lineIndent(value, assignmentStart));
    if (end === bodyStart) throw new Error("sensitive block scalar has no indented body");
    return end;
  }
  if (valueStart === lineEnd && lineEnd < value.length) {
    const bodyStart = skipLineEnding(value, lineEnd);
    const end = consumeIndentedLines(value, bodyStart, lineIndent(value, assignmentStart));
    return end === bodyStart ? undefined : end;
  }
  return undefined;
}

function consumeShellContinuations(value: string, start: number): number | undefined {
  let cursor = start;
  let continuationSeen = false;
  let lines = 0;
  while (cursor < value.length) {
    const end = lineEndingIndex(value, cursor);
    const line = value.slice(cursor, end);
    let trailingBackslashes = 0;
    for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) {
      trailingBackslashes += 1;
    }
    if (trailingBackslashes % 2 === 0) {
      if (!continuationSeen) return undefined;
      assertMultilineBounds(value, start, end);
      return end;
    }
    continuationSeen = true;
    lines += 1;
    if (lines >= multilineValueLineLimit || end - start > multilineValueByteLimit) {
      throw new Error("sensitive multiline value exceeds bounds");
    }
    const next = skipLineEnding(value, end);
    if (next === end) throw new Error("unclosed sensitive shell continuation");
    cursor = next;
  }
  return continuationSeen ? value.length : undefined;
}

function consumeIndentedLines(value: string, start: number, parentIndent: number): number {
  let cursor = start;
  let consumedEnd = start;
  let lines = 0;
  while (cursor < value.length) {
    const end = lineEndingIndex(value, cursor);
    const line = value.slice(cursor, end);
    if (line.trim().length > 0 && lineIndent(value, cursor) <= parentIndent) break;
    consumedEnd = end;
    cursor = skipLineEnding(value, end);
    lines += 1;
    if (lines > multilineValueLineLimit || consumedEnd - start > multilineValueByteLimit) {
      throw new Error("sensitive multiline value exceeds bounds");
    }
  }
  assertMultilineBounds(value, start, consumedEnd);
  return consumedEnd;
}

function lineIndent(value: string, index: number): number {
  const lineStart = Math.max(value.lastIndexOf("\n", Math.max(0, index - 1)) + 1, 0);
  let cursor = lineStart;
  while (value[cursor] === " ") cursor += 1;
  return cursor - lineStart;
}

function lineEndingIndex(value: string, start: number): number {
  const newline = value.indexOf("\n", start);
  const carriage = value.indexOf("\r", start);
  if (newline < 0) return carriage < 0 ? value.length : carriage;
  return carriage < 0 ? newline : Math.min(newline, carriage);
}

function skipLineEnding(value: string, index: number): number {
  if (value[index] === "\r" && value[index + 1] === "\n") return index + 2;
  return value[index] === "\r" || value[index] === "\n" ? index + 1 : index;
}

function assertMultilineBounds(value: string, start: number, end: number): void {
  if (end - start > multilineValueByteLimit) {
    throw new Error("sensitive multiline value exceeds bounds");
  }
  let lines = 1;
  for (let index = start; index < end; index += 1) {
    if (value[index] === "\n") lines += 1;
    if (lines > multilineValueLineLimit) {
      throw new Error("sensitive multiline value exceeds bounds");
    }
  }
}

function consumeQuoted(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return index + 1;
  }
  return value.length;
}

function consumeBalanced(value: string, start: number): number {
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[" || character === "{") stack.push(character);
    else if (character === "]" || character === "}") {
      const opening = stack.pop();
      if (
        opening === undefined ||
        (character === "]" && opening !== "[") ||
        (character === "}" && opening !== "{")
      ) {
        return value.length;
      }
      if (stack.length === 0) return index + 1;
    }
  }
  return value.length;
}

function consumeMalformedSensitiveValue(
  value: string,
  start: number,
  boundary: "json" | "assignment",
): number {
  if (boundary === "assignment") {
    const newline = value.indexOf("\n", start);
    return newline < 0 ? value.length : newline;
  }
  const closing = value.indexOf("}", start);
  return closing < 0 ? value.length : closing;
}

function isExactRedaction(
  value: string,
  start: number,
  end: number,
  boundary: "json" | "assignment",
): boolean {
  if (!isRedacted(value.slice(start, end))) return false;
  let index = end;
  while (index < value.length && (value[index] === " " || value[index] === "\t")) index += 1;
  const next = value[index];
  if (next === undefined || next === "," || next === "}" || next === "]") return true;
  if (boundary === "assignment" && (next === ";" || next === "&")) return true;
  if (boundary === "assignment" && (next === "\n" || next === "\r")) {
    const following = skipLineEnding(value, index);
    return following >= value.length || lineIndent(value, following) === 0;
  }
  if (boundary !== "assignment" || (next !== '"' && next !== "'")) return false;
  const afterQuote = value[index + 1];
  return afterQuote === undefined || afterQuote === "," || afterQuote === "}" || afterQuote === "]";
}

function containsSensitiveLexicalLeak(value: string): boolean {
  const patterns: ReadonlyArray<{
    readonly pattern: RegExp;
    readonly key: (prefix: string) => string | undefined;
    readonly boundary: "json" | "assignment";
  }> = [
    {
      pattern: /("(?:\\.|[^"\\])*"\s*:\s*)/g,
      key(prefix) {
        const literal = /^("(?:\\.|[^"\\])*")/.exec(prefix)?.[1];
        return literal === undefined ? undefined : decodeJsonString(literal);
      },
      boundary: "json",
    },
    {
      pattern: /\b(?![A-Za-z0-9_.-]*\.(?:test|spec)\.ts\s*:)([A-Za-z0-9_.-]+)[\\"']*\s*[=:]\s*/gi,
      key: (prefix) => prefix,
      boundary: "assignment",
    },
  ];
  for (const scanner of patterns) {
    for (const match of value.matchAll(scanner.pattern)) {
      const prefix = match[1] ?? match[0];
      const key = scanner.key(prefix);
      if (key === undefined || !isSensitiveField(key)) continue;
      const start = match.index + match[0].length;
      const end = consumeSensitiveValue(value, start, scanner.boundary);
      if (!isExactRedaction(value, start, end, scanner.boundary)) return true;
    }
  }
  return false;
}

export async function publishEvidence(
  root: string,
  input: EvidenceInput,
): Promise<PublishedEvidence> {
  const workspaceInputs = await readWorkspaceInputs(root);
  const workspaceInputDigest = digestWorkspaceInputs(workspaceInputs);
  const summary = {
    schemaVersion: 2,
    runId: input.runId,
    stage: input.stage,
    command: input.command,
    agentFindingsAttached: (input.agentFindings?.length ?? 0) > 0,
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
    schemaVersion: 2,
    runId: input.runId,
    scenarios: input.scenarios,
    agentFindings: input.agentFindings ?? [],
  };
  const schemas = await loadSchemaCatalog(root);
  const summaryText = serializeValidated(summary, root, (value) => {
    schemas.validate("evidence-summary-v2.schema.json", value, "summary");
    decodeSummary(value);
  });
  const resultText = serializeValidated(results, root, (value) => {
    schemas.validate("evidence-result-v2.schema.json", value, "result");
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
  const summaryVersion = requireEvidenceDocumentVersion(summaryValue, "summary");
  const resultVersion = requireEvidenceDocumentVersion(resultValue, "result");
  schemas.validate(
    summaryVersion === 1 ? "evidence-summary-v1.schema.json" : "evidence-summary-v2.schema.json",
    summaryValue,
    "summary",
  );
  schemas.validate(
    resultVersion === 1 ? "evidence-result-v1.schema.json" : "evidence-result-v2.schema.json",
    resultValue,
    "result",
  );
  schemas.validate("evidence-replay-v1.schema.json", replayValue, "replay");
  const summary = decodeSummary(summaryValue);
  const result = decodeResult(resultValue);
  const replay = decodeReplay(replayValue);
  if (summary.schemaVersion !== result.schemaVersion) {
    throw new Error("summary/result schemaVersion mismatch");
  }
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

export async function currentWorkspaceInputDigest(root: string): Promise<string> {
  return digestWorkspaceInputs(await readWorkspaceInputs(root));
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
  if (["access", "refresh", "key"].includes(normalized)) return true;
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
  const schemaVersion = requireEvidenceDocumentVersion(record, "summary");
  const keys = [
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
  ];
  requireExactKeys(
    record,
    schemaVersion === 1 ? keys : [...keys, "agentFindingsAttached"],
    "summary",
  );
  if (schemaVersion === 2 && typeof record.agentFindingsAttached !== "boolean") {
    throw new Error("summary.agentFindingsAttached must be boolean");
  }
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
    schemaVersion,
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

function decodeAgentFindings(value: unknown): ReadonlyArray<AgentFindingEvidence> {
  const input = requireRecord(value, "agent findings input");
  requireExactKeys(input, ["schemaVersion", "agentFindings"], "agent findings input");
  requireVersion(input, "agent findings input", 1);
  if (!Array.isArray(input.agentFindings)) {
    throw new Error("agent findings input.agentFindings must be an array");
  }
  const ids = new Set<string>();
  return input.agentFindings.map((value, index) => {
    const finding = requireRecord(value, `agent finding ${index}`);
    requireExactKeys(
      finding,
      ["id", "role", "severity", "summary", "review", "disposition"],
      `agent finding ${index}`,
    );
    const id = requireString(finding.id, `agent finding ${index}.id`);
    if (ids.has(id)) {
      throw new Error(`duplicate agent finding id ${id}`);
    }
    ids.add(id);
    const role = requireAgentRole(finding.role, `agent finding ${index}.role`);
    const severity = requireAgentSeverity(finding.severity, `agent finding ${index}.severity`);
    const reviewValue = requireRecord(finding.review, `agent finding ${index}.review`);
    requireExactKeys(
      reviewValue,
      ["workspaceDigest", "gitRevision", "reviewedAt"],
      `agent finding ${index}.review`,
    );
    const gitRevision = reviewValue.gitRevision;
    if (gitRevision !== null && typeof gitRevision !== "string") {
      throw new Error(`agent finding ${index}.review.gitRevision must be string or null`);
    }
    const dispositionValue = requireRecord(
      finding.disposition,
      `agent finding ${index}.disposition`,
    );
    requireExactKeys(
      dispositionValue,
      ["status", "rationale", "regressionScenarioId"],
      `agent finding ${index}.disposition`,
    );
    const regressionScenarioId = dispositionValue.regressionScenarioId;
    if (regressionScenarioId !== null && typeof regressionScenarioId !== "string") {
      throw new Error(`agent finding ${index}.regressionScenarioId must be string or null`);
    }
    return {
      id,
      role,
      severity,
      summary: requireString(finding.summary, `agent finding ${index}.summary`),
      review: {
        workspaceDigest: requireString(
          reviewValue.workspaceDigest,
          `agent finding ${index}.review.workspaceDigest`,
        ),
        gitRevision,
        reviewedAt: requireString(
          reviewValue.reviewedAt,
          `agent finding ${index}.review.reviewedAt`,
        ),
      },
      disposition: {
        status: requireFindingDisposition(
          dispositionValue.status,
          `agent finding ${index}.disposition.status`,
        ),
        rationale: requireString(
          dispositionValue.rationale,
          `agent finding ${index}.disposition.rationale`,
        ),
        regressionScenarioId,
      },
    };
  });
}

function decodeResult(value: unknown): DecodedResult {
  const record = requireRecord(value, "result");
  const schemaVersion = requireEvidenceDocumentVersion(record, "result");
  requireExactKeys(
    record,
    schemaVersion === 1
      ? ["schemaVersion", "runId", "scenarios"]
      : ["schemaVersion", "runId", "scenarios", "agentFindings"],
    "result",
  );
  if (!Array.isArray(record.scenarios)) {
    throw new Error("result.scenarios must be an array");
  }
  const ids = new Set<string>();
  const scenarios: Array<{ id: string; result: string }> = [];
  for (const scenario of record.scenarios) {
    const scenarioRecord = requireRecord(scenario, "result scenario");
    const scenarioKeys = ["id", "file", "result", "seed", "schedule", "boundaryConfiguration"];
    requireExactKeys(
      scenarioRecord,
      schemaVersion === 1 ? scenarioKeys : [...scenarioKeys, "observations"],
      "result scenario",
    );
    const id = requireString(scenarioRecord.id, "result scenario id");
    requireString(scenarioRecord.file, "result scenario file");
    const scenarioResult = requireString(scenarioRecord.result, "result scenario result");
    requireString(scenarioRecord.seed, "result scenario seed");
    requireString(scenarioRecord.schedule, "result scenario schedule");
    requireString(scenarioRecord.boundaryConfiguration, "result scenario boundaryConfiguration");
    if (schemaVersion === 2) {
      requireRecord(scenarioRecord.observations, "result scenario observations");
    }
    if (ids.has(id)) {
      throw new Error(`duplicate evidence scenario ${id}`);
    }
    ids.add(id);
    scenarios.push({ id, result: scenarioResult });
  }
  if (schemaVersion === 2) {
    decodeResultAgentFindings(record.agentFindings);
  }
  return {
    schemaVersion,
    runId: requireString(record.runId, "result.runId"),
    scenarios,
  };
}

function decodeResultAgentFindings(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("result.agentFindings must be an array");
  }
  for (const finding of value) {
    const findingRecord = requireRecord(finding, "agent finding");
    requireExactKeys(
      findingRecord,
      ["id", "role", "severity", "summary", "review", "disposition"],
      "agent finding",
    );
    requireString(findingRecord.id, "agent finding id");
    requireAgentRole(findingRecord.role, "agent finding role");
    requireAgentSeverity(findingRecord.severity, "agent finding severity");
    requireString(findingRecord.summary, "agent finding summary");
    const review = requireRecord(findingRecord.review, "agent finding review");
    requireExactKeys(
      review,
      ["workspaceDigest", "gitRevision", "reviewedAt"],
      "agent finding review",
    );
    requireString(review.workspaceDigest, "agent finding workspace digest");
    if (review.gitRevision !== null)
      requireString(review.gitRevision, "agent finding git revision");
    requireString(review.reviewedAt, "agent finding review timestamp");
    const disposition = requireRecord(findingRecord.disposition, "agent finding disposition");
    requireExactKeys(
      disposition,
      ["status", "rationale", "regressionScenarioId"],
      "agent finding disposition",
    );
    requireFindingDisposition(disposition.status, "agent finding disposition status");
    requireString(disposition.rationale, "agent finding disposition rationale");
    if (disposition.regressionScenarioId !== null) {
      requireString(disposition.regressionScenarioId, "agent finding regression scenario");
    }
  }
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
  requireVersion(record, "replay", 1);
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
    if (!Object.hasOwn(record, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}

function requireEvidenceDocumentVersion(value: unknown, label: string): 1 | 2 {
  const record = requireRecord(value, label);
  if (record.schemaVersion === 1 || record.schemaVersion === 2) {
    return record.schemaVersion;
  }
  throw new Error(`${label} has unsupported schemaVersion`);
}

function requireVersion(record: Record<string, unknown>, label: string, expected: number): void {
  if (record.schemaVersion !== expected) {
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

function requireAgentRole(value: unknown, label: string): "scout" | "review" {
  if (value === "scout" || value === "review") {
    return value;
  }
  throw new Error(`${label} must be scout or review`);
}

function requireAgentSeverity(value: unknown, label: string): "info" | "warning" | "error" {
  if (value === "info" || value === "warning" || value === "error") {
    return value;
  }
  throw new Error(`${label} must be info, warning, or error`);
}

function requireFindingDisposition(
  value: unknown,
  label: string,
): "open" | "accepted" | "fixed" | "not-applicable" {
  if (value === "open" || value === "accepted" || value === "fixed" || value === "not-applicable") {
    return value;
  }
  throw new Error(`${label} has an unsupported disposition`);
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
