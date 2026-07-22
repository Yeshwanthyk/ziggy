import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import {
  decodeClientRequest,
  encodeServerFrame,
  MAIN_SESSION_ID,
  PROTOCOL_VERSION,
  type ClientRequestFrame,
  type ServerFrame,
  type SessionEnvelope,
  type SessionSummary,
} from "../../packages/protocol/src/index.ts";
import {
  AttachOutcomeUnknownError,
  createAttachClient,
  unixAttachTransportFactory,
} from "../../packages/ziggy/src/attach.ts";
import { runScopedEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  observeCanonicalEvents,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

const temporaryDirectories: string[] = [];
const summary: SessionSummary = {
  sessionId: MAIN_SESSION_ID,
  createdAt: "2026-07-21T00:00:00.000Z",
  lastSeq: 1,
};
const replay: SessionEnvelope = {
  schemaVersion: 1,
  seq: 1,
  emittedAt: "2026-07-21T00:00:00.001Z",
  event: {
    type: "turn-ended",
    sessionId: MAIN_SESSION_ID,
    turnId: "replayed-turn",
    status: "completed",
  },
};
let observations: RuntimeObservations = emptyRuntimeObservations();

test("shared Attach Client correlates reverse responses and applies real-socket replay", async () => {
  let delayedEnsure: ClientRequestFrame | undefined;
  const server = await unixFixture((request, socket) => {
    if (request.method === "session/ensure" && delayedEnsure === undefined) {
      delayedEnsure = request;
      return;
    }
    if (request.method === "session/list") {
      sendSuccess(socket, request, { sessions: [summary] });
      const ensure = delayedEnsure;
      if (ensure !== undefined) sendSuccess(socket, ensure, { session: summary });
      return;
    }
    if (request.method === "session/subscribe") {
      send(socket, {
        schemaVersion: PROTOCOL_VERSION,
        type: "event",
        subscriptionId: "shared-subscription",
        event: replay,
      });
      sendSuccess(socket, request, { subscriptionId: "shared-subscription", replayThroughSeq: 1 });
      return;
    }
    respondNormally(request, socket);
  });

  const result = await runScopedEffect(
    Effect.gen(function* () {
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(server.socketPath),
        client: { name: "s3-shared-client", version: "1.0.0" },
      });
      const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
      const event = yield* subscription.next;
      const ensure = yield* Effect.forkScoped(client.ensureMain);
      yield* Effect.promise(() => server.waitForMethod("session/ensure"));
      const listed = yield* client.listSessions;
      const ensured = yield* Fiber.join(ensure);
      return {
        event,
        listed,
        ensured,
        watermark: yield* subscription.replayThroughSeq,
      };
    }),
  );
  await server.waitForClientClose();
  expect(result).toEqual({ event: replay, listed: [summary], ensured: summary, watermark: 1 });
  observations = {
    ...observations,
    canonicalEventTrace: observeCanonicalEvents([replay]),
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "attach-protocol",
        point: "reverse-correlation-replay",
        occurrence: 1,
        outcome: "recovered",
      },
    ],
  };
  await server.close();
});

test("shared Attach Client reports outcome unknown after accepted real-socket write disconnect", async () => {
  let turnStarts = 0;
  const server = await unixFixture((request, socket) => {
    if (request.method === "turn/start") {
      turnStarts += 1;
      socket.destroy();
      return;
    }
    respondNormally(request, socket);
  });

  const result = await runScopedEffect(
    Effect.gen(function* () {
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(server.socketPath),
        client: { name: "s3-shared-client", version: "1.0.0" },
      });
      const error = yield* Effect.flip(client.startMainTurn("execute once", 0));
      return { error, connections: server.connections(), turnStarts };
    }),
  );
  expect(result).toEqual({
    error: new AttachOutcomeUnknownError({ sessionId: MAIN_SESSION_ID }),
    connections: 1,
    turnStarts: 1,
  });
  observations = {
    ...observations,
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "attach-receive",
        point: "post-write-disconnect",
        occurrence: 1,
        outcome: "failed",
      },
    ],
  };
  await server.close();
});

test("shared Attach Client retries setup once before real-socket turn acceptance", async () => {
  let fixture: UnixFixture | undefined;
  let turnStarts = 0;
  const server = await unixFixture((request, socket) => {
    if (request.method === "initialize" && fixture?.connections() === 1) {
      socket.destroy();
      return;
    }
    if (request.method === "turn/start") turnStarts += 1;
    respondNormally(request, socket);
  });
  fixture = server;
  const result = await runScopedEffect(
    Effect.gen(function* () {
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(server.socketPath),
        client: { name: "s3-shared-client", version: "1.0.0" },
      });
      const accepted = yield* client.startMainTurn("retry setup", 0);
      return { acceptance: accepted.acceptance, connections: server.connections(), turnStarts };
    }),
  );
  expect(result).toEqual({
    acceptance: { turnId: "turn-accepted", disposition: "started" },
    connections: 2,
    turnStarts: 1,
  });
  observations = {
    ...observations,
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "attach-setup",
        point: "first-connection-disconnect",
        occurrence: 1,
        outcome: "recovered",
      },
    ],
  };
  await server.close();
});

test("shared Attach Client backpressures real-socket replay at event capacity", async () => {
  const server = await unixFixture((request, socket) => {
    if (request.method === "session/subscribe") {
      sendSuccess(socket, request, {
        subscriptionId: "backpressure-subscription",
        replayThroughSeq: 2,
      });
      for (const seq of [1, 2]) {
        send(socket, {
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: "backpressure-subscription",
          event: { ...replay, seq },
        });
      }
      return;
    }
    respondNormally(request, socket);
  });
  const sequences = await runScopedEffect(
    Effect.gen(function* () {
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(server.socketPath),
        client: { name: "s3-shared-client", version: "1.0.0" },
        eventQueueCapacity: 1,
      });
      const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
      yield* Effect.sleep("20 millis");
      const events = yield* Effect.all([subscription.next, subscription.next], {
        concurrency: 1,
      });
      return events.map((event) => event.seq);
    }),
  );
  expect(sequences).toEqual([1, 2]);
  observations = {
    ...observations,
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "attach-replay",
        point: "event-capacity",
        occurrence: 1,
        outcome: "recovered",
      },
    ],
  };
  await server.close();
});

afterAll(async () => {
  emitVerificationObservation("s3.attach-client", observations);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface UnixFixture {
  readonly socketPath: string;
  readonly connections: () => number;
  readonly waitForMethod: (method: ClientRequestFrame["method"]) => Promise<void>;
  readonly waitForClientClose: () => Promise<void>;
  readonly close: () => Promise<void>;
}

async function unixFixture(
  handler: (request: ClientRequestFrame, socket: Socket) => void,
): Promise<UnixFixture> {
  const directory = await mkdtemp(join(tmpdir(), "ziggy-s3-attach-client-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "attach.sock");
  const receivedMethods: ClientRequestFrame["method"][] = [];
  const methodWaiters = new Map<
    ClientRequestFrame["method"],
    Array<ReturnType<typeof Promise.withResolvers<void>>>
  >();
  const clientClosed = Promise.withResolvers<void>();
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount += 1;
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString();
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const request = decodeClientRequest(buffered.slice(0, newline + 1));
        buffered = buffered.slice(newline + 1);
        receivedMethods.push(request.method);
        methodWaiters.get(request.method)?.shift()?.resolve();
        handler(request, socket);
      }
    });
    socket.on("close", () => clientClosed.resolve());
    socket.on("error", () => undefined);
  });
  await listen(server, socketPath);
  return {
    socketPath,
    connections: () => connectionCount,
    waitForMethod: (method) => {
      if (receivedMethods.includes(method)) return Promise.resolve();
      const waiter = Promise.withResolvers<void>();
      const waiters = methodWaiters.get(method) ?? [];
      waiters.push(waiter);
      methodWaiters.set(method, waiters);
      return waiter.promise;
    },
    waitForClientClose: () => clientClosed.promise,
    close: () => closeServer(server),
  };
}

function respondNormally(request: ClientRequestFrame, socket: Socket): void {
  switch (request.method) {
    case "initialize":
      sendSuccess(socket, request, {
        protocolVersion: PROTOCOL_VERSION,
        features: ["stableMainSession", "sessionReplay"],
      });
      return;
    case "session/ensure":
      sendSuccess(socket, request, { session: summary });
      return;
    case "session/subscribe":
      sendSuccess(socket, request, { subscriptionId: "shared-subscription", replayThroughSeq: 0 });
      return;
    case "turn/start":
      sendSuccess(socket, request, { turnId: "turn-accepted", disposition: "started" });
      return;
    case "session/unsubscribe":
      sendSuccess(socket, request, { unsubscribed: true });
      return;
    default:
      send(socket, {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "error",
        code: "invalid-params",
        message: "Unsupported scenario request",
      });
  }
}

function sendSuccess(socket: Socket, request: ClientRequestFrame, result: object): void {
  socket.write(
    `${JSON.stringify({
      schemaVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      method: request.method,
      type: "success",
      result,
    })}\n`,
  );
}

function send(socket: Socket, frame: ServerFrame): void {
  socket.write(encodeServerFrame(frame));
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
