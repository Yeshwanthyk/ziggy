/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi requires thrown tool errors to mark failed executions. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LINEAR_SCRIPT = join(import.meta.dirname, "scripts", "linear_api.py");

const OUTPUT_LIMIT = 32 * 1024;

const Parameters = Type.Object(
  {
    args: Type.Array(Type.String(), {
      description: "Linear helper command and arguments, one array item per argv value.",
      maxItems: 128,
    }),
  },
  { additionalProperties: false },
);

const truncate = (text: string): string =>
  text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n… ${text.length - OUTPUT_LIMIT} characters omitted`;

const successfulText = (result: ExecResult): string => {
  const stdout = truncate(result.stdout);
  const stderr = truncate(result.stderr);
  if (stdout.length > 0 && stderr.length > 0) return `${stdout}\n\nstderr:\n${stderr}`;
  if (stdout.length > 0) return stdout;
  if (stderr.length > 0) return `stderr:\n${stderr}`;
  return "Command completed successfully.";
};

export const linearScriptPath = LINEAR_SCRIPT;

export const runLinearCommand = async (
  exec: ExtensionAPI["exec"],
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
) => {
  const execOptions: Parameters<ExtensionAPI["exec"]>[2] = {
    cwd,
    timeout: 30_000,
  };
  if (signal !== undefined) {
    execOptions.signal = signal;
  }
  const result = await exec(LINEAR_SCRIPT, [...args], execOptions);
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
    throw new Error(`Linear helper ${reason}${output.length > 0 ? `\n${output}` : ""}`);
  }
  return {
    content: [{ type: "text" as const, text: successfulText(result) }],
    details: { code: result.code, killed: result.killed, stdout, stderr },
  };
};

export default function linear(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "linear",
    label: "linear",
    description:
      "Work with Linear issues, projects, teams, states, comments, and documents through the Linear API.",
    parameters: Parameters,
    async execute(_toolCallId, { args }, signal, _onUpdate, ctx) {
      return runLinearCommand(pi.exec.bind(pi), args, ctx.cwd, signal);
    },
  });
}
