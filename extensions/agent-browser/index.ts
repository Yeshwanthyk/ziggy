/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution and child_process are Promise adapter boundaries. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi marks rejected tool Promises as tool failures. */
/* eslint-disable ziggy-effect/no-unknown-error-message -- child_process emits a typed Error at this adapter boundary. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 24 * 1024;
const executable = fileURLToPath(new URL("./bin/agent-browser-wrapper.mjs", import.meta.url));

const Parameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("open"),
      Type.Literal("read"),
      Type.Literal("snapshot"),
      Type.Literal("screenshot"),
      Type.Literal("get"),
      Type.Literal("click"),
      Type.Literal("dblclick"),
      Type.Literal("focus"),
      Type.Literal("hover"),
      Type.Literal("fill"),
      Type.Literal("type"),
      Type.Literal("press"),
      Type.Literal("scroll"),
      Type.Literal("eval"),
      Type.Literal("back"),
      Type.Literal("tab"),
      Type.Literal("close"),
      Type.Literal("skills"),
      Type.Literal("raw"),
    ]),
    url: Type.Optional(Type.String()),
    selector: Type.Optional(Type.String()),
    ref: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    what: Type.Optional(Type.String()),
    attr: Type.Optional(Type.String()),
    direction: Type.Optional(Type.String()),
    tab: Type.Optional(Type.String()),
    amount: Type.Optional(Type.Integer()),
    path: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    code: Type.Optional(Type.String()),
    session: Type.Optional(Type.String()),
    headed: Type.Optional(Type.Boolean()),
    interactive: Type.Optional(Type.Boolean()),
    full: Type.Optional(Type.Boolean()),
    args: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const appendBounded = (current: string, chunk: string): string => {
  if (Buffer.byteLength(current) >= OUTPUT_LIMIT) return current;
  const available = OUTPUT_LIMIT - Buffer.byteLength(current);
  return current + Buffer.from(chunk).subarray(0, available).toString();
};

const display = (value: string): string =>
  Buffer.byteLength(value) < OUTPUT_LIMIT ? value : `${value}\n[output truncated]`;

const execute = (
  input: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable], {
      cwd,
      env: { ...process.env, ZIGGY_PROFILE_PATH: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (cause) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      reject(new Error(`agent_browser failed to start: ${cause.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      const streams = `stdout:\n${display(stdout) || "(empty)"}\nstderr:\n${display(stderr) || "(empty)"}`;
      if (cancelled) return reject(new Error(`agent_browser was cancelled.\n${streams}`));
      if (timedOut)
        return reject(new Error(`agent_browser timed out after ${TIMEOUT_MS}ms.\n${streams}`));
      if (code !== 0)
        return reject(
          new Error(`agent_browser exited with code ${code ?? "unknown"}.\n${streams}`),
        );
      resolve({ stdout: display(stdout), stderr: display(stderr) });
    });
    child.stdin.end(JSON.stringify(input));
  });

export default function agentBrowser(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool({
    name: "agent_browser",
    label: "agent_browser",
    description:
      "Run profile-persistent browser automation with agent-browser. Accepts structured common actions or raw agent-browser arguments.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      const result = await execute(parameters, ctx.cwd, signal);
      const text = result.stderr
        ? `${result.stdout}\n\nstderr:\n${result.stderr}`.trim()
        : result.stdout;
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
