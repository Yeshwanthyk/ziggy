import { expect, test } from "bun:test";
import {
  decodeSessionEnvelope,
  encodeSessionEnvelope,
  type SessionEnvelope,
} from "../../packages/protocol/src/index.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  observeCanonicalEvents,
} from "../testkit/verification-observations.ts";

test("S1 protocol canonical envelope is identical across encode, decode, and replay filtering", () => {
  const envelopes: ReadonlyArray<SessionEnvelope> = [
    {
      schemaVersion: 1,
      seq: 1,
      emittedAt: "2026-07-19T00:00:00.000Z",
      event: {
        type: "turn-started",
        sessionId: "fixture-session",
        turnId: "fixture-turn",
        message: "fixture message",
        origin: "user",
      },
    },
    {
      schemaVersion: 1,
      seq: 2,
      emittedAt: "2026-07-19T00:00:00.001Z",
      event: {
        type: "turn-ended",
        sessionId: "fixture-session",
        turnId: "fixture-turn",
        status: "completed",
      },
    },
  ];
  const frames = envelopes.map(encodeSessionEnvelope);
  const replay = frames.map(decodeSessionEnvelope).filter((envelope) => envelope.seq > 1);

  expect(frames.map(decodeSessionEnvelope)).toEqual([...envelopes]);
  const second = envelopes[1];
  if (second === undefined) {
    throw new Error("missing protocol fixture envelope");
  }
  expect(replay).toEqual([second]);
  expect(() => decodeSessionEnvelope(frames[0]?.slice(0, -2) ?? "")).toThrow();
  expect(() =>
    decodeSessionEnvelope((frames[0] ?? "").replace('"schemaVersion":1', '"schemaVersion":2')),
  ).toThrow();

  emitVerificationObservation("s1.protocol", {
    ...emptyRuntimeObservations(),
    canonicalEventTrace: observeCanonicalEvents(envelopes),
  });
});
