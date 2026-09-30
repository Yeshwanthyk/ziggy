/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-promise-catch -- fixture setup drives the real filesystem */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- test cleanup and fixture guards need finally and throw */
import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Result, Schema } from "effect";
import {
  isSessionHeld,
  listSessions,
  locateSession,
  sessionHistory,
  sessionSummaries,
  showSession,
  takeSessionLease,
} from "ziggy/session/index";

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

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface TestSessionMessage {
  readonly role: string;
  readonly content?:
    | string
    | ReadonlyArray<{ readonly type: string; readonly text?: string; readonly thinking?: string }>;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly usage?: ReturnType<typeof usage>;
  readonly timestamp: number;
}

type TestSessionEntryBody =
  | { readonly type: "model_change"; readonly provider: string; readonly modelId: string }
  | { readonly type: "thinking_level_change"; readonly thinkingLevel: string }
  | { readonly type: "session_info"; readonly name?: string }
  | { readonly type: "custom_message"; readonly customType: string }
  | {
      readonly type: "usage";
      readonly kind: string;
      readonly provider: string;
      readonly model: string;
      readonly usage: ReturnType<typeof usage>;
    }
  | { readonly type: "message"; readonly message: TestSessionMessage };

const header = (id: string, parentSession?: string) => {
  const value = {
    type: "session" as const,
    version: 3,
    id,
    timestamp: "2026-08-08T10:00:00.000Z",
    cwd: "/profile",
  };

  if (parentSession === undefined) return value;

  return { ...value, parentSession };
};

const entry = (id: string, parentId: string | null, value: TestSessionEntryBody) => ({
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

describe("session store", () => {
  test("projects the latest Pi session name and preserves an explicit clear", async () => {
    const root = await profile();
    const namedFile = join(root, "sessions", "named.jsonl");
    const clearedFile = join(root, "sessions", "cleared.jsonl");

    await writeJsonl(namedFile, [
      header("named"),
      entry("old", null, { type: "session_info", name: "Old name" }),
      entry("new", "old", { type: "session_info", name: "  Gateway\nreview  " }),
    ]);
    await writeJsonl(clearedFile, [
      header("cleared"),
      entry("old", null, { type: "session_info", name: "Keep no longer" }),
      entry("new", "old", { type: "session_info", name: "" }),
    ]);

    const sessions = await Effect.runPromise(listSessions(root));

    expect(sessions.find((session) => session.id === "named")?.name).toBe("Gateway review");
    expect(sessions.find((session) => session.id === "cleared")?.name).toBeUndefined();
  });

  test("uses the latest message as activity without advancing for later naming metadata", async () => {
    const root = await profile();
    const file = join(root, "sessions", "activity.jsonl");
    await writeJsonl(file, [
      header("activity"),
      {
        ...entry("message", null, {
          type: "message",
          message: { role: "user", content: "Earlier conversation", timestamp: 1 },
        }),
        timestamp: "2026-08-08T11:00:00.000Z",
      },
      {
        ...entry("result", "message", {
          type: "custom_message",
          customType: "ziggy.automation-result",
        }),
        timestamp: "2026-09-16T12:00:00.000Z",
      },
      {
        ...entry("name", "result", { type: "session_info", name: "Backfilled name" }),
        timestamp: "2026-09-17T12:00:00.000Z",
      },
    ]);

    const session = (await Effect.runPromise(listSessions(root)))[0];

    expect(session?.name).toBe("Backfilled name");
    expect(session?.activityAt).toBe("2026-09-16T12:00:00.000Z");
  });

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
      entry("ggggggg", "ffffff", {
        type: "usage",
        kind: "cache_warm",
        provider: "openai",
        model: "model-a",
        usage: usage(1, 1, 0.1),
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
    const sessions = await Effect.runPromise(listSessions(root));
    const shown = await Effect.runPromise(showSession(root, "local/root.jsonl"));
    expect(await snapshot(root)).toEqual(before);

    expect(sessions).toHaveLength(2);
    expect(shown).toMatchObject({
      path: "local/root.jsonl",
      id: "root-id",
      kind: "root",
      entryCount: 7,
      terminalState: "completed",
      children: [{ id: "child-id", path: "agents/child.jsonl" }],
      modelChanges: [{ at: "2026-08-08T10:00:01.000Z", provider: "openai", model: "model-a" }],
      thinkingChanges: [{ at: "2026-08-08T10:00:02.000Z", level: "high" }],
      usage: {
        input: 23,
        output: 10,
        cacheRead: 4,
        cacheWrite: 8,
        reasoning: 12,
        totalTokens: 45,
        cost: 0.7000000000000001,
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

  test("projects metadata from a transcript larger than the former total-file limit", async () => {
    const root = await profile();
    const file = join(root, "sessions", "large.jsonl");
    const largeContent = "x".repeat(600 * 1024);

    const messages = Array.from({ length: 18 }, (_, index) =>
      entry(`large-${index}`, null, {
        type: "message",
        message: { role: "user", content: `${index}:${largeContent}`, timestamp: index },
      }),
    );

    await writeJsonl(file, [
      header("large-session"),
      ...messages,
      entry("final", null, {
        type: "message",
        message: {
          role: "assistant",
          provider: "openai",
          model: "large-model",
          stopReason: "stop",
          usage: usage(2, 1, 0.01),
          content: "done",
          timestamp: 19,
        },
      }),
    ]);

    expect((await lstat(file)).size).toBeGreaterThan(8 * 1024 * 1024);
    expect(await Effect.runPromise(showSession(root, "large-session"))).toMatchObject({
      id: "large-session",
      entryCount: 19,
      terminalState: "completed",
      usage: { input: 2, output: 1, cost: 0.01 },
    });
  });

  test("missing sessions stay missing and relative paths cannot escape", async () => {
    const root = await profile();
    expect(await Effect.runPromise(listSessions(root))).toEqual([]);
    expect(await Bun.file(join(root, "sessions")).exists()).toBe(false);

    const result = await Effect.runPromise(showSession(root, "../outside").pipe(Effect.result));

    expect(Result.isFailure(result) && result.failure._tag).toBe("SessionNotFound");
    expect(await Bun.file(join(root, "sessions")).exists()).toBe(false);
  });

  test("isolates an oversized record in listings and surfaces it when addressed", async () => {
    const root = await profile();
    const file = join(root, "sessions", "oversized.jsonl");
    const valid = join(root, "sessions", "valid.jsonl");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "x".repeat(8 * 1024 * 1024 + 1));
    await writeJsonl(valid, [header("valid")]);

    expect((await Effect.runPromise(listSessions(root))).map((session) => session.id)).toEqual([
      "valid",
    ]);

    const result = await Effect.runPromise(
      showSession(root, "oversized.jsonl").pipe(Effect.result),
    );

    expect(result).toMatchObject({
      failure: {
        _tag: "SessionReadFailed",
        path: file,
        operation: "read",
        cause: { kind: "line-too-large", maximum: 8 * 1024 * 1024 },
      },
    });
  });

  test("rejects a symlinked root and never follows links inside it", async () => {
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

    const result = await Effect.runPromise(listSessions(rootLink).pipe(Effect.result));
    expect(Result.isFailure(result) && result.failure._tag).toBe("SessionReadFailed");

    for (const target of [fileLink, directoryLink])
      expect(await Effect.runPromise(listSessions(target))).toEqual([]);
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

  test("run --session opens the exact older transcript in a shared directory", async () => {
    const root = await profile();
    await writeFile(join(root, "SOUL.md"), "# Profile\n", "utf8");
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }),
      "utf8",
    );

    const requests: Array<string> = [];

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push(await request.text());

        return new Response(
          [
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"selected answer"},"finish_reason":null}]}',
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "fixture-model" }],
          },
        },
      }),
      "utf8",
    );

    try {
      const sessionDirectory = join(root, "sessions", "shared");
      const older = SessionManager.create(root, sessionDirectory);
      older.appendMessage({
        role: "user",
        content: [{ type: "text", text: "OLDER-HISTORY" }],
        timestamp: Date.now(),
      });
      older.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "older answer" }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture-model",
        usage: usage(1, 1, 0),
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const olderId = older.getSessionId();
      const olderFile = older.getSessionFile();

      if (olderFile === undefined) throw new Error("expected older session file");

      const newer = SessionManager.create(root, sessionDirectory);
      newer.appendMessage({
        role: "user",
        content: [{ type: "text", text: "NEWER-HISTORY" }],
        timestamp: Date.now(),
      });
      newer.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "newer answer" }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture-model",
        usage: usage(1, 1, 0),
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const newerFile = newer.getSessionFile();

      if (newerFile === undefined) throw new Error("expected newer session file");
      await utimes(newerFile, new Date(2_000), new Date(2_000));
      await utimes(olderFile, new Date(1_000), new Date(1_000));

      const child = Bun.spawn(
        [
          process.execPath,
          "src/main.ts",
          "run",
          "--json",
          "--session",
          olderId,
          root,
          "selected prompt",
        ],
        { stdout: "pipe", stderr: "pipe", cwd: process.cwd() },
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const eventLines = stdout.trim().split("\n");
      expect(eventLines.length).toBeGreaterThan(0);

      for (const line of eventLines) expect(() => decodeJsonLine(line)).not.toThrow();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("OLDER-HISTORY");
      expect(requests[0]).not.toContain("NEWER-HISTORY");
      expect(await readFile(olderFile, "utf8")).toContain("selected prompt");
      expect(await readFile(newerFile, "utf8")).not.toContain("selected prompt");
    } finally {
      server.stop(true);
    }
  });

  test("skips a malformed session in listings, fails typed when addressed, never rewrites it", async () => {
    const root = await profile();
    const file = join(root, "sessions", "broken.jsonl");
    await writeJsonl(file, [header("broken")]);
    await writeFile(file, `${JSON.stringify(header("broken"))}\nnot-json\n`);
    const before = await readFile(file);
    expect(await Effect.runPromise(listSessions(root))).toEqual([]);
    const result = await Effect.runPromise(showSession(root, "broken.jsonl").pipe(Effect.result));
    expect(Result.isFailure(result) && result.failure._tag).toBe("SessionReadFailed");
    expect(await readFile(file)).toEqual(before);
  });
});

test("read-only session summaries use first user text while a writer holds the lease", async () => {
  const root = await profile();
  const file = join(root, "sessions", "one.jsonl");
  await writeJsonl(file, [
    header("one"),
    entry("user", null, {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Hello Ziggy" }], timestamp: 0 },
    }),
  ]);
  const before = await readFile(file);
  const lease = Result.getOrThrow(takeSessionLease(root, "one"));

  try {
    expect(await Effect.runPromise(sessionSummaries(root))).toEqual([
      {
        id: "one",
        path: "one.jsonl",
        title: "Hello Ziggy",
        updatedAt: "2026-08-08T10:00:04.000Z",
      },
    ]);
    expect(Result.getOrThrow(isSessionHeld(root, "one"))).toBe(true);
    expect(await readFile(file)).toEqual(before);
  } finally {
    lease.release();
  }

  expect(Result.getOrThrow(isSessionHeld(root, "one"))).toBe(false);
});

test("summary listing isolates bad transcripts, sorts by activity and truncates Unicode titles", async () => {
  const root = await profile();
  const sessions = join(root, "sessions");
  const first = join(sessions, "a.jsonl");
  await writeJsonl(first, [
    header("first"),
    entry("early", null, {
      type: "message",
      message: { role: "user", content: "a".repeat(159) + "😀more", timestamp: 0 },
    }),
  ]);
  await writeJsonl(join(sessions, "b.jsonl"), [
    header("second"),
    entry("recent", null, {
      type: "message",
      message: { role: "user", content: "newer", timestamp: 0 },
    }),
  ]);
  await writeJsonl(join(sessions, "c.jsonl"), [header("first")]);
  await writeFile(join(sessions, "broken.jsonl"), "not json\n");
  await symlink(first, join(sessions, "linked.jsonl"));

  const result = await Effect.runPromise(sessionSummaries(root));
  expect(result.map((item) => item.id)).toEqual(["second", "first"]);
  expect(result[1]?.title).toBe("a".repeat(159) + "😀");
});

test("show skips unrelated broken files but rejects only duplicate identities", async () => {
  const root = await profile();
  const sessions = join(root, "sessions");
  const healthy = join(sessions, "healthy.jsonl");
  await writeJsonl(healthy, [header("healthy")]);
  await writeJsonl(join(sessions, "duplicate-a.jsonl"), [header("duplicate")]);
  await writeJsonl(join(sessions, "duplicate-b.jsonl"), [header("duplicate")]);
  await writeFile(join(sessions, "broken.jsonl"), "not json\n");
  await symlink(healthy, join(sessions, "linked.jsonl"));

  expect((await Effect.runPromise(showSession(root, "healthy"))).id).toBe("healthy");
  expect((await Effect.runPromise(showSession(root, "healthy.jsonl"))).id).toBe("healthy");

  for (const reference of ["duplicate", "duplicate-a.jsonl", "duplicate-b.jsonl"]) {
    expect(await Effect.runPromise(Effect.result(showSession(root, reference)))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SessionReadFailed", operation: "resolve" },
    });
  }
});

test("locate reads the addressed transcript strictly and sets aside an unreadable same-id copy", async () => {
  const root = await profile();
  const sessions = join(root, "sessions");
  const broken = join(sessions, "broken.jsonl");
  await writeJsonl(broken, [header("broken")]);
  await writeFile(broken, `${JSON.stringify({ ...header("broken"), version: 1 })}\nnot-json\n`);
  const before = await readFile(broken);

  expect(await Effect.runPromise(Effect.result(locateSession(root, "broken")))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "SessionReadFailed" },
  });
  expect(await readFile(broken)).toEqual(before);

  await writeJsonl(join(sessions, "copy-a.jsonl"), [header("copied")]);
  await writeFile(
    join(sessions, "copy-b.jsonl"),
    `${JSON.stringify(header("copied"))}\nnot-json\n`,
  );

  expect((await Effect.runPromise(locateSession(root, "copied"))).path).toBe("copy-a.jsonl");
});

const message = (
  id: string,
  timestamp: string,
  role: "user" | "assistant",
  text: string,
): Schema.Json => ({
  type: "message",
  id,
  parentId: null,
  timestamp,
  message:
    role === "user"
      ? { role, content: text }
      : {
          role,
          content: text,
          provider: "openai",
          model: "gpt-5",
          stopReason: "stop",
          usage: usage(1, 1, 0),
        },
});

const writeTranscript = async (profilePath: string, records: ReadonlyArray<Schema.Json>) => {
  const sessionsPath = join(profilePath, "sessions");
  await mkdir(sessionsPath, { recursive: true });
  const file = join(sessionsPath, "root.jsonl");
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  return file;
};

test("history pages back with a cursor that survives appends and goes stale on rewrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-session-history-"));
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });

  try {
    const records: Array<Schema.Json> = [
      {
        type: "session",
        id: "root-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: profilePath,
      },
      ...Array.from({ length: 36 }, (_, index) =>
        message(
          `user-${index}`,
          `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
          "user",
          `question ${index}`,
        ),
      ),
      {
        type: "message",
        id: "tool-result-1",
        parentId: null,
        timestamp: "2026-01-01T01:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "search",
          isError: false,
          content: "ok",
        },
      },
      message("assistant-1", "2026-01-01T01:00:02.000Z", "assistant", "answer"),
    ];

    const file = await writeTranscript(profilePath, records);

    const page = await Effect.runPromise(sessionHistory(profilePath, "root-session"));
    expect(page.entries).toHaveLength(8);
    expect(page.truncated).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(page.entries[0]).toEqual({
      kind: "user",
      timestamp: "2026-01-01T00:30:00.000Z",
      text: "question 30",
    });
    expect(page.entries.at(-2)).toEqual({
      kind: "tool",
      timestamp: "2026-01-01T01:00:01.000Z",
      phase: "end",
      toolName: "search",
      failed: false,
    });
    expect(page.entries.at(-1)).toEqual({
      kind: "assistant",
      timestamp: "2026-01-01T01:00:02.000Z",
      text: "answer",
    });
    expect(page.terminalState).toBe("completed");

    const older = await Effect.runPromise(
      sessionHistory(profilePath, "root-session", page.nextCursor),
    );

    expect(older.entries).toHaveLength(8);
    expect(older.entries[0]).toEqual({
      kind: "user",
      timestamp: "2026-01-01T00:22:00.000Z",
      text: "question 22",
    });
    expect(older.hasMore).toBe(true);
    expect(older.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);

    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      `${source}${JSON.stringify(message("new", "2026-01-02T00:00:00.000Z", "user", "new"))}\n`,
      "utf8",
    );

    const afterAppend = await Effect.runPromise(
      sessionHistory(profilePath, "root-session", page.nextCursor),
    );

    expect(afterAppend.entries).toEqual(older.entries);

    await writeTranscript(profilePath, [...records.slice(0, 1), ...records.slice(2)]);

    const stale = await Effect.runPromise(
      sessionHistory(profilePath, "root-session", page.nextCursor).pipe(Effect.result),
    );

    expect(
      Result.match(stale, {
        onFailure: (error) => Predicate.isTagged(error, "SessionHistoryCursorInvalid"),
        onSuccess: () => false,
      }),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history rejects malformed cursors with a typed failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-session-history-cursor-"));
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });

  try {
    await writeTranscript(profilePath, [
      {
        type: "session",
        id: "root-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: profilePath,
      },
      message("assistant-1", "2026-01-01T00:00:01.000Z", "assistant", "answer"),
    ]);

    const result = await Effect.runPromise(
      sessionHistory(profilePath, "root-session", "not-a-cursor").pipe(Effect.result),
    );

    expect(
      Result.match(result, {
        onFailure: (error) => Predicate.isTagged(error, "SessionHistoryCursorInvalid"),
        onSuccess: () => false,
      }),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history paginates a transcript larger than the former total-file limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-session-history-large-"));
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });

  try {
    const largeContent = "x".repeat(600 * 1024);

    const records: Array<Schema.Json> = [
      {
        type: "session",
        id: "large-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: profilePath,
      },
      ...Array.from({ length: 18 }, (_, index) =>
        message(
          `user-${index}`,
          `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
          "user",
          `question ${index}:${largeContent}`,
        ),
      ),
      message("assistant", "2026-01-01T01:00:00.000Z", "assistant", "answer"),
    ];

    const file = await writeTranscript(profilePath, records);

    expect((await Bun.file(file).size).valueOf()).toBeGreaterThan(8 * 1024 * 1024);

    const first = await Effect.runPromise(sessionHistory(profilePath, "large-session"));
    expect(first.entries).toHaveLength(8);
    expect(first.entries[0]).toMatchObject({ kind: "user", text: expect.stringContaining("11:") });
    expect(first.nextCursor).toBeDefined();

    const second = await Effect.runPromise(
      sessionHistory(profilePath, "large-session", first.nextCursor),
    );

    expect(second.entries).toHaveLength(8);
    expect(second.entries[0]).toMatchObject({ kind: "user", text: expect.stringContaining("3:") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
