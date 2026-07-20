import type { SessionEnvelope, SessionEvent } from "../../../packages/protocol/src/index.ts";
import { FixedClock } from "../boundaries.ts";

export class RecordingSessionWorld {
  private readonly sessions = new Map<string, SessionEnvelope[]>();

  constructor(private readonly clock = new FixedClock("2026-07-19T00:00:00.000Z")) {}

  async appendSession(sessionId: string, event: SessionEvent): Promise<SessionEnvelope> {
    const stored = this.sessions.get(sessionId) ?? [];
    if (event.sessionId !== sessionId) {
      throw new Error(`Event Session ${event.sessionId} does not match ${sessionId}`);
    }
    const envelope: SessionEnvelope = {
      schemaVersion: 1,
      seq: stored.length + 1,
      emittedAt: this.clock.now().toISOString(),
      event: structuredClone(event),
    };
    this.clock.advance(1);
    stored.push(envelope);
    this.sessions.set(sessionId, stored);
    return structuredClone(envelope);
  }

  async readSession(sessionId: string, afterSeq: number): Promise<ReadonlyArray<SessionEnvelope>> {
    return structuredClone(
      (this.sessions.get(sessionId) ?? []).filter((envelope) => envelope.seq > afterSeq),
    );
  }
}
