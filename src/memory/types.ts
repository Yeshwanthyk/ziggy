import { join } from "node:path";
import { Result, Schema } from "effect";
import { codePointLength } from "../platform/text";
import type { ChatContext } from "../session";

export const SHARED_MEMORY_CAP = 2_200;

export const CONTEXT_MEMORY_CAP = 1_375;

export const MEMORY_ENTRY_DELIMITER = "\n§\n";

export type MemoryScope = "shared" | "person" | "group";

const validMemoryId = /^[a-z0-9._-]{1,64}$/;

/** The CLI spelling for a memory document. This is decoded at the CLI boundary. */
export const MemoryScopeReference = Schema.String.check(
  Schema.makeFilter(
    (value) => value === "shared" || /^(?:user|group):[A-Za-z0-9._-]{1,64}$/u.test(value),
    { expected: "shared, user:<id>, or group:<id>" },
  ),
);

export type MemoryScopeReference = typeof MemoryScopeReference.Type;

export type MemoryScopeSelection =
  | { readonly scope: "shared" }
  | { readonly scope: "person"; readonly id: string }
  | { readonly scope: "group"; readonly id: string };

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

/** A memory path is a symlink, or a file or directory of the wrong kind. */
export class MemoryDocumentInvalid extends Schema.TaggedErrorClass<MemoryDocumentInvalid>()(
  "MemoryDocumentInvalid",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The filesystem failed while reading, locking, backing up or writing memory. */
export class MemoryFileError extends Schema.TaggedErrorClass<MemoryFileError>()("MemoryFileError", {
  operation: Schema.Literals(["list", "read", "lock", "backup", "write"]),
  path: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class MemoryIdInvalid extends Schema.TaggedErrorClass<MemoryIdInvalid>()("MemoryIdInvalid", {
  kind: Schema.Literals(["user", "group"]),
  id: Schema.String,
  message: Schema.String,
}) {}

export type MemoryError = MemoryDocumentInvalid | MemoryFileError | MemoryIdInvalid;

// The scope table: where each scope lives, its prompt heading and its cap.
const SCOPES = {
  shared: { directory: undefined, heading: "## Memory (shared)", cap: SHARED_MEMORY_CAP },
  person: { directory: "users", heading: "## Memory (this person)", cap: CONTEXT_MEMORY_CAP },
  group: { directory: "groups", heading: "## Memory (this group)", cap: CONTEXT_MEMORY_CAP },
} as const;

const document = (profilePath: string, selection: MemoryScopeSelection): MemoryDocument => {
  const { directory, heading, cap } = SCOPES[selection.scope];

  const relativePath =
    selection.scope === "shared" || directory === undefined
      ? "MEMORY.md"
      : join("memory", directory, `${selection.id}.md`);

  return {
    scope: selection.scope,
    relativePath,
    absolutePath: join(profilePath, relativePath),
    cap,
    heading,
  };
};

const memoryId = (kind: "user" | "group", id: string): Result.Result<string, MemoryIdInvalid> => {
  const lowered = id.toLowerCase();

  return validMemoryId.test(lowered)
    ? Result.succeed(lowered)
    : Result.fail(
        new MemoryIdInvalid({
          kind,
          id,
          message: `invalid ${kind} memory id: use 1-64 characters from [a-z0-9._-]`,
        }),
      );
};

export const documentForScope = (
  profilePath: string,
  selection: MemoryScopeSelection,
): Result.Result<MemoryDocument, MemoryIdInvalid> =>
  selection.scope === "shared"
    ? Result.succeed(document(profilePath, selection))
    : Result.map(memoryId(selection.scope === "person" ? "user" : "group", selection.id), (id) =>
        document(profilePath, { scope: selection.scope, id }),
      );

/** The document at a Profile-relative path, when it is one memory admits. */
export const documentFromRelativePath = (
  profilePath: string,
  relativePath: string,
): MemoryDocument | undefined => {
  if (relativePath === "MEMORY.md") return document(profilePath, { scope: "shared" });

  const match = /^memory[\\/](users|groups)[\\/]([^\\/]+)\.md$/u.exec(relativePath);
  const id = match?.[2];

  if (id === undefined || !validMemoryId.test(id)) return undefined;

  return document(profilePath, { scope: match?.[1] === "users" ? "person" : "group", id });
};

/** The documents a conversation sees: shared, plus the person or group it is with. */
export const documentsFor = (
  profilePath: string,
  context: ChatContext,
): Result.Result<ReadonlyArray<MemoryDocument>, MemoryIdInvalid> => {
  const shared = document(profilePath, { scope: "shared" });

  const own =
    context.kind === "local"
      ? documentForScope(profilePath, { scope: "person", id: "owner" })
      : context.kind === "user"
        ? documentForScope(profilePath, { scope: "person", id: context.userId })
        : documentForScope(profilePath, { scope: "group", id: context.groupId });

  return Result.map(own, (scoped) => [shared, scoped]);
};

export const parseMemoryScopeReference = (
  reference: MemoryScopeReference,
): MemoryScopeSelection => {
  if (reference === "shared") return { scope: "shared" };
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const id = reference.slice(separator + 1).toLowerCase();

  return kind === "user" ? { scope: "person", id } : { scope: "group", id };
};

export const memoryEntries = (content: string): ReadonlyArray<string> => {
  const normalized = content.trim();

  return normalized.length === 0 ? [] : normalized.split(MEMORY_ENTRY_DELIMITER);
};

const serializeMemoryEntries = (entries: ReadonlyArray<string>): string =>
  entries.length === 0 ? "" : `${entries.join(MEMORY_ENTRY_DELIMITER)}\n`;

export const renderMemoryForPrompt = (content: string): string =>
  memoryEntries(content).join("\n\n");

interface Rejected {
  readonly ok: false;
  readonly message: string;
}

export type ApplyMemoryOperationsResult =
  | { readonly ok: true; readonly content: string; readonly changed: boolean }
  | Rejected;

const rejected = (message: string): Rejected => ({ ok: false, message });

const validText = (
  operation: number,
  action: MemoryOperation["action"],
  field: "content" | "oldText",
  value: string,
): { readonly ok: true; readonly value: string } | Rejected => {
  const trimmed = value.trim();
  const prefix = `operation ${operation} (${action}) rejected:`;

  if (trimmed.length === 0) return rejected(`${prefix} ${field} must be non-empty after trimming`);

  if (field === "content" && trimmed.includes(MEMORY_ENTRY_DELIMITER)) {
    return rejected(`${prefix} content must not contain the memory entry delimiter`);
  }

  return { ok: true, value: trimmed };
};

/** Apply a batch all-or-nothing: the first invalid operation or an over-cap result rejects it. */
export const applyMemoryOperations = (
  initialContent: string,
  operations: ReadonlyArray<MemoryOperation>,
  cap: number,
): ApplyMemoryOperationsResult => {
  const entries = [...memoryEntries(initialContent)];

  for (const [index, operation] of operations.entries()) {
    const number = index + 1;

    if (operation.action === "add") {
      const content = validText(number, operation.action, "content", operation.content);

      if (!content.ok) return content;

      if (!entries.includes(content.value)) entries.push(content.value);

      continue;
    }

    const oldText = validText(number, operation.action, "oldText", operation.oldText);

    if (!oldText.ok) return oldText;

    const matches = entries.flatMap((entry, entryIndex) =>
      entry.includes(oldText.value) ? [entryIndex] : [],
    );

    const match = matches[0];

    if (matches.length !== 1 || match === undefined) {
      return rejected(
        `operation ${number} (${operation.action}) matched ${matches.length} entries for oldText; use text that identifies exactly one entry`,
      );
    }

    if (operation.action === "remove") {
      entries.splice(match, 1);
      continue;
    }

    const content = validText(number, operation.action, "content", operation.content);

    if (!content.ok) return content;

    entries[match] = content.value;
  }

  const content = serializeMemoryEntries(entries);
  const used = codePointLength(content);

  if (used > cap) {
    return rejected(
      `memory full: ${used}/${cap} code points — consolidate or remove entries first`,
    );
  }

  return { ok: true, content, changed: content !== initialContent };
};
