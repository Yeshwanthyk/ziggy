#!/usr/bin/env node
/* eslint-disable ziggy-effect/no-native-promise-ownership -- This executable owns stdin and child-process Promise boundaries. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- This executable converts parse, image, cleanup, and process failures into JSON exit responses. */
/* eslint-disable ziggy-effect/no-json-parse -- The Pi tool validates input with its exact TypeBox schema before this executable. */
/* eslint-disable ziggy-effect/no-promise-catch -- This executable converts its stdin rejection into a process exit response. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 14 * 1024;
const CAPTURE_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 500;
const TRUNCATION_HINT = "re-run get_app_state with a narrower target";
const IMAGE_KEY_RE = /^(screenshot|image|png|data)$/i;

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

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireField(input, key) {
  if (!hasOwn(input, key) || input[key] === null || input[key] === undefined || input[key] === "") {
    fail(`${input.action} requires ${key}`);
  }
}

function addIfPresent(target, input, key) {
  if (hasOwn(input, key) && input[key] !== undefined && input[key] !== null) {
    target[key] = key === "element_index" ? String(input[key]) : input[key];
  }
}

function toolFor(action) {
  return action === "secondary" ? "perform_secondary_action" : action;
}

function argsFor(input) {
  const action = asString(input.action);
  const args = {};
  switch (action) {
    case "list_apps":
      return args;
    case "get_app_state":
      requireField(input, "app");
      for (const key of ["app", "text_limit", "max_tree_nodes", "max_tree_depth"]) {
        addIfPresent(args, input, key);
      }
      return args;
    case "click":
      requireField(input, "app");
      for (const key of ["app", "element_index", "x", "y", "click_count", "mouse_button"]) {
        addIfPresent(args, input, key);
      }
      if (!hasOwn(args, "element_index") && (!hasOwn(args, "x") || !hasOwn(args, "y"))) {
        fail("click requires element_index or x and y");
      }
      return args;
    case "secondary":
      requireField(input, "app");
      requireField(input, "element_index");
      requireField(input, "secondary_action");
      args.app = input.app;
      args.element_index = String(input.element_index);
      args.action = input.secondary_action;
      return args;
    case "scroll":
      requireField(input, "app");
      requireField(input, "element_index");
      requireField(input, "direction");
      for (const key of ["app", "element_index", "direction", "pages"]) {
        addIfPresent(args, input, key);
      }
      return args;
    case "drag":
      requireField(input, "app");
      for (const key of ["from_x", "from_y", "to_x", "to_y"]) requireField(input, key);
      for (const key of ["app", "from_x", "from_y", "to_x", "to_y"]) {
        addIfPresent(args, input, key);
      }
      return args;
    case "type_text":
      requireField(input, "app");
      requireField(input, "text");
      for (const key of ["app", "text"]) addIfPresent(args, input, key);
      return args;
    case "press_key":
      requireField(input, "app");
      requireField(input, "key");
      for (const key of ["app", "key"]) addIfPresent(args, input, key);
      return args;
    case "set_value":
      requireField(input, "app");
      requireField(input, "element_index");
      requireField(input, "value");
      for (const key of ["app", "element_index", "value"]) addIfPresent(args, input, key);
      return args;
    default:
      fail(`unsupported action: ${action}`);
  }
}

function commandFor(input, tempDirectory, tempFiles) {
  const action = asString(input.action);
  switch (action) {
    case "doctor":
      return ["doctor"];
    case "calls": {
      if (!Array.isArray(input.calls) || input.calls.length === 0) {
        fail("calls requires a non-empty calls array");
      }
      const callsFile = path.join(tempDirectory, `calls-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(callsFile, JSON.stringify(input.calls), "utf8");
      tempFiles.push(callsFile);
      return ["call", "--calls-file", callsFile];
    }
    default:
      return ["call", toolFor(action), "--args", JSON.stringify(argsFor(input))];
  }
}

function outputPathFor(profilePath, screenshotDirectory, index) {
  const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${index}.png`;
  const absolute = path.join(screenshotDirectory, file);
  const relative = path.relative(profilePath, absolute);
  return { absolute, display: relative.startsWith("..") ? absolute : relative };
}

function stripDataUrl(value) {
  const match = /^data:image\/png;base64,(.+)$/i.exec(value.trim());
  return (match ? match[1] : value).replace(/\s+/g, "");
}

function looksLikePngBase64(value) {
  if (typeof value !== "string" || value.length < 32) return false;
  const raw = stripDataUrl(value);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw) || raw.length % 4 !== 0) return false;
  try {
    const buffer = Buffer.from(raw, "base64");
    return (
      buffer.length > 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  } catch {
    return false;
  }
}

function writeScreenshot(value, state) {
  const target = outputPathFor(
    state.profilePath,
    state.screenshotDirectory,
    state.screenshots.length,
  );
  fs.writeFileSync(target.absolute, Buffer.from(stripDataUrl(value), "base64"));
  state.screenshots.push(target.display);
  return { screenshot_path: target.display };
}

function replaceImages(value, state, parentKey = "") {
  if (typeof value === "string") {
    if (
      (IMAGE_KEY_RE.test(parentKey) || parentKey.toLowerCase().includes("screenshot")) &&
      looksLikePngBase64(value)
    ) {
      return writeScreenshot(value, state);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceImages(item, state));
  if (value && typeof value === "object") {
    if (
      value.type === "image" &&
      typeof value.data === "string" &&
      looksLikePngBase64(value.data)
    ) {
      return { ...value, data: writeScreenshot(value.data, state) };
    }
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = replaceImages(child, state, key);
    }
    return next;
  }
  return value;
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

function truncateString(value, budget) {
  const omitted = Math.max(0, Buffer.byteLength(value) - budget);
  const marker = `\n[truncated: ${omitted} bytes omitted - ${TRUNCATION_HINT}]`;
  const keep = Math.max(0, budget - Buffer.byteLength(marker));
  return Buffer.from(value).subarray(0, keep).toString() + marker;
}

function findLongestString(value, parent = null, key = null, best = null) {
  if (typeof value === "string") {
    if (!best || Buffer.byteLength(value) > Buffer.byteLength(best.value)) {
      return { parent, key, value };
    }
    return best;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (current, child, index) => findLongestString(child, value, index, current),
      best,
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce(
      (current, [childKey, child]) => findLongestString(child, value, childKey, current),
      best,
    );
  }
  return best;
}

function truncateObjectStrings(value) {
  const clone = structuredClone(value);
  while (Buffer.byteLength(JSON.stringify(clone)) > OUTPUT_LIMIT) {
    const candidate = findLongestString(clone);
    if (!candidate || candidate.value.length < 512) break;
    const excess = Buffer.byteLength(JSON.stringify(clone)) - OUTPUT_LIMIT + 512;
    const keep = Math.max(128, candidate.value.length - excess);
    candidate.parent[candidate.key] = truncateString(candidate.value, keep);
  }
  return clone;
}

function truncateLargeText(value) {
  let encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= OUTPUT_LIMIT) return value;
  if (typeof value.output === "string") {
    value.output = truncateString(value.output, Math.max(1024, OUTPUT_LIMIT - 1024));
    return value;
  }
  if (value.data && typeof value.data === "object") value.data = truncateObjectStrings(value.data);
  encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= OUTPUT_LIMIT) return value;
  return {
    success: value.success,
    action: value.action,
    screenshots: value.screenshots,
    output: truncateString(encoded, OUTPUT_LIMIT - 512),
  };
}

function appendBounded(current, chunk) {
  if (Buffer.byteLength(current) >= CAPTURE_LIMIT) return current;
  const remaining = CAPTURE_LIMIT - Buffer.byteLength(current);
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
const packageRuntime = path.join(profilePath, ".runtime", "open-computer-use");
const screenshotDirectory = path.join(packageRuntime, "screenshots");
const tempDirectory = path.join(packageRuntime, "temp");
const tempFiles = [];
fs.mkdirSync(screenshotDirectory, { recursive: true });
fs.mkdirSync(tempDirectory, { recursive: true });

function cleanupTempFiles() {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Best-effort cleanup.
    }
  }
}

const child = spawn("open-computer-use", commandFor(input, tempDirectory, tempFiles), {
  cwd: profilePath,
  env: process.env,
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
  cleanupTempFiles();
  const message =
    error?.code === "ENOENT"
      ? "open-computer-use is not installed"
      : String(error?.message ?? error);
  process.stdout.write(
    `${JSON.stringify({
      success: false,
      action: input.action ?? "get_app_state",
      error: message,
    })}\n`,
  );
  process.exit(1);
});
child.on("exit", (code) => {
  cleanupTermination();
  cleanupTempFiles();
  const state = { profilePath, screenshotDirectory, screenshots: [] };
  const cleaned = replaceImages(parseOutput(stdout), state);
  const response = truncateLargeText({
    success: code === 0,
    action: input.action ?? "get_app_state",
    ...cleaned,
    ...(state.screenshots.length ? { screenshots: state.screenshots } : {}),
    ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(code ?? 1);
});
