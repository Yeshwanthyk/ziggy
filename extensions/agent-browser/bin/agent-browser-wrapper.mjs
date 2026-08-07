#!/usr/bin/env node
/* eslint-disable ziggy-effect/no-native-promise-ownership -- This executable owns stdin and child-process Promise boundaries. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- This executable converts parse and process failures into JSON exit responses. */
/* eslint-disable ziggy-effect/no-json-parse -- The Pi tool validates input with its exact TypeBox schema before this executable. */
/* eslint-disable ziggy-effect/no-promise-catch -- This executable converts its stdin rejection into a process exit response. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 500;

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(body.trim()));
  });
}

function fail(message, details = {}) {
  process.stdout.write(`${JSON.stringify({ success: false, error: message, ...details })}\n`);
  process.exit(1);
}

function asString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function normalizeRef(ref) {
  if (!ref) return "";
  return ref.startsWith("@") ? ref : `@${ref.replace(/^@+/, "")}`;
}

function target(input) {
  return asString(input.selector) || normalizeRef(asString(input.ref));
}

function sessionName(input) {
  const raw = asString(input.session, "desktop-main");
  const clean = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "desktop-main";
}

function commandFor(input, screenshotDir) {
  const action = asString(input.action, "status");
  switch (action) {
    case "status":
      return ["session", "list"];
    case "open":
      return asString(input.url) ? ["open", asString(input.url)] : ["open"];
    case "read":
      return asString(input.url) ? ["read", asString(input.url)] : ["read"];
    case "snapshot":
      return ["snapshot", ...(input.interactive ? ["-i"] : [])];
    case "screenshot":
      return [
        "screenshot",
        ...(input.full ? ["--full"] : []),
        asString(input.path, path.join(screenshotDir, `${Date.now()}.png`)),
      ];
    case "get": {
      const what = asString(input.what, "text");
      const args = ["get", what];
      if (target(input)) args.push(target(input));
      if (what === "attr" && asString(input.attr)) args.push(asString(input.attr));
      return args;
    }
    case "click":
    case "dblclick":
    case "focus":
    case "hover": {
      const selected = target(input);
      if (!selected) fail(`${action} requires selector or ref`);
      return [action, selected];
    }
    case "fill": {
      const selected = target(input);
      if (!selected) fail("fill requires selector or ref");
      return ["fill", selected, String(input.text ?? "")];
    }
    case "type":
      return target(input)
        ? ["type", target(input), String(input.text ?? "")]
        : ["type", String(input.text ?? "")];
    case "press": {
      const key = asString(input.key);
      if (!key) fail("press requires key");
      return ["press", key];
    }
    case "scroll":
      return [
        "scroll",
        asString(input.direction, "down"),
        ...(Number.isFinite(input.amount) ? [String(input.amount)] : []),
      ];
    case "eval": {
      const code = asString(input.code) || asString(input.text);
      if (!code) fail("eval requires code or text");
      return ["eval", code];
    }
    case "back":
      return ["back"];
    case "tab":
      return ["tab", asString(input.tab, "list")];
    case "close":
      return ["close"];
    case "skills":
      return ["skills", "get", asString(input.name, "core"), ...(input.full ? ["--full"] : [])];
    case "raw": {
      const args = asStringArray(input.args);
      if (args.length === 0) fail("raw requires non-empty args");
      return args;
    }
    default:
      fail(`unsupported action: ${action}`);
  }
}

function parseOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return {};
  try {
    return { data: JSON.parse(trimmed) };
  } catch {
    return { output: trimmed };
  }
}

function appendBounded(current, chunk) {
  if (Buffer.byteLength(current) >= OUTPUT_LIMIT) return current;
  const remaining = OUTPUT_LIMIT - Buffer.byteLength(current);
  return current + Buffer.from(chunk).subarray(0, remaining).toString();
}

const raw = await readStdin().catch((error) => fail(String(error?.message ?? error)));
let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch (error) {
  fail(`invalid stdin JSON: ${error?.message ?? error}`);
}

const profilePath = asString(process.env.ZIGGY_PROFILE_PATH, process.cwd());
const packageRuntime = path.join(profilePath, ".runtime", "agent-browser");
const browserProfile = path.join(packageRuntime, "browser-profile");
const screenshotDir = path.join(packageRuntime, "screenshots");
fs.mkdirSync(browserProfile, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const session = sessionName(input);
const args = [
  "--session",
  session,
  "--profile",
  browserProfile,
  "--json",
  ...(input.headed ? ["--headed"] : []),
  ...commandFor(input, screenshotDir),
];
const child = spawn("agent-browser", args, {
  cwd: profilePath,
  env: {
    ...process.env,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_PROFILE: browserProfile,
  },
  detached: process.platform !== "win32",
});

let terminationStarted = false;
let escalation;
function signalChildTree(signal) {
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
}
function terminateChild() {
  if (terminationStarted) return;
  terminationStarted = true;
  signalChildTree("SIGTERM");
  escalation = setTimeout(() => signalChildTree("SIGKILL"), TERMINATION_GRACE_MS);
  escalation.unref();
}
function cleanupTermination() {
  if (escalation !== undefined) clearTimeout(escalation);
}
for (const event of ["SIGINT", "SIGTERM"]) {
  process.once(event, terminateChild);
}

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout = appendBounded(stdout, chunk);
});
child.stderr.on("data", (chunk) => {
  stderr = appendBounded(stderr, chunk);
});
child.on("error", (error) => {
  cleanupTermination();
  process.stdout.write(
    `${JSON.stringify({
      success: false,
      action: input.action ?? "status",
      browserProfile,
      session,
      error: String(error?.message ?? error),
    })}\n`,
  );
  process.exit(1);
});
child.on("exit", (code) => {
  cleanupTermination();
  process.stdout.write(
    `${JSON.stringify({
      success: code === 0,
      action: input.action ?? "status",
      browserProfile,
      session,
      ...parseOutput(stdout),
      ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
    })}\n`,
  );
  process.exit(code ?? 1);
});
