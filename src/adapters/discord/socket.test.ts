/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { DiscordApiError } from "./api";
import {
  type DiscordSocketConnection,
  type DiscordSocketDependencies,
  openDiscordSocket,
} from "./socket";

class FakeDiscordConnection implements DiscordSocketConnection {
  state = 1;
  readonly sent: Array<string> = [];
  readonly openListeners = new Set<() => void>();
  readonly messageListeners = new Set<(data: unknown) => void>();
  readonly errorListeners = new Set<() => void>();
  readonly closeListeners = new Set<(code: number) => void>();
  closeCompletes = true;
  removedListeners = 0;

  readyState = () => this.state;
  send = (data: string) => {
    this.sent.push(data);
  };
  close = () => {
    if (!this.closeCompletes) {
      return;
    }
    this.state = 3;
    for (const listener of this.closeListeners) {
      listener(1000);
    }
  };
  onOpen = (listener: () => void) => this.add(this.openListeners, listener);
  onMessage = (listener: (data: unknown) => void) =>
    this.add(this.messageListeners, listener);
  onError = (listener: () => void) => this.add(this.errorListeners, listener);
  onClose = (listener: (code: number) => void) => this.add(this.closeListeners, listener);

  emitMessage(data: string) {
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }

  emitClose(code: number) {
    this.state = 3;
    for (const listener of this.closeListeners) {
      listener(code);
    }
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

const apiFailure = (reason: DiscordApiError["reason"]): DiscordApiError =>
  new DiscordApiError({
    operation: "getGatewayBot",
    reason,
    retriable: reason !== "authentication",
    message: "bootstrap failed",
    cause: new Error("bootstrap failed"),
  });

const dependencies = (
  overrides: Partial<DiscordSocketDependencies> = {},
): { readonly value: DiscordSocketDependencies; readonly connections: Array<FakeDiscordConnection> } => {
  const connections: Array<FakeDiscordConnection> = [];
  return {
    connections,
    value: {
      getGatewayBot: () => Effect.succeed({ url: "wss://gateway.discord.test" }),
      connect: () => {
        const connection = new FakeDiscordConnection();
        connections.push(connection);
        return connection;
      },
      schedule: () => () => undefined,
      random: () => 0.5,
      inboundCapacity: 8,
      commandCapacity: 32,
      closeTimeout: Duration.seconds(1),
      ...overrides,
    },
  };
};

const ready = JSON.stringify({
  op: 0,
  s: 42,
  t: "READY",
  d: {
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.test",
    user: { id: "bot" },
  },
});
const message = (id: string) =>
  JSON.stringify({
    op: 0,
    s: 43,
    t: "MESSAGE_CREATE",
    d: {
      id,
      channel_id: "channel",
      author: { id: "owner" },
      content: "hello",
    },
  });

const yieldToSupervisor = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
});

describe("Discord socket Effect boundary", () => {
  test("fails authentication once with a typed socket error", async () => {
    const fixture = dependencies({
      getGatewayBot: () => Effect.fail(apiFailure("authentication")),
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openDiscordSocket("invalid-token", 0, fixture.value);
          return yield* socket.next.pipe(Effect.result);
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DiscordSocketError",
        operation: "connect",
        reason: "authentication",
        retriable: false,
      },
    });
    expect(fixture.connections).toHaveLength(0);
  });

  test("fails malformed gateway JSON through the receive channel", async () => {
    const fixture = dependencies();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openDiscordSocket("token", 0, fixture.value);
          yield* yieldToSupervisor;
          fixture.connections[0]?.emitMessage("{");
          return yield* socket.next.pipe(Effect.result);
        }),
      ),
    );

    expect(Result.isFailure(result) && result.failure.reason).toBe("malformed-frame");
  });

  test("resumes after a retryable close without bootstrapping again", async () => {
    let bootstraps = 0;
    const urls: Array<string> = [];
    const fixture = dependencies({
      getGatewayBot: () => {
        bootstraps += 1;
        return Effect.succeed({ url: "wss://gateway.discord.test" });
      },
      connect: (url) => {
        urls.push(url);
        const connection = new FakeDiscordConnection();
        fixture.connections.push(connection);
        return connection;
      },
      schedule: (_delay, task) => {
        task();
        return () => undefined;
      },
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* openDiscordSocket("token", 0, fixture.value);
          yield* yieldToSupervisor;
          fixture.connections[0]?.emitMessage(ready);
          yield* yieldToSupervisor;
          fixture.connections[0]?.emitClose(1001);
          yield* yieldToSupervisor;
          expect(bootstraps).toBe(1);
          expect(urls).toEqual([
            "wss://gateway.discord.test/?v=10&encoding=json",
            "wss://resume.discord.test/?v=10&encoding=json",
          ]);
        }),
      ),
    );
  });

  test("interrupting one pending receive does not consume the next message", async () => {
    const fixture = dependencies();
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openDiscordSocket("token", 0, fixture.value);
          yield* yieldToSupervisor;
          const pending = yield* socket.next.pipe(Effect.forkChild);
          yield* Fiber.interrupt(pending);
          fixture.connections[0]?.emitMessage(ready);
          fixture.connections[0]?.emitMessage(message("m1"));
          return yield* socket.next;
        }),
      ),
    );

    expect(received.id).toBe("m1");
  });

  test("fails fast when the bounded inbound queue overflows", async () => {
    const fixture = dependencies({ inboundCapacity: 1 });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* openDiscordSocket("token", 0, fixture.value);
          yield* yieldToSupervisor;
          fixture.connections[0]?.emitMessage(ready);
          fixture.connections[0]?.emitMessage(message("m1"));
          fixture.connections[0]?.emitMessage(message("m2"));
          yield* yieldToSupervisor;
          return yield* socket.next.pipe(Effect.result);
        }),
      ),
    );

    expect(Result.isFailure(result) && result.failure.reason).toBe("queue-overflow");
  });

  test("close is bounded and scope cleanup removes listeners", async () => {
    const fixture = dependencies();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* openDiscordSocket("token", 0, fixture.value);
        yield* yieldToSupervisor;
        const connection = fixture.connections[0];
        expect(connection).toBeDefined();
        if (connection === undefined) {
          return;
        }
        connection.closeCompletes = false;
        const closeFiber = yield* socket.close.pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(closeFiber);
        expect(Result.isFailure(result) && result.failure.reason).toBe("close-timeout");
        expect(connection.removedListeners).toBeGreaterThanOrEqual(3);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
  });
});
