import type { Api } from "@earendil-works/pi-ai";
import type { FrozenTool, SessionEnvelope } from "@ziggy/protocol";
import { openSession } from "../memory/session.ts";
import { createMemoryTool } from "../memory/tool.ts";
import type { FilesystemWorld } from "../world/filesystem.ts";
import {
  createSessionRuntime,
  type CreateSessionRuntimeOptions,
  type SessionRuntime,
  type SessionSubscription,
  type SessionTool,
} from "./runtime.ts";

type RuntimeCompositionOptions<TApi extends Api> = Omit<
  CreateSessionRuntimeOptions<TApi>,
  "snapshot" | "tools" | "world"
> & {
  readonly world: FilesystemWorld;
  readonly baseSystemPrompt: string;
  readonly tools: ReadonlyArray<SessionTool>;
};

export type CreateFilesystemSessionRuntimeOptions<TApi extends Api> =
  RuntimeCompositionOptions<TApi>;

export type ResumeFilesystemSessionOptions<TApi extends Api> = RuntimeCompositionOptions<TApi> & {
  readonly sinceSeq: number;
  readonly onEnvelope: (envelope: SessionEnvelope) => void;
};

export interface ResumedFilesystemSession {
  readonly runtime: SessionRuntime;
  readonly subscription: SessionSubscription;
}

export async function createFilesystemSessionRuntime<TApi extends Api>(
  options: CreateFilesystemSessionRuntimeOptions<TApi>,
): Promise<SessionRuntime> {
  const memory = createMemoryTool(options.world);
  const tools: ReadonlyArray<SessionTool> = [memory, ...options.tools];
  requireUniqueToolNames(tools);
  const snapshot = await openSession({
    world: options.world,
    sessionId: options.sessionId,
    baseSystemPrompt: options.baseSystemPrompt,
    tools: freezeTools(tools),
  });
  return createSessionRuntime({
    sessionId: options.sessionId,
    snapshot,
    world: options.world,
    model: options.model,
    streamSimple: options.streamSimple,
    cacheRetention: options.cacheRetention,
    nextTurnId: options.nextTurnId,
    nextStepId: options.nextStepId,
    tools,
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
  });
}

export async function resumeFilesystemSession<TApi extends Api>(
  options: ResumeFilesystemSessionOptions<TApi>,
): Promise<ResumedFilesystemSession> {
  const runtime = await createFilesystemSessionRuntime(options);
  try {
    const subscription = await runtime.subscribe({
      sinceSeq: options.sinceSeq,
      onEnvelope: options.onEnvelope,
    });
    return { runtime, subscription };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

function requireUniqueToolNames(tools: ReadonlyArray<SessionTool>): void {
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length) {
    throw new Error("Filesystem Session tool names must be unique");
  }
}

function freezeTools(tools: ReadonlyArray<SessionTool>): ReadonlyArray<FrozenTool> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
  }));
}
