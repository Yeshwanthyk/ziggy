/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are explicit Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-json-parse -- TypeBox validates the fake process output immediately. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- The guard makes failed fixture decoding fail the test. */
/* eslint-disable ziggy-effect/no-error-constructor -- The guard makes failed fixture decoding fail the test. */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import registerDiffs from "../index";

const fixtures: string[] = [];
const Details = Type.Object(
  {
    id: Type.String(),
    bytes: Type.Integer(),
    path: Type.String(),
    rawPath: Type.String(),
    filePath: Type.String(),
    artifactDir: Type.String(),
  },
  { additionalProperties: true },
);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("registers the native diffs tool", () => {
  const names: string[] = [];
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    names.push(tool.name);
  };

  registerDiffs({ registerTool });

  expect(names).toEqual(["diffs"]);
});

test("writes only the raw diff beneath the Profile runtime", async () => {
  const profile = await mkdtemp(join(tmpdir(), "diffs-profile-"));
  fixtures.push(profile);
  const child = Bun.spawn(["python3", join(import.meta.dir, "..", "bin", "diffs.py")], {
    cwd: profile,
    env: { ...process.env, ZIGGY_PROFILE_PATH: profile },
    stdin: new Blob([
      JSON.stringify({ before: "old", after: "new", path: "note.txt", mode: "file" }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const parsed: unknown = JSON.parse(stdout);

  expect(exitCode).toBe(0);
  expect(Check(Details, parsed)).toBe(true);
  if (!Check(Details, parsed)) throw new Error("wrapper returned invalid details");
  expect(parsed.path).toBe("note.txt");
  expect(parsed.artifactDir).toBe(join(profile, ".runtime", "diffs", "artifacts"));
  expect((await stat(parsed.rawPath)).isFile()).toBe(true);
  expect(parsed.filePath).toBe(parsed.rawPath);
});
