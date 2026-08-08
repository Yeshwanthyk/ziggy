/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { listProfileSessions, showProfileSession } from "./sessions";

const temporaryPaths: Array<string> = [];
const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 1,
  cacheWrite: 2,
  reasoning: 3,
  totalTokens: input + output + 3,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});
const header = (id: string, parentSession?: string) => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-08-08T10:00:00.000Z",
  cwd: "/profile",
  ...(parentSession === undefined ? {} : { parentSession }),
});
const entry = (id: string, parentId: string | null, value: object) => ({
  id,
  parentId,
  timestamp: `2026-08-08T10:00:0${id.length}.000Z`,
  ...value,
});
const writeJsonl = async (file: string, values: ReadonlyArray<object>) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
};
const profile = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ziggy-sessions-"));
  temporaryPaths.push(directory);
  return directory;
};
const snapshot = async (root: string): Promise<ReadonlyArray<string>> => {
  const status = await lstat(root).catch(() => undefined);
  if (status === undefined) return [];
  const values: Array<string> = [];
  const walk = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const target = join(directory, name);
      const child = await lstat(target);
      if (child.isDirectory()) {
        values.push(`${target.slice(root.length)}:dir:${child.mtimeMs}`);
        await walk(target);
      } else {
        values.push(
          `${target.slice(root.length)}:file:${child.mtimeMs}:${Buffer.from(await readFile(target)).toString("base64")}`,
        );
      }
    }
  };
  await walk(root);
  return values;
};

afterEach(async () =>
  Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("Pi session metadata adapter", () => {
  test("projects lineage, changes, usage, and terminal state without transcript fields", async () => {
    const root = await profile();
    const parentFile = join(root, "sessions", "local", "root.jsonl");
    const childFile = join(root, "sessions", "agents", "child.jsonl");
    await writeJsonl(parentFile, [
      header("root-id"),
      entry("a", null, { type: "model_change", provider: "openai", modelId: "model-a" }),
      entry("bb", "a", { type: "thinking_level_change", thinkingLevel: "high" }),
      entry("ccc", "bb", {
        type: "message",
        message: { role: "user", content: "PROMPT-SECRET", timestamp: 1 },
      }),
      entry("dddd", "ccc", {
        type: "message",
        message: {
          role: "assistant",
          provider: "openai",
          model: "model-a",
          stopReason: "toolUse",
          usage: usage(10, 4, 0.1),
          content: [{ type: "thinking", thinking: "THINKING-SECRET" }],
          timestamp: 2,
        },
      }),
      entry("eeeee", "dddd", {
        type: "message",
        message: {
          role: "toolResult",
          usage: usage(5, 2, 0.2),
          content: [{ type: "text", text: "TOOL-SECRET" }],
          timestamp: 3,
        },
      }),
      entry("ffffff", "eeeee", {
        type: "message",
        message: {
          role: "assistant",
          provider: "openai",
          model: "model-a",
          stopReason: "stop",
          usage: usage(7, 3, 0.3),
          content: [{ type: "text", text: "REPLY-SECRET" }],
          timestamp: 4,
        },
      }),
    ]);
    await writeJsonl(childFile, [
      header("child-id", parentFile),
      entry("x", null, {
        type: "message",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "child-model",
          stopReason: "aborted",
          usage: usage(1, 1, 0.01),
          content: [],
          timestamp: 5,
        },
      }),
    ]);

    const before = await snapshot(root);
    const sessions = await Effect.runPromise(listProfileSessions(root));
    const shown = await Effect.runPromise(showProfileSession(root, "local/root.jsonl"));
    expect(await snapshot(root)).toEqual(before);

    expect(sessions).toHaveLength(2);
    expect(shown).toMatchObject({
      path: "local/root.jsonl",
      id: "root-id",
      kind: "root",
      entryCount: 6,
      terminalState: "completed",
      children: [{ id: "child-id", path: "agents/child.jsonl" }],
      modelChanges: [{ at: "2026-08-08T10:00:01.000Z", provider: "openai", model: "model-a" }],
      thinkingChanges: [{ at: "2026-08-08T10:00:02.000Z", level: "high" }],
      usage: {
        input: 22,
        output: 9,
        cacheRead: 3,
        cacheWrite: 6,
        reasoning: 9,
        totalTokens: 40,
        cost: 0.6000000000000001,
      },
    });
    expect(sessions.find((session) => session.id === "child-id")).toMatchObject({
      kind: "child",
      parent: { id: "root-id", path: "local/root.jsonl" },
      terminalState: "aborted",
    });
    expect(JSON.stringify(sessions)).not.toMatch(
      /PROMPT-SECRET|REPLY-SECRET|THINKING-SECRET|TOOL-SECRET/,
    );
  });

  test("missing sessions stay missing and relative paths cannot escape", async () => {
    const root = await profile();
    expect(await Effect.runPromise(listProfileSessions(root))).toEqual([]);
    expect(await Bun.file(join(root, "sessions")).exists()).toBe(false);
    const result = await Effect.runPromise(
      showProfileSession(root, "../outside").pipe(Effect.result),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("SessionNotFound");
    expect(await Bun.file(join(root, "sessions")).exists()).toBe(false);
  });

  test("rejects symlinked roots, files, and nested directories", async () => {
    const outside = await profile();
    await mkdir(join(outside, "real"));
    const rootLink = await profile();
    await symlink(join(outside, "real"), join(rootLink, "sessions"));

    const fileLink = await profile();
    await mkdir(join(fileLink, "sessions"));
    const externalFile = join(outside, "external.jsonl");
    await writeJsonl(externalFile, [header("external")]);
    await symlink(externalFile, join(fileLink, "sessions", "linked.jsonl"));

    const directoryLink = await profile();
    await mkdir(join(directoryLink, "sessions"));
    await symlink(join(outside, "real"), join(directoryLink, "sessions", "linked"));

    for (const target of [rootLink, fileLink, directoryLink]) {
      const result = await Effect.runPromise(listProfileSessions(target).pipe(Effect.result));
      expect(Result.isFailure(result) && result.failure._tag).toBe("SessionReadFailed");
    }
  });

  test("CLI list and show are read-only and never print transcript content", async () => {
    const root = await profile();
    const file = join(root, "sessions", "root.jsonl");
    await writeJsonl(file, [
      header("cli-id"),
      entry("one", null, {
        type: "message",
        message: { role: "user", content: "CLI-PROMPT-SECRET", timestamp: 1 },
      }),
      entry("two", "one", {
        type: "message",
        message: {
          role: "assistant",
          provider: "openai",
          model: "safe-model",
          stopReason: "stop",
          usage: usage(1, 1, 0),
          content: [{ type: "text", text: "CLI-REPLY-SECRET" }],
          timestamp: 2,
        },
      }),
    ]);
    const before = await snapshot(root);
    for (const args of [
      ["sessions", "list", root],
      ["sessions", "show", root, "cli-id"],
    ]) {
      const result = Bun.spawnSync([process.execPath, "src/main.ts", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).not.toMatch(/CLI-PROMPT-SECRET|CLI-REPLY-SECRET/);
    }
    expect(await snapshot(root)).toEqual(before);
  });

  test("fails typed on malformed sessions without rewriting them", async () => {
    const root = await profile();
    const file = join(root, "sessions", "broken.jsonl");
    await writeJsonl(file, [header("broken")]);
    await writeFile(file, `${JSON.stringify(header("broken"))}\nnot-json\n`);
    const before = await readFile(file);
    const result = await Effect.runPromise(listProfileSessions(root).pipe(Effect.result));
    expect(Result.isFailure(result) && result.failure._tag).toBe("SessionReadFailed");
    expect(await readFile(file)).toEqual(before);
  });
});
