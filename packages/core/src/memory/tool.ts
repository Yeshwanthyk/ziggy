import type { JsonObject, JsonValue } from "@ziggy/protocol";
import { Effect, Predicate, Result, Schema } from "effect";
import {
  MemoryBatchConflictError,
  type FilesystemWorld,
  type FilesystemWorldError,
  type MemoryDocument,
  type MemoryReplacement,
} from "../world/filesystem.ts";

export const MEMORY_ENTRY_DELIMITER = "\n§\n";
export const MEMORY_DOCUMENT_LIMIT = 2_200;
export const USER_DOCUMENT_LIMIT = 1_375;

export type MemoryTarget = "memory" | "user";
export type MemoryAction = "add" | "replace" | "remove";

export type MemoryToolResult =
  | {
      readonly success: true;
      readonly message: string;
    }
  | {
      readonly success: false;
      readonly error: string;
    };

export interface RunMemoryToolOptions {
  readonly world: FilesystemWorld;
  readonly operations: unknown;
}

export interface MemoryToolExecutionInput {
  readonly input: JsonObject;
}

export interface MemoryToolDefinition {
  readonly name: "memory";
  readonly description: string;
  readonly inputSchema: JsonObject;
  execute(input: MemoryToolExecutionInput): Effect.Effect<JsonValue>;
}

export class MemoryToolError extends Schema.TaggedErrorClass<MemoryToolError>()("MemoryToolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type MemoryOperation =
  | {
      readonly action: "add";
      readonly target: MemoryTarget;
      readonly content: string;
    }
  | {
      readonly action: "replace";
      readonly target: MemoryTarget;
      readonly oldText: string;
      readonly content: string;
    }
  | {
      readonly action: "remove";
      readonly target: MemoryTarget;
      readonly oldText: string;
    };

const DOCUMENTS: ReadonlyArray<MemoryDocument> = ["MEMORY.md", "USER.md"];

export function createMemoryTool(world: FilesystemWorld): MemoryToolDefinition {
  return {
    name: "memory",
    description:
      "Atomically add, replace, or remove retained Memory entries in MEMORY.md or USER.md.",
    inputSchema: memoryToolInputSchema(),
    execute({ input }) {
      return runMemoryTool({ world, operations: input.operations }).pipe(
        Effect.map((result) =>
          result.success
            ? { success: true, message: result.message }
            : { success: false, error: result.error },
        ),
      );
    },
  };
}

export function runMemoryTool(options: RunMemoryToolOptions): Effect.Effect<MemoryToolResult> {
  const operation = Effect.gen(function* () {
    const operations = yield* Effect.fromResult(decodeOperations(options.operations));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const initial = yield* options.world.readMemoryBatch(DOCUMENTS);
      const documents = yield* Effect.fromResult(
        Result.gen(function* () {
          const values = new Map<MemoryDocument, ReadonlyArray<string>>();
          values.set("MEMORY.md", yield* parseDocument("MEMORY.md", initial["MEMORY.md"] ?? ""));
          values.set("USER.md", yield* parseDocument("USER.md", initial["USER.md"] ?? ""));
          for (const memoryOperation of operations) {
            yield* applyOperation(values, memoryOperation);
          }
          return values;
        }),
      );

      const replacements = yield* Effect.fromResult(buildReplacements(documents, initial));

      const touchedDocuments = [
        ...new Set(operations.map((operation) => documentForTarget(operation.target))),
      ];
      const replaced = yield* Effect.result(
        options.world.replaceMemoryBatch(
          replacements,
          touchedDocuments.map((document) => ({ document, content: initial[document] })),
        ),
      );
      if (Result.isFailure(replaced)) {
        if (Predicate.isTagged("MemoryBatchConflictError")(replaced.failure) && attempt < 8) {
          continue;
        }
        return yield* replaced.failure;
      }
      return {
        success: true,
        message:
          replacements.length === 0
            ? "Memory already matched the requested final state; no write was needed."
            : `Applied ${operations.length} Memory operation(s) atomically.`,
      } satisfies MemoryToolResult;
    }
    return yield* new MemoryToolError({
      message: "Memory kept changing; retry the operation.",
    });
  });
  return operation.pipe(Effect.catch((error) => Effect.succeed(failure(error))));
}

function buildReplacements(
  documents: ReadonlyMap<MemoryDocument, ReadonlyArray<string>>,
  initial: Readonly<Record<string, string | undefined>>,
): Result.Result<ReadonlyArray<MemoryReplacement>, MemoryToolError> {
  const replacements: MemoryReplacement[] = [];
  for (const document of DOCUMENTS) {
    const entries = documents.get(document);
    if (entries === undefined) {
      return Result.fail(new MemoryToolError({ message: `Memory batch lost ${document}` }));
    }
    const serialized = serializeAndValidate(document, entries);
    if (Result.isFailure(serialized)) return Result.fail(serialized.failure);
    const content = serialized.success;
    if (content !== (initial[document] ?? "")) {
      replacements.push({ document, content });
    }
  }
  return Result.succeed(replacements);
}

function memoryToolInputSchema(): JsonObject {
  const target = { type: "string", enum: ["memory", "user"] };
  const content = { type: "string", minLength: 1 };
  const oldText = { type: "string", minLength: 1 };
  return {
    type: "object",
    additionalProperties: false,
    required: ["operations"],
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["action", "target", "content"],
              properties: {
                action: { const: "add" },
                target,
                content,
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["action", "target", "oldText", "content"],
              properties: {
                action: { const: "replace" },
                target,
                oldText,
                content,
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["action", "target", "oldText"],
              properties: {
                action: { const: "remove" },
                target,
                oldText,
              },
            },
          ],
        },
      },
    },
  };
}

function decodeOperations(
  value: unknown,
): Result.Result<ReadonlyArray<MemoryOperation>, MemoryToolError> {
  if (!Array.isArray(value) || value.length === 0) {
    return Result.fail(
      new MemoryToolError({ message: "Memory operations must be a non-empty array." }),
    );
  }
  return Result.all(value.map((operation, index) => decodeOperation(operation, index)));
}

function decodeOperation(
  value: unknown,
  index: number,
): Result.Result<MemoryOperation, MemoryToolError> {
  return Result.gen(function* () {
    const label = `Memory operation ${index + 1}`;
    const candidate = yield* requireRecord(value, label);
    const action = candidate.action;

    if (action === "add") {
      yield* requireExactFields(candidate, ["action", "target", "content"], label);
      return {
        action,
        target: yield* decodeTarget(candidate.target, label),
        content: yield* decodeEntry(candidate.content, `${label} content`),
      };
    }
    if (action === "replace") {
      yield* requireExactFields(candidate, ["action", "target", "oldText", "content"], label);
      return {
        action,
        target: yield* decodeTarget(candidate.target, label),
        oldText: yield* decodeOldText(candidate.oldText, label),
        content: yield* decodeEntry(candidate.content, `${label} content`),
      };
    }
    if (action === "remove") {
      yield* requireExactFields(candidate, ["action", "target", "oldText"], label);
      return {
        action,
        target: yield* decodeTarget(candidate.target, label),
        oldText: yield* decodeOldText(candidate.oldText, label),
      };
    }
    return yield* Result.fail(
      new MemoryToolError({ message: `${label} action must be add, replace, or remove.` }),
    );
  });
}

function applyOperation(
  documents: Map<MemoryDocument, ReadonlyArray<string>>,
  operation: MemoryOperation,
): Result.Result<void, MemoryToolError> {
  const document = documentForTarget(operation.target);
  const entries = documents.get(document);
  if (entries === undefined) {
    return Result.fail(new MemoryToolError({ message: `Memory batch lost ${document}` }));
  }

  if (operation.action === "add") {
    documents.set(
      document,
      entries.includes(operation.content) ? entries : [...entries, operation.content],
    );
    return Result.succeed(undefined);
  }

  const matches = entries.flatMap((entry, index) =>
    entry.includes(operation.oldText) ? [index] : [],
  );
  if (matches.length === 0) {
    return Result.fail(
      new MemoryToolError({
        message: `No ${operation.target} entry matched ${JSON.stringify(operation.oldText)}. Retry with a unique substring from the current entries.`,
      }),
    );
  }
  if (matches.length > 1) {
    return Result.fail(
      new MemoryToolError({
        message: `${JSON.stringify(operation.oldText)} matched multiple ${operation.target} entries. Retry with a more specific substring.`,
      }),
    );
  }
  const match = matches[0];
  if (match === undefined) {
    return Result.fail(
      new MemoryToolError({
        message: "Memory match disappeared while applying the batch.",
      }),
    );
  }

  if (operation.action === "replace") {
    documents.set(
      document,
      entries.map((entry, index) => (index === match ? operation.content : entry)),
    );
    return Result.succeed(undefined);
  }
  documents.set(
    document,
    entries.filter((_entry, index) => index !== match),
  );
  return Result.succeed(undefined);
}

function parseDocument(
  document: MemoryDocument,
  content: string,
): Result.Result<ReadonlyArray<string>, MemoryToolError> {
  if (content.length === 0) {
    return Result.succeed([]);
  }
  const entries = content.split(MEMORY_ENTRY_DELIMITER);
  return Result.map(validateEntries(document, entries), () => entries);
}

function serializeAndValidate(
  document: MemoryDocument,
  entries: ReadonlyArray<string>,
): Result.Result<string, MemoryToolError> {
  return Result.gen(function* () {
    yield* validateEntries(document, entries);
    const content = entries.join(MEMORY_ENTRY_DELIMITER);
    yield* validateLimit(document, content);
    return content;
  });
}

function validateEntries(
  document: MemoryDocument,
  entries: ReadonlyArray<string>,
): Result.Result<void, MemoryToolError> {
  for (const entry of entries) {
    if (entry.trim().length === 0) {
      return Result.fail(
        new MemoryToolError({
          message: `${document} is not a valid entry list: entries separated by the exact delimiter must be non-empty. Remove leading/trailing delimiters and empty entries manually.`,
        }),
      );
    }
    if (entry.includes(MEMORY_ENTRY_DELIMITER)) {
      return Result.fail(
        new MemoryToolError({
          message: `${document} contains an injected Memory entry delimiter.`,
        }),
      );
    }
  }
  return Result.succeed(undefined);
}

function validateLimit(
  document: MemoryDocument,
  content: string,
): Result.Result<void, MemoryToolError> {
  const limit = document === "MEMORY.md" ? MEMORY_DOCUMENT_LIMIT : USER_DOCUMENT_LIMIT;
  const count = Array.from(content).length;
  if (count > limit) {
    return Result.fail(
      new MemoryToolError({
        message: `${document} would use ${count} Unicode code points, exceeding its ${limit} limit. Remove, replace, shorten, or consolidate entries in the same batch.`,
      }),
    );
  }
  return Result.succeed(undefined);
}

function decodeEntry(value: unknown, label: string): Result.Result<string, MemoryToolError> {
  if (typeof value !== "string") {
    return Result.fail(new MemoryToolError({ message: `${label} must be a string.` }));
  }
  const entry = value.trim();
  if (entry.length === 0) {
    return Result.fail(new MemoryToolError({ message: `${label} must not be empty.` }));
  }
  if (entry.includes(MEMORY_ENTRY_DELIMITER)) {
    return Result.fail(
      new MemoryToolError({
        message: `${label} must not contain the exact Memory entry delimiter.`,
      }),
    );
  }
  return Result.succeed(entry);
}

function decodeOldText(value: unknown, label: string): Result.Result<string, MemoryToolError> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return Result.fail(
      new MemoryToolError({ message: `${label} oldText must be a non-empty string.` }),
    );
  }
  return Result.succeed(value.trim());
}

function decodeTarget(value: unknown, label: string): Result.Result<MemoryTarget, MemoryToolError> {
  if (value === "memory" || value === "user") {
    return Result.succeed(value);
  }
  return Result.fail(new MemoryToolError({ message: `${label} target must be memory or user.` }));
}

function documentForTarget(target: MemoryTarget): MemoryDocument {
  return target === "memory" ? "MEMORY.md" : "USER.md";
}

function requireRecord(
  value: unknown,
  label: string,
): Result.Result<Readonly<Record<string, unknown>>, MemoryToolError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Result.fail(new MemoryToolError({ message: `${label} must be an object.` }));
  }
  return Result.succeed(Object.fromEntries(Object.entries(value)));
}

function requireExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<string>,
  label: string,
): Result.Result<void, MemoryToolError> {
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !fields.includes(field))) {
    return Result.fail(
      new MemoryToolError({
        message: `${label} must contain exactly: ${fields.join(", ")}.`,
      }),
    );
  }
  return Result.succeed(undefined);
}

function failure(
  error: MemoryToolError | FilesystemWorldError | MemoryBatchConflictError,
): MemoryToolResult {
  return {
    success: false,
    // oxlint-disable-next-line ziggy-effect/no-unknown-error-message -- typed: every Memory failure exposes its stable model-visible message contract
    error: error.message,
  };
}
