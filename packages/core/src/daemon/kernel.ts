import type { SessionRuntime, SessionWorld } from "../agent/runtime.ts";
import { acquireProfileLock, type AcquireProfileLockOptions } from "./profile-lock.ts";
import { reconcileSession } from "./reconciliation.ts";
import { createSessionRegistry, type RegisteredSessionRuntime } from "./registry.ts";

export interface CreateDaemonKernelOptions {
  readonly profilePath: string;
  readonly createWorld: (canonicalProfilePath: string) => SessionWorld;
  readonly createRuntime: (sessionId: string, world: SessionWorld) => Promise<SessionRuntime>;
  readonly lock?: Omit<AcquireProfileLockOptions, "profilePath">;
}

export interface DaemonKernel {
  readonly profilePath: string;
  getOrCreateSession(sessionId: string): Promise<RegisteredSessionRuntime>;
  close(): Promise<void>;
}

export async function createDaemonKernel(
  options: CreateDaemonKernelOptions,
): Promise<DaemonKernel> {
  const lock = await acquireProfileLock({ profilePath: options.profilePath, ...options.lock });
  let world: SessionWorld;
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
