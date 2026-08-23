/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Process-group signaling falls back when group termination races with process exit. */
/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution and child_process are Promise adapter boundaries. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi marks rejected tool Promises as tool failures. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const PROFILE_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const IDLE_TIMEOUT_PATTERN = "^(?:0|[1-9][0-9]{0,8}(?:ms|s|m|h)?)$";
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const EXECUTE_TIMEOUT_MS = 120_000;
const MAINTENANCE_TIMEOUT_MS = 15_000;
const TERMINATION_GRACE_MS = 500;
const OUTPUT_LIMIT = 24 * 1024;

const ExecuteParameters = Type.Object(
  {
    action: Type.Literal("execute"),
    profile: Type.String({
      description: "Logical persistent browser profile slug.",
      minLength: 1,
      maxLength: 48,
      pattern: PROFILE_PATTERN,
    }),
    script: Type.String({
      description: "Sandboxed dev-browser JavaScript sent on stdin, never through a shell.",
      minLength: 1,
      maxLength: 128 * 1024,
    }),
    headless: Type.Optional(
      Type.Boolean({ description: "Launch managed Chromium headless; false is headed." }),
    ),
    connect: Type.Optional(
      Type.Boolean({
        description: "Auto-connect to a local Chrome; remote URLs are not accepted.",
      }),
    ),
    idleTimeout: Type.Optional(
      Type.String({
        description: "Idle cleanup duration up to 24h, such as 30s, 5m, 1h, or raw ms; 0 disables.",
        pattern: IDLE_TIMEOUT_PATTERN,
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowsersParameters = Type.Object(
  { action: Type.Literal("browsers") },
  { additionalProperties: false },
);
const StatusParameters = Type.Object(
  { action: Type.Literal("status") },
  { additionalProperties: false },
);
const StopParameters = Type.Object(
  {
    action: Type.Literal("stop"),
    confirmed: Type.Literal(true, {
      description:
        "Required confirmation that this stops the daemon and all managed browsers globally.",
    }),
  },
  { additionalProperties: false },
);

export const Parameters = Type.Union([
  ExecuteParameters,
  BrowsersParameters,
  StatusParameters,
  StopParameters,
]);

type Parameters = Static<typeof Parameters>;
type ExecuteInput = Static<typeof ExecuteParameters>;

interface CapturedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

interface CliResult {
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
}

interface OutputCollector {
  readonly append: (chunk: Buffer | string) => void;
  readonly value: () => CapturedOutput;
}

const durationMilliseconds = (duration: string): number => {
  const match = /^(0|[1-9][0-9]{0,8})(ms|s|m|h)?$/.exec(duration);
  if (match === null) throw new Error(`Invalid idleTimeout: ${duration}`);
  const value = Number(match[1]);
  const multiplier =
    match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const milliseconds = value * multiplier;
  if (milliseconds > MAX_IDLE_TIMEOUT_MS) {
    throw new Error(`idleTimeout must be at most 24h; received ${duration}`);
  }
  return milliseconds;
};

export const managedBrowserName = (cwd: string, logicalProfile: string): string => {
  const namespace = createHash("sha256")
    .update(resolve(cwd))
    .update("\0")
    .update(logicalProfile)
    .digest("hex")
    .slice(0, 20);
  return `ziggy-${logicalProfile}-${namespace}`;
};

const binary = (): string => process.env.ZIGGY_DEV_BROWSER_BIN?.trim() || "dev-browser";

const signalProcessTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back if the process group has already changed or exited.
    }
  }
  child.kill(signal);
};

const createCollector = (): OutputCollector => {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = OUTPUT_LIMIT - size;
      if (available <= 0) {
        truncated = true;
        return;
      }
      const selected = buffer.subarray(0, available);
      chunks.push(selected);
      size += selected.byteLength;
      if (selected.byteLength < buffer.byteLength) truncated = true;
    },
    value: () => ({ text: Buffer.concat(chunks).toString("utf8"), truncated }),
  };
};

const display = (output: CapturedOutput): string =>
  output.truncated ? `${output.text}\n[output truncated]` : output.text;

const streamSummary = (result: CliResult): string =>
  `stdout:\n${display(result.stdout) || "(empty)"}\nstderr:\n${display(result.stderr) || "(empty)"}`;

const runCli = (
  args: readonly string[],
  stdin: string,
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<CliResult> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(binary(), args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = createCollector();
    const stderr = createCollector();
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let terminating = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      signal?.removeEventListener("abort", cancel);
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      signalProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => signalProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
      escalation.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
    const cancel = (): void => {
      cancelled = true;
      terminate();
    };

    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", stdout.append);
    child.stderr.on("data", stderr.append);
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`dev_browser failed to start ${binary()}: ${cause.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = { stdout: stdout.value(), stderr: stderr.value() };
      const streams = streamSummary(result);
      if (cancelled) return reject(new Error(`dev_browser was cancelled.\n${streams}`));
      if (timedOut)
        return reject(new Error(`dev_browser timed out after ${timeoutMs}ms.\n${streams}`));
      if (code !== 0)
        return reject(new Error(`dev_browser exited with code ${code ?? "unknown"}.\n${streams}`));
      resolvePromise(result);
    });
    child.stdin.on("error", () => {
      // A fast-exiting CLI reports the useful failure through close/stderr.
    });
    child.stdin.end(stdin);
  });

const executeArgs = (input: ExecuteInput, cwd: string): string[] => {
  if (input.idleTimeout !== undefined) durationMilliseconds(input.idleTimeout);
  const args = ["--browser", managedBrowserName(cwd, input.profile)];
  if (input.headless === true) args.push("--headless");
  if (input.connect === true) args.push("--connect");
  if (input.idleTimeout !== undefined) args.push("--idle-timeout", input.idleTimeout);
  return args;
};

const resultText = (result: CliResult): string => {
  const stdout = display(result.stdout);
  const stderr = display(result.stderr);
  return stderr ? `${stdout}\n\nstderr:\n${stderr}`.trim() : stdout || "dev-browser completed.";
};

export const executeDevBrowser = async (input: Parameters, cwd: string, signal?: AbortSignal) => {
  if (input.action === "execute") {
    let result: CliResult;
    try {
      result = await runCli(executeArgs(input, cwd), input.script, cwd, signal, EXECUTE_TIMEOUT_MS);
    } catch (cause) {
      const message = String(cause);
      if (input.idleTimeout !== undefined && message.includes("--idle-timeout")) {
        throw new Error(
          "This installed dev-browser does not support idleTimeout. Upgrade dev-browser to 0.2.9 or newer, or omit idleTimeout; persistent profile reuse still works without idle cleanup.",
        );
      }
      throw cause;
    }
    return {
      content: [{ type: "text" as const, text: resultText(result) }],
      details: {
        action: input.action,
        profile: input.profile,
        stdoutTruncated: result.stdout.truncated,
        stderrTruncated: result.stderr.truncated,
      },
    };
  }

  if (input.action === "stop" && input.confirmed !== true) {
    throw new Error(
      "dev_browser stop requires confirmed:true because it stops the daemon and all managed browsers globally.",
    );
  }
  const result = await runCli([input.action], "", cwd, signal, MAINTENANCE_TIMEOUT_MS);
  const prefix =
    input.action === "stop"
      ? "Stopped the dev-browser daemon and all managed browser connections. Persistent browser profile directories were preserved.\n\n"
      : "";
  return {
    content: [{ type: "text" as const, text: `${prefix}${resultText(result)}`.trim() }],
    details: {
      action: input.action,
      stdoutTruncated: result.stdout.truncated,
      stderrTruncated: result.stderr.truncated,
    },
  };
};

export default function devBrowser(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool({
    name: "dev_browser",
    label: "dev_browser",
    description:
      "Run sandboxed JavaScript in a named persistent dev-browser profile, inspect global daemon state, or explicitly stop the daemon and all managed browser connections while preserving profile directories.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      return executeDevBrowser(input, ctx.cwd, signal);
    },
  });
}
