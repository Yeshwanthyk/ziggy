/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests exercise the package filesystem boundary. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReviewLog,
  observeCompletedForegroundSession,
  readStatus,
  writeCuratorExtension,
  type SessionEntry,
} from "../src/manager.ts";

const roots: string[] = [];
const makeProfile = async (): Promise<string> => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-self-improvement-"));
  roots.push(profile);
  return profile;
};
const entries = (stopReason = "stop"): ReadonlyArray<SessionEntry> => [
  { type: "message", message: { role: "user" } },
  { type: "message", message: { role: "assistant", stopReason } },
];
const body = (id: string, description = `${id} procedure`): string =>
  `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nUse the verified procedure.\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("self-improvement observation", () => {
  test("records only three distinct completed foreground sessions and arms readiness", async () => {
    const profile = await makeProfile();
    for (const [index, name] of ["one", "two", "three"].entries()) {
      const result = await observeCompletedForegroundSession({
        profilePath: profile,
        sessionFile: join(profile, "sessions", `${name}.jsonl`),
        entries: entries(),
        observedAt: new Date(`2026-08-11T0${index}:00:00.000Z`),
      });
      expect(result.observed).toBe(true);
    }
    const duplicate = await observeCompletedForegroundSession({
      profilePath: profile,
      sessionFile: join(profile, "sessions", "three.jsonl"),
      entries: entries(),
    });
    expect(duplicate.observed).toBe(false);
    const status = await readStatus(profile);
    expect(status.completedSessionIds).toHaveLength(3);
    expect(status.ready).toBe(true);
    expect(
      await readFile(join(profile, ".runtime/self-improvement/logs/2026-08-11.md"), "utf8"),
    ).toContain("three.jsonl");
  });

  test("skips automation, specialist, empty, and failed sessions", async () => {
    const profile = await makeProfile();
    for (const sessionFile of [
      join(profile, "sessions/automations/curator/run.jsonl"),
      join(profile, "sessions/agents/research/run.jsonl"),
      join(profile, "sessions/specialists/run.jsonl"),
      join(profile, "sessions/foreground.jsonl"),
    ]) {
      const result = await observeCompletedForegroundSession({
        profilePath: profile,
        sessionFile,
        entries: sessionFile.endsWith("foreground.jsonl") ? entries("error") : [],
      });
      expect(result.observed).toBe(false);
    }
    expect((await readStatus(profile)).completedSessionIds).toHaveLength(0);
  });
});

describe("self-improvement logging and package writer", () => {
  test("logs a decision and clears readiness only after the log succeeds", async () => {
    const profile = await makeProfile();
    await mkdir(join(profile, ".runtime/self-improvement"), { recursive: true });
    await writeFile(join(profile, ".runtime/self-improvement/curator-ready"), "ready\n");
    const result = await appendReviewLog(profile, {
      decision: "no-op",
      detail: "No durable recurrence.",
      clearReady: true,
      at: new Date("2026-08-11T04:00:00.000Z"),
    });
    expect(result.clearedReady).toBe(true);
    expect((await readStatus(profile)).ready).toBe(false);
  });

  test("creates a real skill-only package without overwrite and replaces only managed packages", async () => {
    const profile = await makeProfile();
    const created = await writeCuratorExtension(profile, {
      id: "morning-routine",
      body: body("morning-routine"),
    });
    expect(created.action).toBe("created");
    expect(
      await readFile(join(profile, "extensions/morning-routine/package.json"), "utf8"),
    ).toContain("curatorManaged");
    await expect(
      writeCuratorExtension(profile, {
        id: "morning-routine",
        body: body("morning-routine", "other"),
      }),
    ).rejects.toThrow("already exists");
    const replacement = body("morning-routine", "updated procedure");
    expect(
      (
        await writeCuratorExtension(profile, {
          id: "morning-routine",
          body: replacement,
          replace: true,
        })
      ).action,
    ).toBe("replaced");
    expect(
      await readFile(
        join(profile, "extensions/morning-routine/skills/morning-routine/SKILL.md"),
        "utf8",
      ),
    ).toBe(replacement);
  });

  test("rejects traversal, malformed skills, symlinked package paths, and human packages", async () => {
    const profile = await makeProfile();
    await expect(
      writeCuratorExtension(profile, { id: "../escape", body: body("../escape") }),
    ).rejects.toThrow("kebab-case");
    await expect(
      writeCuratorExtension(profile, { id: "safe-skill", body: "not frontmatter" }),
    ).rejects.toThrow("frontmatter");
    await mkdir(join(profile, "extensions"), { recursive: true });
    const outside = await makeProfile();
    await mkdir(join(outside, "skills/safe-skill"), { recursive: true });
    await writeFile(join(outside, "skills/safe-skill/SKILL.md"), body("safe-skill"));
    await symlink(join(outside, "skills"), join(profile, "extensions", "safe-skill"), "dir");
    await expect(
      writeCuratorExtension(profile, { id: "safe-skill", body: body("safe-skill"), replace: true }),
    ).rejects.toThrow();

    const human = join(profile, "extensions", "human-skill");
    await mkdir(join(human, "skills/human-skill"), { recursive: true });
    await writeFile(
      join(human, "package.json"),
      JSON.stringify({ name: "@ziggy/human-skill", pi: { skills: ["./skills"] } }),
    );
    await writeFile(join(human, "skills/human-skill/SKILL.md"), body("human-skill"));
    await expect(
      writeCuratorExtension(profile, {
        id: "human-skill",
        body: body("human-skill", "changed"),
        replace: true,
      }),
    ).rejects.toThrow("curatorManaged");
  });
});
