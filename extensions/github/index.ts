/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi requires thrown tool errors to mark failed executions. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OUTPUT_LIMIT = 32 * 1024;

const Parameters = Type.Object(
  {
    args: Type.Array(Type.String(), {
      description: "GitHub CLI subcommand and arguments, one array item per argv value.",
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

export const runGithubCommand = async (
  exec: ExtensionAPI["exec"],
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
) => {
  const result = await exec("gh", [...args], {
    cwd,
    ...(signal === undefined ? {} : { signal }),
    timeout: 30_000,
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
    throw new Error(`gh ${reason}${output.length > 0 ? `\n${output}` : ""}`);
  }
  return {
    content: [{ type: "text" as const, text: successfulText(result) }],
    details: { code: result.code, killed: result.killed, stdout, stderr },
  };
};

export default function github(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "github",
    label: "github",
    description:
      "Run the authenticated GitHub CLI for repositories, issues, pull requests, workflows, releases, and API calls.",
    parameters: Parameters,
    async execute(_toolCallId, { args }, signal, _onUpdate, ctx) {
      return runGithubCommand(pi.exec.bind(pi), args, ctx.cwd, signal);
    },
  });
}
