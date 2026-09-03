/* oxlint-disable ziggy/no-unknown-parameters, ziggy/no-known-value-widening, ziggy/no-conditional-empty-object-spread, ziggy/no-runtime-typeof, ziggy/no-reflect-get, ziggy-effect/no-instanceof-tagged-error, ziggy-effect/no-inline-schema-compile, ziggy-effect/no-try-catch-or-throw -- This boundary normalizes confined interpreter and typed adapter failures into the public diagnostic envelope. */
import { Effect, Option, Result, Schema } from "effect";
import { loadConfig, resolveLimits, type ResolvedLimits } from "./config.ts";
import { McpHost } from "./host.ts";
import { formatLogValues, interpret, InterpreterError, parseProgram } from "./interpreter.ts";

type CodeModeDiagnostic = {
  readonly kind: string;
  readonly message: string;
  readonly line?: number;
};

export type CodeModeResult =
  | {
      readonly ok: true;
      readonly value: Schema.Json;
      readonly logs: ReadonlyArray<string>;
      readonly toolCalls: ReadonlyArray<{ readonly path: string }>;
      readonly durationMs: number;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly error: CodeModeDiagnostic;
      readonly logs: ReadonlyArray<string>;
      readonly toolCalls: ReadonlyArray<{ readonly path: string }>;
      readonly durationMs: number;
      readonly truncated: boolean;
    };

type SessionHost = { readonly host: McpHost; readonly limits: ResolvedLimits };

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const boundEnvelope = (result: CodeModeResult, maximum: number): CodeModeResult => {
  if (byteLength(JSON.stringify(result)) <= maximum) return result;
  const logs = [...result.logs];
  const toolCalls = [...result.toolCalls];
  if (result.ok) {
    let value: Schema.Json = result.value;
    const build = (): CodeModeResult => ({
      ...result,
      value,
      logs,
      toolCalls,
      truncated: true,
    });
    while (byteLength(JSON.stringify(build())) > maximum && logs.length > 0) logs.pop();
    while (byteLength(JSON.stringify(build())) > maximum && toolCalls.length > 0) toolCalls.pop();
    if (byteLength(JSON.stringify(build())) > maximum) value = null;
    return build();
  }
  let message = result.error.message;
  const build = (): CodeModeResult => ({
    ...result,
    error: { ...result.error, message },
    logs,
    toolCalls,
    truncated: true,
  });
  while (byteLength(JSON.stringify(build())) > maximum && logs.length > 0) logs.pop();
  while (byteLength(JSON.stringify(build())) > maximum && toolCalls.length > 0) toolCalls.pop();
  while (byteLength(JSON.stringify(build())) > maximum && message.length > 16) {
    message = `${message.slice(0, Math.max(8, Math.floor(message.length / 2)))}…`;
  }
  return build();
};

const boundJson = (
  value: unknown,
  maximum: number,
): { readonly value: Schema.Json; readonly truncated: boolean } => {
  const decoded = Schema.decodeUnknownOption(Schema.Json)(value);
  const safe = Option.isSome(decoded) ? decoded.value : null;
  const serialized = JSON.stringify(safe);
  if (byteLength(serialized) <= maximum) return { value: safe, truncated: false };
  const preview = serialized.slice(0, Math.max(0, Math.floor(maximum / 2)));
  return { value: { truncated: true, preview }, truncated: true };
};

const diagnostic = (error: unknown): CodeModeDiagnostic => {
  if (error instanceof InterpreterError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.sourceLine === undefined ? {} : { line: error.sourceLine }),
    };
  }
  if (typeof error === "object" && error !== null) {
    const tag = Reflect.get(error, "_tag");
    const reason = Reflect.get(error, "reason");
    if (typeof tag === "string" && typeof reason === "string")
      return { kind: tag, message: reason };
  }
  return { kind: "ExecutionFailure", message: "Code Mode execution failed." };
};

export class CodeModeSession {
  #owner: SessionHost | undefined;

  host(profilePath: string): Effect.Effect<SessionHost, unknown> {
    if (this.#owner !== undefined) return Effect.succeed(this.#owner);
    return loadConfig(profilePath).pipe(
      Effect.map((config) => {
        const limits = resolveLimits(config);
        const owner = { host: new McpHost(config, profilePath, limits), limits };
        this.#owner = owner;
        return owner;
      }),
    );
  }

  close(): Effect.Effect<void> {
    if (this.#owner === undefined) return Effect.void;
    const owner = this.#owner;
    this.#owner = undefined;
    return owner.host.close();
  }
}

export const createCodeModeSession = (): CodeModeSession => new CodeModeSession();

export const executeCodeMode = (
  session: CodeModeSession,
  profilePath: string,
  code: string,
): Effect.Effect<CodeModeResult> => {
  const started = performance.now();
  let outputLimit = 32 * 1024;
  let currentLogs: ReadonlyArray<string> = [];
  let currentToolCalls: ReadonlyArray<{ readonly path: string }> = [];
  let currentTruncated = false;
  const execution = Effect.gen(function* () {
    const acquired = yield* session.host(profilePath).pipe(Effect.result);
    if (Result.isFailure(acquired)) {
      return {
        ok: false as const,
        error: diagnostic(acquired.failure),
        logs: [],
        toolCalls: [],
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        truncated: false,
      };
    }
    const { host, limits } = acquired.success;
    outputLimit = limits.maxOutputBytes;
    if (byteLength(code) > limits.maxCodeBytes) {
      return {
        ok: false as const,
        error: { kind: "CodeLimitExceeded", message: "Code exceeds the configured byte limit." },
        logs: [],
        toolCalls: [],
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        truncated: false,
      };
    }

    const logs: string[] = [];
    const toolCalls: Array<{ readonly path: string }> = [];
    currentLogs = logs;
    currentToolCalls = toolCalls;
    let logBytes = 0;
    let truncated = false;
    const addLog = (level: "log" | "warn" | "error", values: ReadonlyArray<unknown>) => {
      const line = `[${level}] ${formatLogValues(values)}`;
      const bytes = byteLength(line);
      if (logs.length >= 100 || logBytes + bytes > Math.floor(limits.maxOutputBytes / 2)) {
        truncated = true;
        currentTruncated = true;
        return;
      }
      logs.push(line);
      logBytes += bytes;
    };
    let program;
    try {
      program = parseProgram(code);
    } catch (error) {
      return {
        ok: false as const,
        error: diagnostic(error),
        logs,
        toolCalls,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        truncated,
      };
    }
    let calls = 0;
    const interpreted = interpret(program, {
      maxSteps: limits.maxSteps,
      log: addLog,
      invoke: (path, input) => {
        calls += 1;
        if (calls > limits.maxToolCalls) {
          return Effect.fail(
            new InterpreterError({
              kind: "ToolCallLimitExceeded",
              message: "MCP tool call limit exceeded.",
            }),
          );
        }
        const name = path.join(".");
        toolCalls.push({ path: name });
        return path[0] === "$codemode" && path[1] === "search"
          ? host.search(input)
          : host.call(path[0] ?? "", path[1] ?? "", input);
      },
    }).pipe(
      Effect.onInterrupt(() => host.revokeAll()),
      Effect.timeoutOption(limits.timeoutMs),
    );
    const exit = yield* interpreted.pipe(Effect.result);
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    if (Result.isFailure(exit)) {
      return {
        ok: false as const,
        error: diagnostic(exit.failure),
        logs,
        toolCalls,
        durationMs,
        truncated,
      };
    }
    if (Option.isNone(exit.success)) {
      return {
        ok: false as const,
        error: { kind: "TimeoutExceeded", message: "Code Mode wall timeout exceeded." },
        logs,
        toolCalls,
        durationMs,
        truncated,
      };
    }
    const bounded = boundJson(exit.success.value, Math.max(256, limits.maxOutputBytes - logBytes));
    return {
      ok: true as const,
      value: bounded.value,
      logs,
      toolCalls,
      durationMs,
      truncated: truncated || bounded.truncated,
    };
  });
  return execution.pipe(
    Effect.catchDefect(() =>
      Effect.succeed({
        ok: false as const,
        error: {
          kind: "ExecutionFailure",
          message: "Code Mode rejected invalid or unsupported source.",
        },
        logs: currentLogs,
        toolCalls: currentToolCalls,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        truncated: currentTruncated,
      }),
    ),
    Effect.map((result) => boundEnvelope(result, outputLimit)),
  );
};
