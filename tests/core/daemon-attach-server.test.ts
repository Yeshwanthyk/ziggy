import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  createSessionRuntime,
  type AttachServer,
  type DaemonKernel,
  type DaemonWorld,
  type FilesystemWorld,
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
  type SessionEnvelope,
  type SessionEvent,
} from "../../packages/protocol/src/index.ts";
import { SequenceIds } from "../testkit/boundaries.ts";
import { Barrier } from "../testkit/barrier.ts";
import { awaitingAbortStep, ScriptedProvider, textStep } from "../testkit/provider/scripted.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  observeCanonicalEvents,
  observeProviderInputs,
} from "../testkit/verification-observations.ts";
import { runEffect } from "../testkit/effect.ts";

const profiles: string[] = [];
const SNAPSHOT = { systemPrompt: "You are Ziggy.", tools: [] };
let attachScenarioObservations = emptyRuntimeObservations();

describe("Unix attach server", () => {
  test("creates a mode-0600 socket and enforces initialize before exact method dispatch", async () => {
    const fixture = await filesystemFixture(new ScriptedProvider([]));
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    try {
      const socket = await lstat(fixture.server.socketPath);
      expect(socket.isSocket()).toBeTrue();
      expect(socket.mode & 0o777).toBe(0o600);

      peer.sendRaw(
        '{"schemaVersion":1,"requestId":"v1","method":"initialize","params":{"client":{"name":"legacy","version":"1"},"features":[]}}\n',
      );
      expect(await peer.next()).toMatchObject({
        type: "error",
        requestId: "v1",
        code: "version-mismatch",
        schemaVersion: 2,
      });

      peer.send(request("before-init", "session/list", {}));
      expect(await peer.next()).toMatchObject({
        type: "error",
        requestId: "before-init",
        code: "not-initialized",
      });

      await initialize(peer, "initialize");
      peer.send(request("initialize-again", "initialize", clientIdentity()));
      expect(await peer.next()).toMatchObject({
        type: "error",
        requestId: "initialize-again",
        code: "already-initialized",
      });

      peer.send(request("start", "session/start", {}));
      const started = await response(peer, "start");
      expect(started).toMatchObject({
        type: "success",
        method: "session/start",
        result: {
          session: { sessionId: "session-a", createdAt: "2026-07-20T00:00:00.000Z", lastSeq: 1 },
        },
      });

      peer.send(request("list", "session/list", {}));
      expect(await response(peer, "list")).toMatchObject({
        type: "success",
        method: "session/list",
        result: { sessions: [{ sessionId: "session-a", lastSeq: 1 }] },
      });

      peer.send(request("subscribe", "session/subscribe", { sessionId: "session-a", sinceSeq: 0 }));
      const subscribeResponse = await peer.next();
      expect(subscribeResponse).toMatchObject({
        type: "success",
        requestId: "subscribe",
        method: "session/subscribe",
        result: { subscriptionId: "subscription-a", replayThroughSeq: 1 },
      });
      expect(await peer.next()).toMatchObject({
        type: "event",
        subscriptionId: "subscription-a",
        event: { seq: 1, event: { type: "session-started", sessionId: "session-a" } },
      });

      peer.send(
        request("unsubscribe", "session/unsubscribe", { subscriptionId: "subscription-a" }),
      );
      expect(await response(peer, "unsubscribe")).toMatchObject({
        type: "success",
        result: { unsubscribed: true },
      });
      peer.send(
        request("unsubscribe-again", "session/unsubscribe", {
          subscriptionId: "subscription-a",
        }),
      );
      expect(await response(peer, "unsubscribe-again")).toMatchObject({
        type: "success",
        result: { unsubscribed: false },
      });

      peer.send(request("missing", "turn/start", { sessionId: "missing", message: "hello" }));
      expect(await response(peer, "missing")).toMatchObject({
        type: "error",
        code: "session-not-found",
      });
      peer.sendRaw(
        '{"schemaVersion":2,"requestId":"unknown","method":"session/delete","params":{}}\n',
      );
      expect(await peer.next()).toMatchObject({
        type: "error",
        requestId: "unknown",
        code: "unknown-method",
      });

      const resumed = await SocketPeer.connect(fixture.server.socketPath);
      try {
        await initialize(resumed, "resume-init");
        resumed.send(request("resume", "session/resume", { sessionId: "session-a", sinceSeq: 0 }));
        expect(await resumed.next()).toMatchObject({
          type: "success",
          requestId: "resume",
          method: "session/resume",
          result: { subscriptionId: "subscription-b", replayThroughSeq: 1 },
        });
        expect(await resumed.next()).toMatchObject({
          type: "event",
          subscriptionId: "subscription-b",
          event: { seq: 1 },
        });
      } finally {
        await resumed.close();
      }
    } finally {
      await peer.close();
      await fixture.close();
    }
  });

  test("reserves main from session/start without creating it", async () => {
    const fixture = await filesystemFixture(new ScriptedProvider([]), {
      nextSessionId: () => "main",
    });
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await initialize(peer, "init");
      peer.send(request("start", "session/start", {}));
      expect(await response(peer, "start")).toMatchObject({
        type: "error",
        requestId: "start",
        code: "internal",
      });
      expect(await runEffect(fixture.world.readSession("main", 0))).toEqual([]);
      expect(await runEffect(fixture.kernel.listSessions)).toEqual([]);
    } finally {
      await peer.close();
      await fixture.close();
    }
  });

  test("lazily ensures one stable main Session across concurrent Clients and restart", async () => {
    const profile = await createProfile("stable-main");
    const first = await filesystemFixture(new ScriptedProvider([]), { profilePath: profile });
    const left = await SocketPeer.connect(first.server.socketPath);
    const right = await SocketPeer.connect(first.server.socketPath);
    let createdAt = "";
    try {
      await Promise.all([initialize(left, "init-left"), initialize(right, "init-right")]);

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
      expect(await runEffect(first.world.readSession("main", 0))).toEqual([]);

      left.send(request("ensure-left", "session/ensure", { sessionId: "main" }));
      right.send(request("ensure-right", "session/ensure", { sessionId: "main" }));
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
      if (leftEnsure.type !== "success" || leftEnsure.method !== "session/ensure") {
        throw new Error("Expected session/ensure success");
      }
      createdAt = leftEnsure.result.session.createdAt;

      const durable = await runEffect(first.world.readSession("main", 0));
      expect(durable).toHaveLength(1);
      expect(durable[0]).toMatchObject({
        schemaVersion: 1,
        seq: 1,
        event: { type: "session-started", sessionId: "main" },
      });
    } finally {
      await left.close();
      await right.close();
      await first.close();
    }

    await runEffect(
      first.world.appendSession("main", {
        type: "turn-started",
        sessionId: "main",
        turnId: "durable-turn",
        message: "persisted before restart",
        origin: "user",
      }),
    );
    await runEffect(
      first.world.appendSession("main", {
        type: "turn-ended",
        sessionId: "main",
        turnId: "durable-turn",
        status: "completed",
      }),
    );
    const path = join(profile, "sessions", "main.ndjson");
    const beforeRestart = await readFile(path, "utf8");
    const persistedFrames = beforeRestart
      .trimEnd()
      .split("\n")
      .map((line) => decodeSessionEnvelope(`${line}\n`));
    expect(persistedFrames).toHaveLength(3);
    expect(persistedFrames.map((frame) => frame.schemaVersion)).toEqual([1, 1, 1]);

    const restarted = await filesystemFixture(new ScriptedProvider([]), { profilePath: profile });
    const peer = await SocketPeer.connect(restarted.server.socketPath);
    try {
      await initialize(peer, "restart-init");
      expect(await readFile(path, "utf8")).toBe(beforeRestart);
      peer.send(request("restart-ensure", "session/ensure", { sessionId: "main" }));
      expect(await response(peer, "restart-ensure")).toMatchObject({
        type: "success",
        result: { session: { sessionId: "main", createdAt, lastSeq: 3 } },
      });
      expect(await readFile(path, "utf8")).toBe(beforeRestart);
    } finally {
      await peer.close();
      await restarted.close();
    }
  });

  test("fans out live events and preserves a Turn across disconnect for exact replay", async () => {
    const responseBarrier = new Barrier();
    const step = textStep("completed after disconnect", 100);
    if (step.kind !== "events") throw new Error("Expected an event-producing scripted step");
    const provider = new ScriptedProvider([{ ...step, barrier: responseBarrier }]);
    const fixture = await filesystemFixture(provider);
    const first = await SocketPeer.connect(fixture.server.socketPath);
    const second = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await Promise.all([initialize(first, "init-a"), initialize(second, "init-b")]);
      first.send(request("start-session", "session/start", {}));
      await response(first, "start-session");

      await subscribeWithReplay(first, "sub-a", "session-a", "subscription-a", 0, 1);
      await subscribeWithReplay(second, "sub-b", "session-a", "subscription-b", 0, 1);

      first.send(
        request("start-turn", "turn/start", { sessionId: "session-a", message: "continue" }),
      );
      const firstStart = await responseWithEvents(first, "start-turn");
      expect(firstStart.response).toMatchObject({
        type: "success",
        method: "turn/start",
        result: { turnId: "turn-a", disposition: "started" },
      });
      await provider.waitForCalls(1);
      const beforeDisconnect = await runEffect(fixture.world.readSession("session-a", 0));
      expect(beforeDisconnect.map((envelope) => envelope.event.type)).toEqual([
        "session-started",
        "turn-started",
        "step-started",
      ]);

      await first.close();
      responseBarrier.release();
      const durable = await waitForTurnEnd(fixture.world, "session-a");
      expect(durable.at(-1)?.event).toMatchObject({
        type: "turn-ended",
        turnId: "turn-a",
        status: "completed",
      });
      attachScenarioObservations = {
        ...emptyRuntimeObservations(),
        canonicalEventTrace: observeCanonicalEvents(durable),
        providerInputs: observeProviderInputs(provider.calls),
      };

      const secondEvents = await readEvents(second, durable.length - 1);
      expect(secondEvents).toEqual(durable.slice(1));

      const reconnected = await SocketPeer.connect(fixture.server.socketPath);
      try {
        await initialize(reconnected, "init-c");
        const sinceSeq = beforeDisconnect.at(-1)?.seq ?? 0;
        const missed = durable.filter((envelope) => envelope.seq > sinceSeq);
        reconnected.send(
          request("replay", "session/subscribe", { sessionId: "session-a", sinceSeq }),
        );
        expect(await reconnected.next()).toMatchObject({
          type: "success",
          requestId: "replay",
          result: { replayThroughSeq: durable.length },
        });
        expect(await readEvents(reconnected, missed.length)).toEqual(missed);
      } finally {
        await reconnected.close();
      }
    } finally {
      await first.close();
      await second.close();
      await fixture.close();
    }
  });

  test("runs two Sessions concurrently over the real Unix socket", async () => {
    const sessionABarrier = new Barrier();
    const sessionAStep = textStep("session A completed", 100);
    if (sessionAStep.kind !== "events") {
      throw new Error("Expected an event-producing scripted step");
    }
    const provider = new ScriptedProvider([
      { ...sessionAStep, barrier: sessionABarrier },
      textStep("session B completed", 100),
    ]);
    const fixture = await filesystemFixture(provider);
    const sessionA = await SocketPeer.connect(fixture.server.socketPath);
    const sessionB = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await Promise.all([initialize(sessionA, "init-a"), initialize(sessionB, "init-b")]);
      sessionA.send(request("start-a", "session/start", {}));
      await response(sessionA, "start-a");
      sessionB.send(request("start-b", "session/start", {}));
      await response(sessionB, "start-b");
      await subscribeWithReplay(sessionA, "subscribe-a", "session-a", "subscription-a", 1, 0);
      await subscribeWithReplay(sessionB, "subscribe-b", "session-b", "subscription-b", 1, 0);

      sessionA.send(
        request("turn-a", "turn/start", { sessionId: "session-a", message: "block A" }),
      );
      await response(sessionA, "turn-a");
      await provider.waitForCalls(1);
      await sessionABarrier.entered;

      sessionB.send(
        request("turn-b", "turn/start", { sessionId: "session-b", message: "complete B" }),
      );
      const startedB = await responseWithEvents(sessionB, "turn-b");
      const sessionBEvents = await readThroughTurnEnd(sessionB, startedB.events);
      expect(sessionBEvents.map((envelope) => envelope.event.type)).toEqual([
        "turn-started",
        "step-started",
        "model-chunk",
        "model-response",
        "step-ended",
        "turn-ended",
      ]);
      expect(sessionBEvents.at(-1)?.event).toMatchObject({
        type: "turn-ended",
        sessionId: "session-b",
        status: "completed",
      });
      expect(
        (await runEffect(fixture.world.readSession("session-a", 0))).some(
          (envelope) => envelope.event.type === "turn-ended",
        ),
      ).toBeFalse();

      sessionABarrier.release();
      expect((await readThroughTurnEnd(sessionA)).at(-1)?.event).toMatchObject({
        type: "turn-ended",
        sessionId: "session-a",
        status: "completed",
      });
    } finally {
      sessionABarrier.release();
      await sessionA.close();
      await sessionB.close();
      await fixture.close();
    }
  });

  test("rejects subscribe and resume cursors beyond the durable tail while accepting the tail", async () => {
    const fixture = await filesystemFixture(new ScriptedProvider([]), {
      summaryLastSeq: Number.MAX_SAFE_INTEGER,
    });
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await initialize(peer, "init");
      peer.send(request("start-session", "session/start", {}));
      await response(peer, "start-session");

      peer.send(
        request("subscribe-beyond-tail", "session/subscribe", {
          sessionId: "session-a",
          sinceSeq: 2,
        }),
      );
      expect(await response(peer, "subscribe-beyond-tail")).toMatchObject({
        type: "error",
        code: "unsafe-sequence",
      });

      peer.send(
        request("resume-beyond-tail", "session/resume", {
          sessionId: "session-a",
          sinceSeq: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(await response(peer, "resume-beyond-tail")).toMatchObject({
        type: "error",
        code: "unsafe-sequence",
      });

      peer.send(
        request("subscribe-at-tail", "session/subscribe", {
          sessionId: "session-a",
          sinceSeq: 1,
        }),
      );
      expect(await response(peer, "subscribe-at-tail")).toMatchObject({
        type: "success",
        result: { replayThroughSeq: 1 },
      });

      peer.send(
        request("resume-at-tail", "session/resume", {
          sessionId: "session-a",
          sinceSeq: 1,
        }),
      );
      expect(await response(peer, "resume-at-tail")).toMatchObject({
        type: "success",
        result: { replayThroughSeq: 1 },
      });
    } finally {
      await peer.close();
      await fixture.close();
    }
  });

  test("orders the subscribe response, replay, and a concurrent live append without gaps", async () => {
    const provider = new ScriptedProvider([textStep("live", 100)]);
    const fixture = await memoryFixture(provider);
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await initialize(peer, "init");
      peer.send(request("start-session", "session/start", {}));
      await response(peer, "start-session");

      const replayRead = new Barrier();
      fixture.world.blockReadAfter(1, replayRead);
      peer.send(request("subscribe", "session/subscribe", { sessionId: "session-a", sinceSeq: 0 }));
      await replayRead.entered;
      peer.send(
        request("start-turn", "turn/start", { sessionId: "session-a", message: "during replay" }),
      );
      replayRead.release();

      expect(await peer.next()).toMatchObject({
        type: "success",
        requestId: "subscribe",
        result: { replayThroughSeq: 1 },
      });
      expect(await peer.next()).toMatchObject({
        type: "event",
        event: { seq: 1, event: { type: "session-started" } },
      });
      const durable = await waitForTurnEnd(fixture.world, "session-a");
      const firstEnvelope = durable[0];
      if (firstEnvelope === undefined) throw new Error("Session lost its start envelope");
      const delivered: SessionEnvelope[] = [firstEnvelope];
      let turnResponseSeen = false;
      while (delivered.length < durable.length || !turnResponseSeen) {
        const frame = await peer.next();
        if (frame.type === "event") delivered.push(frame.event);
        else if (frame.requestId === "start-turn") turnResponseSeen = true;
      }
      expect(delivered).toEqual([...durable]);
      expect(delivered.map((envelope) => envelope.seq)).toEqual(
        durable.map((envelope) => envelope.seq),
      );
    } finally {
      await peer.close();
      await fixture.close();
    }
  });

  test("terminates a connection that reuses an in-flight turn/start request id", async () => {
    const fixture = await memoryFixture(new ScriptedProvider([]));
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    const turnStartAppend = new Barrier();
    try {
      await initialize(peer, "init");
      peer.send(request("start-session", "session/start", {}));
      await response(peer, "start-session");
      fixture.world.blockNext("turn-started", turnStartAppend);
      const duplicate = request("duplicate-turn", "turn/start", {
        sessionId: "session-a",
        message: "execute once",
      });
      peer.send(duplicate);
      await turnStartAppend.entered;
      peer.send(duplicate);
      expect(await response(peer, "duplicate-turn")).toMatchObject({
        type: "error",
        code: "invalid-params",
      });
      await peer.waitForClose();
      turnStartAppend.release();
      const durable = await waitForTurnEnd(fixture.world, "session-a");
      expect(durable.filter((envelope) => envelope.event.type === "turn-started")).toHaveLength(1);
    } finally {
      turnStartAppend.release();
      await peer.close();
      await fixture.close();
    }
  });

  test("atomically rejects a colliding fresh Session id while creation is paused", async () => {
    const fixture = await memoryFixture(new ScriptedProvider([]), {
      nextSessionId: () => "colliding-session",
    });
    const first = await SocketPeer.connect(fixture.server.socketPath);
    const second = await SocketPeer.connect(fixture.server.socketPath);
    const creation = new Barrier();
    try {
      await Promise.all([initialize(first, "init-first"), initialize(second, "init-second")]);
      fixture.world.blockNext("session-started", creation);
      first.send(request("start-first", "session/start", {}));
      await creation.entered;
      second.send(request("start-second", "session/start", {}));
      expect(await response(second, "start-second")).toMatchObject({
        type: "error",
        code: "internal",
      });
      creation.release();
      expect(await response(first, "start-first")).toMatchObject({
        type: "success",
        result: { session: { sessionId: "colliding-session" } },
      });
      expect(await runEffect(fixture.world.readSession("colliding-session", 0))).toHaveLength(1);
    } finally {
      creation.release();
      await first.close();
      await second.close();
      await fixture.close();
    }
  });

  test("dispatches steer during a blocked interrupt and rejects excess in-flight work", async () => {
    const provider = new ScriptedProvider([awaitingAbortStep(100)]);
    const fixture = await memoryFixture(provider, { maxPendingRequests: 2 });
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await initialize(peer, "init");
      peer.send(request("start-session", "session/start", {}));
      await response(peer, "start-session");
      peer.send(request("start-turn", "turn/start", { sessionId: "session-a", message: "race" }));
      await response(peer, "start-turn");
      await provider.waitForCalls(1);

      peer.send(
        request("steer-before", "turn/steer", {
          sessionId: "session-a",
          expectedTurnId: "turn-a",
          message: "accepted before interrupt",
        }),
      );
      expect(await response(peer, "steer-before")).toMatchObject({
        type: "success",
        result: { turnId: "turn-a" },
      });

      const interruptAppend = new Barrier();
      fixture.world.blockNext("interrupt-received", interruptAppend);
      peer.send(
        request("interrupt", "turn/interrupt", {
          sessionId: "session-a",
          expectedTurnId: "turn-a",
        }),
      );
      await interruptAppend.entered;
      peer.send(
        request("steer", "turn/steer", {
          sessionId: "session-a",
          expectedTurnId: "turn-a",
          message: "too late",
        }),
      );
      peer.send(request("overloaded", "session/list", {}));

      expect(await peer.next()).toMatchObject({
        type: "error",
        requestId: "overloaded",
        code: "overloaded",
      });
      interruptAppend.release();
      const interrupt = await response(peer, "interrupt");
      const steer = await response(peer, "steer");
      expect(interrupt).toMatchObject({ type: "success", result: { turnId: "turn-a" } });
      expect(steer).toMatchObject({ type: "error", code: "stale-turn" });
      const durable = await waitForTurnEnd(fixture.world, "session-a");
      expect(
        durable.filter((envelope) => envelope.event.type === "interrupt-received"),
      ).toHaveLength(1);
      expect(
        durable
          .filter((envelope) => envelope.event.type === "steer-received")
          .map((envelope) =>
            envelope.event.type === "steer-received" ? envelope.event.message : "",
          ),
      ).toEqual(["accepted before interrupt"]);
    } finally {
      await peer.close();
      await fixture.close();
    }
  });

  test("fans approval resolution to every Client and makes the first response win", async () => {
    const fixture = await memoryFixture(new ScriptedProvider([]));
    const first = await SocketPeer.connect(fixture.server.socketPath);
    const second = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await Promise.all([initialize(first, "init-a"), initialize(second, "init-b")]);
      first.send(request("start-session", "session/start", {}));
      await response(first, "start-session");
      await runEffect(
        fixture.world.appendSession("session-a", {
          type: "turn-started",
          sessionId: "session-a",
          turnId: "turn-approval",
          message: "guarded work",
          origin: "user",
        }),
      );
      await runEffect(
        fixture.world.appendSession("session-a", approvalRequested("Approve guarded work?")),
      );
      await subscribeWithReplay(first, "sub-a", "session-a", "subscription-a", 0, 3);
      await subscribeWithReplay(second, "sub-b", "session-a", "subscription-b", 0, 3);

      const resolutionAppend = new Barrier();
      fixture.world.blockNext("approval-resolved", resolutionAppend);
      first.send(
        request("approve", "approval/resolve", {
          sessionId: "session-a",
          approvalId: "approval-a",
          decision: "approve",
        }),
      );
      await resolutionAppend.entered;
      second.send(
        request("deny", "approval/resolve", {
          sessionId: "session-a",
          approvalId: "approval-a",
          decision: "deny",
        }),
      );
      resolutionAppend.release();

      const firstResolution = await responseWithEvents(first, "approve");
      const secondResolution = await responseWithEvents(second, "deny");
      expect(firstResolution.response).toMatchObject({
        type: "success",
        result: { outcome: "resolved" },
      });
      expect(secondResolution.response).toMatchObject({
        type: "success",
        result: { outcome: "already-resolved" },
      });
      for (const delivered of [firstResolution.events, secondResolution.events]) {
        expect(delivered).toEqual([
          expect.objectContaining({
            event: expect.objectContaining({
              event: {
                type: "approval-resolved",
                sessionId: "session-a",
                turnId: "turn-approval",
                approvalId: "approval-a",
                decision: "approve",
              },
            }),
          }),
        ]);
      }

      second.send(
        request("late", "approval/resolve", {
          sessionId: "session-a",
          approvalId: "approval-a",
          decision: "deny",
        }),
      );
      expect(await response(second, "late")).toMatchObject({
        type: "success",
        result: { outcome: "already-resolved" },
      });
      expect(
        (await runEffect(fixture.world.readSession("session-a", 0))).filter(
          (envelope) => envelope.event.type === "approval-resolved",
        ),
      ).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
      await fixture.close();
    }
  });

  test("disconnects only the connection that exceeds its outbound byte budget", async () => {
    const fixture = await memoryFixture(new ScriptedProvider([]), { maxOutboundBytes: 300 });
    const healthy = await SocketPeer.connect(fixture.server.socketPath);
    const slow = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await Promise.all([initialize(healthy, "healthy-init"), initialize(slow, "slow-init")]);
      healthy.send(request("start-session", "session/start", {}));
      await response(healthy, "start-session");
      await runEffect(
        fixture.world.appendSession("session-a", {
          type: "turn-started",
          sessionId: "session-a",
          turnId: "turn-approval",
          message: "guarded work",
          origin: "user",
        }),
      );
      await subscribeWithReplay(healthy, "bounded-replay", "session-a", "subscription-a", 0, 2);
      healthy.send(
        request("bounded-unsubscribe", "session/unsubscribe", {
          subscriptionId: "subscription-a",
        }),
      );
      expect(await response(healthy, "bounded-unsubscribe")).toMatchObject({
        type: "success",
        result: { unsubscribed: true },
      });
      await runEffect(
        fixture.world.appendSession("session-a", approvalRequested("x".repeat(1024))),
      );

      slow.send(
        request("oversized-replay", "session/subscribe", {
          sessionId: "session-a",
          sinceSeq: 0,
        }),
      );
      await slow.waitForClose();

      healthy.send(request("still-healthy", "session/list", {}));
      expect(await response(healthy, "still-healthy")).toMatchObject({
        type: "success",
        result: { sessions: [{ sessionId: "session-a", lastSeq: 3 }] },
      });
    } finally {
      await healthy.close();
      await slow.close();
      await fixture.close();
    }
  });

  test("stops a paced replay when the Client unsubscribes", async () => {
    const fixture = await memoryFixture(new ScriptedProvider([]));
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    try {
      await initialize(peer, "init");
      peer.send(request("start-session", "session/start", {}));
      await response(peer, "start-session");
      const replayEvents = 5_000;
      for (let index = 0; index < replayEvents; index += 1) {
        await runEffect(
          fixture.world.appendSession("session-a", {
            type: "model-chunk",
            sessionId: "session-a",
            turnId: "turn-replay",
            stepId: "step-replay",
            contentIndex: 0,
            kind: "text",
            delta: `${index}-${"x".repeat(256)}`,
          }),
        );
      }

      peer.send(request("subscribe", "session/subscribe", { sessionId: "session-a", sinceSeq: 0 }));
      expect(await peer.next()).toMatchObject({
        type: "success",
        requestId: "subscribe",
        result: { subscriptionId: "subscription-a", replayThroughSeq: replayEvents + 1 },
      });
      peer.send(
        request("unsubscribe", "session/unsubscribe", { subscriptionId: "subscription-a" }),
      );
      const unsubscribed = await responseWithEvents(peer, "unsubscribe");
      expect(unsubscribed.response).toMatchObject({
        type: "success",
        result: { unsubscribed: true },
      });
      expect(unsubscribed.events.length).toBeLessThan(replayEvents + 1);

      peer.send(request("after-unsubscribe", "session/list", {}));
      const after = await responseWithEvents(peer, "after-unsubscribe");
      expect(after.events).toHaveLength(0);
      expect(after.response).toMatchObject({ type: "success", method: "session/list" });
    } finally {
      await peer.close();
      await fixture.close();
    }
  });

  test("closes after disconnecting a Client with a subscription request in flight", async () => {
    const fixture = await memoryFixture(new ScriptedProvider([]));
    const peer = await SocketPeer.connect(fixture.server.socketPath);
    const replayRead = new Barrier();
    try {
      await initialize(peer, "init");
      peer.send(request("start-session", "session/start", {}));
      await response(peer, "start-session");

      fixture.world.blockReadAfter(1, replayRead);
      peer.send(request("subscribe", "session/subscribe", { sessionId: "session-a", sinceSeq: 0 }));
      await replayRead.entered;

      const serverClosed = runEffect(fixture.server.close);
      const firstSettled = await Promise.race([
        serverClosed.then(() => "server"),
        peer.waitForClose().then(() => "peer"),
      ]);
      expect(firstSettled).toBe("peer");

      replayRead.release();
      await serverClosed;
    } finally {
      replayRead.release();
      await peer.close();
      await fixture.close();
    }
  });
});

afterAll(async () => {
  await Promise.all(profiles.map((path) => rm(path, { recursive: true, force: true })));
  emitVerificationObservation("s2.attach-socket", attachScenarioObservations);
});

interface Fixture<WorldError, World extends DaemonWorld<WorldError>, KernelError> {
  readonly world: World;
  readonly kernel: DaemonKernel<KernelError>;
  readonly server: AttachServer;
  close(): Promise<void>;
}

interface FilesystemFixtureOptions {
  readonly profilePath?: string;
  readonly summaryLastSeq?: number;
  readonly nextSessionId?: () => string;
}

async function filesystemFixture(
  provider: ScriptedProvider,
  options: FilesystemFixtureOptions = {},
) {
  const profile = options.profilePath ?? (await createProfile("filesystem"));
  let milliseconds = Date.parse("2026-07-20T00:00:00.000Z");
  let world: FilesystemWorld | undefined;
  const turnIds = new SequenceIds(["turn-a", "turn-b"]);
  const stepIds = new SequenceIds(["step-a", "step-b"]);
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld(profilePath) {
        const created = createFilesystemWorld({
          profilePath,
          now() {
            const value = new Date(milliseconds);
            milliseconds += 1;
            return value;
          },
        });
        world = created;
        return created;
      },
      createRuntime(sessionId, filesystemWorld) {
        return createFilesystemSessionRuntime({
          sessionId,
          world: filesystemWorld,
          baseSystemPrompt: SNAPSHOT.systemPrompt,
          tools: [],
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => turnIds.next(),
          nextStepId: () => stepIds.next(),
        });
      },
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  const sessionIds = new SequenceIds(["session-a", "session-b"]);
  const subscriptionIds = new SequenceIds([
    "subscription-a",
    "subscription-b",
    "subscription-c",
    "subscription-d",
  ]);
  const attachKernel: DaemonKernel<unknown> = {
    profilePath: kernel.profilePath,
    createSession: (sessionId) => kernel.createSession(sessionId),
    getOrCreateSession: (sessionId) => kernel.getOrCreateSession(sessionId),
    ensureMainSession: () => kernel.ensureMainSession(),
    getSessionSummary: (sessionId) =>
      kernel
        .getSessionSummary(sessionId)
        .pipe(
          Effect.map((summary) =>
            summary === undefined || options.summaryLastSeq === undefined
              ? summary
              : { ...summary, lastSeq: options.summaryLastSeq },
          ),
        ),
    listSessions: kernel.listSessions,
    close: kernel.close,
  };
  const server = await runEffect(
    createAttachServer({
      kernel: attachKernel,
      nextSessionId: options.nextSessionId ?? (() => sessionIds.next()),
      nextSubscriptionId: () => subscriptionIds.next(),
    }),
  );
  if (world === undefined) throw new Error("Daemon kernel did not create its World");
  return fixture(world, kernel, server);
}

interface MemoryFixtureOptions {
  readonly maxPendingRequests?: number;
  readonly maxOutboundBytes?: number;
  readonly nextSessionId?: () => string;
}

async function memoryFixture(provider: ScriptedProvider, options: MemoryFixtureOptions = {}) {
  const profile = await createProfile("memory");
  const world = new MemoryDaemonWorld();
  const turnIds = new SequenceIds(["turn-a", "turn-b"]);
  const stepIds = new SequenceIds(["step-a", "step-b"]);
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: () => world,
      createRuntime(sessionId, daemonWorld) {
        return createSessionRuntime({
          sessionId,
          snapshot: SNAPSHOT,
          world: daemonWorld,
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => turnIds.next(),
          nextStepId: () => stepIds.next(),
          tools: [],
        });
      },
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  const sessionIds = new SequenceIds(["session-a", "session-b"]);
  const subscriptionIds = new SequenceIds([
    "subscription-a",
    "subscription-b",
    "subscription-c",
    "subscription-d",
  ]);
  const server = await runEffect(
    createAttachServer({
      kernel,
      nextSessionId: options.nextSessionId ?? (() => sessionIds.next()),
      nextSubscriptionId: () => subscriptionIds.next(),
      ...(options.maxPendingRequests === undefined
        ? {}
        : { maxPendingRequests: options.maxPendingRequests }),
      ...(options.maxOutboundBytes === undefined
        ? {}
        : { maxOutboundBytes: options.maxOutboundBytes }),
    }),
  );
  return fixture(world, kernel, server);
}

function fixture<WorldError, World extends DaemonWorld<WorldError>, KernelError>(
  world: World,
  kernel: DaemonKernel<KernelError>,
  server: AttachServer,
): Fixture<WorldError, World, KernelError> {
  let closing: Promise<void> | undefined;
  return {
    world,
    kernel,
    server,
    close() {
      closing ??= runEffect(server.close.pipe(Effect.andThen(kernel.close)));
      return closing;
    },
  };
}

class MemoryDaemonWorld implements DaemonWorld<SessionRuntimeError> {
  private readonly sessions = new Map<string, SessionEnvelope[]>();
  private milliseconds = Date.parse("2026-07-20T00:00:00.000Z");
  private blockedType: SessionEvent["type"] | undefined;
  private appendBarrier: Barrier | undefined;
  private readsBeforeBlock: number | undefined;
  private readBarrier: Barrier | undefined;

  blockNext(type: SessionEvent["type"], barrier: Barrier): void {
    this.blockedType = type;
    this.appendBarrier = barrier;
  }

  blockReadAfter(readsBeforeBlock: number, barrier: Barrier): void {
    this.readsBeforeBlock = readsBeforeBlock;
    this.readBarrier = barrier;
  }

  appendSession(sessionId: string, event: SessionEvent) {
    return Effect.gen({ self: this }, function* () {
      if (event.type === this.blockedType) {
        const barrier = this.appendBarrier;
        this.blockedType = undefined;
        this.appendBarrier = undefined;
        if (barrier !== undefined) {
          yield* Effect.tryPromise({
            try: () => barrier.wait(),
            catch: (cause) =>
              new SessionRuntimeError({ message: "Fixture append barrier failed", cause }),
          });
        }
      }
      if (event.sessionId !== sessionId) {
        return yield* new SessionRuntimeError({ message: "Event does not match Session" });
      }
      const stored = this.sessions.get(sessionId) ?? [];
      const envelope: SessionEnvelope = {
        schemaVersion: 1,
        seq: stored.length + 1,
        emittedAt: new Date(this.milliseconds).toISOString(),
        event: structuredClone(event),
      };
      this.milliseconds += 1;
      stored.push(envelope);
      this.sessions.set(sessionId, stored);
      return structuredClone(envelope);
    });
  }

  readSession(sessionId: string, afterSeq: number) {
    return Effect.gen({ self: this }, function* () {
      if (this.readsBeforeBlock !== undefined) {
        if (this.readsBeforeBlock === 0) {
          const barrier = this.readBarrier;
          this.readsBeforeBlock = undefined;
          this.readBarrier = undefined;
          if (barrier !== undefined) {
            yield* Effect.tryPromise({
              try: () => barrier.wait(),
              catch: (cause) =>
                new SessionRuntimeError({ message: "Fixture read barrier failed", cause }),
            });
          }
        } else {
          this.readsBeforeBlock -= 1;
        }
      }
      return structuredClone(
        (this.sessions.get(sessionId) ?? []).filter((envelope) => envelope.seq > afterSeq),
      );
    });
  }

  readonly listSessions = Effect.sync(() =>
    [...this.sessions.entries()].map(([sessionId, envelopes]) => ({
      sessionId,
      lastSeq: envelopes.length,
    })),
  );
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
    socket.on("error", () => {});
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
    return Promise.race([
      waiter.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("Timed out waiting for attach frame");
      }),
    ]);
  }

  waitForClose(): Promise<void> {
    if (this.socket.destroyed) return Promise.resolve();
    return Promise.race([
      this.closed.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error("Timed out waiting for socket close");
      }),
    ]);
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

function clientIdentity(): Extract<
  ClientRequestFrame,
  { readonly method: "initialize" }
>["params"] {
  return { client: { name: "socket-test", version: "1.0.0" }, features: [] };
}

async function initialize(peer: SocketPeer, requestId: string): Promise<void> {
  peer.send(request(requestId, "initialize", clientIdentity()));
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
  return (await responseWithEvents(peer, requestId)).response;
}

async function responseWithEvents(
  peer: SocketPeer,
  requestId: string,
): Promise<{ readonly response: ServerFrame; readonly events: ReadonlyArray<ServerFrame> }> {
  const events: ServerFrame[] = [];
  while (true) {
    const frame = await peer.next();
    if (frame.type !== "event" && frame.requestId === requestId) {
      return { response: frame, events };
    }
    events.push(frame);
  }
}

async function subscribeWithReplay(
  peer: SocketPeer,
  requestId: string,
  sessionId: string,
  subscriptionId: string,
  sinceSeq: number,
  replayCount: number,
): Promise<void> {
  peer.send(request(requestId, "session/subscribe", { sessionId, sinceSeq }));
  expect(await peer.next()).toMatchObject({
    type: "success",
    requestId,
    method: "session/subscribe",
    result: { subscriptionId },
  });
  expect(await readEvents(peer, replayCount)).toHaveLength(replayCount);
}

async function readEvents(
  peer: SocketPeer,
  count: number,
): Promise<ReadonlyArray<SessionEnvelope>> {
  const events: SessionEnvelope[] = [];
  while (events.length < count) {
    const frame = await peer.next();
    if (frame.type !== "event") throw new Error("Expected a Session event frame");
    events.push(frame.event);
  }
  return events;
}

async function readThroughTurnEnd(
  peer: SocketPeer,
  initialFrames: ReadonlyArray<ServerFrame> = [],
): Promise<ReadonlyArray<SessionEnvelope>> {
  const events = initialFrames
    .filter((frame) => frame.type === "event")
    .map((frame) => frame.event);
  while (!events.some((envelope) => envelope.event.type === "turn-ended")) {
    const frame = await peer.next();
    if (frame.type !== "event") throw new Error("Expected a live Session event frame");
    events.push(frame.event);
  }
  return events;
}

async function waitForTurnEnd(
  world: Pick<DaemonWorld<unknown>, "readSession">,
  sessionId: string,
): Promise<ReadonlyArray<SessionEnvelope>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const envelopes = await runEffect(world.readSession(sessionId, 0));
    if (envelopes.some((envelope) => envelope.event.type === "turn-ended")) return envelopes;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for durable turn-ended");
}

function approvalRequested(prompt: string): SessionEvent {
  return {
    type: "approval-requested",
    sessionId: "session-a",
    turnId: "turn-approval",
    approvalId: "approval-a",
    toolCallId: "call-a",
    prompt,
    choices: ["approve", "deny"],
  };
}

async function createProfile(label: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-s2-${label}-`));
  profiles.push(profile);
  return profile;
}
