/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute filesystem Effects */
import { expect, test } from "bun:test";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Predicate, Result, Schema } from "effect";
import { readSessionHistory } from "ziggy/adapters/pi/session-history";

const usage: Schema.Json = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
          usage,
        },
});

const writeTranscript = async (profilePath: string, records: ReadonlyArray<Schema.Json>) => {
  const sessionsPath = join(profilePath, "sessions");
  await mkdir(sessionsPath, { recursive: true });
  const file = join(sessionsPath, "root.jsonl");
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
};

test("history reads a bounded projection from Pi JSONL and paginates with an opaque cursor", async () => {
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
      ...Array.from({ length: 35 }, (_, index) =>
        message(
          `user-${index}`,
          `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
          "user",
          `question ${index}`,
        ),
      ),
      {
        type: "toolCall",
        id: "tool-1",
        parentId: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        toolCallId: "call-1",
        toolName: "search",
      },
      {
        type: "message",
        id: "tool-result-1",
        parentId: null,
        timestamp: "2026-01-01T01:00:01.000Z",
        message: { role: "toolResult", toolCallId: "call-1", isError: false, content: "ok" },
      },
      message("assistant-1", "2026-01-01T01:00:02.000Z", "assistant", "answer"),
    ];
    const file = await writeTranscript(profilePath, records);

    const page = await Effect.runPromise(readSessionHistory(profilePath, "root.jsonl"));
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
      readSessionHistory(profilePath, "root.jsonl", page.nextCursor),
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
    const stale = await Effect.runPromise(
      readSessionHistory(profilePath, "root.jsonl", page.nextCursor).pipe(Effect.result),
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
      readSessionHistory(profilePath, "root.jsonl", "not-a-cursor").pipe(Effect.result),
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
