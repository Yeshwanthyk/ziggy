import { expect, test } from "bun:test";
import { createSessionRuntime } from "../../packages/core/src/index.ts";
import { Effect, Scope } from "effect";
import { runEffect } from "../testkit/effect.ts";
import { ScriptedProvider, textStep } from "../testkit/provider/scripted.ts";
import { RecordingSessionWorld } from "../testkit/provider/session-world.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  observeCanonicalEvents,
  observeProviderInputs,
} from "../testkit/verification-observations.ts";

test("S1 agent loop records a deterministic Turn and its actual Provider input", async () => {
  const world = new RecordingSessionWorld();
  const provider = new ScriptedProvider([textStep("fixture answer", 100)]);
  const scope = await runEffect(Scope.make());
  const runtime = await runEffect(
    createSessionRuntime({
      sessionId: "fixture-session",
      snapshot: { systemPrompt: "fixture system prompt", tools: [] },
      world,
      model: provider.model,
      streamSimple: provider.streamSimple,
      cacheRetention: "long",
      nextTurnId: () => "fixture-turn",
      nextStepId: () => "fixture-step",
      tools: [],
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  expect(await runEffect(runtime.startTurn({ message: "fixture question" }))).toEqual({
    turnId: "fixture-turn",
    disposition: "started",
  });
  await runEffect(runtime.waitForIdle);
  const replay = await runEffect(world.readSession("fixture-session", 0));
  expect(replay.map((envelope) => envelope.event.type)).toEqual([
    "session-started",
    "turn-started",
    "step-started",
    "model-chunk",
    "model-response",
    "step-ended",
    "turn-ended",
  ]);
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]?.options).toEqual({
    sessionId: "fixture-session",
    cacheRetention: "long",
  });

  emitVerificationObservation("s1.agent-loop", {
    ...emptyRuntimeObservations(),
    canonicalEventTrace: observeCanonicalEvents(replay),
    providerInputs: observeProviderInputs(provider.calls),
  });
  await runEffect(runtime.close);
});
