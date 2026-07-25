import * as path from "node:path";
import { Schema } from "effect";

export const SHARED_MEMORY_CAP = 2_200;
export const CONTEXT_MEMORY_CAP = 1_375;

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

export class MemoryIdInvalid extends Schema.TaggedErrorClass<MemoryIdInvalid>()("MemoryIdInvalid", {
  kind: Schema.Literals(["user", "group"]),
  id: Schema.String,
  message: Schema.String,
}) {}

export type MemoryDocumentsResult =
  | { readonly ok: true; readonly documents: ReadonlyArray<MemoryDocument> }
  | { readonly ok: false; readonly error: MemoryIdInvalid };

const validMemoryId = /^[a-z0-9._-]{1,64}$/;

export const codePointLength = (value: string): number => [...value].length;

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
