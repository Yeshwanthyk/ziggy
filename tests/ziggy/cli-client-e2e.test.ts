import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeClientRequest,
  encodeServerFrame,
  PROTOCOL_VERSION,
  type ClientRequestFrame,
  type ServerFrame,
  type SessionSummary,
} from "../../packages/protocol/src/index.ts";
import {
  runProductionAsk,
  runProductionSessionsList,
} from "../../packages/ziggy/src/cli-client.ts";
import type { DaemonProbeResult } from "../../packages/ziggy/src/daemon.ts";
import { Effect } from "effect";
import { runEffect } from "../testkit/effect.ts";

const directories: string[] = [];

const main: SessionSummary = {
  sessionId: "main",
  createdAt: "2026-07-21T00:00:00.000Z",
  lastSeq: 0,
};

const other: SessionSummary = {
  sessionId: "session-2",
  createdAt: "2026-07-21T00:00:01.000Z",
  lastSeq: 7,
  activeTurnId: "active-turn",
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI real-socket lane", () => {
  it("initializes v2, ensures main, subscribes, starts once, and streams accepted text", async () => {
    const fixture = await attachFixture((request, socket) => {
      switch (request.method) {
        case "initialize":
          sendSuccess(socket, request, {
            protocolVersion: PROTOCOL_VERSION,
            features: ["stableMainSession", "sessionReplay"],
          });
          return;
        case "session/ensure":
          sendSuccess(socket, request, { session: main });
          return;
        case "session/subscribe":
          sendSuccess(socket, request, { subscriptionId: "cli-subscription", replayThroughSeq: 0 });
          return;
        case "turn/start":
          sendSuccess(socket, request, { turnId: "accepted-turn", disposition: "started" });
          send(socket, {
            schemaVersion: PROTOCOL_VERSION,
            type: "event",
            subscriptionId: "cli-subscription",
            event: {
              schemaVersion: 1,
              seq: 1,
              emittedAt: "2026-07-21T00:00:02.000Z",
              event: {
                type: "model-chunk",
                sessionId: "main",
                turnId: "accepted-turn",
                stepId: "step-1",
                contentIndex: 0,
                kind: "text",
                delta: "accepted text\n\n",
              },
            },
          });
          send(socket, {
            schemaVersion: PROTOCOL_VERSION,
            type: "event",
            subscriptionId: "cli-subscription",
            event: {
              schemaVersion: 1,
              seq: 2,
              emittedAt: "2026-07-21T00:00:03.000Z",
              event: {
                type: "turn-ended",
                sessionId: "main",
                turnId: "accepted-turn",
                status: "completed",
              },
            },
          });
          return;
        default:
          reject(socket, request);
      }
    });
    const output: string[] = [];

    await runEffect(
      runProductionAsk("/profile", "hello", readySetup(fixture.socketPath), (text) =>
        Effect.sync(() => output.push(text)),
      ),
    );

    expect(fixture.methods).toEqual([
      "initialize",
      "session/ensure",
      "session/subscribe",
      "turn/start",
    ]);
    expect(fixture.turnMessages).toEqual(["hello"]);
    expect(output.join("")).toBe("accepted text\n");
    await fixture.close();
  });

  it("auto-starts an absent daemon and lists every Session without Client writes", async () => {
    const fixture = await attachFixture((request, socket) => {
      if (request.method === "initialize") {
        sendSuccess(socket, request, {
          protocolVersion: PROTOCOL_VERSION,
          features: ["stableMainSession", "sessionReplay"],
        });
        return;
      }
      if (request.method === "session/list") {
        sendSuccess(socket, request, { sessions: [other, main] });
        return;
      }
      reject(socket, request);
    });
    let starts = 0;
    const absent: DaemonProbeResult = {
      status: "unavailable",
      profilePath: "/canonical",
      socketPath: fixture.socketPath,
      socketState: "absent",
      detail: "absent",
    };

    const output = await runEffect(
      runProductionSessionsList("/profile", {
        probe: () => Effect.succeed(absent),
        startAbsent: () =>
          Effect.sync(() => {
            starts += 1;
            return ready(fixture.socketPath);
          }),
      }),
    );

    expect(starts).toBe(1);
    expect(fixture.methods).toEqual(["initialize", "session/list"]);
    expect(fixture.turnMessages).toEqual([]);
    expect(output).toBe(
      '[{"sessionId":"main","createdAt":"2026-07-21T00:00:00.000Z","status":"idle"},{"sessionId":"session-2","createdAt":"2026-07-21T00:00:01.000Z","status":"active"}]',
    );
    await fixture.close();
  });
});

function ready(socketPath: string): DaemonProbeResult {
  return {
    status: "ready",
    profilePath: "/canonical",
    socketPath,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function readySetup(socketPath: string) {
  return {
    probe: () => Effect.succeed(ready(socketPath)),
    startAbsent: () => Effect.succeed(ready(socketPath)),
  };
}

interface AttachFixture {
  readonly socketPath: string;
  readonly methods: ClientRequestFrame["method"][];
  readonly turnMessages: string[];
  readonly close: () => Promise<void>;
}

async function attachFixture(
  handler: (request: ClientRequestFrame, socket: Socket) => void,
): Promise<AttachFixture> {
  const directory = await mkdtemp(join(tmpdir(), "ziggy-cli-lane-"));
  directories.push(directory);
  const socketPath = join(directory, "attach.sock");
  const methods: ClientRequestFrame["method"][] = [];
  const turnMessages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString();
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const request = decodeClientRequest(buffered.slice(0, newline + 1));
        buffered = buffered.slice(newline + 1);
        methods.push(request.method);
        if (request.method === "turn/start") turnMessages.push(request.params.message);
        handler(request, socket);
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await listen(server, socketPath);
  return {
    socketPath,
    methods,
    turnMessages,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return closeServer(server);
    },
  };
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

function reject(socket: Socket, request: ClientRequestFrame): void {
  send(socket, {
    schemaVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    type: "error",
    code: "invalid-params",
    message: "Unexpected fixture request",
  });
}

function send(socket: Socket, frame: ServerFrame): void {
  socket.write(encodeServerFrame(frame));
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, rejectListen) => {
    server.once("listening", resolve);
    server.once("error", rejectListen);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
