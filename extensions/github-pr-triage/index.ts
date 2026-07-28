/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi's exec and tool contracts are Promise adapter boundaries. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- Throwing from a Pi tool marks the tool result as failed. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi tool failures cross this boundary as rejected Error values. */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 24 * 1024;
const executable = fileURLToPath(new URL("./bin/gh-prs.py", import.meta.url));
const Parameters = Type.Object(
  { args: Type.Array(Type.String(), { description: "Arguments passed to the gh-prs helper." }) },
  { additionalProperties: false },
);

const display = (value: string): string => {
  if (Buffer.byteLength(value) <= OUTPUT_LIMIT) return value;
  return `${Buffer.from(value).subarray(0, OUTPUT_LIMIT).toString()}\n[output truncated]`;
};

export const runGithubPrTriage = async (
  pi: Pick<ExtensionAPI, "exec">,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const result = await pi.exec("python3", [executable, ...args], {
    cwd,
    ...(signal ? { signal } : {}),
    timeout: TIMEOUT_MS,
  });
  const stdout = display(result.stdout);
  const stderr = display(result.stderr);
  const streams = `stdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
  if (result.killed) {
    const reason = signal?.aborted ? "was cancelled" : `timed out after ${TIMEOUT_MS}ms`;
    throw new Error(`gh_prs ${reason}.\n${streams}`);
  }
  if (result.code !== 0) throw new Error(`gh_prs exited with code ${result.code}.\n${streams}`);
  return { stdout, stderr, code: result.code };
};

export default function githubPrTriage(pi: Pick<ExtensionAPI, "exec" | "registerTool">): void {
  pi.registerTool({
    name: "gh_prs",
    label: "gh_prs",
    description:
      "Read-only GitHub PR triage. Arguments: review-requested; mine; or view <owner/repo> <number>.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, { args }, signal, _onUpdate, ctx) {
      const result = await runGithubPrTriage(pi, args, ctx.cwd, signal);
      const text = result.stderr
        ? `${result.stdout}\n\nstderr:\n${result.stderr}`.trim()
        : result.stdout;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
}
