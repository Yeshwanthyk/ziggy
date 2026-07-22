/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: pi-ai CredentialStore is Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: pi-ai and Node reject through native exceptions */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: pi-ai and Node reject through native Error values */
/* oxlint-disable ziggy-effect/no-json-parse -- boundary: adapter validates the complete persisted document immediately */
/* oxlint-disable ziggy-effect/no-unknown-shape-probing -- boundary: adapter guards Node and persisted JSON values */
/* oxlint-disable ziggy-effect/no-instanceof-error -- boundary: adapter normalizes native Node errors */
/* oxlint-disable ziggy-effect/no-unknown-error-message -- boundary: adapter preserves native diagnostics for the Effect wrapper */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type { Effect, Semaphore } from "effect";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_PROVIDERS = 256;
const MAX_CREDENTIAL_FIELDS = 256;
const MAX_ENV_ENTRIES = 64;
const MAX_STRING_LENGTH = 65_536;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface CredentialDocument {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, Credential>>;
}

export async function createNodeCredentialStore(profilePath: string): Promise<CredentialStore> {
  const directory = join(profilePath, "credentials");
  const directoryIdentity = identityOf(await ensureDirectory(directory));
  const path = join(directory, "auth.json");
  await readDocument(directory, directoryIdentity, path);

  return {
    async read(providerId) {
      requireProviderId(providerId);
      return ownCredential(
        (await readDocument(directory, directoryIdentity, path)).credentials,
        providerId,
      );
    },
    async list() {
      return Object.entries((await readDocument(directory, directoryIdentity, path)).credentials)
        .map(
          ([providerId, credential]): CredentialInfo => ({
            providerId,
            type: credential.type,
          }),
        )
        .sort((left, right) => left.providerId.localeCompare(right.providerId));
    },
    async modify(providerId, fn) {
      requireProviderId(providerId);
      const document = await readDocument(directory, directoryIdentity, path);
      const current = ownCredential(document.credentials, providerId);
      const next = await fn(current === undefined ? undefined : structuredClone(current));
      if (next === undefined) return current;
      const credential = decodeCredential(next, `credential ${providerId}`);
      const credentials = Object.fromEntries([
        ...Object.entries(document.credentials).filter(([id]) => id !== providerId),
        [providerId, credential],
      ]);
      requireProviderBound(credentials);
      await writeDocument(directory, directoryIdentity, path, {
        schemaVersion: SCHEMA_VERSION,
        credentials,
      });
      return structuredClone(credential);
    },
    async delete(providerId) {
      requireProviderId(providerId);
      const document = await readDocument(directory, directoryIdentity, path);
      if (ownCredential(document.credentials, providerId) === undefined) return;
      await writeDocument(directory, directoryIdentity, path, {
        schemaVersion: SCHEMA_VERSION,
        credentials: Object.fromEntries(
          Object.entries(document.credentials).filter(([id]) => id !== providerId),
        ),
      });
    },
  };
}

export function serializeNodeCredentialStore<E>(
  node: CredentialStore,
  gate: Semaphore.Semaphore,
  runPromise: <Value>(effect: Effect.Effect<Value, E>) => Promise<Value>,
  wrap: <Value>(operation: string, run: () => Promise<Value>) => Effect.Effect<Value, E>,
): CredentialStore {
  const serialized = <Value>(operation: string, run: () => Promise<Value>): Promise<Value> =>
    runPromise(gate.withPermit(wrap(operation, run)));
  return {
    read: (providerId) =>
      serialized("Failed to read Profile credential", () => node.read(providerId)),
    list: () => serialized("Failed to list Profile credentials", () => node.list()),
    modify: (providerId, update) =>
      serialized("Failed to modify Profile credential", () => node.modify(providerId, update)),
    delete: (providerId) =>
      serialized("Failed to delete Profile credential", () => node.delete(providerId)),
  };
}

export function nodeCredentialErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

async function ensureDirectory(path: string): Promise<Stats> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    await chmod(path, DIRECTORY_MODE);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`credentials path is not a regular directory: ${path}`);
  }
  if ((status.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`credentials directory must have mode 0700: ${path}`);
  }
  return status;
}

async function readDocument(
  directory: string,
  directoryIdentity: DirectoryIdentity,
  path: string,
): Promise<CredentialDocument> {
  await requireDirectoryIdentity(directory, directoryIdentity);
  const before = await safeLstat(path);
  if (before === undefined) {
    await requireDirectoryIdentity(directory, directoryIdentity);
    return { schemaVersion: SCHEMA_VERSION, credentials: Object.fromEntries([]) };
  }
  requireSafeFile(before, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents: string;
  try {
    const opened = await handle.stat();
    requireSafeFile(opened, path);
    requireSameIdentity(opened, before, path);
    if (opened.size > MAX_DOCUMENT_BYTES) {
      throw new Error(`credential store exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    }
    await requireDirectoryIdentity(directory, directoryIdentity);
    contents = await handle.readFile("utf8");
    await requirePathIdentity(path, opened);
    await requireDirectoryIdentity(directory, directoryIdentity);
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid credential store at ${path}: ${errorDetail(error)}`);
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "credentials"])) {
    throw new Error(`invalid credential store shape at ${path}`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported credential store schemaVersion at ${path}`);
  }
  if (!isRecord(value.credentials)) throw new Error(`invalid credentials map at ${path}`);
  requireProviderBound(value.credentials);
  const credentialEntries: Array<readonly [string, Credential]> = [];
  for (const [providerId, credential] of Object.entries(value.credentials)) {
    requireProviderId(providerId);
    credentialEntries.push([providerId, decodeCredential(credential, `credential ${providerId}`)]);
  }
  const credentials = Object.fromEntries(credentialEntries);
  return { schemaVersion: SCHEMA_VERSION, credentials };
}

async function writeDocument(
  directory: string,
  directoryIdentity: DirectoryIdentity,
  path: string,
  document: CredentialDocument,
): Promise<void> {
  await requireDirectoryIdentity(directory, directoryIdentity);
  const current = await safeLstat(path);
  if (current !== undefined) requireSafeFile(current, path);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_DOCUMENT_BYTES) {
    throw new Error(`credential store exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const temporaryPath = join(directory, `.auth-${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  let temporaryStatus: Stats | undefined;
  try {
    await handle.chmod(FILE_MODE);
    temporaryStatus = await handle.stat();
    await requireDirectoryIdentity(directory, directoryIdentity);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  if (temporaryStatus === undefined) throw new Error("credential temporary file was not inspected");
  try {
    await requireDirectoryIdentity(directory, directoryIdentity);
    if (current !== undefined) await requirePathIdentity(path, current);
    await rename(temporaryPath, path);
    await requirePathIdentity(path, temporaryStatus);
    await requireDirectoryIdentity(directory, directoryIdentity);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      requireIdentity(await directoryHandle.stat(), directoryIdentity, directory);
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function decodeCredential(value: unknown, name: string): Credential {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`invalid ${name}`);
  if (value.type === "api_key") return decodeApiKey(value, name);
  if (value.type === "oauth") return decodeOAuth(value, name);
  throw new Error(`invalid ${name} type`);
}

function decodeApiKey(value: Readonly<Record<string, unknown>>, name: string): ApiKeyCredential {
  if (!hasOnlyKeys(value, ["type", "key", "env"])) throw new Error(`invalid ${name} fields`);
  if (
    value.key !== undefined &&
    (typeof value.key !== "string" || value.key.length > MAX_STRING_LENGTH)
  ) {
    throw new Error(`invalid ${name} key`);
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    if (!isRecord(value.env)) throw new Error(`invalid ${name} env`);
    const entries = Object.entries(value.env);
    if (entries.length > MAX_ENV_ENTRIES) throw new Error(`invalid ${name} env size`);
    const decodedEntries: Array<readonly [string, string]> = [];
    for (const [key, entry] of entries) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof entry !== "string" ||
        entry.length > MAX_STRING_LENGTH
      ) {
        throw new Error(`invalid ${name} env value`);
      }
      decodedEntries.push([key, entry]);
    }
    env = Object.fromEntries(decodedEntries);
  }
  return {
    type: "api_key",
    ...(typeof value.key === "string" ? { key: value.key } : {}),
    ...(env === undefined ? {} : { env }),
  };
}

function decodeOAuth(value: Readonly<Record<string, unknown>>, name: string): OAuthCredential {
  if (
    typeof value.refresh !== "string" ||
    value.refresh.length === 0 ||
    value.refresh.length > MAX_STRING_LENGTH ||
    typeof value.access !== "string" ||
    value.access.length === 0 ||
    value.access.length > MAX_STRING_LENGTH ||
    typeof value.expires !== "number" ||
    !Number.isSafeInteger(value.expires) ||
    Object.keys(value).length > MAX_CREDENTIAL_FIELDS
  ) {
    throw new Error(`invalid ${name} OAuth fields`);
  }
  for (const key of Object.keys(value)) {
    if (key.length > 128) throw new Error(`invalid ${name} OAuth field name`);
  }
  requireJsonValue(value, name);
  return {
    ...value,
    type: "oauth",
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
  };
}

function requireJsonValue(value: unknown, name: string): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new Error(`invalid bounded ${name} value`);
    }
    const entry = current.value;
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry === "string") {
      if (entry.length > MAX_STRING_LENGTH) throw new Error(`invalid bounded ${name} string`);
      continue;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) continue;
    const children = Array.isArray(entry)
      ? entry
      : isRecord(entry)
        ? Object.values(entry)
        : undefined;
    if (children === undefined || children.length > MAX_CREDENTIAL_FIELDS) {
      throw new Error(`invalid non-JSON ${name} value`);
    }
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
}

function ownCredential(
  credentials: Readonly<Record<string, Credential>>,
  providerId: string,
): Credential | undefined {
  return Object.hasOwn(credentials, providerId) ? credentials[providerId] : undefined;
}

function requireProviderBound(credentials: Readonly<Record<string, unknown>>): void {
  if (Object.keys(credentials).length > MAX_PROVIDERS) {
    throw new Error(`credential store exceeds ${MAX_PROVIDERS} Providers`);
  }
}

function requireProviderId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new Error("invalid Provider id");
}
function requireSafeFile(status: Stats, path: string): void {
  if (status.isSymbolicLink() || !status.isFile())
    throw new Error(`credential store is not a regular file: ${path}`);
  if ((status.mode & 0o777) !== FILE_MODE)
    throw new Error(`credential store must have mode 0600: ${path}`);
}
function identityOf(status: Stats): DirectoryIdentity {
  return { device: status.dev, inode: status.ino };
}
function requireIdentity(status: Stats, expected: DirectoryIdentity, path: string): void {
  if (status.dev !== expected.device || status.ino !== expected.inode) {
    throw new Error(`credential path identity changed: ${path}`);
  }
}
function requireSameIdentity(actual: Stats, expected: Stats, path: string): void {
  requireIdentity(actual, identityOf(expected), path);
}
async function requireDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`credentials path is not a regular directory: ${path}`);
  }
  if ((status.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`credentials directory must have mode 0700: ${path}`);
  }
  requireIdentity(status, expected, path);
}
async function requirePathIdentity(path: string, expected: Stats): Promise<void> {
  const status = await lstat(path);
  requireSafeFile(status, path);
  requireSameIdentity(status, expected, path);
}
function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlyArray<string>,
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlyArray<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
