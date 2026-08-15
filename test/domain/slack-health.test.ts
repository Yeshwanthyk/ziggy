import { describe, expect, test } from "bun:test";
import { evolveSlackHealth, initialSlackHealth } from "ziggy/domain/slack-health";

describe("Slack health projection", () => {
  test("tracks lifecycle counts without retaining message or Slack routing content", () => {
    const connected = evolveSlackHealth(initialSlackHealth(1), { _tag: "connected", atMs: 2 });
    const inbound = evolveSlackHealth(connected, { _tag: "inbound", atMs: 3 });
    const accepted = evolveSlackHealth(inbound, {
      _tag: "accepted",
      atMs: 4,
      queued: true,
    });
    const started = evolveSlackHealth(accepted, { _tag: "started", atMs: 5, wasQueued: true });
    const completed = evolveSlackHealth(started, {
      _tag: "completed",
      atMs: 6,
      succeeded: true,
    });

    expect(completed).toEqual({
      version: 2,
      state: "connected",
      updatedAtMs: 6,
      startedAtMs: 1,
      lastConnectedAtMs: 2,
      lastInboundAtMs: 3,
      lastTurnCompletedAtMs: 6,
      activeTurnCount: 0,
      queuedTurnCount: 0,
      acceptedTurnCount: 1,
      completedTurnCount: 1,
      cancelledTurnCount: 0,
      failedTurnCount: 0,
      lastFailure: null,
    });
    expect(JSON.stringify(completed)).not.toMatch(
      /channel|message|prompt|response|session|token|ts/u,
    );
  });

  test("counts operator cancellation without fabricating a turn failure", () => {
    const accepted = evolveSlackHealth(initialSlackHealth(1), {
      _tag: "accepted",
      atMs: 2,
      queued: false,
    });
    const cancelled = evolveSlackHealth(accepted, { _tag: "cancelled", atMs: 3 });

    expect(cancelled.activeTurnCount).toBe(0);
    expect(cancelled.cancelledTurnCount).toBe(1);
    expect(cancelled.failedTurnCount).toBe(0);
    expect(cancelled.lastFailure).toBeNull();
  });
});
