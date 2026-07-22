import { expect, test } from "bun:test";
import {
  ZiggyTuiComponent,
  createInitialState,
  type TuiAction,
  type TuiCommand,
  type ZiggyTuiHost,
} from "../../packages/tui/src/index.ts";
import type { TurnStartResponse } from "../../packages/protocol/src/index.ts";
import {
  AttachOutcomeUnknownError,
  AttachProtocolStateError,
  AttachReconnectExhaustedError,
  type AttachClient,
  type AttachClientError,
  type AttachSubscription,
  type AttachSubscriptionChange,
} from "../../packages/ziggy/src/attach-client.ts";
import { runTuiWithClient, type TuiHostFactory } from "../../packages/ziggy/src/tui-client.ts";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { runEffect } from "../testkit/effect.ts";
import { envelope, sessionStarted } from "../tui/fixtures.ts";

const main = {
  sessionId: "main",
  createdAt: "2026-07-21T09:00:00.000Z",
  lastSeq: 1,
};

const other = {
  sessionId: "other",
  createdAt: "2026-07-21T10:00:00.000Z",
  lastSeq: 4,
};

function inertSubscription(
  sessionId: string,
  sinceSeq: number,
  close: Effect.Effect<void, AttachProtocolStateError> = Effect.void,
): AttachSubscription {
  return {
    sessionId,
    next: Effect.never,
    nextChange: Effect.never,
    lastAppliedSeq: Effect.succeed(sinceSeq),
    replayThroughSeq: Effect.succeed(sinceSeq),
    close,
  };
}

function fakeClient(overrides: Partial<AttachClient> = {}): AttachClient {
  return {
    ensureMain: Effect.succeed(main),
    listSessions: Effect.succeed([main, other]),
    subscribe: (sessionId, sinceSeq) => Effect.succeed(inertSubscription(sessionId, sinceSeq)),
    startMainTurn: () => Effect.never,
    startTurn: () => Effect.succeed({ turnId: "turn-started", disposition: "started" }),
    steerTurn: () => Effect.succeed("turn-steered"),
    interruptTurn: () => Effect.succeed("turn-interrupted"),
    resolveApproval: () => Effect.succeed("resolved"),
    ...overrides,
  };
}

function testHost(
  emitReady: Deferred.Deferred<(command: TuiCommand) => void>,
  actions: TuiAction[],
  stopped: { count: number },
  onDispatch: (action: TuiAction, emit: (command: TuiCommand) => void) => void = () => undefined,
): TuiHostFactory {
  return (emit) =>
    Effect.acquireRelease(
      Deferred.succeed(emitReady, emit).pipe(
        Effect.as({
          dispatch: (action: TuiAction) => {
            actions.push(action);
            onDispatch(action, emit);
          },
          stop: () => {
            stopped.count += 1;
          },
        } satisfies ZiggyTuiHost),
      ),
      (host) => Effect.sync(host.stop),
    );
}

test("serializes every protocol command and forwards exact request fields", async () => {
  const result = await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const emitReady = yield* Deferred.make<(command: TuiCommand) => void>();
        const subscribed = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const allCalled = yield* Deferred.make<void>();
        const calls: string[] = [];
        const actions: TuiAction[] = [];
        const stopped = { count: 0 };
        let startCalls = 0;

        const client = fakeClient({
          subscribe: (sessionId, sinceSeq) => {
            calls.push(`subscribe:${sessionId}:${sinceSeq}`);
            return Deferred.succeed(subscribed, undefined).pipe(
              Effect.as(inertSubscription(sessionId, sinceSeq)),
            );
          },
          startTurn: (sessionId, message) => {
            calls.push(`start:${sessionId}:${message}`);
            startCalls += 1;
            return (
              startCalls === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirst)),
                  )
                : Effect.void
            ).pipe(
              Effect.as({
                turnId: "turn-started",
                disposition: "started",
              } satisfies TurnStartResponse),
            );
          },
          steerTurn: (sessionId, expectedTurnId, message) =>
            Effect.sync(() => {
              calls.push(`steer:${sessionId}:${expectedTurnId}:${message}`);
              return expectedTurnId;
            }),
          interruptTurn: (sessionId, expectedTurnId) =>
            Effect.sync(() => {
              calls.push(`interrupt:${sessionId}:${expectedTurnId}`);
              return expectedTurnId;
            }),
          resolveApproval: (sessionId, approvalId, decision) =>
            Effect.sync(() => {
              calls.push(`approval:${sessionId}:${approvalId}:${decision}`);
            }).pipe(
              Effect.andThen(Deferred.succeed(allCalled, undefined)),
              Effect.as("resolved" satisfies "resolved"),
            ),
        });
        const hostFactory = testHost(emitReady, actions, stopped, (action, emit) => {
          if (action.type === "main-ensured") {
            emit({ type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 1 });
          }
        });
        const runFiber = yield* Effect.forkScoped(runTuiWithClient(client, hostFactory));
        const emit = yield* Deferred.await(emitReady);
        yield* Deferred.await(subscribed);

        emit({
          type: "start-turn",
          generation: 1,
          request: { sessionId: "main", message: "start message" },
        });
        emit({
          type: "steer-turn",
          generation: 1,
          request: { sessionId: "main", expectedTurnId: "turn-1", message: "steer message" },
        });
        emit({
          type: "queue-follow-up",
          generation: 1,
          request: { sessionId: "main", message: "follow-up message" },
        });
        emit({
          type: "interrupt-turn",
          generation: 1,
          request: { sessionId: "main", expectedTurnId: "turn-1" },
        });
        emit({
          type: "resolve-approval",
          generation: 1,
          request: { sessionId: "main", approvalId: "approval-1", decision: "deny" },
        });

        yield* Deferred.await(firstStarted);
        const beforeRelease = [...calls];
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(allCalled);
        emit({ type: "detach" });
        yield* Fiber.join(runFiber);
        return { beforeRelease, calls, actions, stopped: stopped.count };
      }),
    ),
  );

  expect(result.beforeRelease).toEqual(["subscribe:main:1", "start:main:start message"]);
  expect(result.calls).toEqual([
    "subscribe:main:1",
    "start:main:start message",
    "steer:main:turn-1:steer message",
    "start:main:follow-up message",
    "interrupt:main:turn-1",
    "approval:main:approval-1:deny",
  ]);
  expect(result.stopped).toBe(1);
});

test("replaces A-to-B-to-A subscriptions safely and suppresses blocked stale callbacks", async () => {
  const result = await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const emitReady = yield* Deferred.make<(command: TuiCommand) => void>();
        const firstSubscribeStarted = yield* Deferred.make<void>();
        const releaseFirstSubscribe = yield* Deferred.make<void>();
        const secondSubscribeStarted = yield* Deferred.make<void>();
        const reconnectReplaySeen = yield* Deferred.make<void>();
        const staleEnvelope = yield* Deferred.make<ReturnType<typeof envelope>>();
        const liveChanges = yield* Queue.unbounded<AttachSubscriptionChange>();
        const calls: string[] = [];
        const closes = [0, 0];
        const actions: TuiAction[] = [];
        const stopped = { count: 0 };
        let subscribeCount = 0;

        const client = fakeClient({
          subscribe: (sessionId, sinceSeq) => {
            const index = subscribeCount;
            subscribeCount += 1;
            calls.push(`${sessionId}:${sinceSeq}`);
            const subscription: AttachSubscription = {
              sessionId,
              next: index === 0 ? Deferred.await(staleEnvelope) : Effect.never,
              nextChange: index === 1 ? Queue.take(liveChanges) : Effect.never,
              lastAppliedSeq: Effect.succeed(sinceSeq),
              replayThroughSeq: Effect.succeed(sinceSeq),
              close: Effect.sync(() => {
                const current = closes[index];
                if (current !== undefined) closes[index] = current + 1;
              }),
            };
            const gate =
              index === 0
                ? Deferred.succeed(firstSubscribeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstSubscribe)),
                  )
                : Deferred.succeed(secondSubscribeStarted, undefined);
            return gate.pipe(Effect.as(subscription));
          },
        });
        const hostFactory = testHost(emitReady, actions, stopped, (action) => {
          if (action.type === "replay-started" && action.replayThroughSeq === 3) {
            Deferred.doneUnsafe(reconnectReplaySeen, Effect.void);
          }
        });
        const runFiber = yield* Effect.forkScoped(runTuiWithClient(client, hostFactory));
        const emit = yield* Deferred.await(emitReady);
        emit({ type: "list-sessions" });
        yield* Effect.yieldNow;
        emit({ type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 1 });
        yield* Deferred.await(firstSubscribeStarted);
        emit({ type: "resume-session", generation: 2, sessionId: "other", sinceSeq: 4 });
        emit({ type: "resume-session", generation: 3, sessionId: "main", sinceSeq: 1 });
        yield* Deferred.succeed(releaseFirstSubscribe, undefined);
        yield* Deferred.await(secondSubscribeStarted);
        yield* Deferred.succeed(staleEnvelope, envelope(2, sessionStarted()));
        yield* Queue.offer(liveChanges, { type: "connection-lost" });
        yield* Queue.offer(liveChanges, { type: "retry-started", attempt: 1 });
        yield* Queue.offer(liveChanges, { type: "retry-started", attempt: 2 });
        yield* Queue.offer(liveChanges, { type: "replay-started", replayThroughSeq: 3 });
        yield* Deferred.await(reconnectReplaySeen);
        emit({ type: "detach" });
        yield* Fiber.join(runFiber);
        return { calls, closes, actions, stopped: stopped.count };
      }),
    ),
  );

  expect(result.calls).toEqual(["main:1", "main:1"]);
  expect(result.closes).toEqual([1, 1]);
  expect(result.actions).not.toContainEqual({
    type: "envelope-received",
    generation: 1,
    envelope: envelope(2, sessionStarted()),
  });
  expect(result.actions).toContainEqual({
    type: "connection-lost",
    generation: 3,
    message: "Attach connection closed.",
  });
  expect(result.actions).toContainEqual({ type: "retry-started", generation: 3, attempt: 1 });
  expect(result.actions).toContainEqual({ type: "retry-started", generation: 3, attempt: 2 });
  expect(result.actions).toContainEqual({
    type: "replay-started",
    generation: 3,
    session: main,
    replayThroughSeq: 3,
  });
  expect(result.stopped).toBe(1);
});

test("disconnect and replay lifecycle callbacks preserve the live composer", async () => {
  const result = await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<AttachSubscriptionChange>();
        const subscribed = yield* Deferred.make<void>();
        const replaySeen = yield* Deferred.make<void>();
        const actions: TuiAction[] = [];
        let finalComposer = "";
        const client = fakeClient({
          subscribe: (sessionId, sinceSeq) =>
            Deferred.succeed(subscribed, undefined).pipe(
              Effect.as({
                ...inertSubscription(sessionId, sinceSeq),
                nextChange: Queue.take(changes),
              }),
            ),
        });
        const hostFactory: TuiHostFactory = (emit) =>
          Effect.acquireRelease(
            Effect.sync((): ZiggyTuiHost => {
              const component = new ZiggyTuiComponent({ state: createInitialState(), emit });
              component.dispatch({ type: "composer-changed", value: "draft survives" });
              return {
                dispatch: (action) => {
                  actions.push(action);
                  component.dispatch(action);
                  if (action.type === "replay-started" && action.replayThroughSeq === 2) {
                    finalComposer = component.currentState.composer;
                    Deferred.doneUnsafe(replaySeen, Effect.void);
                    component.requestQuit();
                  }
                },
                stop: () => undefined,
              };
            }),
            () => Effect.void,
          );
        const runFiber = yield* Effect.forkScoped(runTuiWithClient(client, hostFactory));
        yield* Deferred.await(subscribed);
        yield* Queue.offer(changes, { type: "connection-lost" });
        yield* Queue.offer(changes, { type: "retry-started", attempt: 1 });
        yield* Queue.offer(changes, { type: "replay-started", replayThroughSeq: 2 });
        yield* Deferred.await(replaySeen);
        yield* Fiber.join(runFiber);
        return { actions, finalComposer };
      }),
    ),
  );

  expect(result.finalComposer).toBe("draft survives");
  expect(result.actions).toContainEqual({
    type: "connection-lost",
    generation: 1,
    message: "Attach connection closed.",
  });
  expect(result.actions).toContainEqual({ type: "retry-started", generation: 1, attempt: 1 });
  expect(result.actions).toContainEqual({
    type: "replay-started",
    generation: 1,
    session: main,
    replayThroughSeq: 2,
  });
});

test("surfaces terminal reconnect exhaustion for the active generation", async () => {
  const actions: TuiAction[] = [];
  const stopped = { count: 0 };

  await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const emitReady = yield* Deferred.make<(command: TuiCommand) => void>();
        const changes = yield* Queue.unbounded<AttachSubscriptionChange, AttachClientError>();
        const subscribed = yield* Deferred.make<void>();
        const hostFactory = testHost(emitReady, actions, stopped, (action, emit) => {
          if (action.type === "main-ensured") {
            emit({ type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 1 });
          }
          if (action.type === "failure") emit({ type: "detach" });
        });
        const client = fakeClient({
          subscribe: (sessionId, sinceSeq) =>
            Deferred.succeed(subscribed, undefined).pipe(
              Effect.as({
                ...inertSubscription(sessionId, sinceSeq),
                nextChange: Queue.take(changes),
              }),
            ),
        });
        const runFiber = yield* Effect.forkScoped(runTuiWithClient(client, hostFactory));
        yield* Deferred.await(emitReady);
        yield* Deferred.await(subscribed);
        yield* Queue.fail(
          changes,
          new AttachReconnectExhaustedError({
            attempts: 5,
            lastCause: new AttachProtocolStateError({ message: "fixture cause" }),
          }),
        );
        yield* Fiber.join(runFiber);
      }),
    ),
  );

  expect(actions).toContainEqual({
    type: "failure",
    generation: 1,
    message: "Attach reconnect exhausted after 5 attempts.",
  });
  expect(stopped.count).toBe(1);
});

test("preserves composer text when a Turn outcome is unknown", async () => {
  const actions: TuiAction[] = [];
  const stopped = { count: 0 };

  await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const emitReady = yield* Deferred.make<(command: TuiCommand) => void>();
        const hostFactory = testHost(emitReady, actions, stopped, (action, emit) => {
          if (action.type === "outcome-unknown") emit({ type: "detach" });
        });
        const client = fakeClient({
          startTurn: () => Effect.fail(new AttachOutcomeUnknownError({ sessionId: "main" })),
        });
        const runFiber = yield* Effect.forkScoped(runTuiWithClient(client, hostFactory));
        const emit = yield* Deferred.await(emitReady);
        emit({
          type: "start-turn",
          generation: 1,
          request: { sessionId: "main", message: "preserve me" },
        });
        yield* Fiber.join(runFiber);
      }),
    ),
  );

  expect(actions).toContainEqual({
    type: "outcome-unknown",
    generation: 1,
    message: "Turn outcome unknown; composer text was preserved.",
    composer: "preserve me",
  });
  expect(stopped.count).toBe(1);
});

test("detach interrupts an active command, rejects later commands, and releases each resource once", async () => {
  const result = await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const emitReady = yield* Deferred.make<(command: TuiCommand) => void>();
        const subscribed = yield* Deferred.make<void>();
        const active = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const actions: TuiAction[] = [];
        const stopped = { count: 0 };
        let subscriptionCloses = 0;
        let attachCloses = 0;
        let steerCalls = 0;
        const client = fakeClient({
          subscribe: (sessionId, sinceSeq) =>
            Deferred.succeed(subscribed, undefined).pipe(
              Effect.as(
                inertSubscription(
                  sessionId,
                  sinceSeq,
                  Effect.sync(() => {
                    subscriptionCloses += 1;
                  }),
                ),
              ),
            ),
          startTurn: () =>
            Deferred.succeed(active, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            ),
          steerTurn: () =>
            Effect.sync(() => {
              steerCalls += 1;
              return "turn-1";
            }),
        });
        const acquiredClient = yield* Effect.acquireRelease(Effect.succeed(client), () =>
          Effect.sync(() => {
            attachCloses += 1;
          }),
        );
        const hostFactory = testHost(emitReady, actions, stopped, (action, emit) => {
          if (action.type === "main-ensured") {
            emit({ type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 1 });
          }
        });
        const runFiber = yield* Effect.forkScoped(runTuiWithClient(acquiredClient, hostFactory));
        const emit = yield* Deferred.await(emitReady);
        yield* Deferred.await(subscribed);
        emit({
          type: "start-turn",
          generation: 1,
          request: { sessionId: "main", message: "block" },
        });
        yield* Deferred.await(active);
        emit({
          type: "steer-turn",
          generation: 1,
          request: { sessionId: "main", expectedTurnId: "turn-1", message: "must not run" },
        });
        emit({ type: "detach" });
        emit({
          type: "interrupt-turn",
          generation: 1,
          request: { sessionId: "main", expectedTurnId: "turn-1" },
        });
        yield* Deferred.await(interrupted);
        yield* Fiber.join(runFiber);
        return {
          subscriptionCloses,
          cleanup: {
            get attachCloses() {
              return attachCloses;
            },
          },
          steerCalls,
          hostStops: stopped.count,
        };
      }),
    ),
  );

  expect(result.subscriptionCloses).toBe(1);
  expect(result.cleanup.attachCloses).toBe(1);
  expect(result.steerCalls).toBe(0);
  expect(result.hostStops).toBe(1);
});

test("reports bounded command overload and preserves subscription cleanup failure", async () => {
  const actions: TuiAction[] = [];
  const stopped = { count: 0 };
  let closeCalls = 0;

  const program = Effect.scoped(
    Effect.gen(function* () {
      const emitReady = yield* Deferred.make<(command: TuiCommand) => void>();
      const subscribed = yield* Deferred.make<void>();
      const active = yield* Deferred.make<void>();
      const client = fakeClient({
        subscribe: (sessionId, sinceSeq) =>
          Deferred.succeed(subscribed, undefined).pipe(
            Effect.as(
              inertSubscription(
                sessionId,
                sinceSeq,
                Effect.sync(() => {
                  closeCalls += 1;
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new AttachProtocolStateError({ message: "subscription close failed" }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        startTurn: () => Deferred.succeed(active, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const hostFactory = testHost(emitReady, actions, stopped, (action, emit) => {
        if (action.type === "main-ensured") {
          emit({ type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 1 });
        }
      });
      const runFiber = yield* Effect.forkScoped(runTuiWithClient(client, hostFactory));
      const emit = yield* Deferred.await(emitReady);
      yield* Deferred.await(subscribed);
      emit({
        type: "start-turn",
        generation: 1,
        request: { sessionId: "main", message: "block" },
      });
      yield* Deferred.await(active);
      for (let index = 0; index < 40; index += 1) {
        emit({
          type: "steer-turn",
          generation: 1,
          request: { sessionId: "main", expectedTurnId: "turn-1", message: `queued-${index}` },
        });
      }
      yield* Effect.yieldNow;
      emit({ type: "detach" });
      yield* Fiber.join(runFiber);
    }),
  );

  await expect(runEffect(program)).rejects.toEqual(
    new AttachProtocolStateError({ message: "subscription close failed" }),
  );
  expect(actions).toContainEqual({
    type: "failure",
    message: "TUI command queue is full; command was not sent. Composer text was preserved.",
  });
  expect(
    actions.filter(
      (action) => action.type === "command-admitted" && action.command.type === "steer-turn",
    ),
  ).toHaveLength(32);
  expect(closeCalls).toBe(1);
  expect(stopped.count).toBe(1);
});
