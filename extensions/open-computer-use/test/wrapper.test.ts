/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are explicit Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-json-parse -- TypeBox validates the fake process output immediately. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- The guard makes failed fixture decoding fail the test. */
/* eslint-disable ziggy-effect/no-error-constructor -- The guard makes failed fixture decoding fail the test. */
import { chmod, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import registerOpenComputerUse from "../index";

const fixtures: string[] = [];
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
