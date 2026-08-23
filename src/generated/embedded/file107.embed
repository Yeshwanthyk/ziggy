/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi's exec and tool contracts are Promise adapter boundaries. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- Throwing from a Pi tool marks the tool result as failed. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi tool failures cross this boundary as rejected Error values. */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 24 * 1024;
const executable = join(import.meta.dirname, "bin", "web-search.ts");
const Parameters = Type.Object(
  { args: Type.Array(Type.String(), { description: "Query words and optional --n <count>." }) },
  { additionalProperties: false },
);

const display = (value: string): string => {
  if (Buffer.byteLength(value) <= OUTPUT_LIMIT) return value;
  return `${Buffer.from(value).subarray(0, OUTPUT_LIMIT).toString()}\n[output truncated]`;
};

export const runWebSearch = async (
  pi: Pick<ExtensionAPI, "exec">,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const execOptions: Parameters<Pick<ExtensionAPI, "exec">["exec"]>[2] = {
    cwd,
    timeout: TIMEOUT_MS,
  };
  if (signal) {
    execOptions.signal = signal;
  }
  const result = await pi.exec(process.execPath, [executable, ...args], execOptions);
  const stdout = display(result.stdout);
  const stderr = display(result.stderr);
  const streams = `stdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
  if (result.killed) {
    const reason = signal?.aborted ? "was cancelled" : `timed out after ${TIMEOUT_MS}ms`;
    throw new Error(`web_search ${reason}.\n${streams}`);
  }
  if (result.code !== 0) throw new Error(`web_search exited with code ${result.code}.\n${streams}`);
  return { stdout, stderr, code: result.code };
};

export default function webSearch(pi: Pick<ExtensionAPI, "exec" | "registerTool">): void {
  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web through Exa. Pass a natural-language query in args and optionally --n <count>.",
    parameters: Parameters,
    executionMode: "parallel",
    async execute(_toolCallId, { args }, signal, _onUpdate, ctx) {
      const result = await runWebSearch(pi, args, ctx.cwd, signal);
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
