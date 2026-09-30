import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";
import { Type } from "typebox";
import { runCallback } from "../platform/callback";
import { codePointLength } from "../platform/text";
import type { ChatContext, SessionPrompt, SessionTools } from "../session";
import { updateDocument, viewDocument } from "./memory";
import {
  documentsFor,
  renderMemoryForPrompt,
  type MemoryDocument,
  type MemoryScope,
} from "./types";

const memoryWriteParameters = Type.Object({
  scope: Type.Union([Type.Literal("shared"), Type.Literal("person"), Type.Literal("group")]),
  operations: Type.Array(
    Type.Union([
      Type.Object({ action: Type.Literal("add"), content: Type.String() }),
      Type.Object({
        action: Type.Literal("replace"),
        oldText: Type.String(),
        content: Type.String(),
      }),
      Type.Object({ action: Type.Literal("remove"), oldText: Type.String() }),
    ]),
  ),
});

const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

/** The document `scope` names in this conversation, or why it cannot be written here. */
const writable = (
  profilePath: string,
  context: ChatContext,
  scope: MemoryScope,
): Result.Result<MemoryDocument, string> => {
  if (scope === "person" && context.kind === "group") {
    return Result.fail("person memory is not writable in group chats");
  }

  if (scope === "group" && context.kind !== "group") {
    return Result.fail("group memory is not writable in 1:1 chats");
  }

  return documentsFor(profilePath, context).pipe(
    Result.mapError((invalid) => invalid.message),
    Result.flatMap((documents) => {
      const document = documents.find((candidate) => candidate.scope === scope);

      return document === undefined
        ? Result.fail(`${scope} memory is not available in this chat`)
        : Result.succeed(document);
    }),
  );
};

export const createMemoryWriteTool = (
  profilePath: string,
  context: ChatContext,
): ToolDefinition<typeof memoryWriteParameters> => ({
  name: "memory_write",
  label: "memory_write",
  description:
    "Apply an all-or-nothing batch of entry-based add, replace, or remove operations to curated memory. Use shared for assistant-wide facts (2200 code points), person for the current 1:1 person (1375), or group for the current group (1375). Add is idempotent; replace/remove oldText must match exactly one entry. Person memory is unavailable in groups; group memory is unavailable in 1:1 chats.",
  parameters: memoryWriteParameters,
  execute(_toolCallId, { scope, operations }, signal) {
    const target = writable(profilePath, context, scope);

    if (Result.isFailure(target)) return Promise.resolve(toolResult(`ERROR: ${target.failure}`));

    const document = target.success;

    const program = updateDocument(profilePath, document, operations).pipe(
      Effect.map((applied) =>
        !applied.ok
          ? `ERROR: ${applied.message}`
          : !applied.changed
            ? "no change"
            : `applied ${operations.length} operation(s); ${codePointLength(applied.content)}/${document.cap} code points in ${document.relativePath}`,
      ),
      Effect.catch((failure) =>
        Effect.logWarning("memory_write failed", failure).pipe(
          Effect.as(
            failure._tag === "MemoryFileError" && failure.operation === "backup"
              ? "ERROR: memory backup failed"
              : failure._tag === "MemoryFileError" && failure.operation === "read"
                ? "ERROR: memory read failed"
                : "ERROR: memory write failed",
          ),
        ),
      ),
      Effect.map(toolResult),
    );

    return runCallback(program, signal);
  },
});

/** Contributes `memory_write` to every Profile session. */
export const memoryTools: SessionTools = ({ profilePath, context }) => [
  createMemoryWriteTool(profilePath, context),
];

const oneLine = (message: string): string => message.replace(/\s+/gu, " ").trim();

/** The conversation's memory, reread before every turn; a failure tells the model, not the user. */
export const memoryPrompt: SessionPrompt = ({ profilePath, context }) =>
  Effect.fromResult(documentsFor(profilePath, context)).pipe(
    Effect.flatMap((documents) =>
      Effect.forEach(documents, (document) => viewDocument(profilePath, document)),
    ),
    Effect.map((views) =>
      [
        ...views.flatMap((view) =>
          view.entries.length === 0
            ? []
            : [`${view.document.heading}\n${renderMemoryForPrompt(view.content)}`],
        ),
        "Durable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
      ].join("\n\n"),
    ),
    Effect.catch((failure) =>
      Effect.succeed(
        [
          "PROFILE MEMORY UNAVAILABLE FOR THIS TURN.",
          `Ziggy could not read the Profile memory under ${profilePath}: ${oneLine(failure.message)}`,
          "Do not claim to remember Profile facts or call memory_write this turn. Tell the user that Profile memory is unavailable.",
        ].join("\n"),
      ),
    ),
  );
