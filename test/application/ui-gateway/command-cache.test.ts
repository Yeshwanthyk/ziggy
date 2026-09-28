/* oxlint-disable ziggy-effect/no-effect-escape-hatch -- Deliberately inject defects to test cache recovery */
/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are Promise-shaped */
import { expect, test } from "bun:test";
import fc from "fast-check";
import { Deferred, Effect, Fiber } from "effect";
import { makeCommandCache } from "ziggy/application/ui-gateway/command-cache";

const success = { id: "first", ok: true as const, result: { pong: true as const } };

test("concurrent identical commands execute once and all waiters finish on success, failure, or defect", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 16 }),
      fc.constantFrom("success", "failure", "defect"),
      async (count, outcome) => {
        const cache = makeCommandCache();
        let executions = 0;

        const results = await Effect.runPromise(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();

            const run = Effect.gen(function* () {
              executions++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);

              if (outcome === "defect") return yield* Effect.die("injected defect");

              if (outcome === "failure") return yield* Effect.fail("injected failure");

              return success;
            });

            const owner = yield* Effect.forkChild(cache("key", "fingerprint", "first", run));
            yield* Deferred.await(started);
            const waiters = [];

            for (let i = 1; i < count; i++) {
              waiters.push(
                yield* Effect.forkChild(cache("key", "fingerprint", `waiter-${i}`, run)),
              );
            }

            yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);

            return yield* Effect.all([Fiber.join(owner), ...waiters.map(Fiber.join)], {
              concurrency: "unbounded",
            });
          }),
        );

        expect(executions).toBe(1);
        expect(results).toHaveLength(count);
        expect(
          results.every((result) => result.ok === (outcome === "success" ? success.ok : false)),
        ).toBe(true);
        expect(results.every((result) => result.id === "first")).toBe(true);

        expect(results.map((result) => (result.ok ? "success" : result.error.code))).toEqual(
          Array(count).fill(outcome === "success" ? "success" : "internal"),
        );
      },
    ),
    { numRuns: 60 },
  );
});

test("an in-flight slot survives completed-result eviction pressure", async () => {
  const cache = makeCommandCache();
  let executions = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const pending = Effect.gen(function* () {
        executions++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);

        return success;
      });

      const owner = yield* Effect.forkChild(cache("oldest", "same", "first", pending));
      yield* Deferred.await(started);

      for (let i = 0; i < 513; i++)
        yield* cache(`completed-${i}`, "same", "first", Effect.succeed(success));
      const waiter = yield* Effect.forkChild(cache("oldest", "same", "second", pending));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* Fiber.join(waiter);
    }),
  );
  expect(executions).toBe(1);
});

test("interrupting the owner releases existing waiters and permits a retry", async () => {
  const cache = makeCommandCache();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const owner = yield* Effect.forkChild(
        cache(
          "key",
          "same",
          "first",
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);

            return yield* Effect.never;
          }),
        ),
      );

      yield* Deferred.await(started);

      const waiter = yield* Effect.forkChild(
        cache("key", "same", "second", Effect.die("must not run")),
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      const released = yield* Fiber.join(waiter);
      const retry = yield* cache("key", "same", "third", Effect.succeed(success));

      return { released, retry };
    }),
  );

  expect(result.released).toMatchObject({ id: "first", ok: false, error: { code: "internal" } });
  expect(result.retry).toEqual(success);
});
