/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are explicit Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-json-parse -- TypeBox validates the fake process output immediately. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- The guard makes failed fixture decoding fail the test. */
/* eslint-disable ziggy-effect/no-error-constructor -- The guard makes failed fixture decoding fail the test. */
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import registerOpenComputerUse from "../index";

const fixtures: string[] = [];

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for process fixture");
};

const Output = Type.Object(
  {
    success: Type.Boolean(),
    action: Type.String(),
    data: Type.Object(
      {
        screenshot: Type.Object({ screenshot_path: Type.String() }),
      },
      { additionalProperties: true },
    ),
    screenshots: Type.Tuple([Type.String()]),
  },
  { additionalProperties: true },
);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("registers the native open_computer_use tool", () => {
  const names: string[] = [];
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    names.push(tool.name);
  };

  registerOpenComputerUse({ registerTool });

  expect(names).toEqual(["open_computer_use"]);
});

test("cleans a calls file when open-computer-use is missing", async () => {
  const profile = await mkdtemp(join(tmpdir(), "computer-use-missing-"));
  fixtures.push(profile);
  const emptyBin = join(profile, "empty-bin");
  await mkdir(emptyBin);

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "bin", "open-computer-use-wrapper.mjs")],
    {
      cwd: profile,
      env: { ...process.env, PATH: emptyBin, ZIGGY_PROFILE_PATH: profile },
      stdin: new Blob([
        JSON.stringify({ action: "calls", calls: [{ tool: "list_apps", args: {} }] }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const parsed: unknown = JSON.parse(stdout);

  expect(exitCode).toBe(1);
  expect(parsed).toMatchObject({ success: false, error: "open-computer-use is not installed" });
  expect(await readdir(join(profile, ".runtime", "open-computer-use", "temp"))).toEqual([]);
});

test("terminates an uncooperative open-computer-use process group on SIGTERM", async () => {
  if (process.platform === "win32") return;
  const profile = await mkdtemp(join(tmpdir(), "computer-use-lifetime-"));
  fixtures.push(profile);
  const fakeBin = join(profile, "fake-bin");
  const marker = join(profile, "descendant.pid");
  await mkdir(fakeBin);
  const fakeExecutable = join(fakeBin, "open-computer-use");
  await Bun.write(
    fakeExecutable,
    `#!/usr/bin/env bun
const descendant = Bun.spawn(["bash", "-c", 'trap : TERM INT; echo $$ > "$DESCENDANT_MARKER"; while :; do sleep 1; done'], { stdout: "ignore", stderr: "ignore" });
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
await new Promise(() => {});
`,
  );
  await chmod(fakeExecutable, 0o755);

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "bin", "open-computer-use-wrapper.mjs")],
    {
      cwd: profile,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ZIGGY_PROFILE_PATH: profile,
        DESCENDANT_MARKER: marker,
      },
      stdin: new Blob([JSON.stringify({ action: "doctor" })]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await waitFor(() => Bun.file(marker).exists());
  const descendantPid = Number((await readFile(marker, "utf8")).trim());

  child.kill("SIGTERM");
  await child.exited;
  await waitFor(() => !processExists(descendantPid));
  expect(processExists(descendantPid)).toBe(false);
});

test("extracts screenshots beneath the Profile runtime", async () => {
  const profile = await mkdtemp(join(tmpdir(), "computer-use-profile-"));
  fixtures.push(profile);
  const fakeBin = join(profile, "fake-bin");
  await mkdir(fakeBin);
  const fakeExecutable = join(fakeBin, "open-computer-use");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]).toString(
    "base64",
  );
  await Bun.write(
    fakeExecutable,
    `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ screenshot: ${JSON.stringify(png)} }));
`,
  );
  await chmod(fakeExecutable, 0o755);

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "bin", "open-computer-use-wrapper.mjs")],
    {
      cwd: profile,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ZIGGY_PROFILE_PATH: profile,
      },
      stdin: new Blob([JSON.stringify({ action: "get_app_state", app: "TextEdit" })]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const parsed: unknown = JSON.parse(stdout);

  expect(exitCode).toBe(0);
  expect(Check(Output, parsed)).toBe(true);
  if (!Check(Output, parsed)) throw new Error("wrapper returned an invalid response");
  expect(parsed.success).toBe(true);
  expect(parsed.action).toBe("get_app_state");
  expect(parsed.screenshots).toHaveLength(1);
  expect(parsed.data.screenshot.screenshot_path).toBe(parsed.screenshots[0]);
  expect(parsed.screenshots[0]?.startsWith(".runtime/open-computer-use/screenshots/")).toBe(true);
  expect((await stat(join(profile, parsed.screenshots[0] ?? ""))).isFile()).toBe(true);
});
