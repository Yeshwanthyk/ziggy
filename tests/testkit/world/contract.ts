import { describe, expect, test } from "bun:test";

export interface SessionEnvelope<Event> {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly emittedAt: string;
  readonly event: Event;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly lastSeq: number;
}

export interface MemoryReplacement {
  readonly document: string;
  readonly content: string;
}

export type MemoryCommitCutPoint =
  | "beforePrepare"
  | "afterPrepare"
  | "duringCommit"
  | "afterCommit";

const requiredMemoryCommitCutPoints: ReadonlyArray<MemoryCommitCutPoint> = [
  "beforePrepare",
  "afterPrepare",
  "duringCommit",
  "afterCommit",
];

export interface EventValidator<Event> {
  decode(value: unknown): Event;
}

export interface ContractWorld<Event> {
  appendSession(sessionId: string, event: unknown): Promise<SessionEnvelope<Event>>;
  readSession(sessionId: string, afterSeq: number): Promise<ReadonlyArray<SessionEnvelope<Event>>>;
  listSessions(): Promise<ReadonlyArray<SessionSummary>>;
  readMemory(document: string): Promise<string | undefined>;
  replaceMemoryBatch(replacements: ReadonlyArray<MemoryReplacement>): Promise<void>;
}

export interface ContractWorldSpecimen<Event> {
  readonly world: ContractWorld<Event>;
  failNextMemoryBatch(cutPoint: MemoryCommitCutPoint): void;
  reopen(): ContractWorld<Event>;
}

export interface ContractWorldFactory<Event> {
  readonly eventValidator: EventValidator<Event>;
  readonly validEventFixtures: readonly [unknown, unknown, unknown];
  readonly expectedEvents: readonly [Event, Event, Event];
  readonly invalidEvent: unknown;
  create(): ContractWorldSpecimen<Event>;
}

export interface FixtureEvent {
  readonly fixture: string;
}

export const fixtureEventValidator: EventValidator<FixtureEvent> = {
  decode(value) {
    const record = requireRecord(value, "fixture event");
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== "fixture" || typeof record.fixture !== "string") {
      throw new Error("fixture event: expected exact string fixture field");
    }
    return { fixture: record.fixture };
  },
};

export function validateSessionEnvelope<Event>(
  value: unknown,
  expectedSeq: number,
  eventValidator: EventValidator<Event>,
): SessionEnvelope<Event> {
  const record = requireRecord(value, "Session envelope");
  const keys = Object.keys(record).sort();
  const expectedKeys = ["emittedAt", "event", "schemaVersion", "seq"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Session envelope: expected canonical fields");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("Session envelope: unsupported schemaVersion");
  }
  if (!Number.isInteger(record.seq) || typeof record.seq !== "number" || record.seq <= 0) {
    throw new Error("Session envelope: seq must be a positive integer");
  }
  if (record.seq !== expectedSeq) {
    throw new Error(`Session envelope: expected contiguous seq ${expectedSeq}`);
  }
  if (typeof record.emittedAt !== "string" || !isCanonicalTimestamp(record.emittedAt)) {
    throw new Error("Session envelope: emittedAt must be a canonical timestamp");
  }
  return {
    schemaVersion: 1,
    seq: record.seq,
    emittedAt: record.emittedAt,
    event: eventValidator.decode(record.event),
  };
}

export function defineContractTests<Event>(
  label: string,
  factory: ContractWorldFactory<Event>,
): void {
  const [firstFixture, secondFixture, thirdFixture] = factory.validEventFixtures;
  const [firstEvent, secondEvent, thirdEvent] = factory.expectedEvents;

  describe(`${label} semantic World contract`, () => {
    test("specimens are isolated", async () => {
      const first = factory.create();
      const second = factory.create();
      await first.world.appendSession("session-a", firstFixture);
      await first.world.replaceMemoryBatch([{ document: "MEMORY.md", content: "first" }]);

      expect(await second.world.readSession("session-a", 0)).toEqual([]);
      expect(await second.world.readMemory("MEMORY.md")).toBeUndefined();
    });

    test("uses exact canonical envelopes and validates events at the boundary", async () => {
      const specimen = factory.create();
      const first = await specimen.world.appendSession("session-a", firstFixture);
      const second = await specimen.world.appendSession("session-a", secondFixture);

      expect(first).toEqual({
        schemaVersion: 1,
        seq: 1,
        emittedAt: "2026-07-19T00:00:00.000Z",
        event: firstEvent,
      });
      expect(second).toEqual({
        schemaVersion: 1,
        seq: 2,
        emittedAt: "2026-07-19T00:00:00.001Z",
        event: secondEvent,
      });
      await expect(
        specimen.world.appendSession("session-a", factory.invalidEvent),
      ).rejects.toThrow();
    });

    test("reads exclusively after zero, an exact sequence, and beyond the tail", async () => {
      const specimen = factory.create();
      const first = await specimen.world.appendSession("session-a", firstFixture);
      const second = await specimen.world.appendSession("session-a", secondFixture);

      expect(await specimen.world.readSession("session-a", 0)).toEqual([first, second]);
      expect(await specimen.world.readSession("session-a", 1)).toEqual([second]);
      expect(await specimen.world.readSession("session-a", 2)).toEqual([]);
      expect(await specimen.world.readSession("session-a", 99)).toEqual([]);
    });

    test("replay is unchanged and persistence continues sequence after reopen", async () => {
      const specimen = factory.create();
      const first = await specimen.world.appendSession("session-a", firstFixture);
      const second = await specimen.world.appendSession("session-a", secondFixture);
      const before = await specimen.world.readSession("session-a", 0);
      const reopened = specimen.reopen();

      expect(before).toEqual([first, second]);
      expect(await reopened.readSession("session-a", 0)).toEqual(before);

      const third = await reopened.appendSession("session-a", thirdFixture);
      expect(third).toEqual({
        schemaVersion: 1,
        seq: 3,
        emittedAt: "2026-07-19T00:00:00.002Z",
        event: thirdEvent,
      });
      expect(before).toEqual([first, second]);
      expect(await reopened.readSession("session-a", 0)).toEqual([...before, third]);
    });

    test("lists Sessions in creation order with their latest sequence", async () => {
      const specimen = factory.create();
      await specimen.world.appendSession("session-z", firstFixture);
      await specimen.world.appendSession("session-a", secondFixture);
      await specimen.world.appendSession("session-z", thirdFixture);

      expect(await specimen.world.listSessions()).toEqual([
        { sessionId: "session-z", lastSeq: 2 },
        { sessionId: "session-a", lastSeq: 1 },
      ]);
    });

    for (const cutPoint of requiredMemoryCommitCutPoints) {
      test(`Memory batch is all-old or all-new after recovery from ${cutPoint}`, async () => {
        const specimen = factory.create();
        await seedMemory(specimen.world);
        specimen.failNextMemoryBatch(cutPoint);

        await expect(replaceBoth(specimen.world)).rejects.toThrow(`injected ${cutPoint} fault`);
        const recovered = specimen.reopen();
        const values = await readMemoryPair(recovered);
        const allOld = values[0] === "old-memory" && values[1] === "old-user";
        const allNew = values[0] === "new-memory" && values[1] === "new-user";
        expect(allOld || allNew).toBe(true);
      });
    }
  });
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return Object.fromEntries(Object.entries(value));
}

async function seedMemory<Event>(world: ContractWorld<Event>): Promise<void> {
  await world.replaceMemoryBatch([
    { document: "MEMORY.md", content: "old-memory" },
    { document: "USER.md", content: "old-user" },
  ]);
}

async function replaceBoth<Event>(world: ContractWorld<Event>): Promise<void> {
  await world.replaceMemoryBatch([
    { document: "MEMORY.md", content: "new-memory" },
    { document: "USER.md", content: "new-user" },
  ]);
}

async function readMemoryPair<Event>(
  world: ContractWorld<Event>,
): Promise<ReadonlyArray<string | undefined>> {
  return Promise.all([world.readMemory("MEMORY.md"), world.readMemory("USER.md")]);
}
