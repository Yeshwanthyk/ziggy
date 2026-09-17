/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test functions own the Effect Promise boundary */
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { ProfileNotInitialized } from "ziggy/domain/agent";
import { makeChatHandle, type ChatEvent, type ChatHandle } from "ziggy/application/agent";
import {
  CHAT_REPLAY_LIMIT,
  MAX_UI_SESSIONS,
  makeChatRegistry,
} from "ziggy/application/chat-registry";

test("remembered destinations keep a known label when a fallback observation arrives", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        const target = {
          _tag: "slack" as const,
          target: "slack:channel:C012345678",
          channelId: "C012345678",
        };

        yield* registry.rememberDestination({ target, label: "engineering" });
        yield* registry.rememberDestination({ target });

        expect(yield* registry.destinations).toEqual([{ target, label: "engineering" }]);
      }),
    ),
  );
});

test("fresh subscriptions bootstrap retained activity while resume cursors require continuity", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        yield* registry.getOrOpenUi(
          "local/main",
          Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("ok") })),
        );

        for (let index = 0; index <= CHAT_REPLAY_LIMIT; index += 1) {
          yield* registry.publish("local/main", { kind: "settled" });
        }

        const received: number[] = [];

        const unsubscribe = yield* registry.subscribeSequenced("local/main", (event) =>
          received.push(event.seq),
        );

        expect(received).toEqual(
          Array.from({ length: CHAT_REPLAY_LIMIT }, (_, index) => index + 2),
        );

        for (const afterSeq of [0, CHAT_REPLAY_LIMIT + 2]) {
          expect(
            yield* Effect.result(
              registry.subscribeSequenced("local/main", () => undefined, afterSeq),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { code: "replay_gap" } });
        }

        const resumed: number[] = [];

        const stopResume = yield* registry.subscribeSequenced(
          "local/main",
          (event) => resumed.push(event.seq),
          CHAT_REPLAY_LIMIT,
        );

        yield* registry.publish("local/main", { kind: "settled" });
        expect(received.at(-1)).toBe(CHAT_REPLAY_LIMIT + 2);
        expect(resumed).toEqual([CHAT_REPLAY_LIMIT + 1, CHAT_REPLAY_LIMIT + 2]);
        unsubscribe();
        stopResume();
        yield* registry.publish("local/main", { kind: "settled" });
        expect(received).toHaveLength(CHAT_REPLAY_LIMIT + 1);
        expect(resumed).toHaveLength(2);
        expect(yield* Effect.result(registry.replay("local/main", 0))).toMatchObject({
          _tag: "Failure",
          failure: { code: "replay_gap" },
        });
      }),
    ),
  );
});

test("concurrent UI opens share one handle and a failed opening is retryable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const openCount = yield* Ref.make(0);
        const shared = makeChatHandle({ prompt: () => Effect.succeed("ok") });

        const open = Ref.update(openCount, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as(shared),
        );

        const first = yield* registry.getOrOpenUi("ui/main", open).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const second = yield* registry.getOrOpenUi("ui/main", open).pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBe(shared);
        expect(yield* Fiber.join(second)).toBe(shared);
        expect(yield* Ref.get(openCount)).toBe(1);

        const failed = registry.getOrOpenUi(
          "ui/retry",
          Effect.fail(
            new ProfileNotInitialized({ profilePath: "/profile", message: "not initialized" }),
          ),
        );

        expect((yield* Effect.result(failed))._tag).toBe("Failure");
        const retry = makeChatHandle({ prompt: () => Effect.succeed("retry") });
        expect(yield* registry.getOrOpenUi("ui/retry", Effect.succeed(retry))).toBe(retry);
      }),
    ),
  );
});

test("UI capacity counts live sessions and openings", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();

        for (let index = 0; index < MAX_UI_SESSIONS; index += 1) {
          yield* registry.getOrOpenUi(
            `ui/s${index}`,
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("ok") })),
          );
        }

        const overflow = yield* Effect.result(
          registry.getOrOpenUi(
            "ui/overflow",
            Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("no") })),
          ),
        );

        expect(overflow).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "UiGatewayError", code: "capacity_exceeded" },
        });
      }),
    ),
  );
});

test("stale channel unregister cannot remove its replacement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry();
        const first = makeChatHandle({ prompt: () => Effect.succeed("first") });
        const second = makeChatHandle({ prompt: () => Effect.succeed("second") });
        yield* registry.registerAlias("discord/user-1", "discord", first);
        yield* registry.registerAlias("discord/user-1", "discord", second);
        yield* registry.unregisterAlias("discord/user-1", first);
        expect((yield* registry.get("discord/user-1")).handle).toBe(second);
        yield* registry.unregisterAlias("discord/user-1", second);
        expect((yield* Effect.result(registry.get("discord/user-1")))._tag).toBe("Failure");
      }),
    ),
  );
});

test("subscriber disconnect does not abort, interrupt, or dispose an admitted prompt", async () => {
  let aborts = 0;
  let disposals = 0;
  const events: ChatEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const promptStarted = yield* Deferred.make<void>();
        const releasePrompt = yield* Deferred.make<void>();
        const listeners = new Set<(event: ChatEvent) => void>();
        let idle = true;

        const handle: ChatHandle = {
          get isIdle() {
            return idle;
          },
          prompt: () =>
            Effect.gen(function* () {
              idle = false;
              yield* Deferred.succeed(promptStarted, undefined);
              yield* Deferred.await(releasePrompt);
              idle = true;

              for (const listener of listeners) listener({ kind: "settled" });

              return "done";
            }),
          abort: Effect.sync(() => {
            aborts += 1;
          }),
          steer: () => Effect.void,
          followUp: () => Effect.void,
          subscribe: (listener) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
          },
          dispose: Effect.sync(() => {
            disposals += 1;
          }),
        };

        const registry = yield* makeChatRegistry();
        yield* registry.getOrOpenUi("ui/main", Effect.succeed(handle));
        const disconnect = yield* registry.subscribe("ui/main", (event) => events.push(event));
        yield* registry.submit("ui/main", "hello");
        yield* Deferred.await(promptStarted);
        disconnect();
        expect(aborts).toBe(0);
        expect(disposals).toBe(0);
        expect(yield* Effect.result(registry.submit("ui/main", "second"))).toMatchObject({
          failure: { code: "session_busy" },
        });
        yield* Deferred.succeed(releasePrompt, undefined);
        yield* Effect.yieldNow;
        expect(events).toEqual([]);
        expect(aborts).toBe(0);
        expect(disposals).toBe(0);
      }),
    ),
  );
  expect(aborts).toBe(0);
  expect(disposals).toBe(1);
});

test("automation delivery refuses opening and closing owners and rejects cross-Profile routing", async () => {
  const result = {
    automationId: "daily-note",
    runId: "manual:one",
    targetSessionId: "stored-session",
    text: "result",
    timestamp: "2026-09-17T12:00:00.000Z",
  } as const;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry("/profiles/a");
        const openEntered = yield* Deferred.make<void>();
        const releaseOpen = yield* Deferred.make<void>();
        const openingHandle = makeChatHandle({ prompt: () => Effect.succeed("unused") });

        const opening = yield* registry
          .openAlias(
            "discord/opening",
            "discord",
            Deferred.succeed(openEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOpen)),
              Effect.as(openingHandle),
            ),
          )
          .pipe(Effect.forkScoped);

        yield* Deferred.await(openEntered);

        expect(
          yield* Effect.result(
            registry.deliverAutomationResult({ name: "a", path: "/profiles/a" }, result),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { category: "owner-unavailable", retriable: true },
        });
        yield* Deferred.succeed(releaseOpen, undefined);
        yield* Fiber.join(opening);

        expect(
          yield* Effect.result(
            registry.deliverAutomationResult({ name: "b", path: "/profiles/b" }, result),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { category: "destination-invalid", retriable: false },
        });

        const releaseDispose = yield* Deferred.make<void>();

        const closingHandle = makeChatHandle({
          prompt: () => Effect.succeed("unused"),
          dispose: Deferred.await(releaseDispose),
        });

        yield* registry.registerAlias("slack/closing", "slack", closingHandle);

        const closing = yield* registry
          .closeAlias("slack/closing", closingHandle)
          .pipe(Effect.forkScoped);

        yield* Effect.yieldNow;

        expect(
          yield* Effect.result(
            registry.getOrOpenUi(
              "slack/closing",
              Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unsafe") })),
            ),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { code: "session_busy" },
        });

        expect(
          yield* Effect.result(
            registry.deliverAutomationResult({ name: "a", path: "/profiles/a" }, result),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { category: "owner-unavailable", retriable: true },
        });
        yield* Deferred.succeed(releaseDispose, undefined);
        yield* Fiber.join(closing);
      }),
    ),
  );
});
