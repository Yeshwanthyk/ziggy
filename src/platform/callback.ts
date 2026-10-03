import { Effect, Logger } from "effect";

/**
 * Run an Effect for a Pi callback that must return a Promise: a tool's `execute`, an event hook,
 * a command. This is the one bridge outside `main.ts`; the signal interrupts the Effect. Logs go to
 * stderr, as they do under `main.ts`, so they never reach an answer on stdout.
 */
export const runCallback = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> =>
  // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- the single Pi callback bridge.
  Effect.runPromise(Effect.provideService(effect, Logger.LogToStderr, true), { signal });
