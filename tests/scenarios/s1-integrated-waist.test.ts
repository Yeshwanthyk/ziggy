import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  resumeFilesystemSession,
} from "../../packages/core/src/index.ts";
import type { SessionEnvelope } from "../../packages/protocol/src/index.ts";
import { ScriptedProvider, textStep } from "../testkit/provider/scripted.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  observeProviderInputs,
} from "../testkit/verification-observations.ts";

test("S1 integrated waist composes a full headless Turn and resumes durable replay without current Memory", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s1-scenario-integrated-"));
  try {
    let millisecond = 0;
    const world = createFilesystemWorld({
      profilePath: profile,
      now: () => new Date(Date.parse("2026-07-19T00:00:00.000Z") + millisecond++),
      nextTemporaryId: () => "fixture-temp",
    });
    await world.replaceMemoryBatch([{ document: "MEMORY.md", content: "fixture retained fact" }]);
    const provider = new ScriptedProvider([textStep("fixture integrated answer", 100)]);
    const runtime = await createFilesystemSessionRuntime({
      sessionId: "fixture-integrated",
      baseSystemPrompt: "fixture base prompt",
      world,
      model: provider.model,
      streamSimple: provider.streamSimple,
      cacheRetention: "long",
      nextTurnId: () => "fixture-turn",
      nextStepId: () => "fixture-step",
      tools: [],
    });
    await runtime.startTurn({ message: "fixture integrated question" });
    await runtime.waitForIdle();

    const replay = await world.readSession("fixture-integrated", 0);
    const bytes = await readFile(join(profile, "sessions/fixture-integrated.ndjson"), "utf8");
    expect(bytes).toBe(replay.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n");
    expect(replay.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await world.readSession("fixture-integrated", 7)).toEqual([]);
    await runtime.close();

    const journalPath = join(profile, "memory/.batch-journal.json");
    await writeFile(journalPath, "{malformed", "utf8");
    const journalBefore = await readFile(journalPath, "utf8");
    const resumedReplay: SessionEnvelope[] = [];
    const resumeProvider = new ScriptedProvider([]);
    const resumed = await resumeFilesystemSession({
      world: createFilesystemWorld({ profilePath: profile }),
      sessionId: "fixture-integrated",
      baseSystemPrompt: "changed fixture base must be ignored",
      tools: [],
      model: resumeProvider.model,
      streamSimple: resumeProvider.streamSimple,
      cacheRetention: "long",
      nextTurnId: () => "unused-turn",
      nextStepId: () => "unused-step",
      sinceSeq: 0,
      onEnvelope: (envelope) => resumedReplay.push(envelope),
    });
    const durableTail = replay.at(-1);
    if (durableTail === undefined) {
      throw new Error("fixture integrated Session has no durable tail");
    }
    expect([...resumedReplay]).toEqual([...replay]);
    expect(resumed.subscription.replayThroughSeq).toBe(durableTail.seq);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    resumed.subscription.unsubscribe();
    await resumed.runtime.close();

    emitVerificationObservation("s1.integrated-waist", {
      ...emptyRuntimeObservations(),
      canonicalEventTrace: observeCanonicalEvents(replay),
      providerInputs: observeProviderInputs(provider.calls),
      filesystemDiffs: [
        {
          path: "sessions/fixture-integrated.ndjson",
          change: "created",
          beforeDigest: null,
          afterDigest: fixtureDigest(bytes),
        },
        {
          path: "memory/.batch-journal.json",
          change: "unchanged",
          beforeDigest: fixtureDigest(journalBefore),
          afterDigest: fixtureDigest(await readFile(journalPath, "utf8")),
        },
      ],
    });
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
});
