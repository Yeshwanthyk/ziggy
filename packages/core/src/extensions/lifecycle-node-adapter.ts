/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node and Bun host APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: host failures are normalized by lifecycle.ts */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: host failures reject with native Error values */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Result, Schema } from "effect";
import {
  readExtensionAuthorityFiles,
  readImmutableExtensionTree,
  type ExtensionTreeSnapshot,
} from "./skill-loader-node-adapter.ts";
import { sha256 } from "./skill-loader.ts";
import { isStrictJson } from "./strict-json.ts";

export interface StagedExtensionPackage {
  readonly profilePath: string;
  readonly transactionPath: string;
  readonly packagePath: string;
}

const TRANSACTION_ID_PATTERN = /^[0-9a-f]{32}$/;
const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTIONS_DIRECTORY = ".transactions";
const CLEANUP_PREFIX = ".cleanup-";
const TRANSACTION_DOCUMENT = "transaction.json";
const COMMIT_DOCUMENT = "commit.json";
const TransactionIdSchema = Schema.String.check(Schema.isPattern(TRANSACTION_ID_PATTERN));
const ExtensionIdSchema = Schema.String.check(Schema.isPattern(EXTENSION_ID_PATTERN));
const Sha256Schema = Schema.String.check(Schema.isPattern(SHA256_PATTERN));
const ExtensionActivationSnapshotSchema = Schema.Struct({
  packageSnapshotSha256: Sha256Schema,
  stateJsonSha256: Sha256Schema,
  provenanceJsonSha256: Sha256Schema,
  approvalsJsonSha256: Sha256Schema,
});
type ExtensionActivationSnapshot = typeof ExtensionActivationSnapshotSchema.Type;
const ExtensionActivationTransactionSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  transactionId: TransactionIdSchema,
  operation: Schema.Literal("install"),
  extensionId: ExtensionIdSchema,
  old: Schema.NullOr(ExtensionActivationSnapshotSchema),
  next: ExtensionActivationSnapshotSchema,
});
type ExtensionActivationTransaction = typeof ExtensionActivationTransactionSchema.Type;
const ExtensionActivationCommitSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  transactionId: TransactionIdSchema,
  decision: Schema.Literal("commit"),
});
type ExtensionActivationCommit = typeof ExtensionActivationCommitSchema.Type;
const decodeTransactionJsonResult = Schema.decodeUnknownResult(
  Schema.fromJsonString(ExtensionActivationTransactionSchema),
  { errors: "all", onExcessProperty: "error" },
);
const decodeCommitJsonResult = Schema.decodeUnknownResult(
  Schema.fromJsonString(ExtensionActivationCommitSchema),
  { errors: "all", onExcessProperty: "error" },
);
const decodeUnknownJsonResult = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

export interface InstalledExtensionFiles {
  readonly rootPath: string;
  readonly tree: ExtensionTreeSnapshot;
  readonly stateJson: string;
  readonly provenanceJson: string;
  readonly approvalsJson: string;
}

export interface InstalledExtensionAuthorityFiles {
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

export type ExtensionLifecycleNodeCheckpoint =
  | "copy-before-directory"
  | "copy-before-file"
  | "copy-complete"
  | "activation-after-package-backup"
  | "activation-after-authority-backup"
  | "activation-after-transaction-durable"
  | "activation-after-old-package-move"
  | "activation-after-new-package-publish"
  | "activation-after-state-publish"
  | "activation-after-provenance-publish"
  | "activation-after-approvals-publish"
  | "activation-before-commit"
  | "activation-after-commit"
  | "cleanup-after-tombstone-publish"
  | "activation-before-package-publish"
  | "activation-after-package-publish"
  | "activation-before-authority-publish"
  | "activation-after-authority-publish"
  | "authority-after-temporary-write"
  | "authority-before-target-publish"
  | "authority-after-target-publish"
  | "process-after-spawn";

export interface ExtensionLifecycleNodeHooks {
  checkpoint(point: ExtensionLifecycleNodeCheckpoint): Promise<void>;
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
  signal?: AbortSignal,
  hooks?: ExtensionLifecycleNodeHooks,
): Promise<{
  readonly sourcePath: string;
  readonly staged: StagedExtensionPackage;
  readonly tree: ExtensionTreeSnapshot;
}> {
  const inspected = await inspectLocalExtensionSource(profilePath, sourcePath);
  const canonicalProfile = await realpath(profilePath);
  const tree = inspected.tree;
  const transactionsRoot = join(canonicalProfile, ".runtime", "extensions", TRANSACTIONS_DIRECTORY);
  const transactionPath = join(transactionsRoot, randomUUID().replaceAll("-", ""));
  const packagePath = join(transactionPath, "package");
  await mkdir(packagePath, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(transactionsRoot));
  await syncDirectory(transactionsRoot);
  try {
    for (const directory of tree.directories) {
      await checkpoint(hooks, "copy-before-directory", signal);
      await mkdir(join(packagePath, directory), { recursive: true, mode: 0o700 });
    }
    for (const file of tree.files) {
      await checkpoint(hooks, "copy-before-file", signal);
      const path = join(packagePath, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { mode: 0o700, flag: "wx" });
    }
    await checkpoint(hooks, "copy-complete", signal);
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

export async function readInstalledExtensionAuthorityFiles(
  profilePath: string,
  extensionId: string,
): Promise<InstalledExtensionAuthorityFiles | undefined> {
  requireExtensionId(extensionId);
  const authorityRoot = join(profilePath, ".runtime", "extensions", extensionId);
  try {
    const status = await lstat(authorityRoot);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`Expected daemon-owned Extension authority directory: ${extensionId}`);
    }
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
  return readExtensionAuthorityFiles(profilePath, extensionId);
}

async function readInstalledExtensionTree(
  profilePath: string,
  extensionId: string,
): Promise<ExtensionTreeSnapshot | undefined> {
  const rootPath = join(profilePath, "extensions", extensionId);
  try {
    await lstat(rootPath);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
  return readImmutableExtensionTree(rootPath);
}

export async function installedExtensionMatchesSeal(
  profilePath: string,
  extensionId: string,
  expected: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>,
): Promise<boolean> {
  try {
    const tree = await readInstalledExtensionTree(profilePath, extensionId);
    if (tree === undefined || tree.files.length !== expected.length) return false;
    return tree.files.every((file, index) => {
      const sealed = expected[index];
      return (
        sealed !== undefined &&
        file.path === sealed.path &&
        file.bytes.byteLength === sealed.bytes &&
        sha256(file.bytes) === sealed.sha256
      );
    });
  } catch {
    return false;
  }
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
  readonly signal?: AbortSignal;
  readonly hooks?: ExtensionLifecycleNodeHooks;
}): Promise<void> {
  requireExtensionId(input.extensionId);
  const canonicalProfile = await realpath(input.profilePath);
  const transactionId = validateStagedTransaction(canonicalProfile, input.staged);
  const extensionsRoot = join(canonicalProfile, "extensions");
  const authoritiesRoot = join(canonicalProfile, ".runtime", "extensions");
  const activePackage = join(extensionsRoot, input.extensionId);
  const activeAuthority = join(authoritiesRoot, input.extensionId);
  const stagedAuthority = join(input.staged.transactionPath, "authority");
  const undoRoot = join(input.staged.transactionPath, "undo");
  const undoPackage = join(undoRoot, "package");
  const undoAuthority = join(undoRoot, "authority");
  const replacedPackage = join(input.staged.transactionPath, "replaced-package");
  await mkdir(extensionsRoot, { recursive: true });
  await mkdir(stagedAuthority, { recursive: true, mode: 0o700 });
  const previousPackage = await pathExists(activePackage);
  const previousAuthority = await pathExists(activeAuthority);
  if (previousPackage !== previousAuthority) {
    throw new Error(`Extension install is missing half of its authority: ${input.extensionId}`);
  }
  if (previousPackage) {
    await mkdir(undoRoot, { recursive: true, mode: 0o700 });
    await cp(activePackage, undoPackage, { recursive: true, errorOnExist: true, force: false });
    await mkdir(undoAuthority, { recursive: true, mode: 0o700 });
    await Promise.all(
      ["state.json", "provenance.json", "approvals.json"].map((name) =>
        cp(join(activeAuthority, name), join(undoAuthority, name), {
          errorOnExist: true,
          force: false,
        }),
      ),
    );
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
  await Promise.all([
    syncTree(input.staged.packagePath),
    syncTree(stagedAuthority),
    ...(previousPackage ? [syncTree(undoRoot)] : []),
  ]);
  const transaction: ExtensionActivationTransaction = {
    schemaVersion: 1,
    transactionId,
    operation: "install",
    extensionId: input.extensionId,
    old: previousPackage ? await activationSnapshot(undoPackage, undoAuthority) : null,
    next: await activationSnapshot(input.staged.packagePath, stagedAuthority),
  };
  await writeDurableExclusiveJson(
    join(input.staged.transactionPath, TRANSACTION_DOCUMENT),
    transaction,
  );
  await checkpoint(input.hooks, "activation-after-transaction-durable", input.signal);
  try {
    if (transaction.old !== null) {
      await validateActivationSnapshot(canonicalProfile, input.extensionId, transaction.old);
    }
    if (previousPackage) {
      await rename(activePackage, replacedPackage);
      await syncRenameParents(extensionsRoot, input.staged.transactionPath);
      await checkpoint(input.hooks, "activation-after-package-backup", input.signal);
      await checkpoint(input.hooks, "activation-after-old-package-move", input.signal);
    }
    if (previousAuthority)
      await checkpoint(input.hooks, "activation-after-authority-backup", input.signal);
    await checkpoint(input.hooks, "activation-before-package-publish", input.signal);
    await rename(input.staged.packagePath, activePackage);
    await syncRenameParents(input.staged.transactionPath, extensionsRoot);
    await checkpoint(input.hooks, "activation-after-package-publish", input.signal);
    await checkpoint(input.hooks, "activation-after-new-package-publish", input.signal);
    await checkpoint(input.hooks, "activation-before-authority-publish", input.signal);
    if (!previousAuthority) {
      await mkdir(activeAuthority, { mode: 0o700 });
      await syncDirectory(authoritiesRoot);
    }
    await publishStagedAuthorityJson(stagedAuthority, activeAuthority, "state.json");
    await checkpoint(input.hooks, "activation-after-state-publish", input.signal);
    await publishStagedAuthorityJson(stagedAuthority, activeAuthority, "provenance.json");
    await checkpoint(input.hooks, "activation-after-provenance-publish", input.signal);
    await publishStagedAuthorityJson(stagedAuthority, activeAuthority, "approvals.json");
    await checkpoint(input.hooks, "activation-after-approvals-publish", input.signal);
    await checkpoint(input.hooks, "activation-after-authority-publish", input.signal);
    await validateActivationSnapshot(canonicalProfile, input.extensionId, transaction.next);
    await checkpoint(input.hooks, "activation-before-commit", input.signal);
    const commit: ExtensionActivationCommit = {
      schemaVersion: 1,
      transactionId,
      decision: "commit",
    };
    await writeDurableExclusiveJson(join(input.staged.transactionPath, COMMIT_DOCUMENT), commit);
    await checkpoint(input.hooks, "activation-after-commit", input.signal);
  } catch (cause) {
    await rollbackTransaction(canonicalProfile, input.staged.transactionPath, transaction);
    throw cause;
  }
  await removeCommittedBackup(replacedPackage);
  await syncDirectory(input.staged.transactionPath);
}

/** Restores or completes every interrupted Extension publication before lifecycle use. */
export async function recoverExtensionTransactions(profilePath: string): Promise<void> {
  const canonicalProfile = await realpath(profilePath);
  const authoritiesRoot = join(canonicalProfile, ".runtime", "extensions");
  await mkdir(authoritiesRoot, { recursive: true, mode: 0o700 });
  await recoverJournalTransactions(canonicalProfile, authoritiesRoot);
  await recoverLegacyQuarantines(canonicalProfile, authoritiesRoot);
}

export async function replaceExtensionAuthorityJson(
  profilePath: string,
  extensionId: string,
  name: "state.json" | "approvals.json",
  contents: string,
  hooks?: ExtensionLifecycleNodeHooks,
): Promise<void> {
  const target = join(profilePath, ".runtime", "extensions", extensionId, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const restore = `${target}.${randomUUID()}.restore`;
  const original = await readFile(target);
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  let targetPublished = false;
  try {
    await checkpoint(hooks, "authority-after-temporary-write");
    await checkpoint(hooks, "authority-before-target-publish");
    await rename(temporary, target);
    targetPublished = true;
    await checkpoint(hooks, "authority-after-target-publish");
  } catch (cause) {
    if (targetPublished) {
      await writeFile(restore, original, { mode: 0o600, flag: "wx" });
      await rename(restore, target);
    }
    await rm(temporary, { force: true });
    await rm(restore, { force: true });
    throw cause;
  }
}

export async function cleanupStagedExtension(
  staged: StagedExtensionPackage,
  hooks?: ExtensionLifecycleNodeHooks,
): Promise<void> {
  const transactionsRoot = dirname(staged.transactionPath);
  if (!(await pathExists(staged.transactionPath))) return;
  const transactionId = staged.transactionPath.slice(transactionsRoot.length + 1);
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("Refusing to clean an invalid Extension transaction path");
  }
  const tombstone = join(transactionsRoot, `${CLEANUP_PREFIX}${transactionId}`);
  await rename(staged.transactionPath, tombstone);
  await syncDirectory(transactionsRoot);
  await checkpoint(hooks, "cleanup-after-tombstone-publish");
  await rm(tombstone, { recursive: true, force: true });
  await syncDirectory(transactionsRoot);
}

async function recoverJournalTransactions(
  profilePath: string,
  authoritiesRoot: string,
): Promise<void> {
  const transactionsRoot = join(authoritiesRoot, TRANSACTIONS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(transactionsRoot, { withFileTypes: true });
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return;
    throw cause;
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    if (entry.name.startsWith(CLEANUP_PREFIX)) {
      const transactionId = entry.name.slice(CLEANUP_PREFIX.length);
      if (
        !TRANSACTION_ID_PATTERN.test(transactionId) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new Error(`Unsupported Extension cleanup tombstone: ${entry.name}`);
      }
      await rm(join(transactionsRoot, entry.name), { recursive: true, force: true });
      await syncDirectory(transactionsRoot);
      continue;
    }
    if (
      !TRANSACTION_ID_PATTERN.test(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      throw new Error(`Unsupported Extension transaction entry: ${entry.name}`);
    }
    const transactionPath = join(transactionsRoot, entry.name);
    const transactionDocumentPath = join(transactionPath, TRANSACTION_DOCUMENT);
    if (!(await pathExists(transactionDocumentPath))) {
      await rm(transactionPath, { recursive: true, force: true });
      await syncDirectory(transactionsRoot);
      continue;
    }
    const transaction = decodeTransaction(
      await readFile(transactionDocumentPath, "utf8"),
      entry.name,
    );
    await validateDurableUndo(transactionPath, transaction);
    const commitPath = join(transactionPath, COMMIT_DOCUMENT);
    if (await pathExists(commitPath)) {
      const commit = decodeCommit(await readFile(commitPath, "utf8"), entry.name);
      requireMatchingCommit(transaction, commit);
      await validateActivationSnapshot(profilePath, transaction.extensionId, transaction.next);
    } else {
      await rollbackTransaction(profilePath, transactionPath, transaction);
    }
    await rm(transactionPath, { recursive: true, force: true });
    await syncDirectory(transactionsRoot);
  }
}

async function recoverLegacyQuarantines(
  profilePath: string,
  authoritiesRoot: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(authoritiesRoot, { withFileTypes: true });
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return;
    throw cause;
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    if (!entry.name.startsWith(".quarantine-")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unsupported legacy Extension quarantine entry: ${entry.name}`);
    }
    const transactionPath = join(authoritiesRoot, entry.name);
    const extensionId = await legacyExtensionId(transactionPath);
    if (extensionId === undefined) {
      await rm(transactionPath, { recursive: true, force: true });
      await syncDirectory(authoritiesRoot);
      continue;
    }
    await rollbackLegacyQuarantine(profilePath, transactionPath, extensionId);
    await rm(transactionPath, { recursive: true, force: true });
    await syncDirectory(authoritiesRoot);
  }
}

async function legacyExtensionId(transactionPath: string): Promise<string | undefined> {
  const candidates = [
    join(transactionPath, "authority", "provenance.json"),
    join(transactionPath, "previous-authority", "provenance.json"),
    join(transactionPath, "package", "extension.json"),
    join(transactionPath, "previous-package", "extension.json"),
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const value = parseUnknownJson(await readFile(candidate, "utf8"), "legacy Extension metadata");
    if (!isRecord(value) || typeof value.extensionId !== "string") {
      if (!isRecord(value) || typeof value.id !== "string") continue;
      requireExtensionId(value.id);
      return value.id;
    }
    requireExtensionId(value.extensionId);
    return value.extensionId;
  }
  return undefined;
}

async function rollbackTransaction(
  profilePath: string,
  transactionPath: string,
  transaction: ExtensionActivationTransaction,
): Promise<void> {
  const extensionsRoot = join(profilePath, "extensions");
  const authoritiesRoot = join(profilePath, ".runtime", "extensions");
  const activePackage = join(extensionsRoot, transaction.extensionId);
  const activeAuthority = join(authoritiesRoot, transaction.extensionId);
  if (transaction.old === null) {
    await rm(activePackage, { recursive: true, force: true });
    await rm(activeAuthority, { recursive: true, force: true });
    await Promise.all([syncDirectory(extensionsRoot), syncDirectory(authoritiesRoot)]);
    return;
  }
  const undoPackage = join(transactionPath, "undo", "package");
  const undoAuthority = join(transactionPath, "undo", "authority");
  const undoSnapshot = await activationSnapshot(undoPackage, undoAuthority);
  if (!sameActivationSnapshot(undoSnapshot, transaction.old)) {
    throw new Error(`Extension transaction undo is invalid: ${transaction.extensionId}`);
  }
  const rollbackPackage = join(transactionPath, "rollback-package");
  await rm(rollbackPackage, { recursive: true, force: true });
  await cp(undoPackage, rollbackPackage, { recursive: true, errorOnExist: true, force: false });
  await syncTree(rollbackPackage);
  await rm(activePackage, { recursive: true, force: true });
  await rename(rollbackPackage, activePackage);
  await syncRenameParents(transactionPath, extensionsRoot);
  const authorityStatus = await lstat(activeAuthority);
  if (authorityStatus.isSymbolicLink() || !authorityStatus.isDirectory()) {
    throw new Error(`Expected Extension authority directory: ${transaction.extensionId}`);
  }
  const authorityNames: ReadonlyArray<"state.json" | "provenance.json" | "approvals.json"> = [
    "state.json",
    "provenance.json",
    "approvals.json",
  ];
  for (const name of authorityNames) {
    await replaceFileFromDurableCopy(join(undoAuthority, name), join(activeAuthority, name));
  }
  await validateActivationSnapshot(profilePath, transaction.extensionId, transaction.old);
}

async function validateDurableUndo(
  transactionPath: string,
  transaction: ExtensionActivationTransaction,
): Promise<void> {
  const undoPath = join(transactionPath, "undo");
  if (transaction.old === null) {
    if (await pathExists(undoPath)) {
      throw new Error(
        `Fresh Extension transaction has unexpected undo: ${transaction.extensionId}`,
      );
    }
    return;
  }
  const actual = await activationSnapshot(join(undoPath, "package"), join(undoPath, "authority"));
  if (!sameActivationSnapshot(actual, transaction.old)) {
    throw new Error(`Extension transaction undo is invalid: ${transaction.extensionId}`);
  }
}

async function rollbackLegacyQuarantine(
  profilePath: string,
  transactionPath: string,
  extensionId: string,
): Promise<void> {
  const extensionsRoot = join(profilePath, "extensions");
  const authoritiesRoot = join(profilePath, ".runtime", "extensions");
  const activePackage = join(extensionsRoot, extensionId);
  const activeAuthority = join(authoritiesRoot, extensionId);
  const previousPackage = join(transactionPath, "previous-package");
  const previousAuthority = join(transactionPath, "previous-authority");
  if (await pathExists(previousPackage)) {
    await rm(activePackage, { recursive: true, force: true });
    await rename(previousPackage, activePackage);
    await syncRenameParents(transactionPath, extensionsRoot);
  } else if (!(await pathExists(join(transactionPath, "package")))) {
    await rm(activePackage, { recursive: true, force: true });
    await syncDirectory(extensionsRoot);
  }
  if (await pathExists(previousAuthority)) {
    await rm(activeAuthority, { recursive: true, force: true });
    await rename(previousAuthority, activeAuthority);
    await syncRenameParents(transactionPath, authoritiesRoot);
  } else if (!(await pathExists(join(transactionPath, "authority")))) {
    await rm(activeAuthority, { recursive: true, force: true });
    await syncDirectory(authoritiesRoot);
  }
}

async function activationSnapshot(
  packagePath: string,
  authorityPath: string,
): Promise<ExtensionActivationSnapshot> {
  const [packageSnapshotSha256, stateJson, provenanceJson, approvalsJson] = await Promise.all([
    directoryDigest(packagePath),
    readFile(join(authorityPath, "state.json")),
    readFile(join(authorityPath, "provenance.json")),
    readFile(join(authorityPath, "approvals.json")),
  ]);
  return {
    packageSnapshotSha256,
    stateJsonSha256: sha256(stateJson),
    provenanceJsonSha256: sha256(provenanceJson),
    approvalsJsonSha256: sha256(approvalsJson),
  };
}

async function validateActivationSnapshot(
  profilePath: string,
  extensionId: string,
  expected: ExtensionActivationSnapshot,
): Promise<void> {
  const actual = await activationSnapshot(
    join(profilePath, "extensions", extensionId),
    join(profilePath, ".runtime", "extensions", extensionId),
  );
  if (!sameActivationSnapshot(actual, expected)) {
    throw new Error(`Extension activation snapshot failed validation: ${extensionId}`);
  }
}

function sameActivationSnapshot(
  left: ExtensionActivationSnapshot,
  right: ExtensionActivationSnapshot,
): boolean {
  return (
    left.packageSnapshotSha256 === right.packageSnapshotSha256 &&
    left.stateJsonSha256 === right.stateJsonSha256 &&
    left.provenanceJsonSha256 === right.provenanceJsonSha256 &&
    left.approvalsJsonSha256 === right.approvalsJsonSha256
  );
}

async function publishStagedAuthorityJson(
  stagedAuthority: string,
  activeAuthority: string,
  name: "state.json" | "provenance.json" | "approvals.json",
): Promise<void> {
  await rename(join(stagedAuthority, name), join(activeAuthority, name));
  await Promise.all([syncDirectory(stagedAuthority), syncDirectory(activeAuthority)]);
}

async function replaceFileFromDurableCopy(source: string, target: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.rollback`;
  await cp(source, temporary, { errorOnExist: true, force: false });
  const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(dirname(target));
}

async function directoryDigest(path: string): Promise<string> {
  const tree = await readImmutableExtensionTree(path);
  const hash = createHash("sha256").update("ziggy-extension-activation-tree-v1\0");
  for (const directory of tree.directories) {
    hash.update("d\0").update(frameString(directory));
  }
  for (const file of tree.files) {
    hash.update("f\0").update(frameString(file.path)).update(frameBytes(file.bytes));
  }
  return hash.digest("hex");
}

function frameString(value: string): Uint8Array {
  return frameBytes(new TextEncoder().encode(value));
}

function frameBytes(value: Uint8Array): Uint8Array {
  const framed = new Uint8Array(8 + value.byteLength);
  new DataView(framed.buffer).setBigUint64(0, BigInt(value.byteLength), false);
  framed.set(value, 8);
  return framed;
}

async function syncTree(rootPath: string): Promise<void> {
  const status = await lstat(rootPath);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Expected durable Extension directory at ${rootPath}`);
  }
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    const entryStatus = await lstat(path);
    if (entryStatus.isSymbolicLink()) throw new Error(`Symbolic links are forbidden: ${path}`);
    if (entryStatus.isDirectory()) {
      await syncTree(path);
      continue;
    }
    if (!entryStatus.isFile() || entryStatus.nlink !== 1) {
      throw new Error(`Expected unaliased durable Extension file at ${path}`);
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(rootPath);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isDirectory()) throw new Error(`Expected directory at ${path}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncRenameParents(left: string, right: string): Promise<void> {
  if (left === right) {
    await syncDirectory(left);
    return;
  }
  await Promise.all([syncDirectory(left), syncDirectory(right)]);
}

async function writeDurableExclusiveJson(
  path: string,
  value: ExtensionActivationTransaction | ExtensionActivationCommit,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

function validateStagedTransaction(
  canonicalProfile: string,
  staged: StagedExtensionPackage,
): string {
  if (staged.profilePath !== canonicalProfile) {
    throw new Error("Staged Extension belongs to a different Profile");
  }
  const transactionId = staged.transactionPath.slice(staged.transactionPath.lastIndexOf("/") + 1);
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("Staged Extension has an invalid transaction id");
  }
  const expectedTransactionPath = join(
    canonicalProfile,
    ".runtime",
    "extensions",
    TRANSACTIONS_DIRECTORY,
    transactionId,
  );
  if (
    staged.transactionPath !== expectedTransactionPath ||
    staged.packagePath !== join(expectedTransactionPath, "package")
  ) {
    throw new Error("Staged Extension transaction path is not confined to its Profile");
  }
  return transactionId;
}

function decodeTransaction(text: string, transactionId: string): ExtensionActivationTransaction {
  if (!isStrictJson(text)) throw new Error("Extension transaction is not strict JSON");
  const decoded = decodeTransactionJsonResult(text);
  if (Result.isFailure(decoded)) throw new Error("Extension transaction is invalid");
  if (decoded.success.transactionId !== transactionId) {
    throw new Error("Extension transaction id does not match its directory");
  }
  return decoded.success;
}

function decodeCommit(text: string, transactionId: string): ExtensionActivationCommit {
  if (!isStrictJson(text)) throw new Error("Extension transaction commit is not strict JSON");
  const decoded = decodeCommitJsonResult(text);
  if (Result.isFailure(decoded)) throw new Error("Extension transaction commit is invalid");
  if (decoded.success.transactionId !== transactionId) {
    throw new Error("Extension transaction commit id does not match its directory");
  }
  return decoded.success;
}

function requireMatchingCommit(
  transaction: ExtensionActivationTransaction,
  commit: ExtensionActivationCommit,
): void {
  if (transaction.transactionId !== commit.transactionId || commit.decision !== "commit") {
    throw new Error("Extension transaction commit does not match its transaction");
  }
}

function parseUnknownJson(text: string, label: string): unknown {
  if (!isStrictJson(text)) throw new Error(`${label} is not strict JSON`);
  const decoded = decodeUnknownJsonResult(text);
  if (Result.isFailure(decoded)) throw new Error(`${label} is malformed JSON`);
  return decoded.success;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExtensionId(extensionId: string): void {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(`Invalid Extension id: ${JSON.stringify(extensionId)}`);
  }
}

export async function runExtensionProcess(input: {
  readonly executablePath: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly signal?: AbortSignal;
  readonly hooks?: ExtensionLifecycleNodeHooks;
}): Promise<ExtensionProcessResult> {
  const subprocess = Bun.spawn([input.executablePath, ...input.argv.slice(1)], {
    cwd: input.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    subprocess.kill();
  };
  input.signal?.addEventListener("abort", interrupt, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, input.timeoutMs);
  try {
    await checkpoint(input.hooks, "process-after-spawn", input.signal);
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      readBoundedStream(subprocess.stdout, input.outputLimitBytes),
      readBoundedStream(subprocess.stderr, input.outputLimitBytes),
    ]);
    const truncated = stdout.truncated || stderr.truncated;
    if (interrupted) throw new Error("Extension process interrupted");
    return {
      status: timedOut ? "timeout" : exitCode === 0 ? "ok" : "failed",
      exitCode: timedOut ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", interrupt);
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

async function checkpoint(
  hooks: ExtensionLifecycleNodeHooks | undefined,
  point: ExtensionLifecycleNodeCheckpoint,
  signal?: AbortSignal,
): Promise<void> {
  if (isAborted(signal)) throw new Error(`Extension operation interrupted at ${point}`);
  await hooks?.checkpoint(point);
  if (isAborted(signal)) throw new Error(`Extension operation interrupted at ${point}`);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
