import { describe, expect, test } from "bun:test";
import {
  defineContractTests,
  fixtureEventValidator,
  validateSessionEnvelope,
  type FixtureEvent,
  type SessionEnvelope,
} from "./contract.ts";
import { createInMemorySpecimen } from "./in-memory.ts";

const validEventFixtures: readonly [FixtureEvent, FixtureEvent, FixtureEvent] = [
  { fixture: "one" },
  { fixture: "two" },
  { fixture: "three" },
];

defineContractTests("shared-state in-memory specimen", {
  eventValidator: fixtureEventValidator,
  validEventFixtures,
  expectedEvents: validEventFixtures,
  invalidEvent: { wrong: true },
  create: createInMemorySpecimen,
});

describe("Session envelope validation", () => {
  const canonicalEnvelope: SessionEnvelope<FixtureEvent> = {
    schemaVersion: 1,
    seq: 1,
    emittedAt: "2026-07-19T00:00:00.000Z",
    event: validEventFixtures[0],
  };

  test("accepts only the exact canonical keys", () => {
    expect(validateSessionEnvelope(canonicalEnvelope, 1, fixtureEventValidator)).toEqual(
      canonicalEnvelope,
    );
    expect(() =>
      validateSessionEnvelope({ ...canonicalEnvelope, extra: true }, 1, fixtureEventValidator),
    ).toThrow("expected canonical fields");
  });

  test("rejects invalid schema versions, sequences, timestamps, and events", () => {
    const invalidEnvelopes: ReadonlyArray<unknown> = [
      { ...canonicalEnvelope, schemaVersion: 2 },
      { ...canonicalEnvelope, seq: 0 },
      { ...canonicalEnvelope, seq: 1.5 },
      { ...canonicalEnvelope, emittedAt: "2026-07-19" },
      { ...canonicalEnvelope, event: { wrong: true } },
    ];

    for (const envelope of invalidEnvelopes) {
      expect(() => validateSessionEnvelope(envelope, 1, fixtureEventValidator)).toThrow();
    }
  });
});
