/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Process-group signaling falls back when group termination races with process exit. */
/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution and child_process are Promise adapter boundaries. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi marks rejected tool Promises as tool failures. */
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import executable from "./bin/diffs.py" with { type: "file" };

const TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const OUTPUT_LIMIT = 24 * 1024;

const Source = Type.Object(
  {
    kind: Type.Optional(
      Type.Union([Type.Literal("pr"), Type.Literal("paste"), Type.Literal("tool")]),
    ),
    ref: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Parameters = Type.Object(
  {
    patch: Type.Optional(Type.String()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    mode: Type.Optional(
      Type.Union([Type.Literal("text"), Type.Literal("file"), Type.Literal("both")]),
    ),
    source: Type.Optional(Source),
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

const signalProcessTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group has already changed or exited.
    }
  }
  child.kill(signal);
};

const execute = (
  input: Static<typeof Parameters>,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("python3", [executable], {
      cwd,
      env: { ...process.env, ZIGGY_PROFILE_PATH: cwd },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminationStarted = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      signal?.removeEventListener("abort", cancel);
    };
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => signalProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
      escalation.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, TIMEOUT_MS);
    const cancel = () => {
      cancelled = true;
      terminate();
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`diffs failed to start: ${cause.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const streams = `stdout:\n${display(stdout) || "(empty)"}\nstderr:\n${display(stderr) || "(empty)"}`;
      if (cancelled) return reject(new Error(`diffs was cancelled.\n${streams}`));
      if (timedOut) return reject(new Error(`diffs timed out after ${TIMEOUT_MS}ms.\n${streams}`));
      if (code !== 0)
        return reject(new Error(`diffs exited with code ${code ?? "unknown"}.\n${streams}`));
      resolve({ stdout: display(stdout), stderr: display(stderr) });
    });
    child.stdin.end(JSON.stringify(input));
  });

export default function diffs(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool({
    name: "diffs",
    label: "diffs",
    description:
      "Render a diff artifact from a patch, before/after text, or a GitHub pull request source.",
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
