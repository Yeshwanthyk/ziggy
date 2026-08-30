import { describe, expect, test } from "bun:test";
import {
  connectZiggy,
  decodeJson,
  initialGatewayState,
  isMethodParams,
  isMethodResult,
  isGatewayEvent,
  isRecord,
  projectGroup,
  reduceGatewayState,
  selectProfileMain,
  selectSpecialist,
  selectVisibleEvents,
  type ZiggyGatewayEvent,
  type ZiggyMethod,
  type ZiggyProfileId,
  type ZiggyRequestMap,
  type ZiggySessionRef,
  type ZiggySocket,
  type ZiggySocketEvent,
  ZIGGY_METHODS,
  ZiggyRequestOutcomeUnknownError,
} from "../src/index";

const PROFILE_A: ZiggyProfileId = "prf_aaaaaaaaaaaaaaaaaaaaaaaa";
const PROFILE_B: ZiggyProfileId = "prf_bbbbbbbbbbbbbbbbbbbbbbbb";
const MAIN_A: ZiggySessionRef = { profileId: PROFILE_A, kind: "live", key: "local/main" };
const SPECIALIST_A: ZiggySessionRef = {
  profileId: PROFILE_A,
  kind: "live",
  key: "local/agents/researcher",
};
const EPOCH_A = "epoch-aaa";
const EPOCH_B = "epoch-bbb";

type SocketEventName = "open" | "message" | "close" | "error";
type SocketListener = (event: ZiggySocketEvent) => void;

class FakeSocket implements ZiggySocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<SocketEventName, Set<SocketListener>>();

  addEventListener(name: SocketEventName, listener: SocketListener): void {
    const listeners = this.listeners.get(name) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  rawMessage(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(name: SocketEventName, event: ZiggySocketEvent): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const socketAt = (sockets: readonly FakeSocket[], index: number): FakeSocket => {
  const socket = sockets[index];
  if (socket === undefined) throw new Error(`missing fake socket at index ${index}`);
  return socket;
};

const frame = (socket: FakeSocket, index: number): Record<string, unknown> => {
  const data = socket.sent[index];
  if (data === undefined) throw new Error(`missing sent frame at index ${index}`);
  const decoded = decodeJson(data);
  if (!isRecord(decoded)) throw new Error(`invalid sent frame at index ${index}`);
  return decoded;
};

const frameId = (socket: FakeSocket, index: number): string => {
  const value = frame(socket, index).id;
  if (typeof value !== "string") throw new Error(`missing request id at index ${index}`);
  return value;
};

const waitFor = async (check: () => boolean): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 500) throw new Error("condition timed out");
    await Bun.sleep(1);
  }
};

const event = (
  profileId: ZiggyProfileId,
  session: "local/main" | "local/agents/researcher",
  eventId: string,
  sequence: number,
  snapshot: string,
  epoch = EPOCH_A,
): ZiggyGatewayEvent => ({
  event: "assistant-text",
  eventId,
  epoch,
  seq: sequence,
  profileId,
  session: {
    profileId,
    kind: "live",
    key: session,
  },
  payload: { delta: snapshot, snapshot },
});

const emptyResultMethods: ReadonlyArray<ZiggyMethod> = [
  "session.watch",
  "session.unwatch",
  "session.close",
  "prompt.submit",
  "session.steer",
  "session.follow-up",
  "session.abort",
];

const profileScopedParams = (profileId: ZiggyProfileId) => ({ profileId });

const methodFixtures = (): ReadonlyArray<{
  readonly method: ZiggyMethod;
  readonly params: unknown;
  readonly result: unknown;
}> => {
  const agent = {
    id: "researcher",
    description: "Research agent",
    tools: ["search"],
  };
  const automation = {
    id: "daily-report",
    valid: true,
    lifecycle: "active",
    message: "ready",
  };
  const run = {
    runId: "run-1",
    automationId: "daily-report",
    trigger: "manual-force",
    state: "completed",
    scheduledForMs: null,
    recordedAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 2,
    failureCategory: null,
    targets: [],
  };
  const model = {
    providerId: "openai",
    modelId: "gpt-5",
    name: "GPT-5",
    thinkingLevels: ["off", "low"],
  };
  const provider = {
    id: "openai",
    name: "OpenAI",
    supportsApiKeyLogin: true,
    supportsOauth: true,
    configured: true,
  };
  const memory = {
    path: "MEMORY.md",
    scope: "shared",
    state: "empty",
    entryCount: 0,
    codePoints: 0,
    cap: 2_200,
  };
  const extension = {
    id: "weather",
    description: "Weather",
    kind: "skill",
    source: "bundled",
  };
  const pin = {
    id: "pin-1",
    ref: MAIN_A,
    order: 0,
  };
  return [
    { method: "ping", params: {}, result: { pong: true } },
    {
      method: "system.capabilities",
      params: {},
      result: {
        protocolVersion: 1,
        defaultProfileId: PROFILE_A,
        serverEpoch: EPOCH_A,
        methods: ["ping"],
        events: ["assistant-text"],
        bounds: {
          maxPromptCodePoints: 60_000,
          replayWindow: 256,
          maxHistoryEntries: 32,
        },
      },
    },
    {
      method: "profile.list",
      params: {},
      result: {
        profiles: [{ profileId: PROFILE_A, name: "Squarey", current: true, available: true }],
      },
    },
    { method: "profile.current", params: {}, result: { profileId: PROFILE_A, name: "Squarey" } },
    {
      method: "profile.health",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, checks: [], hasErrors: false },
    },
    {
      method: "session.list",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, live: [], stored: [] },
    },
    {
      method: "session.show",
      params: { ref: MAIN_A },
      result: {
        profileId: PROFILE_A,
        ref: MAIN_A,
        kind: "live",
        live: { ref: MAIN_A, kind: "ui", idle: true },
      },
    },
    {
      method: "session.history",
      params: { ref: MAIN_A },
      result: {
        profileId: PROFILE_A,
        ref: MAIN_A,
        entries: [],
        terminalState: "completed",
        truncated: false,
        hasMore: false,
      },
    },
    {
      method: "session.open",
      params: { profileId: PROFILE_A, context: { kind: "local" } },
      result: { ref: MAIN_A },
    },
    ...emptyResultMethods.map((method) => ({
      method,
      params:
        method === "prompt.submit" || method === "session.steer" || method === "session.follow-up"
          ? { ref: MAIN_A, text: "hello" }
          : { ref: MAIN_A },
      result: { acknowledged: true },
    })),
    {
      method: "agent.list",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, agents: [agent] },
    },
    {
      method: "agent.show",
      params: { profileId: PROFILE_A, agentId: "researcher" },
      result: { profileId: PROFILE_A, agent },
    },
    {
      method: "agent.create",
      params: { profileId: PROFILE_A, agentId: "researcher" },
      result: { profileId: PROFILE_A, agent },
    },
    {
      method: "agent.validate",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, validations: [] },
    },
    {
      method: "agent.run",
      params: { profileId: PROFILE_A, agentId: "researcher", task: "hello" },
      result: { profileId: PROFILE_A, agentId: "researcher", answer: "done", sessionId: "run-1" },
    },
    {
      method: "model.status",
      params: profileScopedParams(PROFILE_A),
      result: {
        profileId: PROFILE_A,
        providerId: null,
        modelId: null,
        thinking: "off",
        authConfigured: true,
      },
    },
    {
      method: "model.list",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, models: [model], truncated: false },
    },
    {
      method: "model.available",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, models: [model], truncated: false },
    },
    {
      method: "model.set",
      params: { profileId: PROFILE_A, providerId: "openai", modelId: "gpt-5" },
      result: { profileId: PROFILE_A, providerId: "openai", modelId: "gpt-5", thinking: null },
    },
    {
      method: "auth.status",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, providers: [provider] },
    },
    {
      method: "automation.list",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, automations: [automation] },
    },
    {
      method: "automation.show",
      params: { profileId: PROFILE_A, automationId: "daily-report" },
      result: {
        profileId: PROFILE_A,
        id: "daily-report",
        lifecycle: "active",
        source: "",
      },
    },
    {
      method: "automation.create",
      params: { profileId: PROFILE_A, automationId: "daily-report", commandId: "create-1" },
      result: { profileId: PROFILE_A, ...automation },
    },
    {
      method: "automation.save",
      params: {
        profileId: PROFILE_A,
        automationId: "daily-report",
        source: "",
        expectedSource: "",
      },
      result: { profileId: PROFILE_A, id: "daily-report", lifecycle: "active", source: "" },
    },
    {
      method: "automation.validate",
      params: { profileId: PROFILE_A, automationId: "daily-report" },
      result: { profileId: PROFILE_A, validations: [automation] },
    },
    {
      method: "automation.pause",
      params: { profileId: PROFILE_A, automationId: "daily-report" },
      result: { profileId: PROFILE_A, id: "daily-report", lifecycle: "paused" },
    },
    {
      method: "automation.resume",
      params: { profileId: PROFILE_A, automationId: "daily-report" },
      result: { profileId: PROFILE_A, id: "daily-report", lifecycle: "active" },
    },
    {
      method: "automation.run",
      params: { profileId: PROFILE_A, automationId: "daily-report", commandId: "run-1" },
      result: {
        profileId: PROFILE_A,
        automationId: "daily-report",
        accepted: true,
        outcome: "accepted",
      },
    },
    {
      method: "automation.status",
      params: profileScopedParams(PROFILE_A),
      result: {
        profileId: PROFILE_A,
        observedAtMs: 1,
        heartbeatAtMs: null,
        lastTickAtMs: null,
        lastTickStatus: null,
        lastTickError: null,
        schedules: [],
        activeRunCount: 0,
        latestRun: null,
        latestErrorRun: null,
      },
    },
    {
      method: "automation.runs",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, runs: [run] },
    },
    {
      method: "memory.list",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, documents: [memory] },
    },
    {
      method: "memory.show",
      params: { profileId: PROFILE_A, path: "MEMORY.md" },
      result: {
        profileId: PROFILE_A,
        path: "MEMORY.md",
        scope: "shared",
        state: "empty",
        content: "",
        entries: [],
        codePoints: 0,
        cap: 2_200,
      },
    },
    {
      method: "extension.list-for-profile",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, available: [extension], selected: [] },
    },
    {
      method: "extension.add",
      params: { profileId: PROFILE_A, id: "weather" },
      result: { profileId: PROFILE_A, id: "weather", changed: true, selected: true },
    },
    {
      method: "extension.remove",
      params: { profileId: PROFILE_A, id: "weather" },
      result: { profileId: PROFILE_A, id: "weather", changed: true, selected: false },
    },
    {
      method: "extension.validate",
      params: profileScopedParams(PROFILE_A),
      result: {
        profileId: PROFILE_A,
        selected: [],
        preflight: { extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 },
      },
    },
    {
      method: "pin.list",
      params: profileScopedParams(PROFILE_A),
      result: { profileId: PROFILE_A, pins: [pin], revision: 1 },
    },
    {
      method: "pin.set",
      params: {
        profileId: PROFILE_A,
        pin,
        expectedRevision: 0,
        commandId: "pin-set-1",
      },
      result: { profileId: PROFILE_A, pins: [pin], revision: 1 },
    },
    {
      method: "pin.remove",
      params: {
        profileId: PROFILE_A,
        pinId: "pin-1",
        expectedRevision: 1,
        commandId: "pin-remove-1",
      },
      result: { profileId: PROFILE_A, pins: [], revision: 2 },
    },
  ];
};

describe("gateway client transport", () => {
  test("correlates out-of-order responses and authenticates the socket URL", async () => {
    const sockets: FakeSocket[] = [];
    const client = connectZiggy({
      url: "ws://127.0.0.1:1234/ws?source=test",
      token: "secret token",
      socketFactory: (url) => {
        expect(url).toContain("source=test");
        expect(url).toContain("token=secret+token");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const socket = socketAt(sockets, 0);
    const ping = client.request("ping", {});
    const current = client.request("profile.current", {});
    socket.open();
    socket.message({
      id: frameId(socket, 1),
      ok: true,
      result: { profileId: PROFILE_A, name: "Squarey" },
    });
    socket.message({ id: frameId(socket, 0), ok: true, result: { pong: true } });
    expect(await ping).toEqual({ pong: true });
    expect(await current).toEqual({ profileId: PROFILE_A, name: "Squarey" });
    client.close();
  });

  test("rejects malformed wire frames and malformed typed results", async () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    socket.open();
    const request = client.request("ping", {});
    socket.rawMessage("not-json");
    socket.message({ id: frameId(socket, 0), ok: true, result: { pong: "yes" } });
    await expect(request).rejects.toThrow("Invalid Ziggy gateway response for ping");
    client.close();
  });

  test("rejects requests that exceed their timeout", async () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      requestTimeoutMs: 5,
      socketFactory: () => socket,
    });
    socket.open();
    await expect(client.request("ping", {})).rejects.toBeInstanceOf(
      ZiggyRequestOutcomeUnknownError,
    );
    client.close();
  });

  test("restores watches with the last replay cursor after reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const first = socketAt(sockets, 0);
    first.open();
    const watched = client.watchSession(MAIN_A);
    first.message({ id: frameId(first, 0), ok: true, result: { acknowledged: true } });
    await watched;
    first.message(event(PROFILE_A, "local/main", "evt-1", 1, "hello"));
    first.close();
    await waitFor(() => sockets.length === 2);
    const second = socketAt(sockets, 1);
    second.open();
    await waitFor(() => second.sent.length === 1);
    expect(frame(second, 0)).toEqual({
      id: frame(second, 0).id,
      method: "session.watch",
      params: { ref: MAIN_A, afterSeq: 1, epoch: EPOCH_A },
    });
    second.message({ id: frameId(second, 0), ok: true, result: { acknowledged: true } });
    client.close();
  });

  test("signals epoch changes and replay gaps with stable event dedupe", () => {
    const socket = new FakeSocket();
    const client = connectZiggy({
      url: "ws://localhost/ws",
      token: "token",
      socketFactory: () => socket,
    });
    const received: string[] = [];
    client.on("history-reconciliation", (value) => received.push(value.reason));
    const events: string[] = [];
    client.on("assistant-text", (value) => events.push(value.eventId));
    socket.open();
    socket.message(event(PROFILE_A, "local/main", "evt-1", 1, "one"));
    socket.message(event(PROFILE_A, "local/main", "evt-2", 1, "two", EPOCH_B));
    socket.message({
      event: "replay-gap",
      eventId: "gap-1",
      epoch: EPOCH_B,
      seq: 2,
      profileId: PROFILE_A,
      session: MAIN_A,
      payload: {
        requestedAfter: 1,
        availableFrom: 2,
        availableTo: 2,
        reason: "epoch",
      },
    });
    socket.message(event(PROFILE_A, "local/main", "evt-2", 1, "two", EPOCH_B));
    expect(received).toEqual(["epoch-changed", "replay-gap"]);
    expect(events).toEqual(["evt-1", "evt-2"]);
    client.close();
  });
});

describe("gateway state projections", () => {
  test("deduplicates events, sorts by cursor, and isolates profile selectors", () => {
    let state = initialGatewayState(PROFILE_A);
    const first = event(PROFILE_A, "local/main", "a-1", 1, "one");
    const second = event(PROFILE_A, "local/main", "a-2", 2, "two");
    state = reduceGatewayState(state, { type: "event.received", event: second });
    state = reduceGatewayState(state, { type: "event.received", event: first });
    state = reduceGatewayState(state, { type: "event.received", event: first });
    state = reduceGatewayState(state, {
      type: "event.received",
      event: event(PROFILE_B, "local/main", "b-1", 1, "other"),
    });
    expect(selectVisibleEvents(state, MAIN_A).map((value) => value.id)).toEqual([
      "prf_aaaaaaaaaaaaaaaaaaaaaaaa:local/main:a-1",
      "prf_aaaaaaaaaaaaaaaaaaaaaaaa:local/main:a-2",
    ]);
    expect(selectProfileMain(state, PROFILE_A)?.profileId).toBe(PROFILE_A);
    expect(selectProfileMain(state, PROFILE_B)?.profileId).toBe(PROFILE_B);
  });

  test("projects main, specialist, and group conversations from stable refs", () => {
    let state = initialGatewayState(PROFILE_A);
    state = reduceGatewayState(state, {
      type: "event.received",
      event: event(PROFILE_A, "local/main", "main-1", 1, "main"),
    });
    state = reduceGatewayState(state, {
      type: "event.received",
      event: event(PROFILE_A, "local/agents/researcher", "agent-1", 2, "agent"),
    });
    expect(selectSpecialist(state, PROFILE_A, "researcher")?.kind).toBe("specialist");
    const group = projectGroup(state, {
      profileId: PROFILE_A,
      groupId: "research",
      members: [MAIN_A, SPECIALIST_A],
      title: "Research",
    });
    expect(group.id).toBe("prf_aaaaaaaaaaaaaaaaaaaaaaaa:group:research");
    expect(group.kind).toBe("group");
    expect(group.events.map((value) => value.text)).toEqual(["main", "agent"]);
  });

  test("preserves replay state when an existing session projection is refreshed", () => {
    const reconciliation = {
      event: "history-reconciliation" as const,
      profileId: PROFILE_A,
      session: MAIN_A,
      reason: "sequence-gap" as const,
      previousSequence: 1,
      currentSequence: 3,
    };
    let state = initialGatewayState(PROFILE_A);
    state = reduceGatewayState(state, {
      type: "event.received",
      event: event(PROFILE_A, "local/main", "main-1", 1, "main"),
    });
    state = reduceGatewayState(state, { type: "reconciliation", event: reconciliation });
    state = reduceGatewayState(state, {
      type: "session.opened",
      session: {
        profileId: PROFILE_A,
        ref: MAIN_A,
        kind: "live",
        live: { ref: MAIN_A, kind: "ui", idle: true },
      },
    });

    const conversation = selectProfileMain(state, PROFILE_A);
    expect(conversation?.cursor).toEqual({ epoch: EPOCH_A, seq: 1 });
    expect(conversation?.reconciliations).toEqual([reconciliation]);
  });
});

describe("protocol decoder parity", () => {
  test("accepts one strict params/result fixture for every registered method", () => {
    const fixtures = methodFixtures();
    const fixtureMethods = fixtures.map((fixture) => fixture.method);
    expect(new Set(fixtureMethods)).toEqual(new Set(ZIGGY_METHODS));
    for (const fixture of fixtures) {
      if (!isMethodParams(fixture.method, fixture.params)) {
        throw new Error(`invalid params fixture for ${fixture.method}`);
      }
      if (!isMethodResult(fixture.method, fixture.params, fixture.result)) {
        throw new Error(`invalid result fixture for ${fixture.method}`);
      }
    }
  });

  test("rejects cross-profile results and unknown fields", () => {
    const params = { profileId: PROFILE_A } satisfies ZiggyRequestMap["profile.health"];
    expect(
      isMethodResult("profile.health", params, {
        profileId: PROFILE_B,
        checks: [],
        hasErrors: false,
      }),
    ).toBe(false);
    expect(isMethodParams("profile.health", { profileId: PROFILE_A, unexpected: true })).toBe(
      false,
    );
  });

  test("keeps automation and missing-memory result identities requestable", () => {
    const automationParams = { profileId: PROFILE_A } satisfies ZiggyRequestMap["automation.list"];
    expect(
      isMethodResult("automation.list", automationParams, {
        profileId: PROFILE_A,
        automations: [{ id: "daily-report", valid: true, lifecycle: "active" }],
      }),
    ).toBe(true);
    expect(
      isMethodResult("automation.list", automationParams, {
        profileId: PROFILE_A,
        automations: [{ id: "daily--report", valid: true, lifecycle: "active" }],
      }),
    ).toBe(false);
    expect(
      isMethodResult(
        "memory.list",
        { profileId: PROFILE_A },
        {
          profileId: PROFILE_A,
          documents: [
            {
              path: "MEMORY.md",
              scope: "shared",
              state: "missing",
              entryCount: 0,
              codePoints: 0,
              cap: 2_200,
            },
          ],
        },
      ),
    ).toBe(true);
  });

  test("bounds streamed event payloads and accepts the explicit all recipient", () => {
    expect(
      isMethodParams("prompt.submit", {
        ref: MAIN_A,
        text: "compare",
        recipient: { kind: "all" },
      }),
    ).toBe(true);
    expect(
      isGatewayEvent({
        event: "assistant-text",
        eventId: "event-1",
        epoch: EPOCH_A,
        seq: 1,
        profileId: PROFILE_A,
        session: MAIN_A,
        payload: { delta: "x", snapshot: "🧠".repeat(2_001) },
      }),
    ).toBe(false);
  });
});
