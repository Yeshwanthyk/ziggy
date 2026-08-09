/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Result } from "effect";
import { SlackApiError } from "./api";
import {
  type SlackSocketConnection,
  type SlackSocketDependencies,
  openSlackSocket,
} from "./socket";

class FakeSlackConnection implements SlackSocketConnection {
  state = 1;
  readonly sent: Array<string> = [];
  readonly openListeners = new Set<() => void>();
  readonly messageListeners = new Set<(data: unknown) => void>();
  readonly errorListeners = new Set<() => void>();
  readonly closeListeners = new Set<() => void>();
  closeThrows = false;
  errorRegistrationThrows = false;
  removedListeners = 0;

  readyState = () => this.state;
  send = (data: string) => {
    this.sent.push(data);
  };
  close = () => {
    if (this.closeThrows) throw new Error("close failed");
    this.state = 3;
    for (const listener of this.closeListeners) {
      listener();
    }
  };
  onOpen = (listener: () => void) => this.add(this.openListeners, listener);
  onMessage = (listener: (data: unknown) => void) => this.add(this.messageListeners, listener);
  onError = (listener: () => void) => {
    if (this.errorRegistrationThrows) throw new Error("listener registration failed");
    return this.add(this.errorListeners, listener);
  };
  onClose = (listener: () => void) => this.add(this.closeListeners, listener);

  emitMessage(data: string) {
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }

  emitError() {
    for (const listener of this.errorListeners) listener();
  }

  private add<A>(listeners: Set<A>, listener: A): () => void {
    listeners.add(listener);
    return () => {
      if (listeners.delete(listener)) {
        this.removedListeners += 1;
      }
    };
  }
}

const apiFailure = (reason: SlackApiError["reason"]): SlackApiError =>
  new SlackApiError({
    operation: "connectionsOpen",
    reason,
    retriable: reason !== "authentication",
    message: "bootstrap failed",
    cause: new Error("bootstrap failed"),
  });

const dependencies = (
  overrides: Partial<SlackSocketDependencies> = {},
): {
  readonly value: SlackSocketDependencies;
  readonly connections: Array<FakeSlackConnection>;
} => {
  const connections: Array<FakeSlackConnection> = [];
  return {
    connections,
    value: {
      connectionsOpen: () => Effect.succeed({ url: "wss://slack.test/socket" }),
      connect: () => {
        const connection = new FakeSlackConnection();
        connections.push(connection);
        return connection;
      },
      schedule: () => () => undefined,
      inboundCapacity: 8,
      commandCapacity: 32,
      closeTimeout: Duration.seconds(1),
      reportConnected: () => undefined,
      reportConnectionFailure: () => undefined,
      reportCleanupFailure: () => undefined,
      ...overrides,
    },
  };
};

const envelope = (id: string) =>
  JSON.stringify({
    type: "events_api",
    envelope_id: `envelope-${id}`,
    payload: {
      event_id: `event-${id}`,
      event: {
        type: "message",
        channel: "C1",
        channel_type: "im",
        user: "U1",
        text: "hello",
        ts: id,
      },
    },
  });

const yieldToSupervisor = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
});

describe("Slack socket Effect boundary", () => {
  test("fails authentication once with a typed socket error", async () => {
    const fixture = dependencies({
      connectionsOpen: () => Effect.fail(apiFailure("authentication")),
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openSlackSocket("invalid-token", fixture.value);
          return yield* socket.next.pipe(Effect.result);
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SlackSocketError",
        operation: "connect",
        reason: "authentication",
        retriable: false,
      },
    });
    expect(fixture.connections).toHaveLength(0);
  });

  test("ignores malformed unacknowledged frames and delivers the next valid event", async () => {
    const fixture = dependencies();
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openSlackSocket("token", fixture.value);
          yield* yieldToSupervisor;
          const connection = fixture.connections[0];
          connection?.emitMessage("{");
          connection?.emitMessage(envelope("1"));
          const message = yield* socket.next;
          expect(connection?.sent).toEqual([JSON.stringify({ envelope_id: "envelope-1" })]);
          return message;
        }),
      ),
    );

    expect(received).toMatchObject({ channel: "C1", userId: "U1", ts: "1" });
  });

  test("reconnects through a fresh connections.open URL after disconnect", async () => {
    let bootstraps = 0;
    const fixture = dependencies({
      connectionsOpen: () => {
        bootstraps += 1;
        return Effect.succeed({ url: `wss://slack.test/${bootstraps}` });
      },
      schedule: (_delay, task) => {
        task();
        return () => undefined;
      },
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* openSlackSocket("token", fixture.value);
          yield* yieldToSupervisor;
          fixture.connections[0]?.emitMessage(
            JSON.stringify({ type: "disconnect", envelope_id: "disconnect-1" }),
          );
          yield* yieldToSupervisor;
          expect(bootstraps).toBe(2);
          expect(fixture.connections).toHaveLength(2);
        }),
      ),
    );
  });

  test("interrupting one pending receive does not consume the next event", async () => {
    const fixture = dependencies();
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openSlackSocket("token", fixture.value);
          yield* yieldToSupervisor;
          const pending = yield* socket.next.pipe(Effect.forkChild);
          yield* Fiber.interrupt(pending);
          fixture.connections[0]?.emitMessage(envelope("2"));
          return yield* socket.next;
        }),
      ),
    );

    expect(received.ts).toBe("2");
  });

  test("listener registration failure rolls back the partial connection", async () => {
    const fixture = dependencies({
      connect: () => {
        const connection = new FakeSlackConnection();
        connection.errorRegistrationThrows = true;
        fixture.connections.push(connection);
        return connection;
      },
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* openSlackSocket("token", fixture.value);
          yield* yieldToSupervisor;
        }),
      ),
    );

    expect(fixture.connections[0]?.state).toBe(3);
    expect(fixture.connections[0]?.removedListeners).toBe(2);
  });

  test("reconnect close failures are reported after listeners detach", async () => {
    const cleanupFailures: Array<string> = [];
    const fixture = dependencies({
      reportCleanupFailure: (failure) => cleanupFailures.push(failure.reason),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* openSlackSocket("token", fixture.value);
          yield* yieldToSupervisor;
          const connection = fixture.connections[0];
          if (connection === undefined) return;
          connection.closeThrows = true;
          connection.emitError();
          yield* yieldToSupervisor;
          connection.closeThrows = false;
        }),
      ),
    );

    expect(cleanupFailures).toEqual(["connection"]);
    expect(fixture.connections[0]?.removedListeners).toBeGreaterThanOrEqual(3);
  });

  test("fails fast on inbound overflow and cleans up listeners with the scope", async () => {
    const fixture = dependencies({ inboundCapacity: 1 });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openSlackSocket("token", fixture.value);
          yield* yieldToSupervisor;
          fixture.connections[0]?.emitMessage(envelope("1"));
          fixture.connections[0]?.emitMessage(envelope("2"));
          yield* yieldToSupervisor;
          return yield* socket.next.pipe(Effect.result);
        }),
      ),
    );

    expect(Result.isFailure(result) && result.failure.reason).toBe("queue-overflow");
    expect(fixture.connections[0]?.sent).toEqual([JSON.stringify({ envelope_id: "envelope-1" })]);
    expect(fixture.connections[0]?.removedListeners).toBeGreaterThanOrEqual(3);
  });
});
