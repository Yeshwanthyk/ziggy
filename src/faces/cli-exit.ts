import { Effect, Predicate, Runtime, Schema } from "effect";

/** A command failed for a reason the CLI face states itself (resident state, retired aliases). */
export class CliCommandFailed extends Schema.TaggedErrorClass<CliCommandFailed>()(
  "CliCommandFailed",
  { message: Schema.String },
) {}

/**
 * The command already printed its outcome and exits non-zero. `runMain` reads the exit code from
 * `Runtime.errorExitCode` and skips its own report.
 */
export class CliExit extends Schema.TaggedErrorClass<CliExit>()("CliExit", {
  code: Schema.Int,
}) {
  get [Runtime.errorExitCode](): number {
    return this.code;
  }

  readonly [Runtime.errorReported] = false;
}

/** A command's result is its exit code; `void` and 0 succeed. */
export const exitWith = (code: number | void): Effect.Effect<void, CliExit> =>
  Predicate.isNumber(code) && code !== 0 ? Effect.fail(new CliExit({ code })) : Effect.void;
