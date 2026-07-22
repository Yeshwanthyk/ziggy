import { Effect } from "effect";
import { runFork as executeInBackground } from "effect/Effect";

export const execute = Effect.runPromise(Effect.void);
export const fork = executeInBackground(Effect.void);
