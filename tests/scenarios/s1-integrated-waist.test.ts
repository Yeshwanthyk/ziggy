import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  resumeFilesystemSession,
} from "../../packages/core/src/index.ts";
import { Effect, Scope } from "effect";
import type { SessionEnvelope } from "../../packages/protocol/src/index.ts";
import { ScriptedProvider, textStep } from "../testkit/provider/scripted.ts";
import { runEffect } from "../testkit/effect.ts";
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
    await runEffect(
      world.replaceMemoryBatch([{ document: "MEMORY.md", content: "fixture retained fact" }]),
    );
    const provider = new ScriptedProvider([textStep("fixture integrated answer", 100)]);
    const scope = await runEffect(Scope.make());
    const runtime = await runEffect(
      createFilesystemSessionRuntime({
        sessionId: "fixture-integrated",
        baseSystemPrompt: "fixture base prompt",
        world,
        model: provider.model,
        streamSimple: provider.streamSimple,
        cacheRetention: "long",
        nextTurnId: () => "fixture-turn",
        nextStepId: () => "fixture-step",
        tools: [],
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await runEffect(runtime.startTurn({ message: "fixture integrated question" }));
    await runEffect(runtime.waitForIdle);

    const replay = await runEffect(world.readSession("fixture-integrated", 0));
    const bytes = await readFile(join(profile, "sessions/fixture-integrated.ndjson"), "utf8");
    expect(bytes).toBe(replay.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n");
    expect(replay.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await runEffect(world.readSession("fixture-integrated", 7))).toEqual([]);
    await runEffect(runtime.close);

    const journalPath = join(profile, "memory/.batch-journal.json");
    await writeFile(journalPath, "{malformed", "utf8");
    const journalBefore = await readFile(journalPath, "utf8");
    const resumedReplay: SessionEnvelope[] = [];
    const resumeProvider = new ScriptedProvider([]);
    const resumeScope = await runEffect(Scope.make());
    const resumed = await runEffect(
      resumeFilesystemSession({
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
      }).pipe(Effect.provideService(Scope.Scope, resumeScope)),
    );
    const durableTail = replay.at(-1);
    if (durableTail === undefined) {
      throw new Error("fixture integrated Session has no durable tail");
    }
    expect([...resumedReplay]).toEqual([...replay]);
    expect(resumed.subscription.replayThroughSeq).toBe(durableTail.seq);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    await runEffect(resumed.subscription.unsubscribe);
    await runEffect(resumed.runtime.close);

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
