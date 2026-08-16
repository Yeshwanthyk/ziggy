import { Context, Effect, Layer } from "effect";
import {
  MemoryFiles,
  type MemoryFilesApi,
  type MemoryDocumentRead,
} from "../adapters/fs/memory-files";
import {
  codePointLength,
  memoryDocumentForScope,
  memoryEntries,
  MemoryIdInvalid,
  type MemoryDocument,
  type MemoryScopeSelection,
} from "../domain/memory";
import type { ProfileTarget } from "../domain/profile";

export type MemoryDocumentState = "empty" | "present" | "missing";

export interface MemoryDocumentView {
  readonly document: MemoryDocument;
  readonly state: MemoryDocumentState;
  readonly entries: ReadonlyArray<string>;
  readonly codePoints: number;
  readonly cap: number;
  readonly content: string;
}

export type MemoryError = Effect.Error<ReturnType<MemoryFilesApi["read"]>> | MemoryIdInvalid;

export interface MemoryApi {
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<ReadonlyArray<MemoryDocumentView>, MemoryError>;
  readonly show: (
    target: ProfileTarget,
    scope: MemoryScopeSelection,
  ) => Effect.Effect<MemoryDocumentView, MemoryError>;
}

export class Memory extends Context.Service<Memory, MemoryApi>()("ziggy/Memory") {}

const view = (loaded: MemoryDocumentRead): MemoryDocumentView => {
  const entries = memoryEntries(loaded.content);
  return {
    document: loaded.document,
    state: loaded.exists ? (entries.length === 0 ? "empty" : "present") : "missing",
    entries,
    codePoints: loaded.exists ? codePointLength(loaded.content) : 0,
    cap: loaded.document.cap,
    content: loaded.content,
  };
};

export const makeMemory = (files: MemoryFilesApi): MemoryApi => ({
  list: (target) =>
    Effect.gen(function* () {
      const documents = yield* files.list(target.path);
      const loaded = yield* Effect.forEach(documents, (document) => files.read(document), {
        concurrency: 1,
      });
      return loaded.flatMap((document) => {
        const item = view(document);
        return item.state === "missing" ? [] : [item];
      });
    }),
  show: (target, scope) =>
    Effect.gen(function* () {
      const resolved = memoryDocumentForScope(target.path, scope);
      if (!resolved.ok) return yield* resolved.error;
      return view(yield* files.read(resolved.document));
    }),
});

export const MemoryLive = Layer.effect(
  Memory,
  Effect.gen(function* () {
    return makeMemory(yield* MemoryFiles);
  }),
);
