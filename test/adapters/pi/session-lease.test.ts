/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import fc from "fast-check";
import { acquireSessionLease, makeSessionLeaseTransitions } from "ziggy/adapters/pi/session-lease";

test("one live holder per session; stale pid reclaims; releases are idempotent", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
      async (staleFlags) => {
        const profile = await mkdtemp(join(tmpdir(), "ziggy-session-lease-"));
        let owner = 0;
        let live = true;
        const runtime = { pid: 12345, ownerId: () => `owner-${++owner}`, isAlive: () => live };

        try {
          for (const [index, stale] of staleFlags.entries()) {
            const id = `session-${index}`;
            const first = await Effect.runPromise(acquireSessionLease(profile, id, runtime));
            const held = await Effect.runPromiseExit(acquireSessionLease(profile, id, runtime));
            expect(Exit.isFailure(held)).toBe(true);

            if (stale) {
              live = false;

              const replacement = await Effect.runPromise(
                acquireSessionLease(profile, id, runtime),
              );

              await Effect.runPromise(first); // Old owner cannot erase replacement.
              live = true;

              const stillHeld = Exit.isFailure(
                await Effect.runPromiseExit(acquireSessionLease(profile, id, runtime)),
              );

              if (!stillHeld) throw new Error("old owner released the replacement lease");
              await Effect.runPromise(replacement);
            } else {
              await Effect.runPromise(first);
            }

            await Effect.runPromise(first);
            const next = await Effect.runPromise(acquireSessionLease(profile, id, runtime));
            await Effect.runPromise(next);
          }
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 30 },
  );
});

test("session replacement holds its destination before releasing its previous id", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-session-transition-"));

  try {
    const first = await Effect.runPromise(acquireSessionLease(profile, "first"));
    const transitions = makeSessionLeaseTransitions(profile, "first", first);
    const competing = await Effect.runPromise(acquireSessionLease(profile, "second"));
    const blocked = await Effect.runPromiseExit(transitions.reserve("second"));

    expect(Exit.isFailure(blocked)).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(acquireSessionLease(profile, "first")))).toBe(
      true,
    );
    await Effect.runPromise(competing);
    await Effect.runPromise(transitions.reserve("second"));
    expect(
      Exit.isFailure(await Effect.runPromiseExit(acquireSessionLease(profile, "second"))),
    ).toBe(true);
    await Effect.runPromise(transitions.transition("second"));
    expect(transitions.owns("second")).toBe(true);
    const old = await Effect.runPromise(acquireSessionLease(profile, "first"));
    await Effect.runPromise(old);
    await Effect.runPromise(transitions.close);
    await Effect.runPromise(transitions.close);
    const next = await Effect.runPromise(acquireSessionLease(profile, "second"));
    await Effect.runPromise(next);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
