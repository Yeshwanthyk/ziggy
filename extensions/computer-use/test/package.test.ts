/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun and Pi loader tests are explicit Promise execution boundaries. */
import { chmod, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

const packageRoot = join(import.meta.dir, "..");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("declares the concrete Pi 0.84.1 entrypoint and expected tool surface", async () => {
  const manifest = await Bun.file(join(packageRoot, "package.json")).json();
  const source = await readFile(
    join(packageRoot, "dist", "extensions", "computer-use.mts"),
    "utf8",
  );
  const names = [...source.matchAll(/name:\s*"([a-z_]+)"/gu)].map((match) => match[1]);

  expect(manifest).toMatchObject({
    name: "@ziggy/computer-use",
    version: "0.5.0",
    pi: { extensions: ["./index.ts"] },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "0.84.1",
      typebox: "1.3.7",
    },
  });
  expect(names).toEqual([
    "find_roots",
    "observe_ui",
    "search_ui",
    "expand_ui",
    "inspect_ui",
    "act_ui",
    "read_text",
    "wait_for",
    "launch_browser",
    "navigate_browser",
    "evaluate_browser",
  ]);
});

test("loads the upstream tools and Ziggy segment tool through Pi 0.84.1's public loader", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ziggy-computer-use-loader-"));
  fixtures.push(fixture);
  const loaded = await discoverAndLoadExtensions([packageRoot], packageRoot, fixture);

  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect(loaded.extensions.map((extension) => [...extension.tools.keys()])).toEqual([
    [
      "find_roots",
      "observe_ui",
      "search_ui",
      "expand_ui",
      "inspect_ui",
      "act_ui",
      "read_text",
      "wait_for",
      "launch_browser",
      "navigate_browser",
      "evaluate_browser",
      "run_ui_segment",
    ],
  ]);
  const segmentSchemas = loaded.extensions.flatMap((extension) => {
    const tool = extension.tools.get("run_ui_segment");
    return tool === undefined ? [] : [tool.definition.parameters];
  });
  const steps = [
    {
      target: { text: "Save" },
      actions: [{ action: "click" }],
      expect: { text: "Saved", until: "present" },
    },
  ];
  expect(
    segmentSchemas.map((schema) => ({
      semantic: Check(schema, { rootQuery: { app: "TextEdit", kind: "window" }, steps }),
      assertion: Check(schema, {
        rootQuery: { app: "Google Chrome", kind: "window" },
        steps: [{ assert: { text: "Signed in", until: "present" } }],
      }),
      mixedStep: Check(schema, {
        steps: [
          {
            assert: { text: "Signed in", until: "present" },
            target: { text: "Save" },
            actions: [{ action: "click" }],
            expect: { text: "Saved", until: "present" },
          },
        ],
      }),
      empty: Check(schema, { rootQuery: {}, steps }),
      pid: Check(schema, { rootQuery: { pid: 42 }, steps }),
      ref: Check(schema, { rootQuery: { ref: "@r1" }, steps }),
    })),
  ).toEqual([
    {
      semantic: true,
      assertion: true,
      mixedStep: false,
      empty: false,
      pid: false,
      ref: false,
    },
  ]);
});

test("retains the upstream license and native helper payloads", async () => {
  const license = await readFile(join(packageRoot, "LICENSE"), "utf8");
  const macosHelper = await stat(
    join(
      packageRoot,
      "prebuilt",
      "macos",
      "universal",
      "pi-computer-use.app",
      "Contents",
      "MacOS",
      "bridge",
    ),
  );
  const linuxArm64 = await stat(join(packageRoot, "prebuilt", "linux", "arm64", "linux-bridge"));
  const linuxX64 = await stat(join(packageRoot, "prebuilt", "linux", "x64", "linux-bridge"));

  expect(license).toContain("MIT License");
  expect(macosHelper.isFile()).toBe(true);
  expect(linuxArm64.isFile()).toBe(true);
  expect(linuxX64.isFile()).toBe(true);
});

test("installs the published macOS helper into an isolated destination", async () => {
  if (process.platform !== "darwin") return;
  const fixture = await mkdtemp(join(tmpdir(), "ziggy-computer-use-"));
  fixtures.push(fixture);
  const stagedPackage = join(fixture, "package");
  await cp(packageRoot, stagedPackage, { recursive: true });
  await chmod(
    join(
      stagedPackage,
      "prebuilt",
      "macos",
      "universal",
      "pi-computer-use.app",
      "Contents",
      "MacOS",
      "bridge",
    ),
    0o644,
  );
  const helperPath = join(fixture, "pi-computer-use.app");
  const child = Bun.spawn(
    [process.execPath, join(stagedPackage, "scripts", "setup-helper.mjs"), "--runtime"],
    {
      cwd: stagedPackage,
      env: { ...process.env, PI_COMPUTER_USE_HELPER_APP_PATH: helperPath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(exitCode, stderr).toBe(0);
  const executable = await stat(join(helperPath, "Contents", "MacOS", "bridge"));
  expect((executable.mode & 0o111) !== 0).toBe(true);
});
