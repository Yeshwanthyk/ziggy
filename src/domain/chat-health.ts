// These counters have the same transition semantics for Slack and Discord.
export interface ChatHealthCounts {
  readonly activeTurnCount: number;
  readonly queuedTurnCount: number;
  readonly acceptedTurnCount: number;
  readonly completedTurnCount: number;
  readonly cancelledTurnCount: number;
  readonly failedTurnCount: number;
}

export type ChatTurnHealthEvent =
  | { readonly _tag: "accepted"; readonly queued: boolean }
  | { readonly _tag: "started"; readonly wasQueued: boolean }
  | { readonly _tag: "completed"; readonly succeeded: boolean }
  | { readonly _tag: "cancelled"; readonly wasQueued: boolean }
  | { readonly _tag: "stopped" };

export const turnHealthCounts = (
  current: ChatHealthCounts,
  event: ChatTurnHealthEvent,
): ChatHealthCounts => {
  switch (event._tag) {
    case "accepted":
      return {
        ...current,
        activeTurnCount: current.activeTurnCount + 1,
        queuedTurnCount: current.queuedTurnCount + (event.queued ? 1 : 0),
        acceptedTurnCount: current.acceptedTurnCount + 1,
      };
    case "started":
      return {
        ...current,
        queuedTurnCount: event.wasQueued
          ? Math.max(0, current.queuedTurnCount - 1)
          : current.queuedTurnCount,
      };
    case "completed":
      return {
        ...current,
        activeTurnCount: Math.max(0, current.activeTurnCount - 1),
        completedTurnCount: current.completedTurnCount + (event.succeeded ? 1 : 0),
        failedTurnCount: current.failedTurnCount + (event.succeeded ? 0 : 1),
      };
    case "cancelled":
      return {
        ...current,
        activeTurnCount: Math.max(0, current.activeTurnCount - 1),
        queuedTurnCount: event.wasQueued
          ? Math.max(0, current.queuedTurnCount - 1)
          : current.queuedTurnCount,
        cancelledTurnCount: current.cancelledTurnCount + 1,
      };
    case "stopped":
      return { ...current, activeTurnCount: 0, queuedTurnCount: 0 };
  }
};
