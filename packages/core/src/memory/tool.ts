import type { FilesystemWorld, MemoryDocument, MemoryReplacement } from "../world/filesystem.ts";

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

export async function runMemoryTool(options: RunMemoryToolOptions): Promise<MemoryToolResult> {
  let operations: ReadonlyArray<MemoryOperation>;
  try {
    operations = decodeOperations(options.operations);
  } catch (error) {
    return failure(error);
  }

  try {
    const initial = await options.world.readMemoryBatch(DOCUMENTS);
    const documents = new Map<MemoryDocument, ReadonlyArray<string>>();
    documents.set("MEMORY.md", parseDocument("MEMORY.md", initial["MEMORY.md"] ?? ""));
    documents.set("USER.md", parseDocument("USER.md", initial["USER.md"] ?? ""));

    for (const operation of operations) {
      applyOperation(documents, operation);
    }

    const replacements: MemoryReplacement[] = [];
    for (const document of DOCUMENTS) {
      const entries = documents.get(document);
      if (entries === undefined) {
        throw new Error(`Memory batch lost ${document}`);
      }
      const content = serializeAndValidate(document, entries);
      if (content !== (initial[document] ?? "")) {
        replacements.push({ document, content });
      }
    }

    if (replacements.length > 0) {
      await options.world.replaceMemoryBatch(replacements);
    }
    return {
      success: true,
      message:
        replacements.length === 0
          ? "Memory already matched the requested final state; no write was needed."
          : `Applied ${operations.length} Memory operation(s) atomically.`,
    };
  } catch (error) {
    return failure(error);
  }
}

function decodeOperations(value: unknown): ReadonlyArray<MemoryOperation> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Memory operations must be a non-empty array.");
  }
  return value.map((operation, index) => decodeOperation(operation, index));
}

function decodeOperation(value: unknown, index: number): MemoryOperation {
  const label = `Memory operation ${index + 1}`;
  const candidate = requireRecord(value, label);
  const action = candidate.action;

  if (action === "add") {
    requireExactFields(candidate, ["action", "target", "content"], label);
    return {
      action,
      target: decodeTarget(candidate.target, label),
      content: decodeEntry(candidate.content, `${label} content`),
    };
  }
  if (action === "replace") {
    requireExactFields(candidate, ["action", "target", "oldText", "content"], label);
    return {
      action,
      target: decodeTarget(candidate.target, label),
      oldText: decodeOldText(candidate.oldText, label),
      content: decodeEntry(candidate.content, `${label} content`),
    };
  }
  if (action === "remove") {
    requireExactFields(candidate, ["action", "target", "oldText"], label);
    return {
      action,
      target: decodeTarget(candidate.target, label),
      oldText: decodeOldText(candidate.oldText, label),
    };
  }
  throw new Error(`${label} action must be add, replace, or remove.`);
}

function applyOperation(
  documents: Map<MemoryDocument, ReadonlyArray<string>>,
  operation: MemoryOperation,
): void {
  const document = documentForTarget(operation.target);
  const entries = documents.get(document);
  if (entries === undefined) {
    throw new Error(`Memory batch lost ${document}`);
  }

  if (operation.action === "add") {
    documents.set(
      document,
      entries.includes(operation.content) ? entries : [...entries, operation.content],
    );
    return;
  }

  const matches = entries.flatMap((entry, index) =>
    entry.includes(operation.oldText) ? [index] : [],
  );
  if (matches.length === 0) {
    throw new Error(
      `No ${operation.target} entry matched ${JSON.stringify(operation.oldText)}. Retry with a unique substring from the current entries.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${JSON.stringify(operation.oldText)} matched multiple ${operation.target} entries. Retry with a more specific substring.`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error("Memory match disappeared while applying the batch.");
  }

  if (operation.action === "replace") {
    documents.set(
      document,
      entries.map((entry, index) => (index === match ? operation.content : entry)),
    );
    return;
  }
  documents.set(
    document,
    entries.filter((_entry, index) => index !== match),
  );
}

function parseDocument(document: MemoryDocument, content: string): ReadonlyArray<string> {
  if (content.length === 0) {
    return [];
  }
  const entries = content.split(MEMORY_ENTRY_DELIMITER);
  validateEntries(document, entries);
  return entries;
}

function serializeAndValidate(document: MemoryDocument, entries: ReadonlyArray<string>): string {
  validateEntries(document, entries);
  const content = entries.join(MEMORY_ENTRY_DELIMITER);
  validateLimit(document, content);
  return content;
}

function validateEntries(document: MemoryDocument, entries: ReadonlyArray<string>): void {
  for (const entry of entries) {
    if (entry.trim().length === 0) {
      throw new Error(
        `${document} is not a valid entry list: entries separated by the exact delimiter must be non-empty.`,
      );
    }
    if (entry.includes(MEMORY_ENTRY_DELIMITER)) {
      throw new Error(`${document} contains an injected Memory entry delimiter.`);
    }
  }
}

function validateLimit(document: MemoryDocument, content: string): void {
  const limit = document === "MEMORY.md" ? MEMORY_DOCUMENT_LIMIT : USER_DOCUMENT_LIMIT;
  const count = Array.from(content).length;
  if (count > limit) {
    throw new Error(
      `${document} would use ${count} Unicode code points, exceeding its ${limit} limit. Remove, replace, shorten, or consolidate entries in the same batch.`,
    );
  }
}

function decodeEntry(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const entry = value.trim();
  if (entry.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (entry.includes(MEMORY_ENTRY_DELIMITER)) {
    throw new Error(`${label} must not contain the exact Memory entry delimiter.`);
  }
  return entry;
}

function decodeOldText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} oldText must be a non-empty string.`);
  }
  return value.trim();
}

function decodeTarget(value: unknown, label: string): MemoryTarget {
  if (value === "memory" || value === "user") {
    return value;
  }
  throw new Error(`${label} target must be memory or user.`);
}

function documentForTarget(target: MemoryTarget): MemoryDocument {
  return target === "memory" ? "MEMORY.md" : "USER.md";
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<string>,
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((field) => !fields.includes(field))) {
    throw new Error(`${label} must contain exactly: ${fields.join(", ")}.`);
  }
}

function failure(error: unknown): MemoryToolResult {
  return {
    success: false,
    error:
      error instanceof Error ? error.message : "Memory operation failed without an error message.",
  };
}
