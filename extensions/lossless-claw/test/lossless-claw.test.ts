import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  describeProfileSession,
  expandProfileQuery,
  listProfileSessions,
  searchProfileSessions,
} from "../src/store.ts";

const temporaryProfiles: string[] = [];

const createProfile = (): string => {
  const profile = mkdtempSync(join(tmpdir(), "lossless-claw-test-"));
  temporaryProfiles.push(profile);
  return profile;
};

const writeSession = (
  profile: string,
  relativePath: string,
  entries: ReadonlyArray<unknown>,
): string => {
  const path = join(profile, "sessions", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
};

const header = (id: string) => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-07-01T00:00:00.000Z",
  cwd: "/profile",
});

const userMessage = (id: string, parentId: string | null, timestamp: string, content: string) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: {
    role: "user",
    content,
    timestamp: Date.parse(timestamp),
  },
});

afterEach(() => {
  for (const profile of temporaryProfiles.splice(0)) {
    rmSync(profile, { recursive: true, force: true });
  }
});

describe("Lossless Claw session projection", () => {
  test("discovers recursively, uses header identity, retains summaries, and marks the final branch", () => {
    const profile = createProfile();
    const sessionPath = writeSession(profile, "archive/deep/not-the-session-id.jsonl", [
      header("header-session-id"),
      userMessage("root", null, "2026-07-01T00:01:00.000Z", "shared root evidence"),
      {
        type: "message",
        id: "abandoned",
        parentId: "root",
        timestamp: "2026-07-01T00:02:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "abandoned branch evidence" }],
          timestamp: Date.parse("2026-07-01T00:02:00.000Z"),
        },
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "root",
        timestamp: "2026-07-01T00:03:00.000Z",
        summary: "retained compact summary",
        firstKeptEntryId: "root",
        tokensBefore: 100,
      },
      {
        type: "branch_summary",
        id: "branch-summary",
        parentId: "compact",
        timestamp: "2026-07-01T00:04:00.000Z",
        fromId: "compact",
        summary: "retained branch summary",
      },
      userMessage(
        "active-leaf",
        "branch-summary",
        "2026-07-01T00:05:00.000Z",
        "active leaf evidence",
      ),
    ]);

    const sessions = listProfileSessions(profile);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "header-session-id",
      path: sessionPath,
      activeLeafId: "active-leaf",
      compactions: 1,
      branchSummaries: 1,
    });

    const description = describeProfileSession(profile, "header-session-id");
    expect(description).toMatchObject({
      sessionId: "header-session-id",
      activeLeafId: "active-leaf",
      compactions: 1,
      branchSummaries: 1,
    });
    expect(description?.activeBranch.map((entry) => entry.entryId)).toEqual([
      "root",
      "compact",
      "branch-summary",
      "active-leaf",
    ]);

    const compaction = searchProfileSessions(profile, {
      query: "retained compact",
      session: "header-session-id",
    });
    expect(compaction).toHaveLength(2);
    expect(compaction[0]).toMatchObject({
      entryId: "compact",
      parentId: "root",
      kind: "compaction",
      active: true,
      match: "and",
    });

    const abandoned = searchProfileSessions(profile, {
      query: "abandoned",
      activeOnly: true,
    });
    expect(abandoned).toEqual([]);
  });

  test("does not index sessions reached through an external directory symlink", () => {
    const profile = createProfile();
    const outside = createProfile();
    writeSession(outside, "outside.jsonl", [
      header("outside-session"),
      userMessage("outside-entry", null, "2026-07-01T00:01:00.000Z", "outside-secret-marker"),
    ]);
    mkdirSync(join(profile, "sessions"), { recursive: true });
    symlinkSync(join(outside, "sessions"), join(profile, "sessions", "linked"), "dir");

    expect(listProfileSessions(profile)).toEqual([]);
    expect(searchProfileSessions(profile, { query: "outside-secret-marker" })).toEqual([]);
  });

  test("transactionally replaces changed files and removes deleted projections", () => {
    const profile = createProfile();
    const sessionPath = writeSession(profile, "current.jsonl", [
      header("refresh-session"),
      userMessage("old", null, "2026-07-02T00:01:00.000Z", "obsolete orchid"),
    ]);

    expect(searchProfileSessions(profile, { query: "orchid" })).toHaveLength(1);

    writeSession(profile, "current.jsonl", [
      header("refresh-session"),
      userMessage(
        "new",
        null,
        "2026-07-02T00:02:00.000Z",
        "replacement cobalt content with a different size",
      ),
    ]);

    expect(searchProfileSessions(profile, { query: "orchid" })).toEqual([]);
    expect(searchProfileSessions(profile, { query: "cobalt" })).toMatchObject([
      { sessionId: "refresh-session", entryId: "new" },
    ]);

    unlinkSync(sessionPath);
    expect(searchProfileSessions(profile, { query: "cobalt" })).toEqual([]);
  });

  test("searches tool text and expands a hit with neighboring evidence", () => {
    const profile = createProfile();
    writeSession(profile, "tooling.jsonl", [
      header("tool-session"),
      userMessage("request", null, "2026-07-03T00:01:00.000Z", "prepare lunar deployment"),
      {
        type: "message",
        id: "tool-call",
        parentId: "request",
        timestamp: "2026-07-03T00:02:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "release_build",
              arguments: { target: "moon" },
            },
          ],
          timestamp: Date.parse("2026-07-03T00:02:00.000Z"),
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "tool-call",
        timestamp: "2026-07-03T00:03:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "release_build",
          content: [{ type: "text", text: "deployment complete artifact 42" }],
          isError: false,
          timestamp: Date.parse("2026-07-03T00:03:00.000Z"),
        },
      },
      {
        type: "message",
        id: "answer",
        parentId: "tool-result",
        timestamp: "2026-07-03T00:04:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "neighboring final answer" }],
          timestamp: Date.parse("2026-07-03T00:04:00.000Z"),
        },
      },
    ]);

    const toolCallMatches = searchProfileSessions(profile, {
      query: "release_build moon",
      session: "tool-session",
    });
    expect(toolCallMatches[0]).toMatchObject({
      entryId: "tool-call",
      role: "assistant",
      match: "and",
    });

    const expanded = expandProfileQuery(profile, {
      query: "deployment artifact",
      session: "tool-session",
      limit: 1,
      context: 1,
    });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.match).toMatchObject({
      entryId: "tool-result",
      role: "toolResult",
    });
    expect(expanded[0]?.evidence.map((entry) => entry.entryId)).toEqual([
      "tool-call",
      "tool-result",
      "answer",
    ]);
  });
});
