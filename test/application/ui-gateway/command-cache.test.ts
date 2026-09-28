/* oxlint-disable ziggy-effect/no-effect-escape-hatch -- Inject a defect to test cache recovery */
/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are Promise-shaped */
import { expect, test } from "bun:test";
import fc from "fast-check";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { makeCommandCache } from "ziggy/application/ui-gateway/command-cache";
import { protocolFailure } from "ziggy/application/ui-gateway/errors";

const success = { id: "first", ok: true as const, result: { pong: true as const } };

const typedFailure = {
  id: "first",
  ok: false as const,
  error: protocolFailure("internal", "unavailable"),
};

test("concurrent commands execute once and every waiter finishes on success, typed failure, or defect", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 16 }),
      fc.constantFrom("success", "typed failure", "defect"),
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

              return outcome === "typed failure" ? typedFailure : success;
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

test("interrupting the owner leaves the command running for another connection", async () => {
  const cache = makeCommandCache();
  let executions = 0;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const run = Effect.gen(function* () {
        executions++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);

        return success;
      });

      const owner = yield* Effect.forkChild(cache("key", "same", "first", run));
      yield* Deferred.await(started);

      const waiter = yield* Effect.forkChild(
        cache("key", "same", "second", Effect.die("must not run")),
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      yield* Deferred.succeed(release, undefined);
      const released = yield* Fiber.join(waiter);
      const retry = yield* cache("key", "same", "third", Effect.succeed(success));

      return { released, retry };
    }),
  );

  expect(result.released).toEqual(success);
  expect(result.retry).toEqual(success);
  expect(executions).toBe(1);
});

test("typed failure responses are not retained for retries", async () => {
  const cache = makeCommandCache();
  let executions = 0;

  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const run = Effect.sync(() => {
        executions++;

        return executions === 1 ? typedFailure : success;
      });

      const first = yield* cache("key", "same", "first", run);
      const second = yield* cache("key", "same", "second", run);

      return { first, second };
    }),
  );

  expect(results.first).toEqual(typedFailure);
  expect(results.second).toEqual(success);
  expect(executions).toBe(2);
});

test("closing the UI server scope interrupts running commands and releases waiters", async () => {
  const cache = makeCommandCache();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const serverScope = yield* Scope.make();
      const started = yield* Deferred.make<void>();

      yield* Effect.forkChild(
        cache(
          "key",
          "same",
          "first",
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);

            return yield* Effect.never;
          }),
        ).pipe(Effect.provideService(Scope.Scope, serverScope)),
      );

      yield* Deferred.await(started);

      const waiter = yield* Effect.forkChild(
        cache("key", "same", "second", Effect.die("must not run")),
      );

      yield* Effect.yieldNow;
      yield* Scope.close(serverScope, Exit.void);
      const released = yield* Fiber.join(waiter);
      const afterClose = yield* Effect.flip(cache("new", "same", "third", Effect.succeed(success)));

      return { released, afterClose };
    }),
  );

  expect(result.released).toMatchObject({
    ok: false,
    error: { code: "internal", message: "command interrupted" },
  });
  expect(result.afterClose).toMatchObject({ code: "internal", message: "UI server stopped" });
});
