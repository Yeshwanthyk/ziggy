import { afterAll, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  type AttachServer,
  type DaemonKernel,
  ProfileLockCoordinator,
  SessionRuntimeError,
} from "../../packages/core/src/index.ts";
import {
  decodeClientRequest,
  decodeServerFrame,
  decodeSessionEnvelope,
  encodeClientRequest,
  type ClientRequestFrame,
  type ServerFrame,
} from "../../packages/protocol/src/index.ts";
import { Barrier } from "../testkit/barrier.ts";
import { ScriptedProvider } from "../testkit/provider/scripted.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

const profiles: string[] = [];
let stableMainObservations: RuntimeObservations = emptyRuntimeObservations();

test("stable main is lazy, concurrent, schema-v1 durable, and reused after restart", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s3-stable-main-"));
  profiles.push(profile);
  const firstCreation = new Barrier();
  const first = await createFixture(profile, firstCreation);
  const left = await SocketPeer.connect(first.server.socketPath);
  const right = await SocketPeer.connect(first.server.socketPath);
  let createdAt = "";

  try {
    expect(await exists(join(profile, "sessions", "main.ndjson"))).toBeFalse();

    left.sendRaw(
      '{"schemaVersion":1,"requestId":"legacy","method":"initialize","params":{"client":{"name":"legacy","version":"1"},"features":[]}}\n',
    );
    expect(await left.next()).toMatchObject({
      schemaVersion: 2,
      type: "error",
      requestId: "legacy",
      code: "version-mismatch",
    });

    await Promise.all([initialize(left, "initialize-left"), initialize(right, "initialize-right")]);

    left.send(request("start-main", "session/start", {}));
    expect(await response(left, "start-main")).toMatchObject({
      type: "error",
      code: "internal",
    });
    expect(await exists(join(profile, "sessions", "main.ndjson"))).toBeFalse();

    left.send(request("list-before", "session/list", {}));
    expect(await response(left, "list-before")).toMatchObject({
      type: "success",
      result: { sessions: [] },
    });
    left.send(request("resume-before", "session/resume", { sessionId: "main", sinceSeq: 0 }));
    expect(await response(left, "resume-before")).toMatchObject({
      type: "error",
      code: "session-not-found",
    });
    expect(await exists(join(profile, "sessions", "main.ndjson"))).toBeFalse();

    left.send(request("ensure-left", "session/ensure", { sessionId: "main" }));
    await firstCreation.entered;
    right.send(request("ensure-right", "session/ensure", { sessionId: "main" }));
    await first.twoEnsureCalls;
    expect(first.runtimeCreations()).toBe(1);
    firstCreation.release();
    const [leftEnsure, rightEnsure] = await Promise.all([
      response(left, "ensure-left"),
      response(right, "ensure-right"),
    ]);
    expect(leftEnsure).toMatchObject({
      type: "success",
      method: "session/ensure",
      result: { session: { sessionId: "main", lastSeq: 1 } },
    });
    expect(rightEnsure).toMatchObject({
      type: "success",
      method: "session/ensure",
      result: { session: { sessionId: "main", lastSeq: 1 } },
    });
    if (
      leftEnsure.type !== "success" ||
      leftEnsure.method !== "session/ensure" ||
      rightEnsure.type !== "success" ||
      rightEnsure.method !== "session/ensure"
    ) {
      throw new Error("Expected session/ensure success");
    }
    expect(rightEnsure.result.session).toEqual(leftEnsure.result.session);
    createdAt = leftEnsure.result.session.createdAt;

    expect(await readdir(join(profile, "sessions"))).toEqual(["main.ndjson"]);
    const durable = await readFile(join(profile, "sessions", "main.ndjson"), "utf8");
    const frames = durable
      .trimEnd()
      .split("\n")
      .map((line) => decodeSessionEnvelope(`${line}\n`));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      schemaVersion: 1,
      seq: 1,
      event: { type: "session-started", sessionId: "main" },
    });
    stableMainObservations = {
      ...emptyRuntimeObservations(),
      canonicalEventTrace: observeCanonicalEvents(frames),
      filesystemDiffs: [
        {
          path: "sessions/main.ndjson",
          change: "created",
          beforeDigest: null,
          afterDigest: fixtureDigest(durable),
        },
      ],
    };
  } finally {
    firstCreation.release();
    await left.close();
    await right.close();
    await first.close();
  }

  const path = join(profile, "sessions", "main.ndjson");
  const beforeRestart = await readFile(path, "utf8");
  const restarted = await createFixture(profile);
  const peer = await SocketPeer.connect(restarted.server.socketPath);
  try {
    expect(await readFile(path, "utf8")).toBe(beforeRestart);
    await initialize(peer, "restart-initialize");
    peer.send(request("restart-ensure", "session/ensure", { sessionId: "main" }));
    expect(await response(peer, "restart-ensure")).toMatchObject({
      type: "success",
      result: { session: { sessionId: "main", createdAt, lastSeq: 1 } },
    });
    expect(await readFile(path, "utf8")).toBe(beforeRestart);
    expect(await readdir(join(profile, "sessions"))).toEqual(["main.ndjson"]);
  } finally {
    await peer.close();
    await restarted.close();
  }
});

afterAll(async () => {
  await Promise.all(profiles.map((profile) => rm(profile, { recursive: true, force: true })));
  emitVerificationObservation("s3.stable-main", stableMainObservations);
});

interface Fixture {
  readonly server: AttachServer;
  readonly twoEnsureCalls: Promise<void>;
  readonly runtimeCreations: () => number;
  readonly close: () => Promise<void>;
}

async function createFixture(profilePath: string, creationBarrier?: Barrier): Promise<Fixture> {
  const provider = new ScriptedProvider([]);
  let milliseconds = Date.parse("2026-07-21T00:00:00.000Z");
  let runtimeCreations = 0;
  let ensureCalls = 0;
  const secondEnsure = Promise.withResolvers<void>();
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath,
      createWorld: (canonicalProfilePath) =>
        createFilesystemWorld({
          profilePath: canonicalProfilePath,
          now: () => {
            const value = new Date(milliseconds);
            milliseconds += 1;
            return value;
          },
        }),
      createRuntime: (sessionId, world) => {
        runtimeCreations += 1;
        const create = createFilesystemSessionRuntime({
          sessionId,
          world,
          baseSystemPrompt: "You are Ziggy.",
          tools: [],
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => "unused-turn",
          nextStepId: () => "unused-step",
        });
        return creationBarrier === undefined
          ? create
          : Effect.tryPromise({
              try: () => creationBarrier.wait(),
              catch: (cause) =>
                new SessionRuntimeError({ message: "Stable main creation barrier failed", cause }),
            }).pipe(Effect.andThen(create));
      },
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  const observedKernel: DaemonKernel<unknown> = {
    profilePath: kernel.profilePath,
    createSession: (sessionId) => kernel.createSession(sessionId),
    getOrCreateSession: (sessionId) => kernel.getOrCreateSession(sessionId),
    ensureMainSession: () =>
      Effect.sync(() => {
        ensureCalls += 1;
        if (ensureCalls === 2) secondEnsure.resolve();
      }).pipe(Effect.andThen(kernel.ensureMainSession())),
    getSessionSummary: (sessionId) => kernel.getSessionSummary(sessionId),
    listSessions: kernel.listSessions,
    close: kernel.close,
  };
  const server = await runEffect(
    createAttachServer({
      kernel: observedKernel,
      nextSessionId: () => "main",
      nextSubscriptionId: () => "unused-subscription",
    }),
  );
  return {
    ...fixture(kernel, server),
    twoEnsureCalls: secondEnsure.promise,
    runtimeCreations: () => runtimeCreations,
  };
}

function fixture(
  kernel: DaemonKernel<unknown>,
  server: AttachServer,
): Omit<Fixture, "twoEnsureCalls" | "runtimeCreations"> {
  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => {
      closing ??= runEffect(server.close.pipe(Effect.andThen(kernel.close)));
      return closing;
    },
  };
}

class SocketPeer {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<ReturnType<typeof Promise.withResolvers<ServerFrame>>> = [];
  private readonly closed = Promise.withResolvers<void>();
  private remainder = "";

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) =>
      this.receive(typeof chunk === "string" ? chunk : chunk.toString()),
    );
    socket.on("close", () => this.closed.resolve());
    socket.on("error", () => undefined);
  }

  static async connect(socketPath: string): Promise<SocketPeer> {
    const socket = createConnection(socketPath);
    const peer = new SocketPeer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return peer;
  }

  send(frame: ClientRequestFrame): void {
    this.sendRaw(encodeClientRequest(frame));
  }

  sendRaw(frame: string): void {
    this.socket.write(frame);
  }

  next(): Promise<ServerFrame> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    const waiter = Promise.withResolvers<ServerFrame>();
    this.waiters.push(waiter);
    return waiter.promise;
  }

  async close(): Promise<void> {
    if (!this.socket.destroyed) this.socket.destroy();
    await this.closed.promise;
  }

  private receive(chunk: string): void {
    this.remainder += chunk;
    while (true) {
      const newline = this.remainder.indexOf("\n");
      if (newline < 0) return;
      const frame = decodeServerFrame(this.remainder.slice(0, newline + 1));
      this.remainder = this.remainder.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.frames.push(frame);
      else waiter.resolve(frame);
    }
  }
}

function request<Method extends ClientRequestFrame["method"]>(
  requestId: string,
  method: Method,
  params: Extract<ClientRequestFrame, { readonly method: Method }>["params"],
): ClientRequestFrame {
  const encoded = JSON.stringify({ schemaVersion: 2, requestId, method, params });
  if (encoded === undefined) throw new Error("Test request is not JSON-safe");
  return decodeClientRequest(`${encoded}\n`);
}

async function initialize(peer: SocketPeer, requestId: string): Promise<void> {
  peer.send(
    request(requestId, "initialize", {
      client: { name: "stable-main-scenario", version: "1.0.0" },
      features: [],
    }),
  );
  expect(await response(peer, requestId)).toMatchObject({
    type: "success",
    method: "initialize",
    result: {
      protocolVersion: 2,
      features: [
        "sessionReplay",
        "turnSteering",
        "turnInterrupt",
        "approvals",
        "stableMainSession",
      ],
    },
  });
}

async function response(peer: SocketPeer, requestId: string): Promise<ServerFrame> {
  while (true) {
    const frame = await peer.next();
    if (frame.type !== "event" && frame.type !== "auth" && frame.requestId === requestId) {
      return frame;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
