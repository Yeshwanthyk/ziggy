import { describe, expect, test } from "bun:test";
import { evolveDiscordHealth, initialDiscordHealth } from "ziggy/domain/discord-health";

describe("Discord runtime health", () => {
  test("tracks connection, queue, completion, cancellation, and boundary failures", () => {
    let health = initialDiscordHealth(1);
    health = evolveDiscordHealth(health, { _tag: "connected", atMs: 2 });
    health = evolveDiscordHealth(health, { _tag: "accepted", atMs: 3, queued: false });
    health = evolveDiscordHealth(health, { _tag: "accepted", atMs: 4, queued: true });
    health = evolveDiscordHealth(health, { _tag: "started", atMs: 5, wasQueued: false });
    health = evolveDiscordHealth(health, { _tag: "completed", atMs: 6, succeeded: true });
    health = evolveDiscordHealth(health, { _tag: "started", atMs: 7, wasQueued: true });
    health = evolveDiscordHealth(health, { _tag: "cancelled", atMs: 8, wasQueued: false });
    health = evolveDiscordHealth(health, {
      _tag: "boundary-failed",
      atMs: 9,
      failure: "thread",
    });

    expect(health).toMatchObject({
      state: "connected",
      activeTurnCount: 0,
      queuedTurnCount: 0,
      acceptedTurnCount: 2,
      completedTurnCount: 1,
      cancelledTurnCount: 1,
      failedTurnCount: 0,
      lastFailure: "thread",
    });
  });

  test("settles a queued turn cancelled before it starts", () => {
    let health = initialDiscordHealth(1);
    health = evolveDiscordHealth(health, { _tag: "connected", atMs: 2 });
    health = evolveDiscordHealth(health, { _tag: "accepted", atMs: 3, queued: false });
    health = evolveDiscordHealth(health, { _tag: "accepted", atMs: 4, queued: true });
    health = evolveDiscordHealth(health, { _tag: "cancelled", atMs: 5, wasQueued: true });

    expect(health).toMatchObject({
      activeTurnCount: 1,
      queuedTurnCount: 0,
      cancelledTurnCount: 1,
    });
  });
});
