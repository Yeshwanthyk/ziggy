import type { SessionEnvelope } from "@ziggy/protocol";
import { Effect, Schema } from "effect";

export interface ReconciliationWorld<WorldError> {
  appendSession(
    sessionId: string,
    event: SessionEnvelope["event"],
  ): Effect.Effect<SessionEnvelope, WorldError>;
  readSession(
    sessionId: string,
    afterSeq: number,
  ): Effect.Effect<ReadonlyArray<SessionEnvelope>, WorldError>;
}

export class SessionLifecycleError extends Schema.TaggedErrorClass<SessionLifecycleError>(
  "@ziggy/core/daemon/SessionLifecycleError",
)("SessionLifecycleError", {
  message: Schema.String,
}) {}

export interface OpenSessionLifecycle {
  readonly turnId: string | undefined;
  readonly stepId: string | undefined;
}

export function reconcileSession<WorldError>(
  world: ReconciliationWorld<WorldError>,
  sessionId: string,
): Effect.Effect<void, SessionLifecycleError | WorldError> {
  return Effect.gen(function* () {
    const envelopes = yield* world.readSession(sessionId, 0);
    const open = yield* scanSessionLifecycle(envelopes);
    if (open.stepId !== undefined && open.turnId !== undefined) {
      yield* world.appendSession(sessionId, {
        type: "step-ended",
        sessionId,
        turnId: open.turnId,
        stepId: open.stepId,
        status: "failed",
      });
    }
    if (open.turnId !== undefined) {
      yield* world.appendSession(sessionId, {
        type: "turn-ended",
        sessionId,
        turnId: open.turnId,
        status: "failed",
      });
    }
  });
}

export function scanSessionLifecycle(
  envelopes: ReadonlyArray<SessionEnvelope>,
): Effect.Effect<OpenSessionLifecycle, SessionLifecycleError> {
  return Effect.gen(function* () {
    let turnId: string | undefined;
    let stepId: string | undefined;
    for (const envelope of envelopes) {
      const event = envelope.event;
      if (event.type === "turn-started") {
        if (turnId !== undefined) {
          return yield* new SessionLifecycleError({
            message: "Session lifecycle has overlapping turns",
          });
        }
        turnId = event.turnId;
      } else if (event.type === "step-started") {
        if (turnId !== event.turnId || stepId !== undefined) {
          return yield* new SessionLifecycleError({
            message: "Session lifecycle has an invalid step start",
          });
        }
        stepId = event.stepId;
      } else if (event.type === "step-ended") {
        if (turnId !== event.turnId || stepId !== event.stepId) {
          return yield* new SessionLifecycleError({
            message: "Session lifecycle has an unmatched step end",
          });
        }
        stepId = undefined;
      } else if (event.type === "turn-ended") {
        if (turnId !== event.turnId || stepId !== undefined) {
          return yield* new SessionLifecycleError({
            message: "Session lifecycle has an invalid turn end",
          });
        }
        turnId = undefined;
      }
    }
    return { turnId, stepId };
  });
}
