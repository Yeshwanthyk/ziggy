import type { SessionEnvelope, SessionEvent } from "../../../packages/protocol/src/index.ts";
import { SessionRuntimeError } from "../../../packages/core/src/agent/runtime.ts";
import { Effect } from "../../../packages/core/node_modules/effect/dist/index.js";
import { FixedClock } from "../boundaries.ts";

export class RecordingSessionWorld {
  private readonly sessions = new Map<string, SessionEnvelope[]>();

  constructor(private readonly clock = new FixedClock("2026-07-19T00:00:00.000Z")) {}

  appendSession(
    sessionId: string,
    event: SessionEvent,
  ): Effect.Effect<SessionEnvelope, SessionRuntimeError> {
    return Effect.try({
      try: () => {
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
      },
      catch: (cause) =>
        new SessionRuntimeError({ message: "Fixture failed to append Session event", cause }),
    });
  }

  readSession(
    sessionId: string,
    afterSeq: number,
  ): Effect.Effect<ReadonlyArray<SessionEnvelope>, SessionRuntimeError> {
    return Effect.sync(() =>
      structuredClone(
        (this.sessions.get(sessionId) ?? []).filter((envelope) => envelope.seq > afterSeq),
      ),
    );
  }
}
