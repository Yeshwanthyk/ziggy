import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemWorld,
  createSessionRuntime,
  openSession,
} from "../../packages/core/src/index.ts";
import { ScriptedProvider, textStep } from "../testkit/provider/scripted.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  observeProviderInputs,
} from "../testkit/verification-observations.ts";

test("S1 integrated waist persists one full headless Turn and replays exact canonical bytes", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s1-scenario-integrated-"));
  try {
    let millisecond = 0;
    const world = createFilesystemWorld({
      profilePath: profile,
      now: () => new Date(Date.parse("2026-07-19T00:00:00.000Z") + millisecond++),
      nextTemporaryId: () => "fixture-temp",
    });
    await world.replaceMemoryBatch([{ document: "MEMORY.md", content: "fixture retained fact" }]);
    const snapshot = await openSession({
      world,
      sessionId: "fixture-integrated",
      baseSystemPrompt: "fixture base prompt",
      tools: [],
    });
    const provider = new ScriptedProvider([textStep("fixture integrated answer", 100)]);
    const runtime = await createSessionRuntime({
      sessionId: "fixture-integrated",
      snapshot,
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
      ],
    });
    await runtime.close();
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
});
