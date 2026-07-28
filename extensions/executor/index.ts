/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi requires thrown tool errors to mark failed executions. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OUTPUT_LIMIT = 32 * 1024;

const Arguments = Type.Object(
  {
    args: Type.Array(Type.String(), {
      description: "Arguments passed verbatim after the fixed Executor subcommand.",
      maxItems: 128,
    }),
  },
  { additionalProperties: false },
);

type RunOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly timeout: number;
};

const truncate = (text: string): string => {
  if (text.length <= OUTPUT_LIMIT) return text;
  const omitted = text.length - OUTPUT_LIMIT;
  return `${text.slice(0, OUTPUT_LIMIT)}\n… ${omitted} characters omitted`;
};

const formatSuccess = (result: ExecResult): string => {
  const stdout = truncate(result.stdout);
  const stderr = truncate(result.stderr);
  if (stdout.length > 0 && stderr.length > 0) return `${stdout}\n\nstderr:\n${stderr}`;
  if (stdout.length > 0) return stdout;
  if (stderr.length > 0) return `stderr:\n${stderr}`;
  return "Command completed successfully.";
};

export const runExecutorCommand = async (exec: ExtensionAPI["exec"], options: RunOptions) => {
  const result = await exec(options.command, [...options.args], {
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeout: options.timeout,
  });
  const stdout = truncate(result.stdout);
  const stderr = truncate(result.stderr);

  if (result.code !== 0) {
    const reason = result.killed ? "was terminated" : `exited with code ${result.code}`;
    const output = [
      stderr.length > 0 ? `stderr:\n${stderr}` : "",
      stdout.length > 0 ? `stdout:\n${stdout}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    throw new Error(`executor ${reason}${output.length > 0 ? `\n${output}` : ""}`);
  }

  return {
    content: [{ type: "text" as const, text: formatSuccess(result) }],
    details: { code: result.code, killed: result.killed, stdout, stderr },
  };
};

type ExecutorTool = {
  readonly name:
    | "executor_tools_search"
    | "executor_tools_sources"
    | "executor_tools_describe"
    | "executor_call"
    | "executor_resume";
  readonly description: string;
  readonly prefix: readonly string[];
  readonly timeout: number;
};

const tools: readonly ExecutorTool[] = [
  {
    name: "executor_tools_search",
    description:
      "Search the configured Executor tool catalog. Pass query and options as separate args.",
    prefix: ["tools", "search"],
    timeout: 30_000,
  },
  {
    name: "executor_tools_sources",
    description: "List configured Executor sources and tool counts.",
    prefix: ["tools", "sources"],
    timeout: 30_000,
  },
  {
    name: "executor_tools_describe",
    description: "Describe an Executor tool path and its input schema.",
    prefix: ["tools", "describe"],
    timeout: 30_000,
  },
  {
    name: "executor_call",
    description: "Invoke an Executor tool path with its input.",
    prefix: ["call"],
    timeout: 120_000,
  },
  {
    name: "executor_resume",
    description: "Resume a paused Executor execution with explicit response arguments.",
    prefix: ["resume"],
    timeout: 120_000,
  },
];

export default function executor(pi: ExtensionAPI): void {
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Arguments,
      async execute(_toolCallId, { args }, signal, _onUpdate, ctx) {
        return runExecutorCommand(pi.exec.bind(pi), {
          command: "executor",
          args: [...tool.prefix, ...args],
          cwd: ctx.cwd,
          signal,
          timeout: tool.timeout,
        });
      },
    });
  }
}
