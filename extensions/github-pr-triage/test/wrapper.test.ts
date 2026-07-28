/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests and the fake pi.exec are Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-json-parse -- This parses deterministic fake-command output. */
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerGithubPrTriage, { runGithubPrTriage } from "../index";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("registers the native gh_prs tool", () => {
  const names: string[] = [];
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    names.push(tool.name);
  };
  const exec: ExtensionAPI["exec"] = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });

  registerGithubPrTriage({ exec, registerTool });

  expect(names).toEqual(["gh_prs"]);
});

test("runs the package-relative helper through pi.exec with the Profile boundary", async () => {
  const profile = "/tmp/gh-prs-profile";
  const controller = new AbortController();
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    signal: AbortSignal | undefined;
    timeout: number | undefined;
  }> = [];
  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    calls.push({
      command,
      args,
      cwd: options?.cwd,
      signal: options?.signal,
      timeout: options?.timeout,
    });
    return { stdout: "[]\n", stderr: "", code: 0, killed: false };
  };

  const result = await runGithubPrTriage(
    { exec },
    ["review-requested"],
    profile,
    controller.signal,
  );

  expect(result).toEqual({ stdout: "[]\n", stderr: "", code: 0 });
  expect(calls).toEqual([
    {
      command: "python3",
      args: [join(import.meta.dir, "..", "bin", "gh-prs.py"), "review-requested"],
      cwd: profile,
      signal: controller.signal,
      timeout: 30_000,
    },
  ]);
});

test("preserves the review-requested gh argv contract", async () => {
  const profile = await mkdtemp(join(tmpdir(), "gh-prs-profile-"));
  fixtures.push(profile);
  const fakeBin = join(profile, "fake-bin");
  await mkdir(fakeBin);
  const argsPath = join(profile, "gh-args.txt");
  const fakeGh = join(fakeBin, "gh");
  await Bun.write(
    fakeGh,
    `#!/bin/sh
printf '%s\\n' "$*" > "$ZIGGY_PROFILE_PATH/gh-args.txt"
printf '[]\\n'
`,
  );
  await chmod(fakeGh, 0o755);

  const child = Bun.spawn(
    ["python3", join(import.meta.dir, "..", "bin", "gh-prs.py"), "review-requested"],
    {
      cwd: profile,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ZIGGY_PROFILE_PATH: profile,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual([]);
  expect(await Bun.file(argsPath).text()).toBe(
    "search prs --review-requested=@me --state=open --json repository,number,title,url,author,updatedAt\n",
  );
});
