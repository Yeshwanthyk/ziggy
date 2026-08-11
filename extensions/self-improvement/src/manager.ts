/* oxlint-disable ziggy-effect/no-native-promise-ownership -- This package is a Pi filesystem boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Filesystem failures become stable tool errors. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Errors are the standalone Pi tool boundary. */
/* oxlint-disable ziggy-effect/no-json-parse -- This package's bounded state file is decoded immediately and never enters domain code. */
/* oxlint-disable ziggy-effect/no-promise-catch -- Cleanup is intentionally best effort at the filesystem boundary. */
/* oxlint-disable ziggy/no-unsafe-typescript-syntax -- Small JSON/frontmatter boundary values are validated immediately. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const MAX_LOG_DETAIL = 2_000;
const MAX_EVIDENCE = 500;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SESSION_IDS = 32;
const READY_THRESHOLD = 3;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 1_024;

export type ReviewDecision = "applied" | "no-op" | "staged" | "error";

export interface ObservationInput {
  readonly profilePath: string;
  readonly sessionFile: string | undefined;
  readonly entries: ReadonlyArray<unknown>;
  readonly observedAt?: Date;
}

export interface CuratorState {
  readonly version: 1;
  readonly completedSessionIds: ReadonlyArray<string>;
  readonly lastObservedAt?: string;
}

export interface CuratorStatus extends CuratorState {
  readonly ready: boolean;
  readonly statePath: string;
  readonly readyPath: string;
  readonly logsPath: string;
}

export interface ExtensionWriteInput {
  readonly id: string;
  readonly body: string;
  readonly replace?: boolean;
  readonly expectedOldSha256?: string;
}

interface ParsedSkill {
  readonly name: string;
  readonly description: string;
}

const runtimePath = (profilePath: string): string =>
  join(profilePath, ".runtime", "self-improvement");
const statePath = (profilePath: string): string => join(runtimePath(profilePath), "state.json");
const readyPath = (profilePath: string): string => join(runtimePath(profilePath), "curator-ready");
const logsPath = (profilePath: string): string => join(runtimePath(profilePath), "logs");

const ensureRuntime = async (profilePath: string): Promise<void> => {
  await ensurePhysicalDirectory(profilePath, false);
  await ensurePhysicalDirectory(join(profilePath, ".runtime"), true);
  await ensurePhysicalDirectory(runtimePath(profilePath), true);
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const defaultState = (): CuratorState => ({ version: 1, completedSessionIds: [] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeState = (value: unknown): CuratorState => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.completedSessionIds))
    throw new Error("invalid self-improvement state.json");
  if (
    value.completedSessionIds.some(
      (item) => typeof item !== "string" || item.length === 0 || item.length > 512,
    )
  )
    throw new Error("invalid completed session IDs in self-improvement state.json");
  if (value.lastObservedAt !== undefined && typeof value.lastObservedAt !== "string")
    throw new Error("invalid lastObservedAt in self-improvement state.json");
  return {
    version: 1,
    completedSessionIds: [...new Set(value.completedSessionIds)].slice(-MAX_SESSION_IDS),
    ...(value.lastObservedAt === undefined ? {} : { lastObservedAt: value.lastObservedAt }),
  };
};

const readState = async (profilePath: string): Promise<CuratorState> => {
  try {
    return decodeState(JSON.parse(await readFile(statePath(profilePath), "utf8")));
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return defaultState();
    throw cause;
  }
};

const atomicFileWrite = async (targetPath: string, content: string): Promise<void> => {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  const file = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
};

const isPhysicalDirectory = async (path: string): Promise<boolean> => {
  try {
    const status = await lstat(path);
    return status.isDirectory() && !status.isSymbolicLink();
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const ensurePhysicalDirectory = async (path: string, create: boolean): Promise<string> => {
  if (!(await isPhysicalDirectory(path))) {
    if (!create) throw new Error(`expected a physical directory at ${path}`);
    try {
      await mkdir(path);
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
    }
  }
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error(`expected a physical directory at ${path}`);
  return realpath(path);
};

const assertContained = (root: string, candidate: string): void => {
  const remainder = relative(root, candidate);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || resolve(remainder) === remainder)
    throw new Error("Profile extension path escapes the Profile");
};

const rejectRepositoryRoot = async (profilePath: string): Promise<void> => {
  try {
    await lstat(join(profilePath, ".git"));
    throw new Error("refusing to write self-improvement data in a repository checkout");
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
};

const textField = (value: string, field: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes("\0"))
    throw new Error(`${field} must be non-empty and at most ${maximum} characters`);
  return normalized;
};

const parseSkillFrontmatter = (id: string, body: string): ParsedSkill => {
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES)
    throw new Error(`SKILL.md exceeds the ${MAX_SKILL_BYTES}-byte limit`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (match === null) throw new Error("SKILL.md requires YAML frontmatter");
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const parsed = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (parsed === null) throw new Error("SKILL.md frontmatter contains an invalid line");
    const key = parsed[1] as string;
    if (fields.has(key)) throw new Error(`SKILL.md frontmatter repeats '${key}'`);
    let value = (parsed[2] as string).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    fields.set(key, value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (name !== id || !ID_PATTERN.test(name ?? ""))
    throw new Error(`SKILL.md frontmatter name must exactly match '${id}'`);
  return { name, description: textField(description ?? "", "description", DESCRIPTION_MAX) };
};

const looksLikeMessage = (
  entry: unknown,
): { readonly role?: unknown; readonly stopReason?: unknown } => {
  if (!isRecord(entry)) return {};
  const message = isRecord(entry.message) ? entry.message : entry;
  return { role: message.role, stopReason: message.stopReason };
};

const eligibleSession = (
  sessionFile: string | undefined,
  entries: ReadonlyArray<unknown>,
): string | undefined => {
  if (sessionFile === undefined || sessionFile.length === 0) return undefined;
  const normalized = sessionFile.replaceAll("\\", "/");
  if (
    normalized.includes("/sessions/automations/") ||
    normalized.includes("/sessions/agents/") ||
    normalized.includes("/sessions/specialists/")
  )
    return undefined;
  const messages = entries.filter((entry) => isRecord(entry) && entry.type === "message");
  if (messages.length === 0 || !messages.some((entry) => looksLikeMessage(entry).role === "user"))
    return undefined;
  const assistantMessages = messages.filter(
    (entry) => looksLikeMessage(entry).role === "assistant",
  );
  const lastAssistant = assistantMessages.at(-1);
  if (lastAssistant === undefined) return undefined;
  const stopReason = looksLikeMessage(lastAssistant).stopReason;
  if (stopReason === "aborted" || stopReason === "error") return undefined;
  return resolve(sessionFile);
};

const appendObservation = async (
  profilePath: string,
  sessionId: string,
  at: Date,
): Promise<void> => {
  const day = at.toISOString().slice(0, 10);
  const timestamp = at.toISOString();
  const sessionLabel = basename(sessionId);
  await mkdir(logsPath(profilePath), { recursive: true });
  await appendFile(
    join(logsPath(profilePath), `${day}.md`),
    `## ${timestamp} — completed foreground session\n\n- session: ${sessionLabel}\n- signal: eligible for Curator review after distinct-session recurrence\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

export const observeCompletedForegroundSession = async (
  input: ObservationInput,
): Promise<{ readonly observed: boolean; readonly ready: boolean; readonly reason?: string }> => {
  await ensureRuntime(input.profilePath);
  const sessionId = eligibleSession(input.sessionFile, input.entries);
  if (sessionId === undefined)
    return { observed: false, ready: false, reason: "ineligible-session" };
  const state = await readState(input.profilePath);
  if (state.completedSessionIds.includes(sessionId)) {
    return {
      observed: false,
      ready: await fileExists(readyPath(input.profilePath)),
      reason: "already-observed",
    };
  }
  const at = input.observedAt ?? new Date();
  const completedSessionIds = [...state.completedSessionIds, sessionId].slice(-MAX_SESSION_IDS);
  const next: CuratorState = {
    version: 1,
    completedSessionIds,
    lastObservedAt: at.toISOString(),
  };
  await atomicFileWrite(statePath(input.profilePath), `${JSON.stringify(next, null, 2)}\n`);
  await appendObservation(input.profilePath, sessionId, at);
  const ready = completedSessionIds.length >= READY_THRESHOLD;
  if (ready) await atomicFileWrite(readyPath(input.profilePath), "ready\n");
  return { observed: true, ready };
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

export const readStatus = async (profilePath: string): Promise<CuratorStatus> => {
  await ensureRuntime(profilePath);
  const state = await readState(profilePath);
  return {
    ...state,
    ready: await fileExists(readyPath(profilePath)),
    statePath: statePath(profilePath),
    readyPath: readyPath(profilePath),
    logsPath: logsPath(profilePath),
  };
};

export const appendReviewLog = async (
  profilePath: string,
  input: {
    readonly decision: ReviewDecision;
    readonly detail: string;
    readonly evidence?: string;
    readonly clearReady?: boolean;
    readonly at?: Date;
  },
): Promise<{ readonly path: string; readonly clearedReady: boolean }> => {
  await ensureRuntime(profilePath);
  if (input.clearReady === true && input.decision !== "applied" && input.decision !== "no-op")
    throw new Error("readiness can be cleared only after an applied or no-op review");
  const detail = textField(input.detail.replaceAll("\n", " "), "detail", MAX_LOG_DETAIL);
  const evidence =
    input.evidence === undefined ? undefined : textField(input.evidence, "evidence", MAX_EVIDENCE);
  const at = input.at ?? new Date();
  const day = at.toISOString().slice(0, 10);
  const path = join(logsPath(profilePath), `${day}.md`);
  await mkdir(logsPath(profilePath), { recursive: true });
  await appendFile(
    path,
    `## ${at.toISOString()} — ${input.decision}\n\n- detail: ${detail}${evidence === undefined ? "" : `\n- evidence: ${evidence}`}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let clearedReady = false;
  if (input.clearReady === true) {
    try {
      await rm(readyPath(profilePath));
      clearedReady = true;
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
    }
  }
  return { path, clearedReady };
};

const packageManifest = (id: string, description: string): string =>
  `${JSON.stringify(
    {
      name: `@ziggy/${id}`,
      private: true,
      type: "module",
      keywords: ["pi-package"],
      description,
      ziggy: { curatorManaged: true },
      pi: { skills: ["./skills"] },
    },
    null,
  )}\n`;

const managedManifest = (id: string, value: unknown): boolean =>
  isRecord(value) &&
  value.name === `@ziggy/${id}` &&
  isRecord(value.ziggy) &&
  value.ziggy.curatorManaged === true &&
  isRecord(value.pi) &&
  Array.isArray(value.pi.skills) &&
  value.pi.skills.length === 1 &&
  value.pi.skills[0] === "./skills" &&
  !Array.isArray(value.pi.extensions);

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const checkedSkillFile = async (profilePath: string, id: string): Promise<string> => {
  const extensionRoot = join(profilePath, "extensions", id);
  const skillsRoot = join(extensionRoot, "skills");
  const skillRoot = join(skillsRoot, id);
  const skillFile = join(skillRoot, "SKILL.md");
  const profileReal = await ensurePhysicalDirectory(profilePath, false);
  const extensionReal = await ensurePhysicalDirectory(join(profilePath, "extensions"), false);
  const packageReal = await ensurePhysicalDirectory(extensionRoot, false);
  const skillsReal = await ensurePhysicalDirectory(skillsRoot, false);
  const skillReal = await ensurePhysicalDirectory(skillRoot, false);
  assertContained(profileReal, extensionReal);
  assertContained(extensionReal, packageReal);
  assertContained(packageReal, skillsReal);
  assertContained(skillsReal, skillReal);
  const fileStatus = await lstat(skillFile);
  if (fileStatus.isSymbolicLink() || !fileStatus.isFile())
    throw new Error(`SKILL.md must be a regular file at ${skillFile}`);
  assertContained(skillReal, await realpath(skillFile));
  return skillFile;
};

export const writeCuratorExtension = async (
  profilePath: string,
  input: ExtensionWriteInput,
): Promise<{
  readonly id: string;
  readonly action: "created" | "replaced";
  readonly path: string;
  readonly sha256: string;
}> => {
  const id = textField(input.id, "extension ID", 64);
  if (!ID_PATTERN.test(id) || id === "pi-packages")
    throw new Error("extension ID must be kebab-case and non-reserved");
  if (input.expectedOldSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedOldSha256))
    throw new Error("expectedOldSha256 must be a lowercase SHA-256 digest");
  const parsed = parseSkillFrontmatter(id, input.body);
  await rejectRepositoryRoot(profilePath);
  const profileReal = await ensurePhysicalDirectory(profilePath, false);
  const extensionsPath = join(profilePath, "extensions");
  const extensionsReal = await ensurePhysicalDirectory(extensionsPath, true);
  assertContained(profileReal, extensionsReal);
  const packagePath = join(extensionsPath, id);
  const packageJsonPath = join(packagePath, "package.json");
  const skillPath = join(packagePath, "skills", id, "SKILL.md");
  const exists = await fileExists(packagePath);
  if (exists && input.replace !== true)
    throw new Error(`Profile extension '${id}' already exists; set replace:true to replace it`);
  if (exists) {
    const packageReal = await ensurePhysicalDirectory(packagePath, false);
    assertContained(extensionsReal, packageReal);
    const manifestStatus = await lstat(packageJsonPath);
    if (manifestStatus.isSymbolicLink() || !manifestStatus.isFile())
      throw new Error("managed package.json must be a regular file");
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (!managedManifest(id, manifest))
      throw new Error("replacement requires ziggy.curatorManaged package manifest");
    const currentSkill = await checkedSkillFile(profilePath, id);
    const currentBody = await readFile(currentSkill, "utf8");
    if (input.expectedOldSha256 !== undefined && sha256(currentBody) !== input.expectedOldSha256)
      throw new Error("replacement expected-old SHA-256 does not match current SKILL.md");
    await atomicFileWrite(currentSkill, input.body);
    return { id, action: "replaced", path: currentSkill, sha256: sha256(input.body) };
  }

  await mkdir(packagePath);
  try {
    await mkdir(join(packagePath, "skills"));
    await mkdir(join(packagePath, "skills", id));
    await atomicFileWrite(packageJsonPath, packageManifest(id, parsed.description));
    await atomicFileWrite(skillPath, input.body);
  } catch (cause) {
    await rm(packagePath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
  return { id, action: "created", path: skillPath, sha256: sha256(input.body) };
};
