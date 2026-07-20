import type { FrozenSessionSnapshot, FrozenTool } from "@ziggy/protocol";
import type { FilesystemWorld } from "../world/filesystem.ts";

export interface OpenSessionOptions {
  readonly world: FilesystemWorld;
  readonly sessionId: string;
  readonly baseSystemPrompt: string;
  readonly tools: ReadonlyArray<FrozenTool>;
}

export async function openSession(options: OpenSessionOptions): Promise<FrozenSessionSnapshot> {
  const persisted = await options.world.readSessionSnapshot(options.sessionId);
  if (persisted !== undefined) {
    return persisted;
  }

  const memory = await options.world.readMemoryBatch(["MEMORY.md", "USER.md"]);
  const snapshot: FrozenSessionSnapshot = {
    systemPrompt: assembleSystemPrompt(
      options.baseSystemPrompt,
      memory["MEMORY.md"] ?? "",
      memory["USER.md"] ?? "",
    ),
    tools: structuredClone(options.tools),
  };
  const started = await options.world.startSession(options.sessionId, snapshot);
  return started.snapshot;
}

function assembleSystemPrompt(base: string, memory: string, user: string): string {
  return `${base}\n\n<memory>${memory}</memory>\n\n<user>${user}</user>`;
}
