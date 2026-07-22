import { Effect } from "effect";

declare const program: Effect.Effect<void, { readonly _tag: "Failure" }>;

export const ignored = Effect.ignore(program);
export const defect = program.pipe(Effect.orDie);
