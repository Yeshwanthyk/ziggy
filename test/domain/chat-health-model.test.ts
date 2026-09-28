import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  evolveSlackHealth,
  initialSlackHealth,
  type SlackHealthEvent,
} from "ziggy/domain/slack-health";
import { evolveDiscordHealth, initialDiscordHealth } from "ziggy/domain/discord-health";

// Generate only lifecycle transitions the schedulers can emit: a turn is accepted once,
// starts at most once, and is settled once. Stop discards outstanding turns.
test("Slack and Discord health counts follow outstanding turns", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.nat()), { maxLength: 150 }),
      (steps) => {
        let slack = initialSlackHealth(0);
        let discord = initialDiscordHealth(0);
        let outstanding: Array<{ queued: boolean }> = [];
        let accepted = 0;
        let completed = 0;
        let cancelled = 0;
        let failed = 0;

        steps.forEach(([action, index], atMs) => {
          let event: SlackHealthEvent;

          if (action === 0 || outstanding.length === 0) {
            const queued = outstanding.length > 0;

            outstanding.push({ queued });
            accepted += 1;
            event = { _tag: "accepted", atMs, queued };
          } else if (action === 4) {
            outstanding = [];
            event = { _tag: "stopped", atMs };
          } else {
            const position = index % outstanding.length;
            const turn = outstanding[position];

            if (turn === undefined) return;

            if (action === 1 && turn.queued) {
              turn.queued = false;
              event = { _tag: "started", atMs, wasQueued: true };
            } else {
              outstanding.splice(position, 1);

              if (action === 2) {
                cancelled += 1;
                event = { _tag: "cancelled", atMs, wasQueued: turn.queued };
              } else {
                const succeeded = action === 1;

                if (succeeded) completed += 1;
                else failed += 1;

                // A queued turn cannot complete before starting; start it first.
                if (turn.queued) {
                  const start: SlackHealthEvent = { _tag: "started", atMs, wasQueued: true };
                  slack = evolveSlackHealth(slack, start);
                  discord = evolveDiscordHealth(discord, start);
                }

                event = { _tag: "completed", atMs, succeeded };
              }
            }
          }

          slack = evolveSlackHealth(slack, event);
          discord = evolveDiscordHealth(discord, event);
          const queued = outstanding.filter((turn) => turn.queued).length;

          for (const snapshot of [slack, discord]) {
            expect(snapshot.activeTurnCount).toBe(outstanding.length);
            expect(snapshot.queuedTurnCount).toBe(queued);
            expect(snapshot.queuedTurnCount).toBeLessThanOrEqual(snapshot.activeTurnCount);
            expect(snapshot.acceptedTurnCount).toBe(accepted);
            expect(snapshot.completedTurnCount).toBe(completed);
            expect(snapshot.cancelledTurnCount).toBe(cancelled);
            expect(snapshot.failedTurnCount).toBe(failed);
          }
        });
      },
    ),
    { numRuns: 200, seed: 20260928 },
  );
});
