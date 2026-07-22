import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProfileLock } from "../../packages/core/src/index.ts";
import { BunProcessManager } from "../../packages/ziggy/src/bun-process-node-adapter.ts";
import {
  probeDaemon,
  type DaemonProbeResult,
  type DoctorReport,
} from "../../packages/ziggy/src/daemon.ts";
import type { CommandResult } from "../../packages/ziggy/src/service.ts";
import { redactString } from "../../tooling/verification/evidence.ts";
import { Effect, Fiber, Schedule, Schema, Scope } from "effect";
import { runEffect, runScopedEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

afterAll(() => {
  emitVerificationObservation("s3.compiled-daemon-lifecycle", emptyRuntimeObservations());
});

const repositoryRoot = join(import.meta.dir, "..", "..");
const processManager = new BunProcessManager();
const compileTimeoutMs = 120_000;
const commandTimeoutMs = 10_000;
const stderrCaptureLimit = 2_048;
const stderrDiagnosticLimit = 256;

const DoctorReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profilePath: Schema.String,
  healthy: Schema.Boolean,
  checks: Schema.Struct({
    daemon: Schema.Struct({
      status: Schema.Literals(["ok", "warning", "error"]),
      detail: Schema.String,
    }),
    socket: Schema.Struct({
      status: Schema.Literals(["ok", "warning", "error"]),
      detail: Schema.String,
    }),
    profileLock: Schema.Struct({
      status: Schema.Literals(["ok", "warning", "error"]),
      detail: Schema.String,
    }),
    providerAuth: Schema.Struct({
      status: Schema.Literals(["ok", "warning", "error"]),
      detail: Schema.String,
    }),
  }),
});
const decodeDoctorReport = Schema.decodeUnknownEffect(Schema.fromJsonString(DoctorReportSchema));

class CompiledLifecycleError extends Schema.TaggedErrorClass<CompiledLifecycleError>()(
  "CompiledLifecycleError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface CompiledLifecycleEvidence {
  readonly doctor: DoctorReport;
  readonly ready: DaemonProbeResult;
  readonly stopped: DaemonProbeResult;
  readonly lock: { readonly state: "absent" };
}

test("compiled binary owns the complete foreground daemon lifecycle", async () => {
  const evidence = await runScopedEffect(compiledLifecycle);

  expect(evidence.doctor.healthy).toBeTrue();
  expect(evidence.doctor.checks.daemon.status).toBe("ok");
  expect(evidence.ready).toMatchObject({ status: "ready", protocolVersion: 2 });
  expect(evidence.stopped).toMatchObject({ status: "unavailable", socketState: "absent" });
  expect(evidence.lock).toEqual({ state: "absent" });
});

// oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: the Bun test callback executes the Effect only through runEffect
test("compiled lifecycle rejects an unexpected foreground daemon shutdown exit", async () => {
  const stderr = `token=private\n${join(tmpdir(), "private-profile")}\n${"x".repeat(1_000)}`;
  const failure = await runEffect(
    Effect.flip(requireExpectedServeExit({ exitCode: 17, stderr }, 130)),
  );

  expect(failure).toBeInstanceOf(CompiledLifecycleError);
  expect(failure.operation).toBe("stop-serve");
  expect(failure.message).toContain("unexpected code 17 (expected 130)");
  expect(failure.message).toContain("<redacted>");
  expect(failure.message).toContain("<redacted:path>");
  expect(failure.message).not.toContain("private");
  expect(failure.message.length).toBeLessThanOrEqual(340);
});

const compiledLifecycle = Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const executable = join(directory, "ziggy");
  const profilePath = join(directory, "profile");

  yield* runCommand(
    ["bun", "build", "--compile", "packages/ziggy/src/main.ts", "--outfile", executable],
    compileTimeoutMs,
    "compile",
  );
  yield* runCommand(
    [executable, "init", profilePath, "--voice", "operator"],
    commandTimeoutMs,
    "init",
  );

  const child = yield* acquireServeProcess(executable, profilePath);
  const stderrFiber = yield* Effect.forkScoped(captureServeStderr(child));
  const doctor = yield* awaitHealthyDoctor(executable, profilePath);
  const ready = yield* probeDaemon({ profilePath });
  const exitCode = yield* stopServeProcess(child);
  const stderr = yield* Fiber.join(stderrFiber);
  yield* requireExpectedServeExit({ exitCode, stderr }, 130);
  const stopped = yield* probeDaemon({ profilePath });
  const lock = yield* inspectProfileLock({ profilePath });

  if (lock.state !== "absent") {
    return yield* new CompiledLifecycleError({
      operation: "verify-cleanup",
      message: "compiled daemon left its Profile lock behind",
    });
  }
  return { doctor, ready, stopped, lock };
});

const temporaryDirectory = Effect.acquireRelease(
  tryNode("create temporary directory", () => mkdtemp(join(tmpdir(), "ziggy-compiled-e2e-"))),
  (directory) =>
    tryNode("remove temporary directory", () =>
      rm(directory, { recursive: true, force: true }),
    ).pipe(
      Effect.catch((error) => Effect.logError("Failed to remove compiled E2E directory", error)),
    ),
);

function runCommand(
  argv: ReadonlyArray<string>,
  timeoutMs: number,
  operation: string,
): Effect.Effect<CommandResult, CompiledLifecycleError> {
  return processManager.run(argv, timeoutMs).pipe(
    Effect.mapError(
      (cause) =>
        new CompiledLifecycleError({
          operation,
          message: `${operation} command failed`,
          cause,
        }),
    ),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new CompiledLifecycleError({
              operation,
              message: `${operation} command failed (${result.exitCode}): ${result.stderr}`,
            }),
          ),
    ),
  );
}

function awaitHealthyDoctor(
  executable: string,
  profilePath: string,
): Effect.Effect<DoctorReport, CompiledLifecycleError> {
  const attempt = runCommand(
    [executable, "doctor", "--profile", profilePath],
    commandTimeoutMs,
    "doctor",
  ).pipe(
    Effect.flatMap((result) =>
      decodeDoctorReport(result.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new CompiledLifecycleError({
              operation: "doctor",
              message: "compiled doctor emitted an invalid report",
              cause,
            }),
        ),
      ),
    ),
    Effect.flatMap((report) =>
      report.healthy
        ? Effect.succeed(report)
        : Effect.fail(
            new CompiledLifecycleError({
              operation: "doctor-readiness",
              message: "compiled daemon is not ready yet",
            }),
          ),
    ),
  );
  return attempt.pipe(
    Effect.retry(Schedule.max([Schedule.spaced("20 millis"), Schedule.recurs(200)])),
  );
}

interface ServeProcess {
  readonly exitCode: number | null;
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: Bun exposes subprocess completion only as a Promise, immediately wrapped by awaitServeExit
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: number | NodeJS.Signals): void;
}

function acquireServeProcess(
  executable: string,
  profilePath: string,
): Effect.Effect<ServeProcess, CompiledLifecycleError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([executable, "serve", "--profile", profilePath], {
          cwd: repositoryRoot,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }),
      catch: (cause) =>
        new CompiledLifecycleError({
          operation: "serve",
          message: "failed to start compiled foreground daemon",
          cause,
        }),
    }),
    (child) =>
      emergencyStop(child).pipe(
        Effect.catch((error) => Effect.logError("Failed to stop compiled E2E daemon", error)),
      ),
  );
}

interface ServeExitResult {
  readonly exitCode: number;
  readonly stderr: string;
}

function requireExpectedServeExit(
  { exitCode, stderr }: ServeExitResult,
  expectedExitCode: number,
): Effect.Effect<void, CompiledLifecycleError> {
  if (exitCode === expectedExitCode) return Effect.void;
  return Effect.try({
    try: () => boundedServeDiagnostic(stderr),
    catch: () =>
      new CompiledLifecycleError({
        operation: "stop-serve",
        message: `compiled foreground daemon exited with unexpected code ${exitCode} (expected ${expectedExitCode}); stderr: <redacted>`,
      }),
  }).pipe(
    Effect.flatMap((diagnostic) =>
      Effect.fail(
        new CompiledLifecycleError({
          operation: "stop-serve",
          message: `compiled foreground daemon exited with unexpected code ${exitCode} (expected ${expectedExitCode}); stderr: ${diagnostic}`,
        }),
      ),
    ),
  );
}

function boundedServeDiagnostic(stderr: string): string {
  const redacted = redactString(stderr, repositoryRoot)
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`]+/g, "<redacted:path>")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length === 0) return "<empty>";
  return redacted.slice(0, stderrDiagnosticLimit);
}

function captureServeStderr(child: ServeProcess): Effect.Effect<string, CompiledLifecycleError> {
  // oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: this named Bun stream adapter drains the vendor Promise API while retaining only bounded stderr
  return Effect.tryPromise({
    try: async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      let captured = "";
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (captured.length < stderrCaptureLimit) {
          captured = `${captured}${decoder.decode(result.value, { stream: true })}`.slice(
            0,
            stderrCaptureLimit,
          );
        }
      }
      return `${captured}${decoder.decode()}`.slice(0, stderrCaptureLimit);
    },
    catch: (cause) =>
      new CompiledLifecycleError({
        operation: "read-serve-stderr",
        message: "failed to capture compiled foreground daemon stderr",
        cause,
      }),
  });
  // oxlint-enable ziggy-effect/no-native-promise-ownership
}

function stopServeProcess(child: ServeProcess): Effect.Effect<number, CompiledLifecycleError> {
  return Effect.gen(function* () {
    if (child.exitCode !== null) return child.exitCode;
    yield* Effect.try({
      try: () => child.kill("SIGTERM"),
      catch: (cause) =>
        new CompiledLifecycleError({
          operation: "stop-serve",
          message: "failed to signal compiled foreground daemon",
          cause,
        }),
    });
    return yield* awaitServeExit(child).pipe(
      Effect.timeoutOrElse({
        duration: commandTimeoutMs,
        orElse: () =>
          Effect.fail(
            new CompiledLifecycleError({
              operation: "stop-serve",
              message: "compiled foreground daemon did not stop before the deadline",
            }),
          ),
      }),
    );
  });
}

function emergencyStop(child: ServeProcess): Effect.Effect<void, CompiledLifecycleError> {
  if (child.exitCode !== null) return Effect.void;
  return Effect.try({
    try: () => child.kill("SIGKILL"),
    catch: (cause) =>
      new CompiledLifecycleError({
        operation: "emergency-stop-serve",
        message: "failed to kill compiled foreground daemon",
        cause,
      }),
  });
}

function awaitServeExit(child: ServeProcess): Effect.Effect<number, CompiledLifecycleError> {
  return Effect.tryPromise({
    try: () => child.exited,
    catch: (cause) =>
      new CompiledLifecycleError({
        operation: "wait-for-serve",
        message: "failed while waiting for compiled foreground daemon",
        cause,
      }),
  });
}

function tryNode<A>(
  operation: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: this named Node adapter immediately translates the host Promise into Effect
  evaluate: () => Promise<A>,
): Effect.Effect<A, CompiledLifecycleError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new CompiledLifecycleError({
        operation,
        message: `failed to ${operation}`,
        cause,
      }),
  });
}
