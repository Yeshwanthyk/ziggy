/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are explicit Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- Process fixture probes and expected tool failures require catches. */
/* eslint-disable ziggy-effect/no-error-constructor -- Test guards turn invalid fixtures into explicit failures. */
/* eslint-disable ziggy-effect/no-json-parse -- Parsed fake-CLI output is checked before use. */
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import registerDevBrowser, { executeDevBrowser, managedBrowserName, Parameters } from "../index";

type ToolInput =
  | {
      readonly action: "execute";
      readonly profile: string;
      readonly script: string;
      readonly headless?: boolean;
      readonly connect?: boolean;
      readonly idleTimeout?: string;
    }
  | { readonly action: "browsers" | "status" }
  | { readonly action: "stop"; readonly confirmed: true };

type ToolResult = {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details: unknown;
};

const Invocation = Type.Object(
  {
    args: Type.Array(Type.String()),
    cwd: Type.String(),
    stdin: Type.String(),
  },
  { additionalProperties: false },
);

const fixtures: string[] = [];
const originalBinary = process.env.ZIGGY_DEV_BROWSER_BIN;
const originalDescendantMarker = process.env.DESCENDANT_MARKER;

afterEach(async () => {
  if (originalBinary === undefined) delete process.env.ZIGGY_DEV_BROWSER_BIN;
  else process.env.ZIGGY_DEV_BROWSER_BIN = originalBinary;
  if (originalDescendantMarker === undefined) delete process.env.DESCENDANT_MARKER;
  else process.env.DESCENDANT_MARKER = originalDescendantMarker;
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

const fixtureDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
};

const fakeCli = async (directory: string, source?: string): Promise<string> => {
  const executable = join(directory, "fake-dev-browser");
  await Bun.write(
    executable,
    source ??
      `#!/usr/bin/env bun
const stdin = await Bun.stdin.text();
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }));
`,
  );
  await chmod(executable, 0o755);
  return executable;
};

const invoke = async (cwd: string, input: ToolInput, signal?: AbortSignal): Promise<ToolResult> =>
  executeDevBrowser(input, cwd, signal);

const invocationFrom = (result: ToolResult): Static<typeof Invocation> => {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("tool returned no text");
  const parsed: unknown = JSON.parse(text);
  if (!Check(Invocation, parsed)) throw new Error("fake CLI returned an invalid invocation");
  return parsed;
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for process fixture");
};

test("registers one strict dev_browser tool schema", () => {
  const names: string[] = [];
  const registerTool: ExtensionAPI["registerTool"] = (tool) => names.push(tool.name);
  registerDevBrowser({ registerTool });
  expect(names).toEqual(["dev_browser"]);
  expect(
    Check(Parameters, {
      action: "execute",
      profile: "signed-in-shop",
      script: "console.log(await page.title())",
      headless: false,
      connect: true,
      idleTimeout: "5m",
    }),
  ).toBe(true);
  expect(
    Check(Parameters, {
      action: "execute",
      profile: "shop",
      script: "1",
      connect: "http://localhost:9222",
    }),
  ).toBe(false);
  expect(Check(Parameters, { action: "stop" })).toBe(false);
  expect(Check(Parameters, { action: "stop", confirmed: false })).toBe(false);
  expect(Check(Parameters, { action: "status", extra: true })).toBe(false);
});

test("passes execute flags and script through stdin from the Profile cwd", async () => {
  const profile = await fixtureDirectory("dev-browser-profile-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(profile);
  const script = `const page = await browser.getPage("main");\nconsole.log(await page.title());`;
  const result = await invoke(profile, {
    action: "execute",
    profile: "signed-in-shop",
    script,
    headless: true,
    connect: true,
    idleTimeout: "5m",
  });
  const actualCwd = await realpath(profile);

  expect(invocationFrom(result)).toEqual({
    args: [
      "--browser",
      managedBrowserName(profile, "signed-in-shop"),
      "--headless",
      "--connect",
      "--idle-timeout",
      "5m",
    ],
    cwd: actualCwd,
    stdin: script,
  });
  expect(result.details).toEqual({
    action: "execute",
    profile: "signed-in-shop",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
});

test("keeps headed execution flag-free and rejects an idle timeout over 24h", async () => {
  const profile = await fixtureDirectory("dev-browser-headed-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(profile);
  const result = await invoke(profile, {
    action: "execute",
    profile: "headed",
    script: "console.log('ok')",
    headless: false,
    connect: false,
  });

  expect(invocationFrom(result).args).toEqual(["--browser", managedBrowserName(profile, "headed")]);
  await expect(
    invoke(profile, {
      action: "execute",
      profile: "headed",
      script: "1",
      idleTimeout: "25h",
    }),
  ).rejects.toThrow("idleTimeout must be at most 24h");
});

test("reports when an older installed CLI lacks idle cleanup support", async () => {
  const profile = await fixtureDirectory("dev-browser-old-cli-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(
    profile,
    `#!/usr/bin/env bun
process.stderr.write("error: unexpected argument '--idle-timeout' found\\n");
process.exit(2);
`,
  );

  await expect(
    invoke(profile, {
      action: "execute",
      profile: "acceptance",
      script: "1",
      idleTimeout: "5m",
    }),
  ).rejects.toThrow("Upgrade dev-browser to 0.2.9 or newer");
});

test("namespaces a logical browser profile by Ziggy Profile cwd", async () => {
  const first = await fixtureDirectory("dev-browser-a-");
  const second = await fixtureDirectory("dev-browser-b-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(first);
  const input: ToolInput = { action: "execute", profile: "account", script: "1" };
  const firstName = invocationFrom(await invoke(first, input)).args[1];
  const repeatedName = invocationFrom(await invoke(first, input)).args[1];
  const secondName = invocationFrom(await invoke(second, input)).args[1];

  expect(firstName).toBe(repeatedName);
  expect(firstName).not.toBe(secondName);
  expect(firstName).toMatch(/^ziggy-account-[a-f0-9]{20}$/);
});

test("runs bounded global browsers and status maintenance commands", async () => {
  const profile = await fixtureDirectory("dev-browser-maintenance-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(profile);

  expect(invocationFrom(await invoke(profile, { action: "browsers" }))).toEqual({
    args: ["browsers"],
    cwd: await realpath(profile),
    stdin: "",
  });
  expect(invocationFrom(await invoke(profile, { action: "status" }))).toEqual({
    args: ["status"],
    cwd: await realpath(profile),
    stdin: "",
  });
});

test("requires stop confirmation and explains its global but non-deleting effect", async () => {
  const profile = await fixtureDirectory("dev-browser-stop-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(profile);

  const result = await invoke(profile, { action: "stop", confirmed: true });
  expect(result.content[0]?.text).toContain("all managed browser connections");
  expect(result.content[0]?.text).toContain("profile directories were preserved");
});

test("bounds successful output and failed stdout and stderr", async () => {
  const profile = await fixtureDirectory("dev-browser-output-");
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(
    profile,
    `#!/usr/bin/env bun
process.stdout.write("x".repeat(100000));
`,
  );
  const success = await invoke(profile, { action: "status" });
  expect(success.content[0]?.text).toContain("[output truncated]");
  expect(success.content[0]?.text.length).toBeLessThan(25_000);

  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(
    profile,
    `#!/usr/bin/env bun
process.stdout.write("o".repeat(100000));
process.stderr.write("e".repeat(100000));
process.exit(7);
`,
  );
  let message = "";
  try {
    await invoke(profile, { action: "browsers" });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("exited with code 7");
  expect(message.match(/\[output truncated\]/g)?.length).toBe(2);
  expect(message.length).toBeLessThan(50_000);
});

test("cancellation terminates an uncooperative CLI process tree", async () => {
  if (process.platform === "win32") return;
  const profile = await fixtureDirectory("dev-browser-cancel-");
  const marker = join(profile, "descendant.pid");
  process.env.DESCENDANT_MARKER = marker;
  process.env.ZIGGY_DEV_BROWSER_BIN = await fakeCli(
    profile,
    `#!/usr/bin/env bun
Bun.spawn(["bash", "-c", 'trap : TERM INT; echo $$ > "$DESCENDANT_MARKER"; while :; do sleep 1; done'], { stdout: "ignore", stderr: "ignore" });
process.on("SIGTERM", () => {});
await new Promise(() => {});
`,
  );
  const controller = new AbortController();
  const running = invoke(
    profile,
    { action: "execute", profile: "cancel", script: "1" },
    controller.signal,
  );
  await waitFor(() => Bun.file(marker).exists());
  const descendantPid = Number((await readFile(marker, "utf8")).trim());

  controller.abort();
  await expect(running).rejects.toThrow("dev_browser was cancelled");
  await waitFor(() => !processExists(descendantPid));
  expect(processExists(descendantPid)).toBe(false);
});

test("reports a missing configured CLI without invoking a shell", async () => {
  const profile = await fixtureDirectory("dev-browser-missing-");
  const missing = join(profile, "dev-browser; echo should-not-run");
  process.env.ZIGGY_DEV_BROWSER_BIN = missing;

  await expect(invoke(profile, { action: "status" })).rejects.toThrow(`failed to start ${missing}`);
});
