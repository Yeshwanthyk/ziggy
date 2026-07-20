import type { SessionEnvelope } from "@ziggy/protocol";
import type { SessionWorld } from "../agent/runtime.ts";

export async function reconcileSession(world: SessionWorld, sessionId: string): Promise<void> {
  const envelopes = await world.readSession(sessionId, 0);
  const open = scanSessionLifecycle(envelopes);
  if (open.stepId !== undefined && open.turnId !== undefined) {
    await world.appendSession(sessionId, {
      type: "step-ended",
      sessionId,
      turnId: open.turnId,
      stepId: open.stepId,
      status: "failed",
    });
  }
  if (open.turnId !== undefined) {
    await world.appendSession(sessionId, {
      type: "turn-ended",
      sessionId,
      turnId: open.turnId,
      status: "failed",
    });
  }
}

export function scanSessionLifecycle(envelopes: ReadonlyArray<SessionEnvelope>): {
  readonly turnId: string | undefined;
  readonly stepId: string | undefined;
} {
  let turnId: string | undefined;
  let stepId: string | undefined;
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.type === "turn-started") {
      if (turnId !== undefined) throw new Error(`Session lifecycle has overlapping turns`);
      turnId = event.turnId;
    } else if (event.type === "step-started") {
      if (turnId !== event.turnId || stepId !== undefined) {
        throw new Error(`Session lifecycle has an invalid step start`);
      }
      stepId = event.stepId;
    } else if (event.type === "step-ended") {
      if (turnId !== event.turnId || stepId !== event.stepId) {
        throw new Error(`Session lifecycle has an unmatched step end`);
      }
      stepId = undefined;
    } else if (event.type === "turn-ended") {
      if (turnId !== event.turnId || stepId !== undefined) {
        throw new Error(`Session lifecycle has an invalid turn end`);
      }
      turnId = undefined;
    }
  }
  return { turnId, stepId };
}
