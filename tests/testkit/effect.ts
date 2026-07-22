import { Effect, Fiber, Scope } from "effect";

/** The single Promise bridge used by Bun tests for environment-free Effects. */
export function runEffect<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program);
}

/** Runs a scoped program and verifies every finalizer before the Bun test completes. */
export function runScopedEffect<A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(program));
}

/** Starts an environment-free Effect so a Bun test can exercise interruption explicitly. */
export function forkEffect<A, E>(program: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
  return Effect.runFork(program);
}
