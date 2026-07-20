import type { SessionEnvelope, SessionSummary } from "@ziggy/protocol";
import type { SessionRuntime, SessionWorld } from "../agent/runtime.ts";
import { acquireProfileLock, type AcquireProfileLockOptions } from "./profile-lock.ts";
import { reconcileSession, scanSessionLifecycle } from "./reconciliation.ts";
import { createSessionRegistry, type RegisteredSessionRuntime } from "./registry.ts";

export interface DaemonWorld extends SessionWorld {
  listSessions(): Promise<ReadonlyArray<{ readonly sessionId: string; readonly lastSeq: number }>>;
}

export interface CreateDaemonKernelOptions<World extends DaemonWorld = DaemonWorld> {
  readonly profilePath: string;
  readonly createWorld: (canonicalProfilePath: string) => World;
  readonly createRuntime: (sessionId: string, world: World) => Promise<SessionRuntime>;
  readonly lock?: Omit<AcquireProfileLockOptions, "profilePath">;
}

export interface DaemonKernel {
  readonly profilePath: string;
  getOrCreateSession(sessionId: string): Promise<RegisteredSessionRuntime>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | undefined>;
  listSessions(): Promise<ReadonlyArray<SessionSummary>>;
  close(): Promise<void>;
}

export async function createDaemonKernel<World extends DaemonWorld>(
  options: CreateDaemonKernelOptions<World>,
): Promise<DaemonKernel> {
  const lock = await acquireProfileLock({ profilePath: options.profilePath, ...options.lock });
  let world: World;
  try {
    world = options.createWorld(lock.profilePath);
  } catch (error) {
    await lock.close();
    throw error;
  }
  const registry = createSessionRegistry(async (sessionId) => {
    await reconcileSession(world, sessionId);
    return options.createRuntime(sessionId, world);
  });
  let closing: Promise<void> | undefined;
  return {
    profilePath: lock.profilePath,
    getOrCreateSession: (sessionId) => registry.getOrCreate(sessionId),
    async getSessionSummary(sessionId) {
      return summarizeSession(await world.readSession(sessionId, 0));
    },
    async listSessions() {
      const stored = await world.listSessions();
      const summaries: SessionSummary[] = [];
      for (const session of stored) {
        const summary = summarizeSession(await world.readSession(session.sessionId, 0));
        if (summary === undefined) {
          throw new Error(`Session list references missing Session ${session.sessionId}`);
        }
        summaries.push(summary);
      }
      return summaries;
    },
    close() {
      if (closing === undefined) {
        closing = registry.close().then(
          () => lock.close(),
          async (error) => {
            await lock.close();
            throw error;
          },
        );
      }
      return closing;
    },
  };
}

function summarizeSession(envelopes: ReadonlyArray<SessionEnvelope>): SessionSummary | undefined {
  const first = envelopes[0];
  if (first === undefined) return undefined;
  if (first.event.type !== "session-started") {
    throw new Error("Session does not begin with session-started");
  }
  const last = envelopes.at(-1);
  if (last === undefined) {
    throw new Error("Session lost its first envelope");
  }
  const activeTurnId = scanSessionLifecycle(envelopes).turnId;
  return {
    sessionId: first.event.sessionId,
    createdAt: first.emittedAt,
    lastSeq: last.seq,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
  };
}
