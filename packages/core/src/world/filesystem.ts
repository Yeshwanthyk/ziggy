import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  decodeSessionEnvelope,
  encodeSessionEnvelope,
  type FrozenSessionSnapshot,
  type SessionEnvelope,
  type SessionEvent,
} from "@ziggy/protocol";

const SESSION_SUFFIX = ".ndjson";
const MEMORY_JOURNAL = ".batch-journal.json";
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type MemoryDocument = "MEMORY.md" | "USER.md";
export type MemoryCommitCutPoint =
  | "beforePrepare"
  | "afterPrepare"
  | "duringCommit"
  | "afterCommit";
export type MemoryRecoveryPoint = "duringRecovery";
export type SessionAppendPoint = "afterAppend";

export interface MemoryReplacement {
  readonly document: string;
  readonly content: string;
}

export interface MemoryBatchExpectation {
  readonly document: string;
  readonly content: string | undefined;
}

export class MemoryBatchConflictError extends Error {
  constructor() {
    super("Memory changed while applying the batch");
    this.name = "MemoryBatchConflictError";
  }
}

export interface StoredSessionSummary {
  readonly sessionId: string;
  readonly lastSeq: number;
}

export interface StartSessionResult {
  readonly snapshot: FrozenSessionSnapshot;
  readonly created: boolean;
}

export interface FilesystemWorldOptions {
  readonly profilePath: string;
  readonly now?: () => Date;
  readonly nextTemporaryId?: () => string;
  readonly onMemoryCommitPoint?: (point: MemoryCommitCutPoint) => Promise<void>;
  readonly onMemoryRecoveryPoint?: (point: MemoryRecoveryPoint) => Promise<void>;
  readonly onSessionAppendPoint?: (point: SessionAppendPoint) => Promise<void>;
}

export interface FilesystemWorld {
  readSessionSnapshot(sessionId: string): Promise<FrozenSessionSnapshot | undefined>;
  startSession(sessionId: string, snapshot: FrozenSessionSnapshot): Promise<StartSessionResult>;
  appendSession(sessionId: string, event: SessionEvent): Promise<SessionEnvelope>;
  readSession(sessionId: string, afterSeq: number): Promise<ReadonlyArray<SessionEnvelope>>;
  listSessions(): Promise<ReadonlyArray<StoredSessionSummary>>;
  readMemory(document: string): Promise<string | undefined>;
  readMemoryBatch(
    documents: ReadonlyArray<string>,
  ): Promise<Readonly<Record<string, string | undefined>>>;
  replaceMemoryBatch(
    replacements: ReadonlyArray<MemoryReplacement>,
    expected?: ReadonlyArray<MemoryBatchExpectation>,
  ): Promise<void>;
}

interface JournalValue {
  readonly exists: boolean;
  readonly content: string;
}

interface JournalReplacement {
  readonly document: MemoryDocument;
  readonly old: JournalValue;
  readonly new: JournalValue;
}

interface MemoryJournal {
  readonly schemaVersion: 1;
  readonly phase: "prepared" | "committed";
  readonly replacements: ReadonlyArray<JournalReplacement>;
}

interface ValidatedSession {
  readonly createdAt: string;
  readonly envelopes: ReadonlyArray<SessionEnvelope>;
}

const gates = new Map<string, Promise<void>>();
let temporaryFileSequence = 0;

export function createFilesystemWorld(options: FilesystemWorldOptions): FilesystemWorld {
  const profilePath = resolveProfilePath(options.profilePath);
  const sessionsPath = join(profilePath, "sessions");
  const memoryPath = join(profilePath, "memory");
  const now = options.now ?? (() => new Date());
  const nextTemporaryId = options.nextTemporaryId ?? defaultTemporaryId;
  const onMemoryCommitPoint = options.onMemoryCommitPoint ?? (async () => {});
  const onMemoryRecoveryPoint = options.onMemoryRecoveryPoint ?? (async () => {});
  const onSessionAppendPoint = options.onSessionAppendPoint ?? (async () => {});
  const memoryGate = `memory:${profilePath}`;

  return {
    async readSessionSnapshot(sessionId) {
      validateSessionId(sessionId);
      return withGate(`session:${profilePath}:${sessionId}`, async () => {
        await ensureSafeDirectory(profilePath, false);
        await ensureSafeDirectoryIfPresent(sessionsPath);
        const existing = await readValidatedSession(
          sessionPath(sessionsPath, sessionId),
          sessionId,
        );
        return requireExistingSessionSnapshot(existing.envelopes, sessionId);
      });
    },

    async startSession(sessionId, snapshot) {
      validateSessionId(sessionId);
      return withGate(`session:${profilePath}:${sessionId}`, async () => {
        const event = validateEventForSession(
          { type: "session-started", sessionId, snapshot },
          sessionId,
        );
        if (event.type !== "session-started") {
          throw new Error(`Session ${sessionId} produced an invalid start event`);
        }
        await ensureSafeDirectory(profilePath, false);
        await ensureSafeDirectory(sessionsPath, true);
        const path = sessionPath(sessionsPath, sessionId);
        const existing = await readValidatedSession(path, sessionId);
        const existingSnapshot = requireExistingSessionSnapshot(existing.envelopes, sessionId);
        if (existingSnapshot !== undefined) {
          return { snapshot: existingSnapshot, created: false };
        }

        const envelope = validateEnvelopeForSession(
          {
            schemaVersion: 1,
            seq: 1,
            emittedAt: canonicalNow(now),
            event,
          },
          sessionId,
          1,
        );
        await appendAndFlush(path, encodeSessionEnvelope(envelope));
        await syncDirectory(sessionsPath);
        await onSessionAppendPoint("afterAppend");
        if (envelope.event.type !== "session-started") {
          throw new Error(`Session ${sessionId} persisted an invalid start event`);
        }
        return { snapshot: envelope.event.snapshot, created: true };
      });
    },

    async appendSession(sessionId, event) {
      validateSessionId(sessionId);
      return withGate(`session:${profilePath}:${sessionId}`, async () => {
        const decodedEvent = validateEventForSession(event, sessionId);
        await ensureSafeDirectory(profilePath, false);
        await ensureSafeDirectory(sessionsPath, true);
        const path = sessionPath(sessionsPath, sessionId);
        const existing = await readValidatedSession(path, sessionId);
        requireExistingSessionSnapshot(existing.envelopes, sessionId);
        if (existing.envelopes.length === 0 && decodedEvent.type !== "session-started") {
          throw new Error(`Session ${sessionId} must begin with session-started`);
        }
        if (existing.envelopes.length > 0 && decodedEvent.type === "session-started") {
          throw new Error(`Session ${sessionId} already has its session-started event`);
        }
        const envelope = validateEnvelopeForSession(
          {
            schemaVersion: 1,
            seq: existing.envelopes.length + 1,
            emittedAt: canonicalNow(now),
            event: decodedEvent,
          },
          sessionId,
          existing.envelopes.length + 1,
        );
        const wasMissing = !(await pathExists(path));
        await appendAndFlush(path, encodeSessionEnvelope(envelope));
        if (wasMissing) {
          await syncDirectory(sessionsPath);
        }
        await onSessionAppendPoint("afterAppend");
        return envelope;
      });
    },

    async readSession(sessionId, afterSeq) {
      validateSessionId(sessionId);
      validateAfterSeq(afterSeq);
      return withGate(`session:${profilePath}:${sessionId}`, async () => {
        await ensureSafeDirectory(profilePath, false);
        await ensureSafeDirectoryIfPresent(sessionsPath);
        const validated = await readValidatedSession(
          sessionPath(sessionsPath, sessionId),
          sessionId,
        );
        return validated.envelopes.filter((envelope) => envelope.seq > afterSeq);
      });
    },

    async listSessions() {
      return withGate(`session-list:${profilePath}`, async () => {
        await ensureSafeDirectory(profilePath, false);
        if (!(await ensureSafeDirectoryIfPresent(sessionsPath))) {
          return [];
        }
        const entries = await readdir(sessionsPath, { withFileTypes: true });
        const sessions = await Promise.all(
          entries.filter(isSessionEntry).map(async (entry) => {
            if (!entry.isFile() || entry.isSymbolicLink()) {
              throw new Error(`Session store contains unsafe entry: ${entry.name}`);
            }
            const sessionId = entry.name.slice(0, -SESSION_SUFFIX.length);
            validateSessionId(sessionId);
            const validated = await withGate(`session:${profilePath}:${sessionId}`, () =>
              readValidatedSession(join(sessionsPath, entry.name), sessionId),
            );
            return {
              sessionId,
              lastSeq: validated.envelopes.length,
              createdAt: validated.createdAt,
            };
          }),
        );
        return sessions
          .sort((left, right) => {
            const timeOrder = left.createdAt.localeCompare(right.createdAt);
            return timeOrder === 0 ? left.sessionId.localeCompare(right.sessionId) : timeOrder;
          })
          .map(({ sessionId, lastSeq }) => ({ sessionId, lastSeq }));
      });
    },

    async readMemory(document) {
      const validatedDocument = validateMemoryDocument(document);
      return withGate(memoryGate, async () => {
        await ensureSafeDirectory(profilePath, false);
        await recoverMemory(memoryPath, nextTemporaryId, onMemoryRecoveryPoint);
        return readMemoryDocument(memoryPath, validatedDocument);
      });
    },

    async readMemoryBatch(documents) {
      const validatedDocuments = documents.map(validateMemoryDocument);
      return withGate(memoryGate, async () => {
        await ensureSafeDirectory(profilePath, false);
        await recoverMemory(memoryPath, nextTemporaryId, onMemoryRecoveryPoint);
        const values: Record<string, string | undefined> = {};
        for (const document of validatedDocuments) {
          values[document] = await readMemoryDocument(memoryPath, document);
        }
        return values;
      });
    },

    async replaceMemoryBatch(replacements, expected) {
      const expectations = validateMemoryExpectations(expected);
      const validated = validateReplacements(replacements, expectations.length > 0);
      return withGate(memoryGate, async () => {
        await ensureSafeDirectory(profilePath, false);
        await recoverMemory(memoryPath, nextTemporaryId, onMemoryRecoveryPoint);
        for (const expectation of expectations) {
          if (
            (await readMemoryDocument(memoryPath, expectation.document)) !== expectation.content
          ) {
            throw new MemoryBatchConflictError();
          }
        }
        if (validated.length === 0) {
          return;
        }
        await ensureSafeDirectory(memoryPath, true);

        const journalReplacements: JournalReplacement[] = [];
        for (const replacement of validated) {
          const oldContent = await readMemoryDocument(memoryPath, replacement.document);
          journalReplacements.push({
            document: replacement.document,
            old:
              oldContent === undefined
                ? { exists: false, content: "" }
                : { exists: true, content: oldContent },
            new: { exists: true, content: replacement.content },
          });
        }

        await onMemoryCommitPoint("beforePrepare");
        const prepared: MemoryJournal = {
          schemaVersion: 1,
          phase: "prepared",
          replacements: journalReplacements,
        };
        await writeJournal(memoryPath, prepared, nextTemporaryId);
        await onMemoryCommitPoint("afterPrepare");

        for (let index = 0; index < journalReplacements.length; index += 1) {
          const replacement = journalReplacements[index];
          if (replacement === undefined) {
            throw new Error("Memory transaction lost a replacement");
          }
          await applyJournalValue(
            memoryPath,
            replacement.document,
            replacement.new,
            nextTemporaryId,
          );
          if (index === 0) {
            await onMemoryCommitPoint("duringCommit");
          }
        }

        await writeJournal(memoryPath, { ...prepared, phase: "committed" }, nextTemporaryId);
        await onMemoryCommitPoint("afterCommit");
        await removeJournal(memoryPath);
      });
    },
  };
}

async function withGate<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
  const predecessor = gates.get(key) ?? Promise.resolve();
  const completion = Promise.withResolvers<void>();
  const tail = predecessor.then(() => completion.promise);
  gates.set(key, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    completion.resolve();
    if (gates.get(key) === tail) {
      gates.delete(key);
    }
  }
}

function resolveProfilePath(profilePath: string): string {
  if (profilePath.length === 0 || profilePath.includes("\0")) {
    throw new Error("Profile path must be non-empty and contain no NUL bytes");
  }
  return isAbsolute(profilePath) ? resolve(profilePath) : resolve(process.cwd(), profilePath);
}

function validateSessionId(sessionId: string): void {
  if (
    !SAFE_SESSION_ID.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes(sep) ||
    sessionId.includes("\\")
  ) {
    throw new Error(`Unsafe Session id: ${JSON.stringify(sessionId)}`);
  }
}

function validateAfterSeq(afterSeq: number): void {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error("afterSeq must be a non-negative safe integer");
  }
}

function sessionPath(sessionsPath: string, sessionId: string): string {
  return join(sessionsPath, `${sessionId}${SESSION_SUFFIX}`);
}

function validateEventForSession(event: SessionEvent, sessionId: string): SessionEvent {
  const envelope = validateEnvelopeForSession(
    {
      schemaVersion: 1,
      seq: 1,
      emittedAt: "2000-01-01T00:00:00.000Z",
      event,
    },
    sessionId,
    1,
  );
  return envelope.event;
}

function validateEnvelopeForSession(
  envelope: SessionEnvelope,
  sessionId: string,
  expectedSeq: number,
): SessionEnvelope {
  const decoded = decodeSessionEnvelope(encodeSessionEnvelope(envelope));
  if (decoded.seq !== expectedSeq) {
    throw new Error(
      `Session ${sessionId} expected contiguous seq ${expectedSeq}, got ${decoded.seq}`,
    );
  }
  if (decoded.event.sessionId !== sessionId) {
    throw new Error(
      `Session event id ${decoded.event.sessionId} does not match path id ${sessionId}`,
    );
  }
  return decoded;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("World clock returned an invalid Date");
  }
  return new Date(milliseconds).toISOString();
}

async function readValidatedSession(path: string, sessionId: string): Promise<ValidatedSession> {
  const status = await safeLstat(path);
  if (status === undefined) {
    return { createdAt: "", envelopes: [] };
  }
  requireRegularFile(status, path);
  const contents = await readUtf8File(path, `Session ${sessionId}`);
  if (contents.length === 0) {
    throw new Error(`Session ${sessionId} contains no canonical envelopes`);
  }
  if (!contents.endsWith("\n")) {
    throw new Error(`Session ${sessionId} has a torn final line`);
  }
  const lines = contents.slice(0, -1).split("\n");
  const envelopes = lines.map((line, index) =>
    validateEnvelopeForSession(decodeSessionEnvelope(`${line}\n`), sessionId, index + 1),
  );
  const first = envelopes[0];
  if (first === undefined) {
    throw new Error(`Session ${sessionId} has no canonical envelope`);
  }
  requireExistingSessionSnapshot(envelopes, sessionId);
  return { createdAt: first.emittedAt, envelopes };
}

function requireExistingSessionSnapshot(
  envelopes: ReadonlyArray<SessionEnvelope>,
  sessionId: string,
): FrozenSessionSnapshot | undefined {
  if (envelopes.length === 0) {
    return undefined;
  }
  const first = envelopes[0];
  const starts = envelopes.filter((envelope) => envelope.event.type === "session-started");
  if (first === undefined || first.event.type !== "session-started" || starts.length !== 1) {
    throw new Error(`Session ${sessionId} must start with exactly one session-started snapshot`);
  }
  return first.event.snapshot;
}

function isSessionEntry(entry: Dirent): boolean {
  return entry.name.endsWith(SESSION_SUFFIX);
}

async function appendAndFlush(path: string, contents: string): Promise<void> {
  await rejectSymlinkIfPresent(path);
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateMemoryDocument(document: string): MemoryDocument {
  if (document === "MEMORY.md" || document === "USER.md") {
    return document;
  }
  throw new Error(`Unsupported Memory document: ${JSON.stringify(document)}`);
}

function validateReplacements(
  replacements: ReadonlyArray<MemoryReplacement>,
  allowEmpty: boolean,
): ReadonlyArray<{ readonly document: MemoryDocument; readonly content: string }> {
  if (replacements.length === 0 && !allowEmpty) {
    throw new Error("Memory replacement batch must not be empty");
  }
  const seen = new Set<MemoryDocument>();
  return replacements.map((replacement) => {
    const document = validateMemoryDocument(replacement.document);
    if (seen.has(document)) {
      throw new Error(`Duplicate Memory replacement: ${document}`);
    }
    seen.add(document);
    if (typeof replacement.content !== "string") {
      throw new Error(`Memory replacement content for ${document} must be a string`);
    }
    return { document, content: replacement.content };
  });
}

function validateMemoryExpectations(
  expectations: ReadonlyArray<MemoryBatchExpectation> | undefined,
): ReadonlyArray<{ readonly document: MemoryDocument; readonly content: string | undefined }> {
  if (expectations === undefined) {
    return [];
  }
  const seen = new Set<MemoryDocument>();
  return expectations.map((expectation) => {
    const document = validateMemoryDocument(expectation.document);
    if (seen.has(document)) {
      throw new Error(`Duplicate Memory expectation: ${document}`);
    }
    seen.add(document);
    if (expectation.content !== undefined && typeof expectation.content !== "string") {
      throw new Error(`Memory expectation content for ${document} must be a string or undefined`);
    }
    return { document, content: expectation.content };
  });
}

async function readMemoryDocument(
  memoryPath: string,
  document: MemoryDocument,
): Promise<string | undefined> {
  if (!(await ensureSafeDirectoryIfPresent(memoryPath))) {
    return undefined;
  }
  const path = join(memoryPath, document);
  const status = await safeLstat(path);
  if (status === undefined) {
    return undefined;
  }
  requireRegularFile(status, path);
  return readUtf8File(path, `Memory document ${document}`);
}

async function recoverMemory(
  memoryPath: string,
  nextTemporaryId: () => string,
  onMemoryRecoveryPoint: (point: MemoryRecoveryPoint) => Promise<void>,
): Promise<void> {
  if (!(await ensureSafeDirectoryIfPresent(memoryPath))) {
    return;
  }
  const journalPath = join(memoryPath, MEMORY_JOURNAL);
  const status = await safeLstat(journalPath);
  if (status === undefined) {
    return;
  }
  requireRegularFile(status, journalPath);
  const journal = decodeJournal(await readUtf8File(journalPath, "Memory journal"));
  for (let index = 0; index < journal.replacements.length; index += 1) {
    const replacement = journal.replacements[index];
    if (replacement === undefined) {
      throw new Error("Memory recovery lost a replacement");
    }
    const value = journal.phase === "prepared" ? replacement.old : replacement.new;
    await applyJournalValue(memoryPath, replacement.document, value, nextTemporaryId);
    if (index === 0) {
      await onMemoryRecoveryPoint("duringRecovery");
    }
  }
  await removeJournal(memoryPath);
}

function decodeJournal(contents: string): MemoryJournal {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Memory journal is malformed JSON");
  }
  const record = exactRecord(value, ["schemaVersion", "phase", "replacements"], "Memory journal");
  if (record.schemaVersion !== 1) {
    throw new Error("Memory journal has an unsupported schemaVersion");
  }
  if (record.phase !== "prepared" && record.phase !== "committed") {
    throw new Error("Memory journal has an invalid phase");
  }
  if (!Array.isArray(record.replacements) || record.replacements.length === 0) {
    throw new Error("Memory journal requires replacements");
  }
  const seen = new Set<MemoryDocument>();
  const replacements = record.replacements.map((item) => {
    const replacement = exactRecord(item, ["document", "old", "new"], "Memory journal replacement");
    const document = validateMemoryDocumentValue(replacement.document);
    if (seen.has(document)) {
      throw new Error(`Memory journal repeats ${document}`);
    }
    seen.add(document);
    const oldValue = decodeJournalValue(replacement.old);
    const newValue = decodeJournalValue(replacement.new);
    if (!newValue.exists) {
      throw new Error("Memory journal replacement new value must exist");
    }
    return { document, old: oldValue, new: newValue };
  });
  return { schemaVersion: 1, phase: record.phase, replacements };
}

function decodeJournalValue(value: unknown): JournalValue {
  const record = exactRecord(value, ["exists", "content"], "Memory journal value");
  if (typeof record.exists !== "boolean" || typeof record.content !== "string") {
    throw new Error("Memory journal value requires boolean exists and string content");
  }
  if (!record.exists && record.content !== "") {
    throw new Error("Missing Memory journal values must have empty content");
  }
  return { exists: record.exists, content: record.content };
}

function validateMemoryDocumentValue(value: unknown): MemoryDocument {
  if (typeof value !== "string") {
    throw new Error("Memory journal document must be a string");
  }
  return validateMemoryDocument(value);
}

function exactRecord(
  value: unknown,
  expectedKeys: ReadonlyArray<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = Object.fromEntries(Object.entries(value));
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

async function applyJournalValue(
  memoryPath: string,
  document: MemoryDocument,
  value: JournalValue,
  nextTemporaryId: () => string,
): Promise<void> {
  const path = join(memoryPath, document);
  await rejectSymlinkIfPresent(path);
  if (value.exists) {
    await atomicWrite(path, value.content, memoryPath, nextTemporaryId);
    return;
  }
  await rm(path, { force: true });
  await syncDirectory(memoryPath);
}

async function writeJournal(
  memoryPath: string,
  journal: MemoryJournal,
  nextTemporaryId: () => string,
): Promise<void> {
  await atomicWrite(
    join(memoryPath, MEMORY_JOURNAL),
    `${JSON.stringify(journal)}\n`,
    memoryPath,
    nextTemporaryId,
  );
}

async function removeJournal(memoryPath: string): Promise<void> {
  await rejectSymlinkIfPresent(join(memoryPath, MEMORY_JOURNAL));
  await rm(join(memoryPath, MEMORY_JOURNAL), { force: true });
  await syncDirectory(memoryPath);
}

async function atomicWrite(
  path: string,
  contents: string,
  directory: string,
  nextTemporaryId: () => string,
): Promise<void> {
  await rejectSymlinkIfPresent(path);
  const temporaryId = nextTemporaryId();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(temporaryId)) {
    throw new Error(`Unsafe temporary file id: ${JSON.stringify(temporaryId)}`);
  }
  const temporaryPath = join(directory, `.tmp-${temporaryId}`);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rejectSymlinkIfPresent(path);
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function defaultTemporaryId(): string {
  temporaryFileSequence += 1;
  return `${process.pid}-${temporaryFileSequence}`;
}

async function readUtf8File(path: string, label: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  let status = await safeLstat(path);
  if (status === undefined && create) {
    try {
      await mkdir(path);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
    status = await safeLstat(path);
  }
  if (status === undefined) {
    throw new Error(`Required directory does not exist: ${path}`);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Unsafe directory path: ${path}`);
  }
}

async function ensureSafeDirectoryIfPresent(path: string): Promise<boolean> {
  const status = await safeLstat(path);
  if (status === undefined) {
    return false;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Unsafe directory path: ${path}`);
  }
  return true;
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  const status = await safeLstat(path);
  if (status?.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link: ${path}`);
  }
  if (status !== undefined && !status.isFile()) {
    throw new Error(`Expected regular file: ${path}`);
  }
}

function requireRegularFile(status: Stats, path: string): void {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Expected safe regular file: ${path}`);
  }
}

async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await safeLstat(path)) !== undefined;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isDirectorySyncUnsupported(error)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isDirectorySyncUnsupported(error: unknown): boolean {
  return (
    hasErrorCode(error, "EINVAL") ||
    hasErrorCode(error, "ENOTSUP") ||
    hasErrorCode(error, "EISDIR") ||
    hasErrorCode(error, "EBADF")
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
