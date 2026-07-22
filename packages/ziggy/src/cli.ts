import type { AuthStatus, AuthType } from "@ziggy/protocol";
import { ZIGGY_VERSION } from "@ziggy/core";
import { Cause, Effect, Exit, Option, Predicate, Result, Schema } from "effect";
import { loginProvider, type AuthClientError } from "./auth-client.ts";
import {
  DaemonReadiness,
  ensureProductionDaemonReady,
  probeDaemon,
  runDoctor,
  serveDaemon,
  type DaemonControlError,
  type DoctorReport,
} from "./daemon.ts";
import { productionRuntimeInvocation, type RuntimeInvocationError } from "./executable.ts";
import {
  initializeProfile,
  isVoiceName,
  type ProfileInitializationFailure,
  type ProfileInitializationRequest,
  type ProfileInitializationResult,
  type VoiceName,
} from "./profile-initialization.ts";
import {
  NodeServiceFilesystem,
  createServiceController,
  decodeServicePlatform,
  type ServiceController,
  type ServiceInput,
} from "./service.ts";
import { terminalAuthInteraction, type TerminalAuthError } from "./terminal-auth.ts";
import { BunProcessManager } from "./bun-process-node-adapter.ts";
import {
  runProductionAsk,
  runProductionSessionsList,
  runProductionTui,
  type CliClientError,
  type CliDaemonSetup,
} from "./cli-client.ts";

export { BunProcessManager } from "./bun-process-node-adapter.ts";

export class CliUsageError extends Schema.TaggedErrorClass<CliUsageError>()("CliUsageError", {
  message: Schema.String,
}) {}

export class CliCompositionError extends Schema.TaggedErrorClass<CliCompositionError>()(
  "CliCompositionError",
  { operation: Schema.String, message: Schema.String },
) {}

export class CliHostError extends Schema.TaggedErrorClass<CliHostError>()("CliHostError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const decodeCliUsageError = Schema.decodeUnknownOption(CliUsageError);

export type CliError = CliCompositionError | CliHostError | CliUsageError;

export interface ServeRequest {
  readonly profilePath: string;
  readonly signal: AbortSignal;
}

export interface CliDependencies<E = never, R = never> {
  readonly serve?: (request: ServeRequest) => Effect.Effect<void, E, R>;
  readonly doctor?: (profilePath: string) => Effect.Effect<DoctorReport, E, R>;
  readonly init?: (
    request: ProfileInitializationRequest,
  ) => Effect.Effect<ProfileInitializationResult, E, R>;
  readonly authLogin?: (
    profilePath: string,
    providerId: string,
    type: AuthType,
  ) => Effect.Effect<AuthStatus, E, R>;
  readonly ask?: (profilePath: string, prompt: string) => Effect.Effect<void, E, R>;
  readonly sessionsList?: (profilePath: string) => Effect.Effect<string, E, R>;
  readonly tui?: (profilePath: string) => Effect.Effect<void, E, R>;
  readonly cwd: Effect.Effect<string, E, R>;
  readonly onSignal: (
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => Effect.Effect<void, E, R>;
  readonly offSignal: (
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => Effect.Effect<void, E, R>;
  readonly service?: ServiceController;
  readonly executable?: string;
  readonly canInstallService?: boolean;
  readonly output: (value: string) => Effect.Effect<void, E, R>;
}

export interface CliExecutableDependencies<E = never, R = never> extends CliDependencies<E, R> {
  readonly errorOutput: (value: string) => Effect.Effect<void, never>;
  readonly setExitCode: (code: number) => Effect.Effect<void, never>;
}

export function runCli<E, R>(argv: ReadonlyArray<string>, dependencies: CliDependencies<E, R>) {
  return Effect.gen(function* () {
    if (argv.length === 1 && argv[0] === "--version") {
      yield* dependencies.output(ZIGGY_VERSION);
      return;
    }
    if (argv.length === 1 && argv[0] === "--runtime-mode") {
      yield* dependencies.output(dependencies.canInstallService === true ? "compiled" : "source");
      return;
    }

    const command = argv[0];
    if (command === "init") {
      if (dependencies.init === undefined) {
        return yield* new CliCompositionError({
          operation: "init",
          message: "Profile initialization composition is not available",
        });
      }
      const request = yield* parseInit(argv.slice(1), yield* dependencies.cwd);
      const result = yield* dependencies.init(request);
      yield* dependencies.output(JSON.stringify(result));
      return;
    }
    if (command === "auth") {
      if (dependencies.authLogin === undefined) {
        return yield* new CliCompositionError({
          operation: "auth",
          message: "Provider auth composition is not available",
        });
      }
      const request = yield* parseAuthLogin(argv.slice(1), yield* dependencies.cwd);
      const result = yield* dependencies.authLogin(
        request.profilePath,
        request.providerId,
        request.type,
      );
      yield* dependencies.output(JSON.stringify(result));
      return;
    }
    if (command === "ask") {
      if (dependencies.ask === undefined) {
        return yield* new CliCompositionError({
          operation: "ask",
          message: "ask composition is not available",
        });
      }
      const request = yield* parseAsk(argv.slice(1), yield* dependencies.cwd);
      yield* dependencies.ask(request.profilePath, request.prompt);
      return;
    }
    if (command === "tui") {
      if (dependencies.tui === undefined) {
        return yield* new CliCompositionError({
          operation: "tui",
          message: "TUI composition is not available",
        });
      }
      const profilePath = yield* profile(argv.slice(1), yield* dependencies.cwd).pipe(
        Effect.mapError(() => new CliUsageError({ message: "usage: ziggy tui [--profile PATH]" })),
      );
      yield* dependencies.tui(profilePath);
      return;
    }
    if (command === "sessions") {
      if (dependencies.sessionsList === undefined) {
        return yield* new CliCompositionError({
          operation: "sessions-list",
          message: "Session listing composition is not available",
        });
      }
      const profilePath = yield* parseSessionsList(argv.slice(1), yield* dependencies.cwd);
      yield* dependencies.output(yield* dependencies.sessionsList(profilePath));
      return;
    }
    if (command === "serve") {
      if (dependencies.serve === undefined) {
        return yield* new CliCompositionError({
          operation: "serve",
          message: "foreground daemon composition is not available",
        });
      }
      const serve = dependencies.serve;
      const profilePath = yield* profile(argv.slice(1), yield* dependencies.cwd);
      const controller = yield* Effect.sync(() => new AbortController());
      const stop = (): void => controller.abort();
      return yield* Effect.acquireUseRelease(
        dependencies.onSignal("SIGINT", stop),
        () =>
          Effect.acquireUseRelease(
            dependencies.onSignal("SIGTERM", stop),
            () => serve({ profilePath, signal: controller.signal }),
            () => dependencies.offSignal("SIGTERM", stop),
          ),
        () => dependencies.offSignal("SIGINT", stop),
      );
    }
    if (command === "doctor") {
      if (dependencies.doctor === undefined) {
        return yield* new CliCompositionError({
          operation: "doctor",
          message: "doctor composition is not available",
        });
      }
      const result = yield* dependencies.doctor(
        yield* profile(argv.slice(1), yield* dependencies.cwd),
      );
      yield* dependencies.output(JSON.stringify(result));
      return;
    }
    if (command === "service") {
      const action = argv[1];
      if (!isAction(action)) return yield* serviceUsage();
      if (dependencies.service === undefined || dependencies.executable === undefined) {
        return yield* new CliCompositionError({
          operation: "service",
          message: "service lifecycle composition is not available",
        });
      }
      if (action === "install" && dependencies.canInstallService !== true) {
        return yield* new CliCompositionError({
          operation: "service-install",
          message: "service install requires a compiled Ziggy executable, not Bun source mode",
        });
      }
      const input: ServiceInput = {
        profilePath: yield* profile(argv.slice(2), yield* dependencies.cwd),
        executable: dependencies.executable,
      };
      const result = yield* dependencies.service[action](input);
      yield* dependencies.output(JSON.stringify(result));
      return;
    }
    return yield* new CliUsageError({
      message:
        "usage: ziggy init [path] [--voice NAME] | tui [--profile PATH] | ask PROMPT [--profile PATH] | sessions list [--profile PATH] | auth login PROVIDER [--type api_key|oauth] [--profile PATH] | serve [--profile PATH] | doctor [--profile PATH] | service install|start|stop|status|remove",
    });
  });
}

function parseAsk(
  argv: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<{ readonly profilePath: string; readonly prompt: string }, CliUsageError> {
  if (argv[0] === undefined || argv[0].length === 0 || argv[0].startsWith("-")) {
    return askUsage();
  }
  const prompt = argv[0];
  return profile(argv.slice(1), cwd).pipe(
    Effect.map((profilePath) => ({ profilePath, prompt })),
    Effect.mapError(
      () => new CliUsageError({ message: "usage: ziggy ask PROMPT [--profile PATH]" }),
    ),
  );
}

function parseSessionsList(
  argv: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<string, CliUsageError> {
  if (argv[0] !== "list") return sessionsUsage();
  return profile(argv.slice(1), cwd).pipe(
    Effect.mapError(
      () => new CliUsageError({ message: "usage: ziggy sessions list [--profile PATH]" }),
    ),
  );
}

function askUsage(): Effect.Effect<never, CliUsageError> {
  return Effect.fail(new CliUsageError({ message: "usage: ziggy ask PROMPT [--profile PATH]" }));
}

function sessionsUsage(): Effect.Effect<never, CliUsageError> {
  return Effect.fail(new CliUsageError({ message: "usage: ziggy sessions list [--profile PATH]" }));
}

function parseInit(
  argv: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<ProfileInitializationRequest, CliUsageError> {
  let profilePath: string | undefined;
  let voice: VoiceName | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) return initUsage();
    if (value === "--voice") {
      const candidate = argv[index + 1];
      if (voice !== undefined || candidate === undefined || !isVoiceName(candidate)) {
        return initUsage();
      }
      voice = candidate;
      index += 1;
      continue;
    }
    if (value.startsWith("-") || value.length === 0 || profilePath !== undefined) {
      return initUsage();
    }
    profilePath = value;
  }
  return Effect.succeed({
    profilePath: profilePath ?? cwd,
    ...(voice === undefined ? {} : { voice }),
  });
}

function parseAuthLogin(
  argv: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<
  { readonly profilePath: string; readonly providerId: string; readonly type: AuthType },
  CliUsageError
> {
  if (
    argv[0] !== "login" ||
    argv[1] === undefined ||
    argv[1].length === 0 ||
    argv[1].startsWith("-")
  ) {
    return authUsage();
  }
  const providerId = argv[1];
  let type: AuthType | undefined;
  let profilePath = cwd;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--type" && type === undefined && (value === "api_key" || value === "oauth")) {
      type = value;
      index += 1;
    } else if (
      flag === "--profile" &&
      value !== undefined &&
      value.length > 0 &&
      profilePath === cwd
    ) {
      profilePath = value;
      index += 1;
    } else return authUsage();
  }
  return Effect.succeed({
    profilePath,
    providerId,
    type: type ?? (providerId === "openai-codex" ? "oauth" : "api_key"),
  });
}

function authUsage(): Effect.Effect<never, CliUsageError> {
  return Effect.fail(
    new CliUsageError({
      message: "usage: ziggy auth login PROVIDER [--type api_key|oauth] [--profile PATH]",
    }),
  );
}

function initUsage(): Effect.Effect<never, CliUsageError> {
  return Effect.fail(
    new CliUsageError({ message: "usage: ziggy init [path] [--voice clear|warm|operator]" }),
  );
}

function serviceUsage(): Effect.Effect<never, CliUsageError> {
  return Effect.fail(
    new CliUsageError({
      message: "usage: ziggy service install|start|stop|status|remove [--profile PATH]",
    }),
  );
}

function profile(argv: ReadonlyArray<string>, cwd: string): Effect.Effect<string, CliUsageError> {
  if (argv.length === 0) return Effect.succeed(cwd);
  if (
    argv.length === 2 &&
    argv[0] === "--profile" &&
    argv[1] !== undefined &&
    argv[1].length > 0 &&
    !argv[1].startsWith("-")
  ) {
    return Effect.succeed(argv[1]);
  }
  return Effect.fail(new CliUsageError({ message: "expected [--profile PATH]" }));
}

function isAction(
  value: string | undefined,
): value is "install" | "start" | "stop" | "status" | "remove" {
  return (
    value === "install" ||
    value === "start" ||
    value === "stop" ||
    value === "status" ||
    value === "remove"
  );
}

export function runCliExecutable<E, R>(
  argv: ReadonlyArray<string>,
  dependencies: CliExecutableDependencies<E, R>,
): Effect.Effect<void, never, R> {
  return Effect.exit(runCli(argv, dependencies)).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) return dependencies.setExitCode(0);
      const failure = classifyCliCause(exit.cause);
      return dependencies
        .errorOutput(`${failure.stderr}\n`)
        .pipe(Effect.andThen(dependencies.setExitCode(failure.exitCode)));
    }),
  );
}

export function classifyCliCause<E>(cause: Cause.Cause<E>): {
  readonly exitCode: 1 | 2 | 3 | 130;
  readonly stderr: string;
} {
  if (Cause.hasInterruptsOnly(cause)) return { exitCode: 130, stderr: "Interrupted." };
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const usage = decodeCliUsageError(error);
  if (Option.isSome(usage)) {
    return { exitCode: 2, stderr: usage.value.message.slice(0, 512) };
  }
  if (
    Predicate.isTagged(error, "AttachOutcomeUnknownError") ||
    Predicate.isTagged(error, "CliOutcomeUnknownError")
  ) {
    return {
      exitCode: 3,
      stderr: "Turn outcome unknown; it may have been accepted. Do not retry automatically.",
    };
  }
  return { exitCode: 1, stderr: "Ziggy command failed." };
}

type ProductionOperationError =
  | AuthClientError
  | CliClientError
  | CliError
  | DaemonControlError
  | Effect.Error<ReturnType<typeof serveDaemon>>
  | ProfileInitializationFailure
  | TerminalAuthError;

type ProductionRequirements = DaemonReadiness | Effect.Services<ReturnType<typeof serveDaemon>>;

export const productionDependencies: Effect.Effect<
  CliExecutableDependencies<ProductionOperationError, ProductionRequirements>,
  RuntimeInvocationError
> = Effect.gen(function* () {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const runtime = yield* productionRuntimeInvocation;
  const platform = Result.getSuccess(yield* Effect.result(decodeServicePlatform(process.platform)));
  const clientDaemonSetup: CliDaemonSetup<DaemonReadiness> = {
    probe: (profilePath) => probeDaemon({ profilePath }),
    startAbsent: ensureProductionDaemonReady,
  };
  const base: CliExecutableDependencies<ProductionOperationError, ProductionRequirements> = {
    init: initializeProfile,
    serve: (request) => serveDaemon(request),
    doctor: (profilePath) => runDoctor({ profilePath }),
    ask: (profilePath, prompt) =>
      runProductionAsk(profilePath, prompt, clientDaemonSetup, (text) =>
        hostOperation("write-ask-output", "Failed to write ask output", () => {
          process.stdout.write(text);
        }),
      ),
    sessionsList: (profilePath) => runProductionSessionsList(profilePath, clientDaemonSetup),
    tui: (profilePath) => runProductionTui(profilePath, clientDaemonSetup),
    authLogin: (profilePath, providerId, type) =>
      Effect.gen(function* () {
        const ready = yield* ensureProductionDaemonReady(profilePath);
        if (ready.status !== "ready") {
          return yield* new CliCompositionError({
            operation: "auth",
            message: "Profile daemon is not ready",
          });
        }
        return yield* loginProvider(
          ready.socketPath,
          providerId,
          type,
          terminalAuthInteraction(console.log),
        );
      }),
    cwd: hostOperation("read-current-directory", "Failed to read current directory", process.cwd),
    onSignal: (signal, listener) =>
      hostOperation("register-signal", `Failed to register ${signal} listener`, () => {
        process.on(signal, listener);
      }),
    offSignal: (signal, listener) =>
      hostOperation("remove-signal", `Failed to remove ${signal} listener`, () => {
        process.off(signal, listener);
      }),
    output: (value) =>
      hostOperation("write-output", "Failed to write command output", () => console.log(value)),
    errorOutput: (value) =>
      Effect.sync(() => {
        process.stderr.write(value);
      }),
    setExitCode: (code) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    executable: runtime.executable,
    canInstallService: runtime.kind === "compiled",
    ...(Option.isSome(platform)
      ? {
          service: createServiceController({
            platform: platform.value,
            home: process.env.HOME ?? "",
            ...(uid === undefined ? {} : { uid }),
            ...(process.env.XDG_CONFIG_HOME === undefined ||
            process.env.XDG_CONFIG_HOME.length === 0
              ? {}
              : { xdgConfigHome: process.env.XDG_CONFIG_HOME }),
            filesystem: new NodeServiceFilesystem(),
            process: new BunProcessManager(),
          }),
        }
      : {}),
  };
  return base;
});

function hostOperation<A>(
  operation: string,
  message: string,
  evaluate: () => A,
): Effect.Effect<A, CliHostError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => new CliHostError({ operation, message, cause }),
  });
}
