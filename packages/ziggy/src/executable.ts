import { Effect, Result, Schema } from "effect";

const BUN_COMPILED_MAIN_PREFIX = "/$bunfs/";

export type RuntimeInvocation =
  | {
      readonly kind: "compiled";
      readonly executable: string;
    }
  | {
      readonly kind: "source";
      readonly executable: string;
      readonly entrypoint: string;
    };

export class RuntimeInvocationError extends Schema.TaggedErrorClass<RuntimeInvocationError>()(
  "RuntimeInvocationError",
  { message: Schema.String },
) {}

export function runtimeInvocation(
  main: string,
  executable: string,
): Result.Result<RuntimeInvocation, RuntimeInvocationError> {
  if (main.startsWith(BUN_COMPILED_MAIN_PREFIX)) {
    return Result.succeed({ kind: "compiled", executable });
  }
  if (main.length === 0) {
    return Result.fail(
      new RuntimeInvocationError({ message: "Cannot locate the Ziggy source entry point" }),
    );
  }
  return Result.succeed({ kind: "source", executable, entrypoint: main });
}

export const productionRuntimeInvocation: Effect.Effect<RuntimeInvocation, RuntimeInvocationError> =
  Effect.suspend(() => Effect.fromResult(runtimeInvocation(Bun.main, process.execPath)));

export function serveArgv(runtime: RuntimeInvocation, profilePath: string): ReadonlyArray<string> {
  if (runtime.kind === "compiled") {
    return [runtime.executable, "serve", "--profile", profilePath];
  }
  return [runtime.executable, runtime.entrypoint, "serve", "--profile", profilePath];
}
