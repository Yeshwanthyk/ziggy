/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node and Bun host APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: host failures are normalized by lifecycle.ts */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: host failures reject with native Error values */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import {
  readImmutableExtensionTree,
  type ExtensionTreeSnapshot,
} from "./skill-loader-node-adapter.ts";
import { sha256 } from "./skill-loader.ts";

export interface StagedExtensionPackage {
  readonly profilePath: string;
  readonly transactionPath: string;
  readonly packagePath: string;
}

export interface InstalledExtensionFiles {
  readonly rootPath: string;
  readonly tree: ExtensionTreeSnapshot;
  readonly stateJson: string;
  readonly provenanceJson: string;
  readonly approvalsJson: string;
}

export interface ResolvedExtensionExecutable {
  readonly approvalPath: string;
  readonly executionPath: string;
  readonly sha256: string;
}

export interface ExtensionProcessResult {
  readonly status: "ok" | "failed" | "timeout";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export async function inspectLocalExtensionSource(
  profilePath: string,
  sourcePath: string,
): Promise<{ readonly sourcePath: string; readonly tree: ExtensionTreeSnapshot }> {
  const canonicalProfile = await realpath(profilePath);
  const canonicalSource = await realpath(sourcePath);
  const sourceStatus = await lstat(canonicalSource);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error("Extension source must be a real directory");
  }
  if (canonicalSource === canonicalProfile || canonicalSource.startsWith(`${canonicalProfile}/`)) {
    throw new Error("Extension source must be outside the active Profile");
  }
  return { sourcePath: canonicalSource, tree: await readImmutableExtensionTree(canonicalSource) };
}

export async function stageLocalExtensionPackage(
  profilePath: string,
  sourcePath: string,
): Promise<{
  readonly sourcePath: string;
  readonly staged: StagedExtensionPackage;
  readonly tree: ExtensionTreeSnapshot;
}> {
  const inspected = await inspectLocalExtensionSource(profilePath, sourcePath);
  const canonicalProfile = await realpath(profilePath);
  const tree = inspected.tree;
  const transactionPath = join(
    canonicalProfile,
    ".runtime",
    "extensions",
    `.quarantine-${randomUUID()}`,
  );
  const packagePath = join(transactionPath, "package");
  await mkdir(packagePath, { recursive: true, mode: 0o700 });
  try {
    for (const directory of tree.directories) {
      await mkdir(join(packagePath, directory), { recursive: true, mode: 0o700 });
    }
    for (const file of tree.files) {
      const path = join(packagePath, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { mode: 0o700, flag: "wx" });
    }
    const stagedTree = await readImmutableExtensionTree(packagePath);
    return {
      sourcePath: inspected.sourcePath,
      staged: { profilePath: canonicalProfile, transactionPath, packagePath },
      tree: stagedTree,
    };
  } catch (cause) {
    await rm(transactionPath, { recursive: true, force: true });
    throw cause;
  }
}

export async function readInstalledExtensionFiles(
  profilePath: string,
  extensionId: string,
): Promise<InstalledExtensionFiles | undefined> {
  const rootPath = join(await realpath(profilePath), "extensions", extensionId);
  try {
    await lstat(rootPath);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
  const tree = await readImmutableExtensionTree(rootPath);
  const authorityRoot = join(profilePath, ".runtime", "extensions", extensionId);
  const [stateJson, provenanceJson, approvalsJson] = await Promise.all([
    readFile(join(authorityRoot, "state.json"), "utf8"),
    readFile(join(authorityRoot, "provenance.json"), "utf8"),
    readFile(join(authorityRoot, "approvals.json"), "utf8"),
  ]);
  return { rootPath, tree, stateJson, provenanceJson, approvalsJson };
}

export async function listInstalledExtensionIds(
  profilePath: string,
): Promise<ReadonlyArray<string>> {
  const extensionsPath = join(profilePath, "extensions");
  try {
    const entries = await readdir(extensionsPath, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Unsupported installed Extension entry: ${entry.name}`);
      }
      ids.push(entry.name);
    }
    return ids.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return [];
    throw cause;
  }
}

export async function resolveExtensionExecutable(
  profilePath: string,
  extensionId: string,
  stagedPackagePath: string,
  executable: string,
  commandSearchPath: string,
): Promise<ResolvedExtensionExecutable> {
  if (executable.includes("/")) {
    const executionPath = join(stagedPackagePath, executable);
    const confinedRoot = `${resolve(stagedPackagePath)}/`;
    if (!resolve(executionPath).startsWith(confinedRoot)) {
      throw new Error(`Package executable escapes Extension root: ${executable}`);
    }
    await assertExecutableFile(executionPath);
    const bytes = await readFile(executionPath);
    return {
      approvalPath: join(await realpath(profilePath), "extensions", extensionId, executable),
      executionPath,
      sha256: sha256(bytes),
    };
  }
  for (const directory of commandSearchPath.split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    try {
      const canonical = await realpath(candidate);
      await assertExecutableFile(canonical);
      const bytes = await readFile(canonical);
      return { approvalPath: canonical, executionPath: canonical, sha256: sha256(bytes) };
    } catch (cause) {
      if (hasCode(cause, "ENOENT") || hasCode(cause, "EACCES")) continue;
      throw cause;
    }
  }
  throw new Error(`Declared command could not be resolved: ${executable}`);
}

export async function activateStagedExtension(input: {
  readonly profilePath: string;
  readonly extensionId: string;
  readonly staged: StagedExtensionPackage;
  readonly stateJson: string;
  readonly provenanceJson: string;
  readonly approvalsJson: string;
}): Promise<void> {
  const extensionsRoot = join(input.profilePath, "extensions");
  const authoritiesRoot = join(input.profilePath, ".runtime", "extensions");
  const activePackage = join(extensionsRoot, input.extensionId);
  const activeAuthority = join(authoritiesRoot, input.extensionId);
  const stagedAuthority = join(input.staged.transactionPath, "authority");
  const backupPackage = join(input.staged.transactionPath, "previous-package");
  const backupAuthority = join(input.staged.transactionPath, "previous-authority");
  await mkdir(extensionsRoot, { recursive: true });
  await mkdir(stagedAuthority, { recursive: true, mode: 0o700 });
  const previousPackage = await pathExists(activePackage);
  const previousAuthority = await pathExists(activeAuthority);
  if (previousAuthority && (await pathExists(join(activeAuthority, "state")))) {
    await cp(join(activeAuthority, "state"), join(stagedAuthority, "state"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  await Promise.all([
    writeFile(join(stagedAuthority, "state.json"), input.stateJson, { mode: 0o600, flag: "wx" }),
    writeFile(join(stagedAuthority, "provenance.json"), input.provenanceJson, {
      mode: 0o600,
      flag: "wx",
    }),
    writeFile(join(stagedAuthority, "approvals.json"), input.approvalsJson, {
      mode: 0o600,
      flag: "wx",
    }),
  ]);
  let packageBackedUp = false;
  let authorityBackedUp = false;
  let packageActivated = false;
  let authorityActivated = false;
  try {
    if (previousPackage) {
      await rename(activePackage, backupPackage);
      packageBackedUp = true;
    }
    if (previousAuthority) {
      await rename(activeAuthority, backupAuthority);
      authorityBackedUp = true;
    }
    await rename(input.staged.packagePath, activePackage);
    packageActivated = true;
    await rename(stagedAuthority, activeAuthority);
    authorityActivated = true;
  } catch (cause) {
    if (authorityActivated) await rm(activeAuthority, { recursive: true, force: true });
    if (packageActivated) await rm(activePackage, { recursive: true, force: true });
    if (authorityBackedUp) await rename(backupAuthority, activeAuthority);
    if (packageBackedUp) await rename(backupPackage, activePackage);
    throw cause;
  }
  await Promise.all([removeCommittedBackup(backupPackage), removeCommittedBackup(backupAuthority)]);
}

export async function replaceExtensionAuthorityJson(
  profilePath: string,
  extensionId: string,
  name: "state.json" | "approvals.json",
  contents: string,
): Promise<void> {
  const target = join(profilePath, ".runtime", "extensions", extensionId, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

export async function cleanupStagedExtension(staged: StagedExtensionPackage): Promise<void> {
  await rm(staged.transactionPath, { recursive: true, force: true });
}

export async function runExtensionProcess(input: {
  readonly executablePath: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}): Promise<ExtensionProcessResult> {
  const subprocess = Bun.spawn([input.executablePath, ...input.argv.slice(1)], {
    cwd: input.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, input.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      readBoundedStream(subprocess.stdout, input.outputLimitBytes),
      readBoundedStream(subprocess.stderr, input.outputLimitBytes),
    ]);
    const truncated = stdout.truncated || stderr.truncated;
    return {
      status: timedOut ? "timeout" : exitCode === 0 ? "ok" : "failed",
      exitCode: timedOut ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = Math.max(0, limit - retained);
    if (next.value.byteLength > remaining) truncated = true;
    if (remaining > 0) {
      const chunk = next.value.slice(0, remaining);
      chunks.push(chunk);
      retained += chunk.byteLength;
    }
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated };
}

async function assertExecutableFile(path: string): Promise<void> {
  const status = await stat(path);
  if (!status.isFile()) throw new Error(`Extension executable is not a regular file: ${path}`);
  await access(path, constants.X_OK);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return false;
    throw cause;
  }
}

async function removeCommittedBackup(path: string): Promise<void> {
  // Committed authority must not be reported as failed because transient backup cleanup failed.
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    return;
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return isErrnoException(cause) && cause.code === code;
}

const isErrnoException = Schema.is(Schema.Struct({ code: Schema.String }));
