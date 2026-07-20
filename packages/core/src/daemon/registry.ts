import type { SessionRuntime } from "../agent/runtime.ts";

export type RegisteredSessionRuntime = Omit<SessionRuntime, "close">;
export type SessionRuntimeFactory = (sessionId: string) => Promise<SessionRuntime>;

export interface SessionRegistry {
  getOrCreate(sessionId: string): Promise<RegisteredSessionRuntime>;
  close(): Promise<void>;
}

export function createSessionRegistry(factory: SessionRuntimeFactory): SessionRegistry {
  const entries = new Map<string, Promise<SessionRuntime>>();
  let closing: Promise<void> | undefined;
  let stopped = false;

  return {
    async getOrCreate(sessionId) {
      if (stopped) throw new Error("Session registry is closed");
      const existing = entries.get(sessionId);
      if (existing !== undefined) return facade(await existing);
      const pending = factory(sessionId);
      entries.set(sessionId, pending);
      try {
        return facade(await pending);
      } catch (error) {
        if (entries.get(sessionId) === pending) entries.delete(sessionId);
        throw error;
      }
    },
    close() {
      if (closing !== undefined) return closing;
      stopped = true;
      closing = (async () => {
        const pending = [...entries.values()];
        const creations = await Promise.allSettled(pending);
        const runtimes = creations.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const closures = await Promise.allSettled(runtimes.map(async (runtime) => runtime.close()));
        entries.clear();
        const failures = closures.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to close Session runtimes");
        }
      })();
      return closing;
    },
  };
}

function facade(runtime: SessionRuntime): RegisteredSessionRuntime {
  return {
    startTurn: (input) => runtime.startTurn(input),
    steer: (input) => runtime.steer(input),
    interrupt: (input) => runtime.interrupt(input),
    waitForIdle: () => runtime.waitForIdle(),
    subscribe: (input) => runtime.subscribe(input),
  };
}
