import { FixedClock } from "../boundaries.ts";
import {
  fixtureEventValidator,
  validateSessionEnvelope,
  type ContractWorld,
  type ContractWorldSpecimen,
  type EventValidator,
  type FixtureEvent,
  type MemoryCommitCutPoint,
  type MemoryReplacement,
  type SessionEnvelope,
  type SessionSummary,
} from "./contract.ts";

interface StoredSession<Event> {
  readonly created: number;
  readonly envelopes: SessionEnvelope<Event>[];
}

interface PendingMemoryCommit {
  readonly oldValues: Map<string, string>;
  readonly newValues: Map<string, string>;
  phase: "prepared" | "committing" | "committed";
}

interface SharedState<Event> {
  readonly sessions: Map<string, StoredSession<Event>>;
  memory: Map<string, string>;
  nextSessionOrder: number;
  nextFault: MemoryCommitCutPoint | undefined;
  pendingMemoryCommit: PendingMemoryCommit | undefined;
  readonly clock: FixedClock;
}

class InMemoryWorld<Event> implements ContractWorld<Event> {
  constructor(
    private readonly state: SharedState<Event>,
    private readonly eventValidator: EventValidator<Event>,
  ) {}

  async appendSession(sessionId: string, event: unknown): Promise<SessionEnvelope<Event>> {
    const decodedEvent = this.eventValidator.decode(event);
    let stored = this.state.sessions.get(sessionId);
    if (stored === undefined) {
      stored = { created: this.state.nextSessionOrder, envelopes: [] };
      this.state.nextSessionOrder += 1;
      this.state.sessions.set(sessionId, stored);
    }

    const envelope = validateSessionEnvelope(
      {
        schemaVersion: 1,
        seq: stored.envelopes.length + 1,
        emittedAt: this.state.clock.now().toISOString(),
        event: structuredClone(decodedEvent),
      },
      stored.envelopes.length + 1,
      this.eventValidator,
    );
    this.state.clock.advance(1);
    stored.envelopes.push(structuredClone(envelope));
    return structuredClone(envelope);
  }

  async readSession(
    sessionId: string,
    afterSeq: number,
  ): Promise<ReadonlyArray<SessionEnvelope<Event>>> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new Error("afterSeq must be a non-negative integer");
    }
    const stored = this.state.sessions.get(sessionId);
    if (stored === undefined) {
      return [];
    }
    const validated = stored.envelopes.map((envelope, index) =>
      validateSessionEnvelope(envelope, index + 1, this.eventValidator),
    );
    return structuredClone(validated.filter((envelope) => envelope.seq > afterSeq));
  }

  async listSessions(): Promise<ReadonlyArray<SessionSummary>> {
    return [...this.state.sessions.entries()]
      .sort((left, right) => left[1].created - right[1].created)
      .map(([sessionId, stored]) => ({ sessionId, lastSeq: stored.envelopes.length }));
  }

  async readMemory(document: string): Promise<string | undefined> {
    return this.state.memory.get(document);
  }

  async replaceMemoryBatch(replacements: ReadonlyArray<MemoryReplacement>): Promise<void> {
    const fault = this.state.nextFault;
    this.state.nextFault = undefined;
    failAt(fault, "beforePrepare");

    const transaction: PendingMemoryCommit = {
      oldValues: new Map(this.state.memory),
      newValues: applyReplacements(this.state.memory, replacements),
      phase: "prepared",
    };
    this.state.pendingMemoryCommit = transaction;
    failAt(fault, "afterPrepare");

    transaction.phase = "committing";
    const entries = [...transaction.newValues.entries()];
    const first = entries[0];
    if (first !== undefined) {
      this.state.memory.set(first[0], first[1]);
    }
    failAt(fault, "duringCommit");

    this.state.memory = new Map(transaction.newValues);
    transaction.phase = "committed";
    failAt(fault, "afterCommit");
    this.state.pendingMemoryCommit = undefined;
  }
}

export function createInMemorySpecimen(): ContractWorldSpecimen<FixtureEvent> {
  const state: SharedState<FixtureEvent> = {
    sessions: new Map(),
    memory: new Map(),
    nextSessionOrder: 0,
    nextFault: undefined,
    pendingMemoryCommit: undefined,
    clock: new FixedClock("2026-07-19T00:00:00.000Z"),
  };

  return {
    world: new InMemoryWorld(state, fixtureEventValidator),
    failNextMemoryBatch(cutPoint) {
      state.nextFault = cutPoint;
    },
    reopen() {
      recoverMemory(state);
      return new InMemoryWorld(state, fixtureEventValidator);
    },
  };
}

function applyReplacements(
  current: ReadonlyMap<string, string>,
  replacements: ReadonlyArray<MemoryReplacement>,
): Map<string, string> {
  const staged = new Map(current);
  for (const replacement of replacements) {
    staged.set(replacement.document, replacement.content);
  }
  return staged;
}

function failAt(actual: MemoryCommitCutPoint | undefined, expected: MemoryCommitCutPoint): void {
  if (actual === expected) {
    throw new Error(`injected ${expected} fault`);
  }
}

function recoverMemory<Event>(state: SharedState<Event>): void {
  const pending = state.pendingMemoryCommit;
  if (pending === undefined) {
    return;
  }
  state.memory = new Map(pending.phase === "prepared" ? pending.oldValues : pending.newValues);
  state.pendingMemoryCommit = undefined;
}
