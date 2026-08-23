import { join } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Effect, Schema } from "effect";

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const boundedString = (maximum: number, expected: string) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.length >= 1 && value.length <= maximum, { expected }),
  );
const ToolName = Schema.String.check(
  Schema.makeFilter((value) => TOOL_NAME.test(value), { expected: "a safe MCP tool name" }),
);
const boundedInteger = (minimum: number, maximum: number, expected: string) =>
  Schema.Number.check(
    Schema.makeFilter(
      (value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum,
      { expected },
    ),
  );

const McpServer = Schema.Struct({
  command: boundedString(4096, "a non-empty command of at most 4096 characters"),
  args: Schema.optionalKey(
    Schema.Array(Schema.String).check(
      Schema.makeFilter(
        (args) => args.length <= 64 && args.every((argument) => argument.length <= 4096),
        { expected: "at most 64 arguments of at most 4096 characters" },
      ),
    ),
  ),
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).check(
      Schema.makeFilter(
        (environment) =>
          Object.keys(environment).length <= 128 &&
          Object.entries(environment).every(
            ([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value.length <= 16 * 1024,
          ),
        { expected: "at most 128 safe environment names with bounded values" },
      ),
    ),
  ),
  allowTools: Schema.Array(ToolName).check(
    Schema.makeFilter(
      (tools) => tools.length >= 1 && tools.length <= 100 && new Set(tools).size === tools.length,
      { expected: "1 to 100 unique explicitly allowed MCP tool names" },
    ),
  ),
});

const Limits = Schema.Struct({
  timeoutMs: Schema.optionalKey(
    boundedInteger(1, 120_000, "a timeout from 1 to 120000 milliseconds"),
  ),
  maxSteps: Schema.optionalKey(
    boundedInteger(1, 1_000_000, "an interpreter step limit from 1 to 1000000"),
  ),
  maxToolCalls: Schema.optionalKey(boundedInteger(1, 100, "a tool call limit from 1 to 100")),
  maxOutputBytes: Schema.optionalKey(
    boundedInteger(256, 256 * 1024, "an output byte limit from 256 to 262144"),
  ),
  maxCodeBytes: Schema.optionalKey(
    boundedInteger(1, 128 * 1024, "a code byte limit from 1 to 131072"),
  ),
  maxCatalogTools: Schema.optionalKey(boundedInteger(1, 500, "a catalog tool limit from 1 to 500")),
  maxMcpMessageBytes: Schema.optionalKey(
    boundedInteger(1024, 2 * 1024 * 1024, "an MCP message byte limit from 1024 to 2097152"),
  ),
});

export const CodeModeConfig = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, McpServer).check(
    Schema.makeFilter(
      (servers) =>
        Object.keys(servers).length <= 32 &&
        Object.keys(servers).every((name) => SERVER_NAME.test(name)),
      { expected: "at most 32 lowercase MCP server names without dots" },
    ),
  ),
  limits: Schema.optionalKey(Limits),
});

export type CodeModeConfig = typeof CodeModeConfig.Type;
export type McpServerConfig = typeof McpServer.Type;

export interface ResolvedLimits {
  readonly timeoutMs: number;
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxOutputBytes: number;
  readonly maxCodeBytes: number;
  readonly maxCatalogTools: number;
  readonly maxMcpMessageBytes: number;
}

export const resolveLimits = (config: CodeModeConfig): ResolvedLimits => ({
  timeoutMs: config.limits?.timeoutMs ?? 30_000,
  maxSteps: config.limits?.maxSteps ?? 50_000,
  maxToolCalls: config.limits?.maxToolCalls ?? 20,
  maxOutputBytes: config.limits?.maxOutputBytes ?? 32 * 1024,
  maxCodeBytes: config.limits?.maxCodeBytes ?? 32 * 1024,
  maxCatalogTools: config.limits?.maxCatalogTools ?? 100,
  maxMcpMessageBytes: config.limits?.maxMcpMessageBytes ?? 256 * 1024,
});

class CodeModeConfigError extends Schema.TaggedErrorClass<CodeModeConfigError>()(
  "CodeModeConfigError",
  { path: Schema.String, reason: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CodeModeConfig), {
  onExcessProperty: "error",
});

export const loadConfig = (profilePath: string) => {
  const path = join(profilePath, "codemode.json");
  return Effect.gen(function* () {
    const noFollow = constants.O_NOFOLLOW;
    if (!Number.isSafeInteger(noFollow) || noFollow <= 0) {
      return yield* new CodeModeConfigError({
        path,
        reason: "This platform cannot guarantee no-follow opening for codemode.json.",
      });
    }
    const text = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | noFollow),
        catch: (cause) =>
          new CodeModeConfigError({
            path,
            reason: "Could not open physical codemode.json without following symlinks.",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const metadata = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new CodeModeConfigError({ path, reason: "Could not inspect codemode.json.", cause }),
          });
          if (!metadata.isFile()) {
            return yield* new CodeModeConfigError({
              path,
              reason: "codemode.json must be a physical regular file.",
            });
          }
          return yield* Effect.tryPromise({
            try: () => handle.readFile("utf8"),
            catch: (cause) =>
              new CodeModeConfigError({ path, reason: "Could not read codemode.json.", cause }),
          });
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new CodeModeConfigError({ path, reason: "Could not close codemode.json.", cause }),
        }),
    );
    return yield* decodeConfigJson(text).pipe(
      Effect.mapError(
        (cause) => new CodeModeConfigError({ path, reason: "codemode.json is invalid.", cause }),
      ),
    );
  });
};
