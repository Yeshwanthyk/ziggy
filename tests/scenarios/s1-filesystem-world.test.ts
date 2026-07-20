import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemWorld } from "../../packages/core/src/index.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
} from "../testkit/verification-observations.ts";

test("S1 filesystem World assigns replay sequence and fails loud on a torn tail", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s1-scenario-world-"));
  try {
    let millisecond = 0;
    const world = createFilesystemWorld({
      profilePath: profile,
      now: () => new Date(Date.parse("2026-07-19T00:00:00.000Z") + millisecond++),
      nextTemporaryId: () => "fixture-temp",
    });
    await world.appendSession("fixture-session", {
      type: "session-started",
      sessionId: "fixture-session",
      snapshot: { systemPrompt: "fixture prompt", tools: [] },
    });
    await world.appendSession("fixture-session", {
      type: "turn-started",
      sessionId: "fixture-session",
      turnId: "fixture-turn",
      message: "fixture message",
      origin: "user",
    });
    const replay = await world.readSession("fixture-session", 0);
    expect(replay.map((envelope) => envelope.seq)).toEqual([1, 2]);
    const second = replay[1];
    if (second === undefined) {
      throw new Error("missing filesystem replay fixture envelope");
    }
    expect(await world.readSession("fixture-session", 1)).toEqual([second]);

    const path = join(profile, "sessions/fixture-session.ndjson");
    const before = await readFile(path, "utf8");
    await appendFile(path, '{"schemaVersion":1');
    const after = await readFile(path, "utf8");
    await expect(world.readSession("fixture-session", 0)).rejects.toThrow();

    emitVerificationObservation("s1.filesystem-world", {
      ...emptyRuntimeObservations(),
      canonicalEventTrace: observeCanonicalEvents(replay),
      faultSchedule: [
        {
          boundary: "Session-log",
          point: "torn-final-line",
          occurrence: 1,
          outcome: "failed",
        },
      ],
      filesystemDiffs: [
        {
          path: "sessions/fixture-session.ndjson",
          change: "modified",
          beforeDigest: fixtureDigest(before),
          afterDigest: fixtureDigest(after),
        },
      ],
    });
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
});
