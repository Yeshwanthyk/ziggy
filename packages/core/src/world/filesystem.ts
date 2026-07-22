import { resolve } from "node:path";
import type { FrozenSessionSnapshot, SessionEnvelope, SessionEvent } from "@ziggy/protocol";
import { Effect, PartitionedSemaphore, Schema } from "effect";
import {
  createNodeFilesystemWorld,
  isNodeMemoryBatchConflictError,
  nodeFilesystemErrorMessage,
  type FilesystemWorldOptions,
  type MemoryBatchExpectation,
  type MemoryReplacement,
  type StartSessionResult,
  type StoredSessionSummary,
} from "./filesystem-node-adapter.ts";

export type {
  FilesystemWorldOptions,
  MemoryBatchExpectation,
  MemoryCommitCutPoint,
  MemoryDocument,
  MemoryRecoveryPoint,
  MemoryReplacement,
  SessionAppendPoint,
  StartSessionResult,
  StoredSessionSummary,
} from "./filesystem-node-adapter.ts";

export class MemoryBatchConflictError extends Schema.TaggedErrorClass<MemoryBatchConflictError>()(
  "MemoryBatchConflictError",
  {},
) {
  override readonly message = "Memory changed while applying the batch";
}

const filesystemGates = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });

export class FilesystemWorldError extends Schema.TaggedErrorClass<FilesystemWorldError>()(
  "FilesystemWorldError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export interface FilesystemWorld {
  readSessionSnapshot(
    sessionId: string,
  ): Effect.Effect<FrozenSessionSnapshot | undefined, FilesystemWorldError>;
  startSession(
    sessionId: string,
    snapshot: FrozenSessionSnapshot,
  ): Effect.Effect<StartSessionResult, FilesystemWorldError>;
  appendSession(
    sessionId: string,
    event: SessionEvent,
  ): Effect.Effect<SessionEnvelope, FilesystemWorldError>;
  readSession(
    sessionId: string,
    afterSeq: number,
  ): Effect.Effect<ReadonlyArray<SessionEnvelope>, FilesystemWorldError>;
  readonly listSessions: Effect.Effect<ReadonlyArray<StoredSessionSummary>, FilesystemWorldError>;
  readMemory(document: string): Effect.Effect<string | undefined, FilesystemWorldError>;
  readMemoryBatch(
    documents: ReadonlyArray<string>,
  ): Effect.Effect<Readonly<Record<string, string | undefined>>, FilesystemWorldError>;
  replaceMemoryBatch(
    replacements: ReadonlyArray<MemoryReplacement>,
    expected?: ReadonlyArray<MemoryBatchExpectation>,
  ): Effect.Effect<void, FilesystemWorldError | MemoryBatchConflictError>;
}

export function createFilesystemWorld(options: FilesystemWorldOptions): FilesystemWorld {
  const node = createNodeFilesystemWorld(options);
  const profileKey = resolve(options.profilePath);
  const serialized = <Value, Error>(
    operation: Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error> => filesystemGates.withPermit(profileKey)(operation);
  return {
    readSessionSnapshot: (sessionId) =>
      serialized(
        worldOperation("Failed to read Session snapshot", () =>
          node.readSessionSnapshot(sessionId),
        ),
      ),
    startSession: (sessionId, snapshot) =>
      serialized(
        worldOperation("Failed to start Session", () => node.startSession(sessionId, snapshot)),
      ),
    appendSession: (sessionId, event) =>
      serialized(
        worldOperation("Failed to append Session event", () =>
          node.appendSession(sessionId, event),
        ),
      ),
    readSession: (sessionId, afterSeq) =>
      serialized(
        worldOperation("Failed to read Session", () => node.readSession(sessionId, afterSeq)),
      ),
    listSessions: serialized(worldOperation("Failed to list Sessions", () => node.listSessions())),
    readMemory: (document) =>
      serialized(worldOperation("Failed to read Memory document", () => node.readMemory(document))),
    readMemoryBatch: (documents) =>
      serialized(
        worldOperation("Failed to read Memory batch", () => node.readMemoryBatch(documents)),
      ),
    replaceMemoryBatch: (replacements, expected) =>
      serialized(
        Effect.tryPromise({
          try: () => node.replaceMemoryBatch(replacements, expected),
          catch: (cause) =>
            isNodeMemoryBatchConflictError(cause)
              ? new MemoryBatchConflictError()
              : new FilesystemWorldError({
                  message: nodeFilesystemErrorMessage(cause, "Failed to replace Memory batch"),
                  cause,
                }),
        }),
      ),
  };
}

function worldOperation<Value>(
  operation: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: one wrapper converts the Node adapter Promise into a typed Effect
  run: () => Promise<Value>,
): Effect.Effect<Value, FilesystemWorldError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new FilesystemWorldError({
        message: nodeFilesystemErrorMessage(cause, operation),
        cause,
      }),
  });
}
