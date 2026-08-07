import * as path from "node:path";
import { Schema } from "effect";

export const SHARED_MEMORY_CAP = 2_200;
export const CONTEXT_MEMORY_CAP = 1_375;
export const MEMORY_ENTRY_DELIMITER = "\n§\n";

export type ChatContext =
  | { readonly kind: "local" }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "group"; readonly groupId: string };

export type MemoryScope = "shared" | "person" | "group";

export interface MemoryDocument {
  readonly scope: MemoryScope;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly cap: number;
  readonly heading: string;
}

export type MemoryOperation =
  | { readonly action: "add"; readonly content: string }
  | { readonly action: "replace"; readonly oldText: string; readonly content: string }
  | { readonly action: "remove"; readonly oldText: string };

type MemoryOperationsFailure = { readonly ok: false; readonly message: string };

export type ApplyMemoryOperationsResult =
  | { readonly ok: true; readonly content: string; readonly changed: boolean }
  | MemoryOperationsFailure;

export class MemoryIdInvalid extends Schema.TaggedErrorClass<MemoryIdInvalid>()("MemoryIdInvalid", {
  kind: Schema.Literals(["user", "group"]),
  id: Schema.String,
  message: Schema.String,
}) {}

export class MemoryOperationInvalid extends Schema.TaggedErrorClass<MemoryOperationInvalid>()(
  "MemoryOperationInvalid",
  {
    operation: Schema.Finite,
    action: Schema.Literals(["add", "replace", "remove"]),
    message: Schema.String,
  },
) {}

export class MemoryEntryMatchInvalid extends Schema.TaggedErrorClass<MemoryEntryMatchInvalid>()(
  "MemoryEntryMatchInvalid",
  {
    operation: Schema.Finite,
    action: Schema.Literals(["replace", "remove"]),
    oldText: Schema.String,
    matches: Schema.Finite,
    message: Schema.String,
  },
) {}

export class MemoryFull extends Schema.TaggedErrorClass<MemoryFull>()("MemoryFull", {
  used: Schema.Finite,
  cap: Schema.Finite,
  message: Schema.String,
}) {}

type MemoryOperationError = MemoryOperationInvalid | MemoryEntryMatchInvalid | MemoryFull;

export type MemoryDocumentsResult =
  | { readonly ok: true; readonly documents: ReadonlyArray<MemoryDocument> }
  | { readonly ok: false; readonly error: MemoryIdInvalid };

const validMemoryId = /^[a-z0-9._-]{1,64}$/;

export const codePointLength = (value: string): number => [...value].length;

export const memoryEntries = (content: string): ReadonlyArray<string> => {
  const normalized = content.trim();
  return normalized.length === 0 ? [] : normalized.split(MEMORY_ENTRY_DELIMITER);
};

const serializeMemoryEntries = (entries: ReadonlyArray<string>): string =>
  entries.length === 0 ? "" : `${entries.join(MEMORY_ENTRY_DELIMITER)}\n`;

export const renderMemoryForPrompt = (content: string): string =>
  memoryEntries(content).join("\n\n");

const memoryOperationFailure = ({ message }: MemoryOperationError): MemoryOperationsFailure => ({
  ok: false,
  message,
});

const invalidOperation = (
  operation: number,
  action: MemoryOperation["action"],
  detail: string,
): MemoryOperationsFailure =>
  memoryOperationFailure(
    new MemoryOperationInvalid({
      operation,
      action,
      message: `operation ${operation} (${action}) rejected: ${detail}`,
    }),
  );

const validateText = (
  operation: number,
  action: MemoryOperation["action"],
  field: "content" | "oldText",
  value: string,
): { readonly ok: true; readonly value: string } | MemoryOperationsFailure => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return invalidOperation(operation, action, `${field} must be non-empty after trimming`);
  }
  if (field === "content" && trimmed.includes(MEMORY_ENTRY_DELIMITER)) {
    return invalidOperation(
      operation,
      action,
      "content must not contain the memory entry delimiter",
    );
  }
  return { ok: true, value: trimmed };
};

const invalidMatch = (
  operation: number,
  action: "replace" | "remove",
  oldText: string,
  matches: number,
): MemoryOperationsFailure =>
  memoryOperationFailure(
    new MemoryEntryMatchInvalid({
      operation,
      action,
      oldText,
      matches,
      message: `operation ${operation} (${action}) matched ${matches} entries for oldText; use text that identifies exactly one entry`,
    }),
  );

export const applyMemoryOperations = (
  initialContent: string,
  operations: ReadonlyArray<MemoryOperation>,
  cap: number,
): ApplyMemoryOperationsResult => {
  const entries = [...memoryEntries(initialContent)];

  for (const [index, operation] of operations.entries()) {
    const operationNumber = index + 1;

    if (operation.action === "add") {
      const content = validateText(operationNumber, operation.action, "content", operation.content);
      if (!content.ok) {
        return content;
      }
      if (!entries.includes(content.value)) {
        entries.push(content.value);
      }
      continue;
    }

    const oldText = validateText(operationNumber, operation.action, "oldText", operation.oldText);
    if (!oldText.ok) {
      return oldText;
    }
    const matchingIndexes = entries.flatMap((entry, entryIndex) =>
      entry.includes(oldText.value) ? [entryIndex] : [],
    );
    if (matchingIndexes.length !== 1) {
      return invalidMatch(operationNumber, operation.action, oldText.value, matchingIndexes.length);
    }

    const matchingIndex = matchingIndexes[0];
    if (matchingIndex === undefined) {
      return invalidMatch(operationNumber, operation.action, oldText.value, 0);
    }

    if (operation.action === "remove") {
      entries.splice(matchingIndex, 1);
      continue;
    }

    const content = validateText(operationNumber, operation.action, "content", operation.content);
    if (!content.ok) {
      return content;
    }
    entries[matchingIndex] = content.value;
  }

  const content = serializeMemoryEntries(entries);
  const used = codePointLength(content);
  if (used > cap) {
    return memoryOperationFailure(
      new MemoryFull({
        used,
        cap,
        message: `memory full: ${used}/${cap} code points — consolidate or remove entries first`,
      }),
    );
  }

  return { ok: true, content, changed: content === initialContent ? false : true };
};

export const memoryCap = (scope: MemoryScope): number =>
  scope === "shared" ? SHARED_MEMORY_CAP : CONTEXT_MEMORY_CAP;

export const sanitizeMemoryId = (
  kind: "user" | "group",
  id: string,
):
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: MemoryIdInvalid } => {
  const sanitized = id.toLowerCase();
  if (validMemoryId.test(sanitized)) {
    return { ok: true, id: sanitized };
  }

  return {
    ok: false,
    error: new MemoryIdInvalid({
      kind,
      id,
      message: `invalid ${kind} memory id: use 1-64 characters from [a-z0-9._-]`,
    }),
  };
};

const memoryDocument = (
  profilePath: string,
  scope: MemoryScope,
  relativePath: string,
  heading: string,
): MemoryDocument => ({
  scope,
  relativePath,
  absolutePath: path.join(profilePath, relativePath),
  cap: memoryCap(scope),
  heading,
});

export const memoryFilePaths = (
  profilePath: string,
  context: ChatContext,
): MemoryDocumentsResult => {
  const shared = memoryDocument(profilePath, "shared", "MEMORY.md", "## Memory (shared)");

  if (context.kind === "local") {
    return {
      ok: true,
      documents: [
        shared,
        memoryDocument(
          profilePath,
          "person",
          path.join("memory", "users", "owner.md"),
          "## Memory (this person)",
        ),
      ],
    };
  }

  const kind = context.kind === "user" ? "user" : "group";
  const id = context.kind === "user" ? context.userId : context.groupId;
  const sanitized = sanitizeMemoryId(kind, id);
  if (!sanitized.ok) {
    return sanitized;
  }

  return {
    ok: true,
    documents: [
      shared,
      memoryDocument(
        profilePath,
        context.kind === "user" ? "person" : "group",
        path.join("memory", context.kind === "user" ? "users" : "groups", `${sanitized.id}.md`),
        context.kind === "user" ? "## Memory (this person)" : "## Memory (this group)",
      ),
    ],
  };
};
