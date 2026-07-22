import { afterAll, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  ProfileLockCoordinator,
  SessionRuntimeError,
  type SessionTool,
} from "../../packages/core/src/index.ts";
import {
  decodeClientRequest,
  decodeServerFrame,
  encodeServerFrame,
  PROTOCOL_VERSION,
} from "../../packages/protocol/src/index.ts";
import type {
  ApprovalDecision,
  ClientRequestFrame,
  SessionEnvelope,
  SessionEvent,
  SessionSummary,
  ServerFrame,
} from "../../packages/protocol/src/index.ts";
import {
  createInitialState,
  intentFromInput,
  ZiggyTuiComponent,
  type TuiAction,
  type TuiCommand,
  type ZiggyTuiHost,
  reduceTui,
  renderTui,
  type TuiState,
  type TuiTransition,
} from "../../packages/tui/src/index.ts";
import { createAttachClient } from "../../packages/ziggy/src/attach-client.ts";
import { unixAttachTransportFactory } from "../../packages/ziggy/src/attach-transport.ts";
import { runProductionTui, type CliDaemonSetup } from "../../packages/ziggy/src/cli-client.ts";
import type { TuiHostFactory } from "../../packages/ziggy/src/tui-client.ts";
import { runEffect } from "../testkit/effect.ts";
import { Barrier } from "../testkit/barrier.ts";
import {
  awaitingAbortStep,
  ScriptedProvider,
  textStep,
  toolStep,
  type ScriptedStep,
} from "../testkit/provider/scripted.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  observeProviderInputs,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

const main: SessionSummary = {
  sessionId: "main",
  createdAt: "2026-07-21T03:00:00.000Z",
  lastSeq: 1,
};
const other: SessionSummary = {
  sessionId: "research",
  createdAt: "2026-07-21T02:00:00.000Z",
  lastSeq: 9,
};
const applied: SessionEnvelope[] = [];
const temporaryDirectories: string[] = [];
let liveObservations: RuntimeObservations = emptyRuntimeObservations();

test("protocol-only TUI maps exact controls to Client commands", () => {
  expect([
    intentFromInput("\r"),
    intentFromInput("\x1b\r"),
    intentFromInput("\x1bOQ"),
    intentFromInput("\x18"),
    intentFromInput("\x10"),
    intentFromInput("\x1b"),
    intentFromInput("\x03"),
  ]).toEqual(["enter", "follow-up", "follow-up", "interrupt", "sessions", "dismiss", "detach"]);

  let transition = reduceTui(createInitialState(), { type: "main-ensured", session: main });
  expect(transition.commands).toEqual([
    { type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 0 },
  ]);
  transition = reduceTui(transition.state, {
    type: "command-admitted",
    command: transition.commands[0] ?? { type: "ensure-main" },
  });
  transition = reduceTui(transition.state, {
    type: "replay-started",
    generation: transition.state.resumeGeneration,
    session: main,
    replayThroughSeq: 1,
  });
  transition = apply(
    transition.state,
    envelope(1, {
      type: "session-started",
      sessionId: "main",
      snapshot: { systemPrompt: "fixture", tools: [] },
    }),
  );
  transition = reduceTui(transition.state, { type: "composer-changed", value: "start once" });
  transition = reduceTui(transition.state, { type: "intent", intent: "enter" });
  expect(transition.commands).toEqual([
    {
      type: "start-turn",
      generation: 1,
      request: { sessionId: "main", message: "start once" },
    },
  ]);

  transition = apply(
    transition.state,
    envelope(2, {
      type: "turn-started",
      sessionId: "main",
      turnId: "turn-1",
      message: "start once",
      origin: "user",
    }),
  );
  transition = reduceTui(transition.state, { type: "composer-changed", value: "steer now" });
  transition = reduceTui(transition.state, { type: "intent", intent: "enter" });
  expect(transition.commands).toEqual([
    {
      type: "steer-turn",
      generation: 1,
      request: { sessionId: "main", expectedTurnId: "turn-1", message: "steer now" },
    },
  ]);

  for (const input of ["\x1b\r", "\x1bOQ"]) {
    transition = reduceTui(transition.state, { type: "composer-changed", value: "queue next" });
    const intent = intentFromInput(input);
    expect(intent).toBe("follow-up");
    transition = reduceTui(transition.state, { type: "intent", intent: "follow-up" });
    expect(transition.commands).toEqual([
      {
        type: "queue-follow-up",
        generation: 1,
        request: { sessionId: "main", message: "queue next" },
      },
    ]);
  }

  transition = reduceTui(transition.state, { type: "intent", intent: "interrupt" });
  expect(transition.commands).toEqual([
    {
      type: "interrupt-turn",
      generation: 1,
      request: { sessionId: "main", expectedTurnId: "turn-1" },
    },
  ]);
  transition = reduceTui(transition.state, { type: "intent", intent: "sessions" });
  expect(transition.commands).toEqual([{ type: "list-sessions" }]);
  expect(transition.state.overlay.kind).toBe("sessions");
  transition = reduceTui(transition.state, { type: "intent", intent: "dismiss" });
  expect(transition.commands).toEqual([]);
  expect(transition.state.overlay.kind).toBe("none");
});

test("production TUI adapter streams a Turn over the real attach socket and detaches cleanly", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s3-tui-live-"));
  temporaryDirectories.push(profile);
  const provider = new ScriptedProvider([textStep("real socket response", 1)]);
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: (canonicalProfilePath) =>
        createFilesystemWorld({ profilePath: canonicalProfilePath }),
      createRuntime: (sessionId, world) =>
        createFilesystemSessionRuntime({
          sessionId,
          world,
          baseSystemPrompt: "You are Ziggy.",
          tools: [],
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => "tui-turn",
          nextStepId: () => "tui-step",
        }),
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  const server = await runEffect(
    createAttachServer({
      kernel,
      nextSubscriptionId: () => "tui-subscription",
    }),
  );
  const setup: CliDaemonSetup = {
    probe: () =>
      Effect.succeed({
        status: "ready",
        profilePath: profile,
        socketPath: server.socketPath,
        protocolVersion: 2,
      }),
    startAbsent: () => Effect.never,
  };
  const actions: TuiAction[] = [];
  const commands: TuiCommand[] = [];
  let submitted = false;
  const hostFactory: TuiHostFactory = (emit) =>
    Effect.acquireRelease(
      Effect.sync((): ZiggyTuiHost => {
        const component = new ZiggyTuiComponent({
          state: createInitialState(),
          emit: (command) => {
            commands.push(command);
            emit(command);
          },
        });
        return {
          dispatch: (action) => {
            actions.push(action);
            component.dispatch(action);
            if (
              !submitted &&
              action.type === "envelope-received" &&
              component.currentState.connection.kind === "live"
            ) {
              submitted = true;
              component.dispatch({ type: "composer-changed", value: "run once" });
              component.handleInput("\r");
            }
            if (
              action.type === "envelope-received" &&
              action.envelope.event.type === "turn-ended"
            ) {
              component.requestQuit();
            }
          },
          stop: () => undefined,
        };
      }),
      () => Effect.void,
    );

  await runEffect(runProductionTui(profile, setup, hostFactory));
  expect(provider.calls).toHaveLength(1);
  expect(commands.filter((command) => command.type === "start-turn")).toHaveLength(1);
  expect(commands.at(-1)).toEqual({ type: "detach" });
  expect(actions.some((action) => action.type === "envelope-received")).toBeTrue();
  await runEffect(server.close.pipe(Effect.andThen(kernel.close)));
});

test("production TUI applies a replay larger than every default bounded queue without loss", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s3-tui-backpressure-"));
  temporaryDirectories.push(profile);
  const replayServer = await createReplayPressureServer();
  const setup: CliDaemonSetup = {
    probe: () =>
      Effect.succeed({
        status: "ready",
        profilePath: profile,
        socketPath: replayServer.socketPath,
        protocolVersion: 2,
      }),
    startAbsent: () => Effect.never,
  };
  const host = new LiveTuiHarness();
  const run = runEffect(runProductionTui(profile, setup, host.factory));
  await host.waitFor((action) => action.type === "envelope-received" && action.envelope.seq === 1);
  replayServer.sendTail();
  await host.waitFor(
    (action) => action.type === "envelope-received" && action.envelope.seq === 900,
  );
  await host.waitForLive("main");
  host.component.requestQuit();
  await run;

  const sequences = host.actions
    .filter((action) => action.type === "envelope-received")
    .map((action) => (action.type === "envelope-received" ? action.envelope.seq : 0));
  expect(sequences).toEqual(Array.from({ length: 900 }, (_, index) => index + 1));
  expect(new Set(sequences).size).toBe(900);
  expect(host.actions.filter((action) => action.type === "failure")).toEqual([]);
  expect(host.component.currentState.connection.kind).toBe("live");
  await replayServer.close();
}, 20_000);

test("production TUI reconnects after the Unix listener is absent for one second", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s3-tui-restart-"));
  temporaryDirectories.push(profile);
  const provider = new ScriptedProvider([
    textStep("survives listener restart", 1),
    textStep("created while listener is absent", 2),
  ]);
  let restartTurnSequence = 0;
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: (canonicalProfilePath) =>
        createFilesystemWorld({ profilePath: canonicalProfilePath }),
      createRuntime: (sessionId, world) =>
        createFilesystemSessionRuntime({
          sessionId,
          world,
          baseSystemPrompt: "You are Ziggy.",
          tools: [],
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => (restartTurnSequence++ === 0 ? "restart-turn" : "offline-restart-turn"),
          nextStepId: () => "restart-step",
        }),
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  let server = await runEffect(
    createAttachServer({ kernel, nextSubscriptionId: subscriptionSequence("restart-tui") }),
  );
  let proxy = await createAttachProxy(server.socketPath);
  const listenerPath = proxy.socketPath;
  const setup: CliDaemonSetup = {
    probe: () =>
      Effect.succeed({
        status: "ready",
        profilePath: profile,
        socketPath: listenerPath,
        protocolVersion: 2,
      }),
    startAbsent: () => Effect.never,
  };
  const host = new LiveTuiHarness();
  const run = runEffect(runProductionTui(profile, setup, host.factory));
  await host.waitForLive("main");
  host.submit("run exactly once", "\r");
  await host.waitFor(eventAction("turn-ended", "restart-turn"));
  const lastAppliedBeforeRestart = requiredEnvelopeSeq(
    host.actions.filter(isEnvelopeEvent("turn-ended", "restart-turn")).at(-1),
  );
  expect(lastAppliedBeforeRestart).toBeNumber();
  host.component.dispatch({ type: "composer-changed", value: "preserved during restart" });

  const reconnectStart = host.actions.length;
  proxy.disconnectCurrent();
  await proxy.close();
  await runEffect(server.close);
  await expect(access(listenerPath)).rejects.toThrow();
  await host.waitFor((action) => action.type === "connection-lost", reconnectStart);
  const runtime = await runEffect(kernel.getOrCreateSession("main"));
  await runEffect(
    runtime
      .startTurn({ message: "created without a listener" })
      .pipe(Effect.andThen(runtime.waitForIdle)),
  );
  const offlineDurable = await runEffect(
    createFilesystemWorld({ profilePath: profile }).readSession("main", lastAppliedBeforeRestart),
  );
  const offlineSeq = requiredSessionEnvelopeSeq(
    offlineDurable.filter((entry) => entry.event.type === "turn-ended").at(-1),
  );
  await host.waitFor(
    (action) => action.type === "retry-started" && action.attempt >= 2,
    reconnectStart,
  );
  await Bun.sleep(1_000);
  await expect(access(listenerPath)).rejects.toThrow();
  server = await runEffect(
    createAttachServer({ kernel, nextSubscriptionId: subscriptionSequence("restarted-tui") }),
  );
  proxy = await createAttachProxy(server.socketPath, listenerPath);
  await host.waitFor((action) => action.type === "replay-started", reconnectStart);
  await host.waitForLive("main");

  expect(
    host.actions
      .slice(reconnectStart)
      .filter((action) => action.type === "retry-started")
      .map((action) => (action.type === "retry-started" ? action.attempt : 0)),
  ).toEqual([1, 2, 3, 4, 5]);
  expect(proxy.subscribeCursors("main")).toEqual([lastAppliedBeforeRestart]);
  expect(host.component.currentState.composer).toBe("preserved during restart");
  expect(host.component.currentState.connection.kind).toBe("live");
  expect(provider.calls).toHaveLength(2);
  expect(
    host.commands.filter(
      (command) => command.type === "start-turn" && command.request.message === "run exactly once",
    ),
  ).toHaveLength(1);
  const durable = await runEffect(
    createFilesystemWorld({ profilePath: profile }).readSession("main", 0),
  );
  expect(
    durable.filter(
      (entry) => entry.event.type === "turn-started" && entry.event.turnId === "restart-turn",
    ),
  ).toHaveLength(1);
  const reconnectedSeqs = host.actions
    .slice(reconnectStart)
    .filter((action) => action.type === "envelope-received")
    .map((action) => (action.type === "envelope-received" ? action.envelope.seq : 0));
  expect(reconnectedSeqs).toEqual(offlineDurable.map((entry) => entry.seq));
  expect(reconnectedSeqs.filter((seq) => seq === offlineSeq)).toEqual([offlineSeq]);
  expect(reconnectedSeqs.filter((seq) => seq <= lastAppliedBeforeRestart)).toEqual([]);

  host.component.requestQuit();
  await run;
  await proxy.close();
  await runEffect(server.close.pipe(Effect.andThen(kernel.close)));
}, 10_000);

test("production TUI closes the live Client contract over faulted real sockets", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s3-tui-contract-"));
  temporaryDirectories.push(profile);
  let milliseconds = Date.parse("2026-07-21T05:00:00.000Z");
  const world = createFilesystemWorld({
    profilePath: profile,
    now: () => {
      const value = new Date(milliseconds);
      milliseconds += 1;
      return value;
    },
  });

  const approveTurnBarrier = new Barrier();
  const denyTurnBarrier = new Barrier();
  const reconnectProviderBarrier = new Barrier();
  const quitProviderBarrier = new Barrier();
  const ctrlCProviderBarrier = new Barrier();
  const provider = new ScriptedProvider([
    splitTextStep(["token ", "by ", "token"], 10),
    awaitingAbortStep(20),
    withEventBarrier(
      splitTextStep(["completed ", "after ", "reconnect"], 30),
      3,
      reconnectProviderBarrier,
    ),
    withBarrier(textStep("completed after quit", 40), quitProviderBarrier),
    withBarrier(textStep("completed after ctrl-c", 50), ctrlCProviderBarrier),
  ]);
  const approveProvider = approvalProvider("approve-session", 60);
  const denyProvider = approvalProvider("deny-session", 70);
  let turnSequence = 0;
  let stepSequence = 0;
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: () => world,
      createRuntime: (sessionId, sessionWorld) => {
        const sessionProvider =
          sessionId === "approve-session"
            ? approveProvider
            : sessionId === "deny-session"
              ? denyProvider
              : provider;
        return createFilesystemSessionRuntime({
          sessionId,
          world: sessionWorld,
          baseSystemPrompt: "You are Ziggy.",
          tools: sessionId.endsWith("-session")
            ? [
                approvalTool(
                  sessionWorld,
                  sessionId,
                  sessionId === "approve-session" ? approveTurnBarrier : denyTurnBarrier,
                ),
              ]
            : [],
          model: sessionProvider.model,
          streamSimple: sessionProvider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () =>
            sessionId.endsWith("-session") ? "approval-turn" : `tui-turn-${++turnSequence}`,
          nextStepId: () => `tui-step-${++stepSequence}`,
        });
      },
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  await runEffect(kernel.createSession("approve-session"));
  await runEffect(kernel.createSession("deny-session"));
  await runEffect(kernel.createSession("research"));
  const server = await runEffect(
    createAttachServer({ kernel, nextSubscriptionId: subscriptionSequence("live-tui") }),
  );
  await startTurnFromRemoteClient(server.socketPath, "approve-session", "request approval");
  await approveTurnBarrier.entered;
  await startTurnFromRemoteClient(server.socketPath, "deny-session", "request approval");
  await denyTurnBarrier.entered;
  const proxy = await createAttachProxy(server.socketPath);
  const setup: CliDaemonSetup = {
    probe: () =>
      Effect.succeed({
        status: "ready",
        profilePath: profile,
        socketPath: proxy.socketPath,
        protocolVersion: 2,
      }),
    startAbsent: () => Effect.never,
  };

  const firstHost = new LiveTuiHarness();
  const firstRun = runEffect(runProductionTui(profile, setup, firstHost.factory));
  await firstHost.waitForLive("main");
  expect(proxy.subscribeCursors("main")).toEqual([0]);
  firstHost.submit("stream tokens", "\r");
  await firstHost.waitFor(eventAction("turn-ended", "tui-turn-1"));
  expect(
    firstHost.actions
      .filter(isEnvelopeEvent("model-chunk", "tui-turn-1"))
      .map((action) =>
        action.type === "envelope-received" && action.envelope.event.type === "model-chunk"
          ? action.envelope.event.delta
          : "",
      ),
  ).toEqual(["token ", "by ", "token"]);
  expect(firstHost.assistantText("tui-turn-1")).toBe("token by token");

  firstHost.submit("control active turn", "\r");
  await provider.waitForCalls(2);
  await firstHost.waitFor(eventAction("turn-started", "tui-turn-2"));
  firstHost.submit("steer while active", "\r");
  await firstHost.waitFor(eventAction("steer-received", "tui-turn-2"));
  firstHost.submit("queued follow-up", "\x1b\r");
  await firstHost.waitFor(eventAction("follow-up-received", "tui-turn-2"));
  firstHost.component.handleInput("\x18");
  await firstHost.waitFor(eventAction("turn-ended", "tui-turn-2"));
  await firstHost.waitFor(eventAction("turn-started", "tui-turn-3"));
  expect(
    firstHost.actions
      .filter(isEnvelopeEvent("turn-started", "tui-turn-3"))
      .map((action) => action.envelope.event),
  ).toEqual([
    {
      type: "turn-started",
      sessionId: "main",
      turnId: "tui-turn-3",
      message: "queued follow-up",
      origin: "follow-up",
    },
  ]);
  expect(
    firstHost.actions
      .filter(isEnvelopeEvent("turn-ended", "tui-turn-2"))
      .map((action) => action.envelope.event),
  ).toEqual([
    {
      type: "turn-ended",
      sessionId: "main",
      turnId: "tui-turn-2",
      status: "interrupted",
    },
  ]);
  expect(firstHost.commands.map((command) => command.type)).toEqual(
    expect.arrayContaining(["start-turn", "steer-turn", "queue-follow-up", "interrupt-turn"]),
  );
  expect(
    firstHost.actions.filter(isEnvelopeEvent("follow-up-received", "tui-turn-2")),
  ).toHaveLength(1);
  expect(
    firstHost.commands.filter(
      (command) =>
        command.type === "queue-follow-up" && command.request.message === "queued follow-up",
    ),
  ).toHaveLength(1);

  const unsubscribesBeforeRoundTrip = proxy.requestCount("session/unsubscribe");
  proxy.captureNextSessionEvent("research");
  await firstHost.switchTo("research");
  await firstHost.switchTo("main");
  expect(proxy.requestCount("session/unsubscribe")).toBe(unsubscribesBeforeRoundTrip + 2);

  await firstHost.switchTo("approve-session");
  await firstHost.waitFor(eventAction("approval-requested", "approval-turn", "approve-session"));
  firstHost.component.handleInput("a");
  await firstHost.waitFor(eventAction("approval-resolved", "approval-turn", "approve-session"));
  expect(
    await resolveApprovalFromRemoteClient(
      server.socketPath,
      "approve-session",
      "approval-approve",
      "deny",
    ),
  ).toBe("already-resolved");
  approveTurnBarrier.release();
  await runEffect((await runEffect(kernel.getOrCreateSession("approve-session"))).waitForIdle);

  await firstHost.switchTo("deny-session");
  await firstHost.waitFor(eventAction("approval-requested", "approval-turn", "deny-session"));
  const localApprovalCommands = firstHost.commands.filter(
    (command) => command.type === "resolve-approval",
  ).length;
  expect(
    await resolveApprovalFromRemoteClient(
      server.socketPath,
      "deny-session",
      "approval-deny",
      "deny",
    ),
  ).toBe("resolved");
  await firstHost.waitFor(eventAction("approval-resolved", "approval-turn", "deny-session"));
  expect(firstHost.component.currentState.overlay.kind).toBe("none");
  expect(firstHost.commands.filter((command) => command.type === "resolve-approval")).toHaveLength(
    localApprovalCommands,
  );
  denyTurnBarrier.release();
  await runEffect((await runEffect(kernel.getOrCreateSession("deny-session"))).waitForIdle);
  await firstHost.switchTo("main");

  const staleCallbackStart = firstHost.actions.length;
  proxy.replayCapturedEvent();
  firstHost.component.handleInput("\x10");
  await firstHost.waitFor((action) => action.type === "sessions-listed", staleCallbackStart);
  firstHost.component.handleInput("\x1b");
  expect(
    firstHost.actions
      .slice(staleCallbackStart)
      .filter(
        (action) =>
          action.type === "envelope-received" && action.envelope.event.sessionId === "research",
      ),
  ).toEqual([]);

  await provider.waitForCalls(3);
  await firstHost.waitFor(isEnvelopeDelta("tui-turn-3", "completed "));
  const firstDeltaActions = firstHost.actions.filter(isEnvelopeDelta("tui-turn-3", "completed "));
  const firstDeltaCountBeforeReconnect = firstDeltaActions.length;
  const firstDeltaSeq = requiredEnvelopeSeq(firstDeltaActions.at(-1));
  expect(firstDeltaSeq).toBeNumber();
  const reconnectStart = firstHost.actions.length;
  const reconnectResponse = proxy.blockNextSubscribeResponse("main");
  proxy.disconnectCurrent();
  await firstHost.waitFor((action) => action.type === "retry-started", reconnectStart);
  await reconnectResponse.entered;
  const durableAtDisconnect = await runEffect(world.readSession("main", 0));
  expect(durableAtDisconnect.at(-1)?.event).toMatchObject({
    type: "model-chunk",
    turnId: "tui-turn-3",
    delta: "completed ",
  });
  expect(
    durableAtDisconnect.filter(
      (entry) => entry.event.type === "interrupt-received" && entry.event.turnId === "tui-turn-3",
    ),
  ).toEqual([]);
  const mutationCommandsBeforeRetryInput = firstHost.commands.length;
  firstHost.submit("preserve while retrying", "\r");
  expect(firstHost.component.currentState.composer).toBe("preserve while retrying");
  expect(firstHost.commands).toHaveLength(mutationCommandsBeforeRetryInput);
  proxy.duplicateNextSessionEvent("main", firstDeltaSeq);
  reconnectProviderBarrier.release();
  const mainRuntime = await runEffect(kernel.getOrCreateSession("main"));
  await runEffect(mainRuntime.waitForIdle);
  reconnectResponse.release();
  await firstHost.waitFor((action) => action.type === "replay-started", reconnectStart);
  expect(proxy.subscribeCursors("main").at(-1)).toBe(firstDeltaSeq);
  await firstHost.waitFor(eventAction("turn-ended", "tui-turn-3"), reconnectStart);
  expect(firstHost.assistantText("tui-turn-3")).toBe("completed after reconnect");
  expect(firstHost.actions.filter(isEnvelopeDelta("tui-turn-3", "completed "))).toHaveLength(
    firstDeltaCountBeforeReconnect,
  );
  expect(
    firstHost.actions
      .slice(reconnectStart)
      .filter(isEnvelopeEvent("model-chunk", "tui-turn-3"))
      .map((action) =>
        action.envelope.event.type === "model-chunk" ? action.envelope.event.delta : "",
      ),
  ).toEqual(["after ", "reconnect"]);

  firstHost.submit("finish after quit", "\r");
  await provider.waitForCalls(4);
  await firstHost.waitFor(eventAction("turn-started", "tui-turn-4"));
  const unsubscribesBeforeQuit = proxy.requestCount("session/unsubscribe");
  firstHost.component.requestQuit();
  await firstRun;
  expect(firstHost.stopCalls).toBe(1);
  expect(proxy.requestCount("session/unsubscribe")).toBe(unsubscribesBeforeQuit + 1);
  const durableAfterQuit = await runEffect(world.readSession("main", 0));
  expect(
    durableAfterQuit.filter(
      (entry) => entry.event.type === "interrupt-received" && entry.event.turnId === "tui-turn-4",
    ),
  ).toEqual([]);
  expect(durableAfterQuit.at(-1)?.event).not.toMatchObject({
    type: "turn-ended",
    turnId: "tui-turn-4",
  });
  quitProviderBarrier.release();
  await runEffect(mainRuntime.waitForIdle);

  const secondHost = new LiveTuiHarness();
  const secondRun = runEffect(runProductionTui(profile, setup, secondHost.factory));
  await secondHost.waitForLive("main");
  proxy.dropNextTurnStartResponse();
  secondHost.submit("unknown but durable", "\r");
  await secondHost.waitFor((action) => action.type === "outcome-unknown");
  await provider.waitForCalls(5);
  expect(secondHost.component.currentState.connection.kind).toBe("outcome-unknown");
  expect(secondHost.component.currentState.composer).toBe("unknown but durable");
  secondHost.component.handleInput("\r");
  expect(
    secondHost.commands.filter(
      (command) =>
        command.type === "start-turn" && command.request.message === "unknown but durable",
    ),
  ).toHaveLength(1);
  secondHost.component.handleInput("\x03");
  await secondRun;
  expect(secondHost.stopCalls).toBe(1);
  expect(proxy.clientCloseCount()).toBe(3);
  const durableAfterCtrlC = await runEffect(world.readSession("main", 0));
  expect(
    durableAfterCtrlC.filter(
      (entry) => entry.event.type === "interrupt-received" && entry.event.turnId === "tui-turn-5",
    ),
  ).toEqual([]);
  expect(durableAfterCtrlC.at(-1)?.event).not.toMatchObject({
    type: "turn-ended",
    turnId: "tui-turn-5",
  });

  ctrlCProviderBarrier.release();
  await runEffect(mainRuntime.waitForIdle);

  const sessionIds = ["main", "research", "approve-session", "deny-session"];
  const durableSessions = await Promise.all(
    sessionIds.map((sessionId) => runEffect(world.readSession(sessionId, 0))),
  );
  const durableMain = durableSessions[0] ?? [];
  expect(
    durableMain.filter(
      (entry) =>
        entry.event.type === "turn-started" && entry.event.message === "unknown but durable",
    ),
  ).toHaveLength(1);
  expect(durableMain.at(-1)?.event).toMatchObject({ type: "turn-ended", status: "completed" });
  expect(
    durableSessions
      .flat()
      .filter((entry) => entry.event.type === "approval-resolved")
      .map((entry) => entry.event),
  ).toEqual([
    {
      type: "approval-resolved",
      sessionId: "approve-session",
      turnId: "approval-turn",
      approvalId: "approval-approve",
      decision: "approve",
    },
    {
      type: "approval-resolved",
      sessionId: "deny-session",
      turnId: "approval-turn",
      approvalId: "approval-deny",
      decision: "deny",
    },
  ]);
  expect(provider.pendingSteps()).toBe(0);
  expect(approveProvider.pendingSteps()).toBe(0);
  expect(denyProvider.pendingSteps()).toBe(0);

  const filesystemDiffs: RuntimeObservations["filesystemDiffs"] = await Promise.all(
    sessionIds.map(async (sessionId) => ({
      path: `sessions/${sessionId}.ndjson`,
      change: "created",
      beforeDigest: null,
      afterDigest: fixtureDigest(
        await readFile(join(profile, "sessions", `${sessionId}.ndjson`), "utf8"),
      ),
    })),
  );
  liveObservations = {
    canonicalEventTrace: observeCanonicalEvents(durableSessions.flat()),
    providerInputs: observeProviderInputs([
      ...provider.calls,
      ...approveProvider.calls,
      ...denyProvider.calls,
    ]),
    faultSchedule: [
      {
        boundary: "tui-session-subscription",
        point: "stale-subscription-envelope-after-a-b-a",
        occurrence: 1,
        outcome: "continued",
      },
      {
        boundary: "unix-attach-socket",
        point: "disconnect-during-provider-turn",
        occurrence: 1,
        outcome: "recovered",
      },
      {
        boundary: "attach-replay-live-overlap",
        point: "held-subscribe-response-with-duplicate-live-envelope",
        occurrence: 1,
        outcome: "recovered",
      },
      {
        boundary: "unix-attach-socket",
        point: "post-turn-start-response-drop",
        occurrence: 1,
        outcome: "continued",
      },
    ],
    filesystemDiffs,
    metrics: [
      {
        name: "follow-up-turn-started-count",
        value: durableMain.filter(
          (entry) =>
            entry.event.type === "turn-started" &&
            entry.event.origin === "follow-up" &&
            entry.event.message === "queued follow-up",
        ).length,
      },
      {
        name: "follow-up-received-count",
        value: durableMain.filter(
          (entry) =>
            entry.event.type === "follow-up-received" && entry.event.message === "queued follow-up",
        ).length,
      },
      { name: "reconnect-requested-since-seq", value: firstDeltaSeq },
      {
        name: "replay-duplicate-applied-count",
        value: Math.max(
          0,
          firstHost.actions.filter(isEnvelopeDelta("tui-turn-3", "completed ")).length -
            firstDeltaCountBeforeReconnect,
        ),
      },
      {
        name: "subscription-cleanup-count",
        value: proxy.requestCount("session/unsubscribe"),
      },
      { name: "client-cleanup-count", value: proxy.clientCloseCount() },
    ],
  };

  await proxy.close();
  await runEffect(server.close.pipe(Effect.andThen(kernel.close)));
}, 20_000);

test("protocol script renders stable idle, streaming, picker, approval, and reconnect states", () => {
  applied.splice(0);
  let transition = reduceTui(createInitialState(), { type: "main-ensured", session: main });
  transition = reduceTui(transition.state, {
    type: "command-admitted",
    command: transition.commands[0] ?? { type: "ensure-main" },
  });
  transition = reduceTui(transition.state, {
    type: "replay-started",
    generation: transition.state.resumeGeneration,
    session: main,
    replayThroughSeq: 1,
  });
  transition = apply(
    transition.state,
    envelope(1, {
      type: "session-started",
      sessionId: "main",
      snapshot: { systemPrompt: "fixture", tools: [] },
    }),
  );
  const idle = render(transition.state);

  transition = apply(
    transition.state,
    envelope(2, {
      type: "turn-started",
      sessionId: "main",
      turnId: "turn-1",
      message: "Explain the invariant",
      origin: "user",
    }),
  );
  transition = apply(
    transition.state,
    envelope(3, {
      type: "step-started",
      sessionId: "main",
      turnId: "turn-1",
      stepId: "step-1",
      provider: "scripted",
      model: "scripted-model",
    }),
  );
  transition = apply(
    transition.state,
    envelope(4, {
      type: "model-chunk",
      sessionId: "main",
      turnId: "turn-1",
      stepId: "step-1",
      contentIndex: 0,
      kind: "text",
      delta: "One durable authority.",
    }),
  );
  const streaming = render(transition.state);

  transition = reduceTui(transition.state, { type: "sessions-listed", sessions: [main, other] });
  transition = reduceTui(transition.state, { type: "intent", intent: "sessions" });
  const picker = render(transition.state);
  transition = reduceTui(transition.state, { type: "intent", intent: "dismiss" });

  transition = apply(
    transition.state,
    envelope(5, {
      type: "approval-requested",
      sessionId: "main",
      turnId: "turn-1",
      approvalId: "approval-1",
      toolCallId: "tool-1",
      prompt: "Allow the deterministic tool?",
      choices: ["approve", "deny"],
    }),
  );
  const approval = render(transition.state);
  transition = reduceTui(transition.state, { type: "intent", intent: "deny" });
  expect(transition.commands).toEqual([
    {
      type: "resolve-approval",
      generation: 1,
      request: { sessionId: "main", approvalId: "approval-1", decision: "deny" },
    },
  ]);

  transition = reduceTui(transition.state, {
    type: "connection-lost",
    generation: 1,
    message: "fixture disconnect",
  });
  const disconnected = render(transition.state);
  transition = reduceTui(transition.state, {
    type: "retry-started",
    generation: 1,
    attempt: 1,
  });
  const retrying = render(transition.state);
  transition = reduceTui(transition.state, {
    type: "replay-started",
    generation: transition.state.resumeGeneration,
    session: { ...main, lastSeq: 8, activeTurnId: "turn-1" },
    replayThroughSeq: 8,
  });
  const replaying = render(transition.state);
  transition = apply(
    transition.state,
    envelope(4, {
      type: "model-chunk",
      sessionId: "main",
      turnId: "turn-1",
      stepId: "step-1",
      contentIndex: 0,
      kind: "text",
      delta: "duplicate",
    }),
  );
  transition = apply(
    transition.state,
    envelope(6, {
      type: "approval-resolved",
      sessionId: "main",
      turnId: "turn-1",
      approvalId: "approval-1",
      decision: "deny",
    }),
  );
  transition = apply(
    transition.state,
    envelope(7, {
      type: "model-chunk",
      sessionId: "main",
      turnId: "turn-1",
      stepId: "step-1",
      contentIndex: 0,
      kind: "text",
      delta: " Replayed once.",
    }),
  );
  transition = apply(
    transition.state,
    envelope(8, { type: "turn-ended", sessionId: "main", turnId: "turn-1", status: "completed" }),
  );
  const reconnected = render(transition.state);

  expect(transition.state.connection).toEqual({ kind: "live" });
  expect(transition.state.displayed).toMatchObject({
    kind: "loaded",
    projection: {
      lastAppliedSeq: 8,
      transcript: [
        { kind: "user", text: "Explain the invariant" },
        { kind: "assistant", text: "One durable authority. Replayed once.", streaming: true },
        { kind: "activity", text: "Approval denied" },
      ],
    },
  });

  const snapshots = {
    idle,
    streaming,
    picker,
    approval,
    disconnected,
    retrying,
    replaying,
    reconnected,
  };
  expect(
    Object.fromEntries(
      Object.entries(snapshots).map(([name, value]) => [name, fixtureDigest(value)]),
    ),
  ).toEqual({
    idle: "f42078bd2e0ab0a4a3b41e22fd60de0de84109a3d0e62060f9460d096e288e8a",
    streaming: "08f8029492ab0e21d4227227440d2451875f4c9da9d18e2dcd26e802373d6c6d",
    picker: "84c8ffbcb8caf340d751c1d75defb4f71cc3fcd360e1854483c89bbd975d5c36",
    approval: "4c521f65e99eb410ac795a20dc6b1640128ceefbc5da9fab10db4470b71d8b6a",
    disconnected: "8a2ee12ce6d54b1e41ff21b4922b439b8c5a2d7432590c4df036db1dffc24613",
    retrying: "49bfc679c029b39337dd5950f32a576ca3ed9b4a82df766b5697077e7159023b",
    replaying: "f02aaadb26994e30e28c1b4b41a1f9ce329e480324fda415f948b5ceaeba7c38",
    reconnected: "db3b0389e978fdee029803721d9a560f11141e8e5bc1f5fe019bffa563d4f7a9",
  });
  expect(idle).toContain("ZIGGY / main");
  expect(idle).toContain("READY");
  expect(streaming).toContain("ZIGGY / STREAMING\nOne durable authority.");
  expect(picker).toContain("[SESSIONS] All persisted Sessions");
  expect(approval).toContain("[APPROVAL REQUIRED]");
  expect(disconnected).toContain("DISCONNECTED");
  expect(retrying).toContain("RETRY 1");
  expect(replaying).toContain("REPLAY -> #8");
  expect(reconnected).toContain("READY");
  expect(reconnected).not.toContain("[LIVE]");
});

afterAll(async () => {
  emitVerificationObservation("s3.tui-protocol-face", liveObservations);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function apply(state: TuiState, value: SessionEnvelope): TuiTransition {
  applied.push(value);
  return reduceTui(state, {
    type: "envelope-received",
    generation: state.resumeGeneration,
    envelope: value,
  });
}

function envelope(seq: number, event: SessionEvent): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq,
    emittedAt: new Date(Date.parse("2026-07-21T04:00:00.000Z") + seq).toISOString(),
    event,
  };
}

interface ReplayPressureServer {
  readonly socketPath: string;
  readonly sendTail: () => void;
  readonly close: () => Promise<void>;
}

async function createReplayPressureServer(): Promise<ReplayPressureServer> {
  const directory = await mkdtemp(join(tmpdir(), "ziggy-s3-tui-replay-server-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "attach.sock");
  let current: Socket | undefined;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    current = socket;
    sockets.add(socket);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString();
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline + 1);
        buffered = buffered.slice(newline + 1);
        const request = decodeClientRequest(line);
        const response = replayPressureResponse(request);
        socket.write(encodeServerFrame(response));
        if (request.method === "session/subscribe") {
          for (let seq = 1; seq <= 883; seq += 1) {
            socket.write(
              encodeServerFrame({
                schemaVersion: PROTOCOL_VERSION,
                type: "event",
                subscriptionId: "backpressure-subscription",
                event: replayPressureEnvelope(seq),
              }),
            );
          }
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (current === socket) current = undefined;
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    sendTail: () => {
      const socket = current;
      if (socket === undefined || socket.destroyed) return;
      for (let seq = 884; seq <= 900; seq += 1) {
        socket.write(
          encodeServerFrame({
            schemaVersion: PROTOCOL_VERSION,
            type: "event",
            subscriptionId: "backpressure-subscription",
            event: replayPressureEnvelope(seq),
          }),
        );
      }
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function replayPressureResponse(request: ClientRequestFrame): ServerFrame {
  switch (request.method) {
    case "initialize":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "initialize",
        type: "success",
        result: {
          protocolVersion: PROTOCOL_VERSION,
          features: ["stableMainSession", "sessionReplay"],
        },
      };
    case "session/ensure":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/ensure",
        type: "success",
        result: {
          session: {
            sessionId: "main",
            createdAt: "2026-07-21T00:00:00.000Z",
            lastSeq: 883,
            activeTurnId: "replay-turn",
          },
        },
      };
    case "session/subscribe":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/subscribe",
        type: "success",
        result: { subscriptionId: "backpressure-subscription", replayThroughSeq: 883 },
      };
    case "session/unsubscribe":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/unsubscribe",
        type: "success",
        result: { unsubscribed: true },
      };
    default:
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "error",
        code: "invalid-params",
        message: "unsupported replay fixture request",
      };
  }
}

function replayPressureEnvelope(seq: number): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq,
    emittedAt: new Date(Date.parse("2026-07-21T00:00:00.000Z") + seq).toISOString(),
    event: replayPressureEvent(seq),
  };
}

function replayPressureEvent(seq: number): SessionEvent {
  if (seq === 1) {
    return {
      type: "session-started",
      sessionId: "main",
      snapshot: { systemPrompt: "backpressure fixture", tools: [] },
    };
  }
  if (seq === 2) {
    return {
      type: "turn-started",
      sessionId: "main",
      turnId: "replay-turn",
      message: "replay pressure",
      origin: "user",
    };
  }
  const approvalIndex = Math.floor((seq - 3) / 2);
  const approvalId = `replay-approval-${approvalIndex}`;
  return seq % 2 === 1
    ? {
        type: "approval-requested",
        sessionId: "main",
        turnId: "replay-turn",
        approvalId,
        toolCallId: `replay-tool-${approvalIndex}`,
        prompt: `pressure-${seq}-${"x".repeat(2_500)}`,
        choices: ["approve", "deny"],
      }
    : {
        type: "approval-resolved",
        sessionId: "main",
        turnId: "replay-turn",
        approvalId,
        decision: "deny",
      };
}

function render(state: TuiState): string {
  return renderTui(state, { columns: 88, rows: 14 }).join("\n");
}

function splitTextStep(parts: ReadonlyArray<string>, timestamp: number): ScriptedStep {
  const base = textStep(parts.join(""), timestamp);
  if (base.kind !== "events") return base;
  const events: Array<(typeof base.events)[number]> = [];
  for (const event of base.events) {
    if (event.type === "text_delta") {
      for (const delta of parts) events.push({ ...event, delta });
    } else {
      events.push(event);
    }
  }
  return { ...base, events };
}

function withBarrier(step: ScriptedStep, barrier: Barrier): ScriptedStep {
  return step.kind === "events" ? { ...step, barrier } : step;
}

function withEventBarrier(step: ScriptedStep, index: number, barrier: Barrier): ScriptedStep {
  return step.kind === "events" ? { ...step, eventBarriers: new Map([[index, barrier]]) } : step;
}

function approvalProvider(sessionId: string, timestamp: number): ScriptedProvider {
  return new ScriptedProvider([
    toolStep([{ id: `tool-${sessionId}`, name: "request_approval", arguments: {} }], timestamp),
    textStep("approval requested", timestamp + 1),
  ]);
}

function approvalTool(
  world: ReturnType<typeof createFilesystemWorld>,
  sessionId: string,
  turnBarrier: Barrier,
): SessionTool {
  const approvalId = sessionId === "approve-session" ? "approval-approve" : "approval-deny";
  return {
    name: "request_approval",
    description: "Creates a deterministic approval owned by the daemon runtime.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: (input) =>
      world
        .appendSession(sessionId, {
          type: "approval-requested",
          sessionId,
          turnId: input.turnId,
          approvalId,
          toolCallId: input.toolCallId,
          prompt: `Resolve ${approvalId}?`,
          choices: ["approve", "deny"],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SessionRuntimeError({ message: "Failed to create fixture approval", cause }),
          ),
          Effect.andThen(
            Effect.tryPromise({
              try: () => turnBarrier.wait(),
              catch: (cause) =>
                new SessionRuntimeError({ message: "Approval fixture barrier failed", cause }),
            }),
          ),
          Effect.as({ requested: true }),
        ),
  };
}

function startTurnFromRemoteClient(
  socketPath: string,
  sessionId: string,
  message: string,
): Promise<void> {
  return runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* createAttachClient({
          transport: unixAttachTransportFactory(socketPath),
          client: { name: "remote-turn-test", version: "0.0.0" },
        });
        yield* client.startTurn(sessionId, message);
      }),
    ),
  );
}

function subscriptionSequence(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function eventAction(
  eventType: SessionEvent["type"],
  turnId: string,
  sessionId?: string,
): (action: TuiAction) => boolean {
  return (action) =>
    action.type === "envelope-received" &&
    action.envelope.event.type === eventType &&
    isTurnEvent(action.envelope.event) &&
    action.envelope.event.turnId === turnId &&
    (sessionId === undefined || action.envelope.event.sessionId === sessionId);
}

function isEnvelopeEvent(
  eventType: SessionEvent["type"],
  turnId: string,
): (action: TuiAction) => action is Extract<TuiAction, { readonly type: "envelope-received" }> {
  return (action): action is Extract<TuiAction, { readonly type: "envelope-received" }> =>
    action.type === "envelope-received" &&
    action.envelope.event.type === eventType &&
    isTurnEvent(action.envelope.event) &&
    action.envelope.event.turnId === turnId;
}

function isEnvelopeDelta(
  turnId: string,
  delta: string,
): (action: TuiAction) => action is Extract<TuiAction, { readonly type: "envelope-received" }> {
  return (action): action is Extract<TuiAction, { readonly type: "envelope-received" }> =>
    action.type === "envelope-received" &&
    action.envelope.event.type === "model-chunk" &&
    action.envelope.event.turnId === turnId &&
    action.envelope.event.delta === delta;
}

function isTurnEvent(
  event: SessionEvent,
): event is Exclude<SessionEvent, { readonly type: "session-started" }> {
  return event.type !== "session-started";
}

function requiredEnvelopeSeq(action: TuiAction | undefined): number {
  if (action?.type !== "envelope-received") {
    throw new Error("Expected an envelope action");
  }
  return action.envelope.seq;
}

function requiredSessionEnvelopeSeq(envelope: SessionEnvelope | undefined): number {
  if (envelope === undefined) throw new Error("Expected a Session envelope");
  return envelope.seq;
}

function resolveApprovalFromRemoteClient(
  socketPath: string,
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<"already-resolved" | "resolved"> {
  return runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* createAttachClient({
          transport: unixAttachTransportFactory(socketPath),
          client: { name: "remote-approval-test", version: "0.0.0" },
        });
        return yield* client.resolveApproval(sessionId, approvalId, decision);
      }),
    ),
  );
}

class LiveTuiHarness {
  readonly actions: TuiAction[] = [];
  readonly commands: TuiCommand[] = [];
  stopCalls = 0;
  private mountedComponent: ZiggyTuiComponent | undefined;
  private readonly waiters: Array<{
    readonly after: number;
    readonly predicate: (action: TuiAction) => boolean;
    readonly completion: PromiseWithResolvers<void>;
  }> = [];

  readonly factory: TuiHostFactory = (emit) =>
    Effect.acquireRelease(
      Effect.sync((): ZiggyTuiHost => {
        this.mountedComponent = new ZiggyTuiComponent({
          state: createInitialState(),
          emit: (command) => {
            this.commands.push(command);
            emit(command);
          },
        });
        return {
          dispatch: (action) => {
            this.actions.push(action);
            this.component.dispatch(action);
            for (const waiter of this.waiters) {
              if (this.actions.length > waiter.after && waiter.predicate(action)) {
                waiter.completion.resolve();
              }
            }
          },
          stop: () => {
            this.stopCalls += 1;
          },
        };
      }),
      (host) => Effect.sync(host.stop),
    );

  get component(): ZiggyTuiComponent {
    const component = this.mountedComponent;
    if (component === undefined) throw new Error("TUI component is not mounted");
    return component;
  }

  waitFor(predicate: (action: TuiAction) => boolean, after = 0): Promise<void> {
    if (this.actions.slice(after).some(predicate)) return Promise.resolve();
    const completion = Promise.withResolvers<void>();
    this.waiters.push({ after, predicate, completion });
    return completion.promise;
  }

  waitForLive(sessionId: string, after = 0): Promise<void> {
    return this.waitFor(
      () =>
        this.component.currentState.connection.kind === "live" &&
        this.component.currentState.displayed.kind === "loaded" &&
        this.component.currentState.displayed.projection.summary.sessionId === sessionId,
      after,
    );
  }

  submit(message: string, key: string): void {
    this.component.dispatch({ type: "composer-changed", value: message });
    this.component.handleInput(key);
  }

  async beginSwitchTo(sessionId: string): Promise<number> {
    const after = this.actions.length;
    this.component.handleInput("\x10");
    await this.waitFor((action) => action.type === "sessions-listed", after);
    const state = this.component.currentState;
    if (state.overlay.kind !== "sessions") throw new Error("Session picker did not open");
    const target = state.sessions.findIndex((session) => session.sessionId === sessionId);
    if (target < 0) throw new Error(`Session ${sessionId} was not listed`);
    const delta = target - state.overlay.selectedIndex;
    const key = delta < 0 ? "\x1b[A" : "\x1b[B";
    for (let index = 0; index < Math.abs(delta); index += 1) this.component.handleInput(key);
    this.component.handleInput("\r");
    return this.component.currentState.resumeGeneration;
  }

  async switchTo(sessionId: string): Promise<void> {
    const after = this.actions.length;
    await this.beginSwitchTo(sessionId);
    await this.waitForLive(sessionId, after);
  }

  assistantText(turnId: string): string | undefined {
    const state = this.component.currentState;
    if (state.displayed.kind !== "loaded") return undefined;
    return state.displayed.projection.transcript.find(
      (item) => item.kind === "assistant" && item.turnId === turnId,
    )?.text;
  }
}

interface AttachProxy {
  readonly socketPath: string;
  readonly disconnectCurrent: () => void;
  readonly dropNextTurnStartResponse: () => void;
  readonly captureNextSessionEvent: (sessionId: string) => void;
  readonly replayCapturedEvent: () => void;
  readonly blockNextSubscribeResponse: (sessionId: string) => Barrier;
  readonly duplicateNextSessionEvent: (sessionId: string, afterSeq: number) => void;
  readonly requestCount: (method: ClientRequestFrame["method"]) => number;
  readonly subscribeCursors: (sessionId: string) => ReadonlyArray<number>;
  readonly clientCloseCount: () => number;
  readonly close: () => Promise<void>;
}

async function createAttachProxy(
  upstreamPath: string,
  fixedSocketPath?: string,
): Promise<AttachProxy> {
  const directory =
    fixedSocketPath === undefined
      ? await mkdtemp(join(tmpdir(), "ziggy-s3-tui-proxy-"))
      : undefined;
  if (directory !== undefined) temporaryDirectories.push(directory);
  const socketPath = fixedSocketPath ?? join(directory ?? "", "attach.sock");
  await rm(socketPath, { force: true });
  let current: { readonly client: Socket; readonly upstream: Socket } | undefined;
  let dropTurnStart = false;
  let captureSessionId: string | undefined;
  let capturedEventLine: string | undefined;
  let duplicateEvent: { readonly sessionId: string; readonly afterSeq: number } | undefined;
  let closeCount = 0;
  const blockedSubscribeResponses = new Map<string, Barrier>();
  const subscribeResponseBarriers = new Map<string, Barrier>();
  const requests: ClientRequestFrame[] = [];
  const server = createServer((client) => {
    const upstream = createConnection(upstreamPath);
    current = { client, upstream };
    let clientBuffered = "";
    let upstreamBuffered = "";
    let dropping = false;
    client.setEncoding("utf8");
    upstream.setEncoding("utf8");
    client.on("data", (chunk) => {
      clientBuffered += typeof chunk === "string" ? chunk : chunk.toString();
      while (true) {
        const newline = clientBuffered.indexOf("\n");
        if (newline < 0) break;
        const line = clientBuffered.slice(0, newline + 1);
        clientBuffered = clientBuffered.slice(newline + 1);
        const request: ClientRequestFrame = decodeClientRequest(line);
        requests.push(request);
        if (dropTurnStart && request.method === "turn/start") {
          dropTurnStart = false;
          dropping = true;
          upstream.write(line, () => client.destroy());
          continue;
        }
        if (request.method === "session/subscribe") {
          const responseBarrier = blockedSubscribeResponses.get(request.params.sessionId);
          if (responseBarrier !== undefined) {
            blockedSubscribeResponses.delete(request.params.sessionId);
            subscribeResponseBarriers.set(request.requestId, responseBarrier);
          }
        }
        upstream.write(line);
      }
    });
    upstream.on("data", (chunk) => {
      upstreamBuffered += typeof chunk === "string" ? chunk : chunk.toString();
      while (true) {
        const newline = upstreamBuffered.indexOf("\n");
        if (newline < 0) break;
        const line = upstreamBuffered.slice(0, newline + 1);
        upstreamBuffered = upstreamBuffered.slice(newline + 1);
        if (dropping) {
          dropping = false;
          upstream.destroy();
          return;
        }
        if (client.destroyed) continue;
        const frame: ServerFrame = decodeServerFrame(line);
        if (frame.type === "success" && frame.requestId !== null) {
          const responseBarrier = subscribeResponseBarriers.get(frame.requestId);
          if (responseBarrier !== undefined) {
            subscribeResponseBarriers.delete(frame.requestId);
            void responseBarrier.wait().then(() => client.write(line));
            continue;
          }
        }
        client.write(line);
        if (
          frame.type === "event" &&
          captureSessionId !== undefined &&
          frame.event.event.sessionId === captureSessionId
        ) {
          captureSessionId = undefined;
          capturedEventLine = line;
        }
        if (
          frame.type === "event" &&
          duplicateEvent !== undefined &&
          frame.event.event.sessionId === duplicateEvent.sessionId &&
          frame.event.seq > duplicateEvent.afterSeq
        ) {
          duplicateEvent = undefined;
          client.write(line);
        }
      }
    });
    client.on("close", () => {
      closeCount += 1;
      if (!dropping) upstream.destroy();
      if (current?.client === client) current = undefined;
    });
    client.on("error", () => undefined);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
  });
  await listenServer(server, socketPath);
  return {
    socketPath,
    disconnectCurrent: () => {
      current?.client.destroy();
      current?.upstream.destroy();
    },
    dropNextTurnStartResponse: () => {
      dropTurnStart = true;
    },
    captureNextSessionEvent: (sessionId) => {
      captureSessionId = sessionId;
      capturedEventLine = undefined;
    },
    replayCapturedEvent: () => {
      if (capturedEventLine === undefined || current === undefined) {
        throw new Error("No captured Session event is available");
      }
      current.client.write(capturedEventLine);
    },
    blockNextSubscribeResponse: (sessionId) => {
      const barrier = new Barrier();
      blockedSubscribeResponses.set(sessionId, barrier);
      return barrier;
    },
    duplicateNextSessionEvent: (sessionId, afterSeq) => {
      duplicateEvent = { sessionId, afterSeq };
    },
    requestCount: (method) => requests.filter((request) => request.method === method).length,
    subscribeCursors: (sessionId) =>
      requests.flatMap((request) =>
        request.method === "session/subscribe" && request.params.sessionId === sessionId
          ? [request.params.sinceSeq]
          : [],
      ),
    clientCloseCount: () => closeCount,
    close: async () => {
      await closeNetServer(server);
      await rm(socketPath, { force: true });
    },
  };
}

function listenServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
}

function closeNetServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
