import type { FrozenSessionSnapshot, FrozenTool } from "@ziggy/protocol";
import { Effect } from "effect";
import type { FilesystemWorld, FilesystemWorldError } from "../world/filesystem.ts";

export interface OpenSessionOptions {
  readonly world: FilesystemWorld;
  readonly sessionId: string;
  readonly baseSystemPrompt: string;
  readonly tools: ReadonlyArray<FrozenTool>;
}

export function openSession(
  options: OpenSessionOptions,
): Effect.Effect<FrozenSessionSnapshot, FilesystemWorldError> {
  return Effect.gen(function* () {
    const persisted = yield* options.world.readSessionSnapshot(options.sessionId);
    if (persisted !== undefined) {
      return persisted;
    }

    const memory = yield* options.world.readMemoryBatch(["MEMORY.md", "USER.md"]);
    const snapshot: FrozenSessionSnapshot = {
      systemPrompt: assembleSystemPrompt(
        options.baseSystemPrompt,
        memory["MEMORY.md"] ?? "",
        memory["USER.md"] ?? "",
      ),
      tools: structuredClone(options.tools),
    };
    const started = yield* options.world.startSession(options.sessionId, snapshot);
    return started.snapshot;
  });
}

function assembleSystemPrompt(base: string, memory: string, user: string): string {
  return `${base}\n\n<memory>${memory}</memory>\n\n<user>${user}</user>`;
}
