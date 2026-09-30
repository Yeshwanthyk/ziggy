import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ziggy } from "../harness/cli";
import { scratchProfile, sessionFiles, type ScratchProfile, treeHash } from "../harness/profile";
import {
  fail,
  lastUserContent,
  type ModelServer,
  startModelServer,
  text,
} from "../harness/provider";
import { onlyTranscript, readTranscript, sessionId } from "../harness/transcript";

let server: ModelServer;

let profile: ScratchProfile;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  server.stop();
  await profile.remove();
});

describe("Profile commands", () => {
  test("init twice leaves SOUL.md byte-identical", async () => {
    const first = await ziggy(profile, "init", profile.path, "--non-interactive");
    const second = await ziggy(profile, "init", profile.path, "--non-interactive");

    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    expect(await readFile(join(profile.path, "SOUL.md"), "utf8")).toBe(profile.soul);
  });

  // Red until work-order step 1: listing Profiles prunes stale registry entries.
  test.failing(
    "profiles changes nothing and starts nothing, even with a stale registry",
    async () => {
      await writeFile(
        join(profile.home, "profiles.list"),
        `${profile.path}\n${join(profile.root, "moved-away")}\n`,
        "utf8",
      );
      const before = await treeHash(profile.root);
      const listed = await ziggy(profile, "profiles");

      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain(profile.path);
      expect(await treeHash(profile.root)).toBe(before);
    },
  );
});

describe("run", () => {
  test("sends the configured model and the SOUL, prints the reply and exits 0", async () => {
    server.push(text("hello back"));
    const result = await ziggy(profile, "run", profile.path, "hi");

    expect(result).toEqual({ exitCode: 0, stdout: "hello back\n", stderr: "" });
    expect(server.requests.map((request) => request.model)).toEqual(["harness-model"]);
    expect(server.raw(0)).toContain("SOUL_MARKER_7f3a");
    expect(lastUserContent(server.request(0))).toContain("hi");
  });

  test("models set changes the model of the next request", async () => {
    const set = await ziggy(profile, "models", "set", profile.path, "harness/harness-other");
    expect(set.exitCode).toBe(0);

    await ziggy(profile, "run", profile.path, "hi");
    expect(server.requests.map((request) => request.model)).toEqual(["harness-other"]);
  });

  test("--json prints Pi's session header first", async () => {
    const result = await ziggy(profile, "run", "--json", profile.path, "hi");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")[0]).toStartWith('{"type":"session","version":3,');
  });

  test("a model error exits 1 with one stderr line", async () => {
    // 400, not 5xx: Pi retries server errors, and a retry would get the default reply.
    server.push(fail(400, "scripted failure"));
    const result = await ziggy(profile, "run", profile.path, "hi");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("provider request failed\n");
  });
});

describe("sessions", () => {
  test("list and show change nothing; run --session appends to that file", async () => {
    server.push(text("first answer"), text("second answer"));
    await ziggy(profile, "run", profile.path, "first question");
    const first = await onlyTranscript(profile.path);
    const { file } = first;
    const id = sessionId(first);

    const before = await treeHash(profile.home);
    const listed = await ziggy(profile, "sessions", "list", profile.path);
    const shown = await ziggy(profile, "sessions", "show", profile.path, id);

    expect([listed.exitCode, shown.exitCode]).toEqual([0, 0]);
    expect(listed.stdout).toContain(id);
    expect(await treeHash(profile.home)).toBe(before);

    const resumed = await ziggy(profile, "run", "--session", id, profile.path, "second question");
    expect(resumed.stdout).toBe("second answer\n");
    expect(await sessionFiles(profile.path)).toEqual([file]);

    const transcript = await readTranscript(profile.path, file);
    expect(transcript.roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(transcript.text).toContain("second question");
  });
});
