import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeClientRequest,
  encodeServerFrame,
  PROTOCOL_VERSION,
  type ClientRequestFrame,
  type ServerFrame,
} from "../../packages/protocol/src/index.ts";
import {
  AttachTransportClosedError,
  AttachTransportConfigurationError,
  AttachTransportOpenError,
  AttachTransportQueueOverflowError,
  AttachTransportReadError,
  AttachTransportWriteError,
  unixAttachTransportFactory,
} from "../../packages/ziggy/src/attach.ts";
import { Effect, Fiber, Queue, Scope } from "effect";
import { runScopedEffect } from "../testkit/effect.ts";

interface UnixServerHarness {
  readonly server: Server;
  readonly connections: Queue.Queue<Socket>;
}

const initializeSuccess: ServerFrame = {
  schemaVersion: PROTOCOL_VERSION,
  requestId: "initialize-1",
  method: "initialize",
  type: "success",
  result: {
    protocolVersion: PROTOCOL_VERSION,
    features: ["stableMainSession", "sessionReplay"],
  },
};

const listSuccess: ServerFrame = {
  schemaVersion: PROTOCOL_VERSION,
  requestId: "list-1",
  method: "session/list",
  type: "success",
  result: { sessions: [] },
};

const initializeRequest: ClientRequestFrame = {
  schemaVersion: PROTOCOL_VERSION,
  requestId: "initialize-1",
  method: "initialize",
  params: {
    client: { name: "transport-test", version: "0.0.0" },
    features: [],
  },
};

const temporarySocketPath = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "ziggy-attach-transport-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
).pipe(Effect.map((directory) => join(directory, "attach.sock")));

function unixServer(
  socketPath: string,
): Effect.Effect<UnixServerHarness, AttachTransportOpenError, Scope.Scope> {
  return Effect.gen(function* () {
    const connections = yield* Queue.unbounded<Socket>();
    const server = createServer((socket) => {
      Queue.offerUnsafe(connections, socket);
    });
    const close = closeServer(server);
    yield* Scope.addFinalizer(yield* Effect.scope, close);
    yield* listenServer(server, socketPath).pipe(Effect.onError(() => close));
    return { server, connections };
  });
}

function listenServer(
  server: Server,
  socketPath: string,
): Effect.Effect<void, AttachTransportOpenError> {
  return Effect.callback<void, AttachTransportOpenError>((resume) => {
    const onListening = (): void => {
      server.off("error", onError);
      resume(Effect.void);
    };
    const onError = (cause: Error): void => {
      server.off("listening", onListening);
      resume(Effect.fail(new AttachTransportOpenError({ cause })));
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(socketPath);
    return Effect.sync(() => {
      server.off("listening", onListening);
      server.off("error", onError);
    });
  });
}

function closeServer(server: Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
  });
}

function writePeer(socket: Socket, data: string): Effect.Effect<void, AttachTransportWriteError> {
  return Effect.callback<void, AttachTransportWriteError>((resume) => {
    socket.write(data, (cause) => {
      resume(
        cause === undefined || cause === null
          ? Effect.void
          : Effect.fail(new AttachTransportWriteError({ cause })),
      );
    });
  });
}

function readPeerLine(socket: Socket): Effect.Effect<string, AttachTransportWriteError> {
  return Effect.callback<string, AttachTransportWriteError>((resume) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk], buffered.byteLength + chunk.byteLength);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resume(Effect.succeed(buffered.subarray(0, newline + 1).toString("utf8")));
    };
    const onError = (cause: Error): void => {
      cleanup();
      resume(Effect.fail(new AttachTransportWriteError({ cause })));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    return Effect.sync(cleanup);
  });
}

describe("Unix Attach transport adapter", () => {
  it("rejects every invalid capacity before opening the socket", async () => {
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const option of ["maxFrameBytes", "maxQueuedBytes", "maxQueuedFrames"] as const) {
      for (const value of invalid) {
        const error = await runScopedEffect(
          Effect.flip(
            unixAttachTransportFactory("/definitely/missing/ziggy.sock", {
              [option]: value,
            }).connect,
          ),
        );
        expect(error).toEqual(new AttachTransportConfigurationError({ option }));
      }
    }
  });

  it("preserves fragmented and batched frame order and writes canonical requests", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const socketPath = yield* temporarySocketPath;
        const harness = yield* unixServer(socketPath);
        const transport = yield* unixAttachTransportFactory(socketPath).connect;
        const peer = yield* Queue.take(harness.connections);

        const firstEncoded = encodeServerFrame(initializeSuccess);
        const secondEncoded = encodeServerFrame(listSuccess);
        yield* writePeer(peer, firstEncoded.slice(0, 7));
        yield* writePeer(peer, firstEncoded.slice(7) + secondEncoded);
        const first = yield* transport.receive;
        const second = yield* transport.receive;

        const outboundFiber = yield* Effect.forkScoped(readPeerLine(peer), {
          startImmediately: true,
        });
        yield* transport.write(initializeRequest);
        const outbound = yield* Fiber.join(outboundFiber);
        return { first, second, outbound };
      }),
    );

    expect(result).toEqual({
      first: initializeSuccess,
      second: listSuccess,
      outbound: encodeClientRequest(initializeRequest),
    });
  });

  it("backpressures a batched peer when the bounded frame queue is full", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const socketPath = yield* temporarySocketPath;
        const harness = yield* unixServer(socketPath);
        const transport = yield* unixAttachTransportFactory(socketPath, {
          maxQueuedFrames: 1,
        }).connect;
        const peer = yield* Queue.take(harness.connections);
        yield* writePeer(
          peer,
          encodeServerFrame(initializeSuccess) + encodeServerFrame(listSuccess),
        );
        yield* Effect.sleep("20 millis");
        const first = yield* transport.receive;
        const second = yield* transport.receive;
        return { first, second };
      }),
    );

    expect(result).toEqual({ first: initializeSuccess, second: listSuccess });
  });

  it("drains a terminal peer's complete batch under frame and byte backpressure", async () => {
    const encoded = encodeServerFrame(listSuccess);
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const socketPath = yield* temporarySocketPath;
        const harness = yield* unixServer(socketPath);
        const transport = yield* unixAttachTransportFactory(socketPath, {
          maxQueuedBytes: Buffer.byteLength(encoded),
          maxQueuedFrames: 1,
        }).connect;
        const peer = yield* Queue.take(harness.connections);
        peer.end(encoded.repeat(3));
        yield* Effect.sleep("20 millis");
        const received = yield* Effect.all(
          [transport.receive, transport.receive, transport.receive],
          { concurrency: 1 },
        );
        const terminal = yield* Effect.flip(transport.receive);
        return { received, terminal };
      }),
    );

    expect(result).toEqual({
      received: [listSuccess, listSuccess, listSuccess],
      terminal: new AttachTransportClosedError(),
    });
  });

  it("drains a complete batch before publishing an immediate read error", async () => {
    const encoded = encodeServerFrame(listSuccess);
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const socketPath = yield* temporarySocketPath;
        const harness = yield* unixServer(socketPath);
        const transport = yield* unixAttachTransportFactory(socketPath, {
          maxQueuedBytes: Buffer.byteLength(encoded),
          maxQueuedFrames: 1,
        }).connect;
        const peer = yield* Queue.take(harness.connections);
        peer.end(`${encoded.repeat(3)}not-json\n`);
        const received = yield* Effect.all(
          [transport.receive, transport.receive, transport.receive],
          { concurrency: 1 },
        );
        const terminal = yield* Effect.flip(transport.receive);
        return { received, terminal };
      }),
    );

    expect(result.received).toEqual([listSuccess, listSuccess, listSuccess]);
    expect(result.terminal).toBeInstanceOf(AttachTransportReadError);
  });

  it("fails a valid frame that cannot fit within the bounded byte budget", async () => {
    const encoded = encodeServerFrame(initializeSuccess);
    const error = await runScopedEffect(
      Effect.gen(function* () {
        const socketPath = yield* temporarySocketPath;
        const harness = yield* unixServer(socketPath);
        const transport = yield* unixAttachTransportFactory(socketPath, {
          maxQueuedBytes: Buffer.byteLength(encoded) - 1,
        }).connect;
        const peer = yield* Queue.take(harness.connections);
        yield* writePeer(peer, encoded);
        return yield* Effect.flip(transport.receive);
      }),
    );

    expect(error).toEqual(
      new AttachTransportQueueOverflowError({ queuedFrames: 0, queuedBytes: 0 }),
    );
  });

  it("fails newline-free input beyond the framing limit", async () => {
    const error = await runScopedEffect(
      Effect.gen(function* () {
        const socketPath = yield* temporarySocketPath;
        const harness = yield* unixServer(socketPath);
        const transport = yield* unixAttachTransportFactory(socketPath, {
          maxFrameBytes: 16,
        }).connect;
        const peer = yield* Queue.take(harness.connections);
        yield* writePeer(peer, "x".repeat(17));
        return yield* Effect.flip(transport.receive);
      }),
    );

    expect(error).toEqual(new AttachTransportReadError());
  });
});
