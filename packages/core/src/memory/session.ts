import type { FrozenSessionSnapshot, FrozenTool } from "@ziggy/protocol";
import type { FilesystemWorld } from "../world/filesystem.ts";

export interface OpenSessionOptions {
  readonly world: FilesystemWorld;
  readonly sessionId: string;
  readonly baseSystemPrompt: string;
  readonly tools: ReadonlyArray<FrozenTool>;
}

const sessionGates = new WeakMap<FilesystemWorld, Map<string, Promise<void>>>();

export async function openSession(options: OpenSessionOptions): Promise<FrozenSessionSnapshot> {
  const tools = structuredClone(options.tools);
  return withSessionGate(options.world, options.sessionId, async () => {
    const existing = await options.world.readSession(options.sessionId, 0);
    if (existing.length > 0) {
      const started = existing.filter((envelope) => envelope.event.type === "session-started");
      if (started.length !== 1) {
        throw new Error(
          `Session ${options.sessionId} must contain exactly one session-started snapshot.`,
        );
      }
      const first = existing[0];
      if (first === undefined || first.event.type !== "session-started") {
        throw new Error(`Session ${options.sessionId} does not start with session-started.`);
      }
      return first.event.snapshot;
    }

    const memory = await options.world.readMemoryBatch(["MEMORY.md", "USER.md"]);
    const snapshot: FrozenSessionSnapshot = {
      systemPrompt: assembleSystemPrompt(
        options.baseSystemPrompt,
        memory["MEMORY.md"] ?? "",
        memory["USER.md"] ?? "",
      ),
      tools,
    };
    const persisted = await options.world.appendSession(options.sessionId, {
      type: "session-started",
      sessionId: options.sessionId,
      snapshot,
    });
    if (persisted.event.type !== "session-started") {
      throw new Error(`Session ${options.sessionId} persisted an unexpected start event.`);
    }
    return persisted.event.snapshot;
  });
}

function assembleSystemPrompt(base: string, memory: string, user: string): string {
  return `${base}\n\n<memory>${memory}</memory>\n\n<user>${user}</user>`;
}

async function withSessionGate<Value>(
  world: FilesystemWorld,
  sessionId: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  let worldGates = sessionGates.get(world);
  if (worldGates === undefined) {
    worldGates = new Map<string, Promise<void>>();
    sessionGates.set(world, worldGates);
  }
  const predecessor = worldGates.get(sessionId) ?? Promise.resolve();
  const completion = Promise.withResolvers<void>();
  const tail = predecessor.then(() => completion.promise);
  worldGates.set(sessionId, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    completion.resolve();
    if (worldGates.get(sessionId) === tail) {
      worldGates.delete(sessionId);
    }
  }
}
