/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise filesystem and Pi Promise boundaries. */
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractionScriptPath, runSkillExtraction } from "../index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("skill extraction", () => {
  test("runs the package script in the Profile cwd", async () => {
    const profile = await mkdtemp(join(tmpdir(), "sia-profile-"));
    temporaryDirectories.push(profile);
    const exec: ExtensionAPI["exec"] = async (command, args, options) => {
      expect(command).toBe(extractionScriptPath);
      expect(options?.cwd).toBe(profile);
      const process = Bun.spawn([command, ...args], {
        cwd: options?.cwd ?? profile,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { stdout, stderr, code, killed: false };
    };

    await runSkillExtraction(exec, ["profile-pattern"], profile, undefined);

    const skill = await readFile(join(profile, "skills/profile-pattern/SKILL.md"), "utf8");
    expect(skill).toContain("name: profile-pattern");
    expect(skill).toContain(".learnings/LEARNINGS.md");
  });

  test("rejects Profile escapes", async () => {
    const profile = await mkdtemp(join(tmpdir(), "sia-profile-"));
    temporaryDirectories.push(profile);
    const process = Bun.spawn([extractionScriptPath, "escaped", "--output-dir", "../outside"], {
      cwd: profile,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const exec: ExtensionAPI["exec"] = async () => ({ stdout, stderr, code, killed: false });

    expect(runSkillExtraction(exec, [], profile, undefined)).rejects.toThrow(
      "output directory cannot contain '..'",
    );
  });
});
