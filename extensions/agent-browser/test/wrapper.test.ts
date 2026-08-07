/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are explicit Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-json-parse -- TypeBox validates the fake process output immediately. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- The guard makes failed fixture decoding fail the test. */
/* eslint-disable ziggy-effect/no-error-constructor -- The guard makes failed fixture decoding fail the test. */
import { chmod, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import registerAgentBrowser from "../index";

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
    browserProfile: Type.String(),
    session: Type.String(),
    data: Type.Object(
      {
        args: Type.Array(Type.String()),
        cwd: Type.String(),
        profile: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("registers the native agent_browser tool", () => {
  const names: string[] = [];
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    names.push(tool.name);
  };

  registerAgentBrowser({ registerTool });

  expect(names).toEqual(["agent_browser"]);
});

test("terminates an uncooperative agent-browser process group on SIGTERM", async () => {
  if (process.platform === "win32") return;
  const profile = await mkdtemp(join(tmpdir(), "agent-browser-lifetime-"));
  fixtures.push(profile);
  const fakeBin = join(profile, "fake-bin");
  const marker = join(profile, "descendant.pid");
  await mkdir(fakeBin);
  const fakeExecutable = join(fakeBin, "agent-browser");
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
    [process.execPath, join(import.meta.dir, "..", "bin", "agent-browser-wrapper.mjs")],
    {
      cwd: profile,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ZIGGY_PROFILE_PATH: profile,
        DESCENDANT_MARKER: marker,
      },
      stdin: new Blob([JSON.stringify({ action: "status" })]),
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

test("uses the Profile cwd and persistent package runtime", async () => {
  const profile = await mkdtemp(join(tmpdir(), "agent-browser-profile-"));
  fixtures.push(profile);
  const fakeBin = join(profile, "fake-bin");
  await mkdir(fakeBin);
  const fakeExecutable = join(fakeBin, "agent-browser");
  await Bun.write(
    fakeExecutable,
    `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  profile: process.env.AGENT_BROWSER_PROFILE
}));
`,
  );
  await chmod(fakeExecutable, 0o755);

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "bin", "agent-browser-wrapper.mjs")],
    {
      cwd: profile,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ZIGGY_PROFILE_PATH: profile,
      },
      stdin: new Blob([JSON.stringify({ action: "open", url: "https://example.com" })]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const parsed: unknown = JSON.parse(stdout);

  expect(exitCode).toBe(0);
  expect(Check(Output, parsed)).toBe(true);
  if (!Check(Output, parsed)) throw new Error("wrapper returned an invalid response");
  const processCwd = await realpath(profile);
  const browserProfile = join(profile, ".runtime", "agent-browser", "browser-profile");
  expect(parsed).toEqual({
    success: true,
    action: "open",
    browserProfile,
    session: "desktop-main",
    data: {
      args: [
        "--session",
        "desktop-main",
        "--profile",
        browserProfile,
        "--json",
        "open",
        "https://example.com",
      ],
      cwd: processCwd,
      profile: browserProfile,
    },
  });
});
