/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test functions own the Effect Promise boundary */
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { type ChatHandle } from "ziggy/session/index";
import { makeChatHandle } from "../harness/chat-handle";
import { LIVE_REPLAY_LIMIT, MAX_UI_SESSIONS, makeLiveSessions } from "ziggy/resident/live-sessions";
import { ProfileNotInitialized } from "ziggy/profile/index";

const idleHandle = () => makeChatHandle({ prompt: () => Effect.succeed("ok") });

test("a fresh watcher replays the retained ring; a resume cursor must lie inside it", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();
        yield* live.acquire("local/main", "ui", Effect.succeed(idleHandle()));

        for (let index = 0; index <= LIVE_REPLAY_LIMIT; index += 1) {
          yield* live.publish("local/main", { kind: "settled" });
        }

        const received: number[] = [];
        const stop = yield* live.watch("local/main", (event) => received.push(event.seq));
        expect(received).toEqual(
          Array.from({ length: LIVE_REPLAY_LIMIT }, (_, index) => index + 2),
        );

        for (const afterSeq of [0, LIVE_REPLAY_LIMIT + 2]) {
          expect(
            yield* Effect.result(live.watch("local/main", () => undefined, afterSeq)),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "replay-gap" } });
        }

        const resumed: number[] = [];

        const stopResume = yield* live.watch(
          "local/main",
          (event) => resumed.push(event.seq),
          LIVE_REPLAY_LIMIT,
        );

        yield* live.publish("local/main", { kind: "settled" });
        expect(resumed).toEqual([LIVE_REPLAY_LIMIT + 1, LIVE_REPLAY_LIMIT + 2]);
        stop();
        stopResume();
        yield* live.publish("local/main", { kind: "settled" });
        expect(received).toHaveLength(LIVE_REPLAY_LIMIT + 1);
        expect(resumed).toHaveLength(2);
      }),
    ),
  );
});

test("a transcript reset drops the replay before it", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();
        yield* live.acquire("local/main", "ui", Effect.succeed(idleHandle()));
        yield* live.publish("local/main", { kind: "settled" });
        yield* live.publish("local/main", { kind: "session-state", scope: "transcript" });

        const received: string[] = [];
        yield* live.watch("local/main", ({ event }) => received.push(event.kind));
        expect(received).toEqual(["session-state"]);
      }),
    ),
  );
});

test("concurrent acquires share one open, and a failed open is retryable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const openCount = yield* Ref.make(0);
        const shared = idleHandle();

        const open = Ref.update(openCount, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as(shared),
        );

        const first = yield* live.acquire("ui/main", "ui", open).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const second = yield* live.acquire("ui/main", "ui", open).pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBe(shared);
        expect(yield* Fiber.join(second)).toBe(shared);
        expect(yield* Ref.get(openCount)).toBe(1);

        const failed = live.acquire(
          "ui/retry",
          "ui",
          Effect.fail(
            new ProfileNotInitialized({ profilePath: "/profile", message: "not initialized" }),
          ),
        );

        expect(yield* Effect.result(failed)).toMatchObject({ failure: { reason: "open-failed" } });
        const retry = idleHandle();
        expect(yield* live.acquire("ui/retry", "ui", Effect.succeed(retry))).toBe(retry);
      }),
    ),
  );
});

test("UI capacity is bounded and a channel session is watch-only to the UI", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();

        for (let index = 0; index < MAX_UI_SESSIONS; index += 1) {
          yield* live.acquire(`ui/s${index}`, "ui", Effect.succeed(idleHandle()));
        }

        expect(
          yield* Effect.result(live.acquire("ui/overflow", "ui", Effect.succeed(idleHandle()))),
        ).toMatchObject({ failure: { reason: "capacity" } });

        yield* live.acquire("discord/user-1", "discord", Effect.succeed(idleHandle()));
        expect(
          yield* Effect.result(live.acquire("discord/user-1", "ui", Effect.succeed(idleHandle()))),
        ).toMatchObject({ failure: { reason: "watch-only" } });
      }),
    ),
  );
});

test("releasing a stale handle cannot remove the live one", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeLiveSessions();
        const stale = idleHandle();
        const current = idleHandle();
        yield* live.acquire("discord/user-1", "discord", Effect.succeed(current));
        yield* live.release("discord/user-1", stale);
        expect((yield* live.get("discord/user-1")).handle).toBe(current);
        yield* live.release("discord/user-1", current);
        expect(yield* Effect.result(live.get("discord/user-1"))).toMatchObject({
          failure: { reason: "not-found" },
        });
      }),
    ),
  );
});

test("an exclusive turn survives its caller, refuses a second turn, and is disposed at shutdown", async () => {
  let disposals = 0;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();

        const handle: ChatHandle = {
          ...idleHandle(),
          dispose: Effect.sync(() => {
            disposals += 1;
          }),
        };

        const live = yield* makeLiveSessions();
        yield* live.acquire("ui/main", "ui", Effect.succeed(handle));
        yield* live.runExclusive("ui/main", () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        );
        yield* Deferred.await(started);
        expect((yield* live.get("ui/main")).idle).toBe(false);
        expect(yield* Effect.result(live.runExclusive("ui/main", () => Effect.void))).toMatchObject(
          {
            failure: { reason: "busy" },
          },
        );

        yield* Deferred.succeed(finish, undefined);
        yield* Effect.yieldNow;
        expect((yield* live.get("ui/main")).idle).toBe(true);
        expect(disposals).toBe(0);
      }),
    ),
  );

  expect(disposals).toBe(1);
});
