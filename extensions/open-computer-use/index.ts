/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution and child_process are Promise adapter boundaries. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi marks rejected tool Promises as tool failures. */
/* eslint-disable ziggy-effect/no-unknown-error-message -- child_process emits a typed Error at this adapter boundary. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 24 * 1024;
const executable = fileURLToPath(new URL("./bin/open-computer-use-wrapper.mjs", import.meta.url));

const Call = Type.Object(
  {
    tool: Type.String(),
    args: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { additionalProperties: false },
);

const Parameters = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("doctor"),
        Type.Literal("list_apps"),
        Type.Literal("get_app_state"),
        Type.Literal("click"),
        Type.Literal("secondary"),
        Type.Literal("scroll"),
        Type.Literal("drag"),
        Type.Literal("type_text"),
        Type.Literal("press_key"),
        Type.Literal("set_value"),
        Type.Literal("calls"),
      ],
      { description: "Open Computer Use action to run." },
    ),
    app: Type.Optional(Type.String({ description: "App name or bundle identifier." })),
    element_index: Type.Optional(Type.Integer({ description: "Latest snapshot element index." })),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
    click_count: Type.Optional(Type.Integer({ minimum: 1 })),
    mouse_button: Type.Optional(
      Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]),
    ),
    from_x: Type.Optional(Type.Number()),
    from_y: Type.Optional(Type.Number()),
    to_x: Type.Optional(Type.Number()),
    to_y: Type.Optional(Type.Number()),
    direction: Type.Optional(
      Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ]),
    ),
    pages: Type.Optional(Type.Number()),
    text: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    value: Type.Optional(Type.String()),
    secondary_action: Type.Optional(Type.String()),
    text_limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("max")])),
    max_tree_nodes: Type.Optional(Type.Integer({ minimum: 1 })),
    max_tree_depth: Type.Optional(Type.Integer({ minimum: 1 })),
    calls: Type.Optional(Type.Array(Call)),
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
      reject(new Error(`open_computer_use failed to start: ${cause.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      const streams = `stdout:\n${display(stdout) || "(empty)"}\nstderr:\n${display(stderr) || "(empty)"}`;
      if (cancelled) return reject(new Error(`open_computer_use was cancelled.\n${streams}`));
      if (timedOut)
        return reject(new Error(`open_computer_use timed out after ${TIMEOUT_MS}ms.\n${streams}`));
      if (code !== 0)
        return reject(
          new Error(`open_computer_use exited with code ${code ?? "unknown"}.\n${streams}`),
        );
      resolve({ stdout: display(stdout), stderr: display(stderr) });
    });
    child.stdin.end(JSON.stringify(input));
  });

export default function openComputerUse(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool({
    name: "open_computer_use",
    label: "open_computer_use",
    description:
      "Call Open Computer Use desktop automation tools. Base64 screenshots are saved as Profile-local files.",
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
