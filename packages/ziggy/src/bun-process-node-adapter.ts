import { Effect } from "effect";
import { ServiceError, type CommandResult, type ProcessManager } from "./service.ts";

/** The Bun subprocess boundary used by the Effect-owned service lifecycle. */
export class BunProcessManager implements ProcessManager {
  run(argv: ReadonlyArray<string>, timeoutMs: number): Effect.Effect<CommandResult, ServiceError> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Effect.fail(
        new ServiceError({
          operation: "run service command",
          message: "service command timeout must be a positive safe integer",
        }),
      );
    }
    return Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...argv], {
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGKILL",
          }),
        catch: (cause) =>
          new ServiceError({
            operation: "spawn service command",
            message: "failed to spawn service command",
            cause,
          }),
      }),
      (child) =>
        awaitBunProcess(child).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(
                new ServiceError({
                  operation: "run service command",
                  message: `service command timed out after ${timeoutMs}ms`,
                }),
              ),
          }),
        ),
      (child) =>
        child.exitCode === null
          ? Effect.try({
              try: () => child.kill("SIGKILL"),
              catch: (cause) =>
                new ServiceError({
                  operation: "stop service command",
                  message: "failed to stop service command",
                  cause,
                }),
            })
          : Effect.void,
    );
  }
}

function awaitBunProcess(child: {
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: Bun exposes subprocess completion only as a Promise, immediately wrapped below
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
}): Effect.Effect<CommandResult, ServiceError> {
  // oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: this named Bun adapter immediately translates the vendor Promise into Effect
  return Effect.tryPromise({
    try: async () => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
    catch: (cause) =>
      new ServiceError({
        operation: "read service command",
        message: "failed to read service command result",
        cause,
      }),
  });
  // oxlint-enable ziggy-effect/no-native-promise-ownership
}
