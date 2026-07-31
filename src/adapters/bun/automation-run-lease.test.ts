/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Result } from "effect";
import { withAutomationRunLease } from "./automation-run-lease";

test("serializes one automation and releases the lease after interruption", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automation-run-lease-"));
  const target = { path: profilePath, name: "Test" };
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const first = Effect.runFork(
    withAutomationRunLease(
      target,
      "daily-note",
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ),
  );
  await Effect.runPromise(Deferred.await(entered));

  const second = await Effect.runPromise(
    withAutomationRunLease(target, "daily-note", Effect.succeed("ran")).pipe(Effect.result),
  );
  expect(Result.isFailure(second)).toBeTrue();

  await Effect.runPromise(Deferred.succeed(release, undefined));
  await Effect.runPromise(Fiber.join(first));
  expect(
    await Effect.runPromise(
      withAutomationRunLease(target, "daily-note", Effect.succeed("ran")),
    ),
  ).toBe("ran");
  await rm(profilePath, { recursive: true });
});
