/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- React hook tests own disposable Promise fixtures and rejection cases at the test boundary. */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZiggyRequestOutcomeUnknownError,
  type ZiggyAutomationRun,
  type ZiggyClientEvent,
  type ZiggyProfileId,
  type ZiggyProfileSummary,
  type ZiggySessionHistoryEntry,
  type ZiggySessionHistoryResult,
  type ZiggySessionRef,
  type ZiggySessionListResult,
  type ZiggySystemCapabilitiesResult,
} from "../../../packages/ui-sdk/src/index";
import {
  useZiggyGateway,
  type ConversationSummary,
  type GatewayClient,
  type GatewayConnector,
} from "./gateway";

const mainRef = {
  profileId: "prf_squarey",
  kind: "live",
  key: "local/main",
} as const satisfies ZiggySessionRef;

const specialistRef = {
  profileId: "prf_squarey",
  kind: "live",
  key: "ui/specialist",
} as const satisfies ZiggySessionRef;

const profile = {
  profileId: "prf_squarey",
  name: "Squarey",
  current: true,
  available: true,
} as const satisfies ZiggyProfileSummary;

const initialHistory = [
  { kind: "user", timestamp: "2026-09-15T12:00:00.000Z", text: "Earlier question" },
  { kind: "assistant", timestamp: "2026-09-15T12:00:01.000Z", text: "Earlier answer" },
] as const satisfies ReadonlyArray<ZiggySessionHistoryEntry>;

const automationRun = (automationId: string, recordedAtMs: number): ZiggyAutomationRun => ({
  runId: `run-${automationId}-${recordedAtMs}`,
  automationId,
  trigger: "scheduled",
  state: "completed",
  scheduledForMs: recordedAtMs - 1_000,
  recordedAtMs,
  startedAtMs: recordedAtMs - 700,
  finishedAtMs: recordedAtMs - 200,
  failureCategory: null,
  targets: [],
});

const capabilitiesResult = (
  profileId: ZiggyProfileId = profile.profileId,
  maxPromptCodePoints = 60_000,
): ZiggySystemCapabilitiesResult => ({
  protocolVersion: 1,
  defaultProfileId: profileId,
  serverEpoch: "epoch-1",
  methods: [],
  events: [],
  bounds: { maxPromptCodePoints, replayWindow: 256, maxHistoryEntries: 32 },
});

const historyResult = (
  ref: ZiggySessionRef,
  entries: ReadonlyArray<ZiggySessionHistoryEntry> = initialHistory,
): ZiggySessionHistoryResult => ({
  profileId: ref.profileId,
  ref,
  entries,
  terminalState: "completed",
  truncated: false,
  hasMore: false,
});

const sessionListResult = (): ZiggySessionListResult => ({
  profileId: profile.profileId,
  live: [
    { ref: mainRef, kind: "ui", idle: true },
    { ref: specialistRef, kind: "ui", idle: false, agentId: "researcher" },
    {
      ref: { profileId: profile.profileId, kind: "live", key: "slack/C123" },
      kind: "slack",
      idle: false,
    },
  ],
  stored: [],
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const deferred = <Value,>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
};

type ClientFixture = GatewayClient;

const makeClient = (overrides: Partial<ClientFixture> = {}) => {
  const fixture: ClientFixture = {
    state: "open",
    capabilities: vi.fn(async () => capabilitiesResult()),
    listProfiles: vi.fn(async () => ({ profiles: [profile] })),
    currentProfile: vi.fn(async () => ({ profileId: profile.profileId, name: profile.name })),
    openMain: vi.fn(async () => mainRef),
    openSpecialist: vi.fn(async () => specialistRef),
    listSessions: vi.fn(async () => sessionListResult()),
    showSession: vi.fn(async (ref) => ({
      profileId: ref.profileId,
      ref,
      kind: ref.kind,
      storedSessionId: ref.kind === "live" ? "live-session-1" : ref.id,
      ...(ref.kind === "live"
        ? { live: { ref, kind: "ui" as const, idle: true } }
        : {
            createdAt: "2026-09-17T12:00:00.000Z",
            entryCount: 1,
            terminalState: "completed" as const,
          }),
    })),
    listPins: vi.fn(async () => ({ profileId: profile.profileId, pins: [], revision: 0 })),
    listAgents: vi.fn(async () => ({ profileId: profile.profileId, agents: [] })),
    readAgentDocument: vi.fn(async (_profileId, agentId) => ({
      profileId: profile.profileId,
      id: agentId,
      source: "---\nversion: 1\ndescription: Researcher\n---\n\nResearch carefully.\n",
    })),
    saveAgent: vi.fn(async (_profileId, id, source) => ({
      profileId: profile.profileId,
      id,
      source,
    })),
    listGroups: vi.fn(async () => ({ profileId: profile.profileId, groups: [] })),
    listExtensionsForProfile: vi.fn(async () => ({
      profileId: profile.profileId,
      available: [],
      selected: [],
    })),
    modelStatus: vi.fn(async () => ({
      profileId: profile.profileId,
      providerId: "openai",
      modelId: "gpt-5",
      thinking: "medium",
      authConfigured: true,
    })),
    listModels: vi.fn(async () => ({
      profileId: profile.profileId,
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5",
          name: "GPT-5",
          thinkingLevels: ["low", "medium", "high"],
        },
      ],
      truncated: false,
    })),
    availableModels: vi.fn(async () => ({
      profileId: profile.profileId,
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5",
          name: "GPT-5",
          thinkingLevels: ["low", "medium", "high"],
        },
      ],
      truncated: false,
    })),
    setModel: vi.fn(async (_profileId, providerId, modelId, thinking) => ({
      profileId: profile.profileId,
      providerId,
      modelId,
      thinking: thinking ?? null,
    })),
    authStatus: vi.fn(async () => ({
      profileId: profile.profileId,
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          supportsApiKeyLogin: true,
          supportsOauth: true,
          configured: true,
          type: "oauth" as const,
        },
      ],
    })),
    listAutomations: vi.fn(async () => ({ profileId: profile.profileId, automations: [] })),
    showAutomation: vi.fn(async (_profileId, automationId) => ({
      profileId: profile.profileId,
      id: automationId,
      lifecycle: "active" as const,
      source: "---\nschedule: 0 8 * * *\n---\nCheck the weather.",
    })),
    automationStatus: vi.fn(async () => ({
      profileId: profile.profileId,
      observedAtMs: 1_757_929_000_000,
      heartbeatAtMs: 1_757_928_900_000,
      lastTickAtMs: 1_757_928_800_000,
      lastTickStatus: "ok" as const,
      lastTickError: null,
      schedules: [],
      activeRunCount: 0,
      latestRun: null,
      latestErrorRun: null,
    })),
    listAutomationRuns: vi.fn(async () => ({ profileId: profile.profileId, runs: [] })),
    saveAutomation: vi.fn(async (_profileId, id, source) => ({
      profileId: profile.profileId,
      id,
      lifecycle: "active" as const,
      source,
    })),
    watchSession: vi.fn(async () => undefined),
    unwatchSession: vi.fn(async () => undefined),
    getSessionHistory: vi.fn(async (ref) => historyResult(ref)),
    submitPrompt: vi.fn(async () => undefined),
    steerSession: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    request: vi.fn(async () => {
      throw new Error("Unexpected direct gateway request");
    }),
    abortSession: vi.fn(async () => undefined),
    setPin: vi.fn(async (_profileId, pin, revision) => ({
      profileId: profile.profileId,
      pins: [pin],
      revision: revision + 1,
    })),
    removePin: vi.fn(async () => ({ profileId: profile.profileId, pins: [], revision: 1 })),
    pauseAutomation: vi.fn(async (_profileId, id) => ({
      profileId: profile.profileId,
      id,
      lifecycle: "paused" as const,
    })),
    resumeAutomation: vi.fn(async (_profileId, id) => ({
      profileId: profile.profileId,
      id,
      lifecycle: "active" as const,
    })),
    runAutomation: vi.fn(async (_profileId, automationId) => ({
      profileId: profile.profileId,
      automationId,
      accepted: true,
      outcome: "queued",
    })),
    onAny: vi.fn(() => () => undefined),
    close: vi.fn(),
    ...overrides,
  };
  return {
    fixture,
    client: fixture,
  };
};

const connectHook = async (client: GatewayClient) => {
  const connector: GatewayConnector = () => client;
  const hook = renderHook(() => useZiggyGateway(connector));
  await act(async () => {
    await hook.result.current.connect({ url: "ws://127.0.0.1:9876/ws", token: "token" });
  });
  return hook;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("useZiggyGateway", () => {
  it("keeps session.open replay delivered before the selected reference is known", async () => {
    let emit: (event: ZiggyClientEvent) => void = () => undefined;
    const { client } = makeClient({
      onAny: vi.fn((handler) => {
        emit = handler;
        return () => undefined;
      }),
      openMain: vi.fn(async () => {
        emit({
          event: "assistant-text",
          eventId: "opening",
          epoch: "epoch-1",
          seq: 300,
          profileId: profile.profileId,
          session: mainRef,
          payload: { delta: "Already responding", snapshot: "Already responding" },
        });
        return mainRef;
      }),
    });
    const hook = await connectHook(client);
    expect(hook.result.current.history).toEqual(initialHistory);
    expect(hook.result.current.streamText).toBe("Already responding");
    expect(hook.result.current.busy).toBe(true);
    await act(async () =>
      hook.result.current.connect({ url: "ws://127.0.0.1:9876/ws", token: "token" }),
    );
    expect(hook.result.current.streamText).toBe("Already responding");
    expect(hook.result.current.busy).toBe(true);
  });

  it("preserves activity replayed before and delivered during history reconciliation", async () => {
    let emit: (event: ZiggyClientEvent) => void = () => undefined;
    const reload = deferred<ZiggySessionHistoryResult>();
    const { client, fixture } = makeClient({
      onAny: vi.fn((handler) => {
        emit = handler;
        return () => undefined;
      }),
    });
    const hook = await connectHook(client);
    vi.mocked(fixture.getSessionHistory).mockImplementationOnce(() => reload.promise);
    act(() => {
      emit({
        event: "assistant-text",
        eventId: "before-reload",
        epoch: "epoch-1",
        seq: 300,
        profileId: profile.profileId,
        session: mainRef,
        payload: { delta: "Retained", snapshot: "Retained" },
      });
      emit({
        event: "history-reconciliation",
        profileId: profile.profileId,
        session: mainRef,
        reason: "replay-gap",
      });
    });
    expect(hook.result.current.reconciling).toBe(true);
    act(() => {
      emit({
        event: "assistant-text",
        eventId: "during-reload",
        epoch: "epoch-1",
        seq: 301,
        profileId: profile.profileId,
        session: mainRef,
        payload: { delta: " activity", snapshot: "Retained activity" },
      });
    });
    await act(async () => reload.resolve(historyResult(mainRef)));
    expect(hook.result.current.history).toEqual(initialHistory);
    expect(hook.result.current.streamText).toBe("Retained activity");
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.reconciling).toBe(false);

    const settledReload = deferred<ZiggySessionHistoryResult>();
    vi.mocked(fixture.getSessionHistory).mockImplementationOnce(() => settledReload.promise);
    act(() =>
      emit({
        event: "settled",
        eventId: "settled",
        epoch: "epoch-1",
        seq: 302,
        profileId: profile.profileId,
        session: mainRef,
        payload: {},
      }),
    );
    await act(async () => settledReload.resolve(historyResult(mainRef)));
    expect(hook.result.current.streamText).toBe("");
    expect(hook.result.current.busy).toBe(false);
  });

  it("shows one automation result after live delivery and authoritative history merge", async () => {
    let emit: (event: ZiggyClientEvent) => void = () => undefined;
    const reload = deferred<ZiggySessionHistoryResult>();
    const { client, fixture } = makeClient({
      onAny: vi.fn((handler) => {
        emit = handler;
        return () => undefined;
      }),
    });
    const hook = await connectHook(client);
    vi.mocked(fixture.getSessionHistory).mockImplementationOnce(() => reload.promise);
    const entry = {
      kind: "automation-result" as const,
      automationId: "daily-report",
      runId: "run-1",
      text: "The report is ready.",
      timestamp: "2026-09-17T12:00:00.000Z",
    };

    act(() => {
      emit({
        event: "automation-result",
        eventId: "automation-1",
        epoch: "epoch-1",
        seq: 300,
        profileId: profile.profileId,
        session: mainRef,
        payload: {
          automationId: entry.automationId,
          runId: entry.runId,
          text: entry.text,
          timestamp: entry.timestamp,
        },
      });
      emit({
        event: "history-reconciliation",
        profileId: profile.profileId,
        session: mainRef,
        reason: "replay-gap",
      });
    });
    await act(async () => reload.resolve(historyResult(mainRef, [...initialHistory, entry])));

    expect(hook.result.current.history.filter((item) => item.kind === "automation-result")).toEqual(
      [entry],
    );
  });

  it("keeps one startup connection alive through Strict Mode effect replay", async () => {
    const { client, fixture } = makeClient();
    const connector = vi.fn<GatewayConnector>(() => client);
    const hook = renderHook(
      () => {
        const gateway = useZiggyGateway(connector);
        const started = useRef(false);
        useEffect(() => {
          if (started.current) return;
          started.current = true;
          void gateway.connect({ url: "ws://127.0.0.1:9876/ws", token: "token" });
        });
        return gateway;
      },
      { reactStrictMode: true },
    );

    await waitFor(() => expect(hook.result.current.connection).toBe("open"));

    expect(connector).toHaveBeenCalledOnce();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(hook.result.current.selectedRef).toEqual(mainRef);
  });

  it("opens and watches only local/main during startup", async () => {
    const { client, fixture } = makeClient();
    const hook = await connectHook(client);

    expect(fixture.openMain).toHaveBeenCalledExactlyOnceWith(profile.profileId);
    expect(fixture.watchSession).toHaveBeenCalledExactlyOnceWith(mainRef);
    expect(fixture.watchSession).not.toHaveBeenCalledWith(specialistRef);
    expect(hook.result.current.selectedRef).toEqual(mainRef);
    expect(hook.result.current.connection).toBe("open");
  });

  it("switches Profile-scoped state and restores the selected Profile for the endpoint", async () => {
    const beta = {
      profileId: "prf_beta",
      name: "Beta",
      current: false,
      available: true,
    } as const satisfies ZiggyProfileSummary;
    const betaMain = {
      profileId: beta.profileId,
      kind: "live",
      key: "local/main",
    } as const satisfies ZiggySessionRef;
    const { client, fixture } = makeClient({
      listProfiles: vi.fn(async () => ({ profiles: [profile, beta] })),
      openMain: vi.fn(async (profileId) => (profileId === beta.profileId ? betaMain : mainRef)),
      listSessions: vi.fn(async (profileId) => ({
        profileId,
        live: [
          {
            ref: profileId === beta.profileId ? betaMain : mainRef,
            kind: "ui" as const,
            idle: true,
          },
        ],
        stored: [],
      })),
      listAgents: vi.fn(async (profileId) => ({
        profileId,
        agents:
          profileId === beta.profileId
            ? [{ id: "beta-agent", description: "Beta agent", tools: [] }]
            : [{ id: "squarey-agent", description: "Squarey agent", tools: [] }],
      })),
    });
    const hook = await connectHook(client);
    await waitFor(() => expect(hook.result.current.agents[0]?.id).toBe("squarey-agent"));

    await act(async () => hook.result.current.switchProfile(beta.profileId));

    expect(hook.result.current.profile).toEqual(beta);
    expect(hook.result.current.selectedRef).toEqual(betaMain);
    expect(hook.result.current.agents.map((agent) => agent.id)).toEqual(["beta-agent"]);
    expect(fixture.unwatchSession).toHaveBeenCalledWith(mainRef);
    expect(fixture.watchSession).toHaveBeenCalledWith(betaMain);
    hook.unmount();

    const restored = await connectHook(client);
    expect(restored.result.current.profile).toEqual(beta);
    expect(restored.result.current.selectedRef).toEqual(betaMain);
  });

  it("loads provider and model settings and saves an explicit Profile default", async () => {
    const { client, fixture } = makeClient();
    const hook = await connectHook(client);

    await act(async () => {
      await hook.result.current.loadModelSettings();
    });

    expect(hook.result.current.modelSettings).toMatchObject({
      loading: false,
      saving: false,
      status: { providerId: "openai", modelId: "gpt-5", thinking: "medium" },
      providers: [{ id: "openai", configured: true, type: "oauth" }],
      availableModels: [{ providerId: "openai", modelId: "gpt-5" }],
    });
    expect(fixture.listModels).toHaveBeenCalledExactlyOnceWith(profile.profileId);
    expect(fixture.availableModels).toHaveBeenCalledExactlyOnceWith(profile.profileId);

    await act(async () => {
      await hook.result.current.saveModelSettings("openai", "gpt-5", "high");
    });

    expect(fixture.setModel).toHaveBeenCalledExactlyOnceWith(
      profile.profileId,
      "openai",
      "gpt-5",
      "high",
      expect.stringMatching(/^web-model-save-/),
    );
  });

  it("loads display-ready pins, agents, groups, and automation sections without watching them", async () => {
    const groupRef = {
      profileId: profile.profileId,
      kind: "live",
      key: "ui/group-planning",
    } as const satisfies ZiggySessionRef;
    const slackRef = {
      profileId: profile.profileId,
      kind: "live",
      key: "slack/C123",
    } as const satisfies ZiggySessionRef;
    const storedRef = {
      profileId: profile.profileId,
      kind: "stored",
      id: "session-archive-1",
    } as const satisfies ZiggySessionRef;
    const { client, fixture } = makeClient({
      listSessions: vi.fn(async () => ({
        profileId: profile.profileId,
        live: [
          { ref: mainRef, kind: "ui" as const, idle: true },
          {
            ref: groupRef,
            kind: "ui" as const,
            idle: false,
            context: {
              kind: "group" as const,
              groupId: "planning-room",
              memberAgentIds: ["ada", "librarian"],
              defaultRecipient: { kind: "all" as const },
            },
          },
          { ref: slackRef, kind: "slack" as const, idle: true },
        ],
        stored: [
          {
            ref: storedRef,
            createdAt: "2026-09-17T12:00:00.000Z",
            entryCount: 3,
            terminalState: "completed" as const,
          },
        ],
      })),
      listPins: vi.fn(async () => ({
        profileId: profile.profileId,
        revision: 4,
        pins: [
          { id: "main-pin", ref: mainRef, label: "Home", order: 0 },
          { id: "slack-pin", ref: slackRef, label: "Team updates", order: 1 },
        ],
      })),
      listAgents: vi.fn(async () => ({
        profileId: profile.profileId,
        agents: [{ id: "ada", description: "Plans implementation", tools: [] }],
      })),
      listGroups: vi.fn(async () => ({
        profileId: profile.profileId,
        groups: [
          {
            groupId: "planning-room",
            conversationId: "conversation-planning",
            hostProfileId: profile.profileId,
            memberAgentIds: ["ada", "librarian"],
            defaultRecipient: { kind: "all" as const },
            revision: 3,
          },
        ],
      })),
      listAutomations: vi.fn(async () => ({
        profileId: profile.profileId,
        automations: [
          { id: "morning", valid: true, lifecycle: "active" as const, schedule: "daily" },
          { id: "review", valid: true, lifecycle: "paused" as const },
          { id: "broken", valid: false, lifecycle: "conflict" as const, message: "invalid" },
        ],
      })),
    });
    const hook = await connectHook(client);

    await waitFor(() => expect(hook.result.current.sidebarLoading).toBe(false));

    expect(hook.result.current.pinnedConversations).toEqual([
      {
        pinId: "main-pin",
        ref: mainRef,
        title: "Home",
        subtitle: "Main conversation",
        active: false,
      },
      {
        pinId: "slack-pin",
        ref: slackRef,
        title: "Team updates",
        subtitle: "Pinned conversation",
        active: false,
      },
    ]);
    expect(hook.result.current.automationDestinations).toEqual(
      expect.arrayContaining([
        { ref: slackRef, title: "Team updates", subtitle: "Pinned conversation" },
        { ref: storedRef, title: "session-archive-1", subtitle: "Past conversation" },
      ]),
    );
    expect(hook.result.current.agents).toEqual([
      { id: "ada", description: "Plans implementation" },
    ]);
    expect(hook.result.current.groups).toEqual([
      {
        ref: groupRef,
        groupId: "planning-room",
        title: "Planning room",
        subtitle: "2 agents",
        memberAgentIds: ["ada", "librarian"],
        defaultRecipient: { kind: "all" },
        revision: 3,
        active: true,
      },
    ]);
    expect(hook.result.current.automationSections).toMatchObject({
      active: [{ id: "morning", lifecycle: "active", schedule: "daily" }],
      paused: [{ id: "review", lifecycle: "paused" }],
      attention: [{ id: "broken", lifecycle: "conflict", message: "invalid" }],
    });
    expect(fixture.watchSession).toHaveBeenCalledExactlyOnceWith(mainRef);
  });

  it("opens direct and group conversations and routes group prompts to the chosen recipient", async () => {
    const groupRef = {
      profileId: profile.profileId,
      kind: "live",
      key: "ui/group-planning",
    } as const satisfies ZiggySessionRef;
    const openMain = vi.fn().mockResolvedValueOnce(mainRef).mockResolvedValueOnce(groupRef);
    const request = vi.fn(async () => {
      throw new Error("recipient fixture");
    });
    const { client, fixture } = makeClient({ openMain, request });
    const hook = await connectHook(client);

    await act(async () => {
      await hook.result.current.openSpecialist("ada");
    });
    expect(fixture.openSpecialist).toHaveBeenCalledWith(profile.profileId, "ada");
    expect(hook.result.current.selectedRef).toEqual(specialistRef);

    await act(async () => {
      await hook.result.current.openGroup({
        groupId: "planning",
        memberAgentIds: ["ada", "librarian"],
        defaultRecipient: { kind: "all" },
      });
    });
    expect(openMain).toHaveBeenLastCalledWith(profile.profileId, {
      kind: "group",
      groupId: "planning",
      memberAgentIds: ["ada", "librarian"],
      defaultRecipient: { kind: "all" },
    });
    expect(hook.result.current.selectedRef).toEqual(groupRef);

    await act(async () => {
      await expect(
        hook.result.current.submit("compare approaches", { kind: "agent", agentId: "ada" }),
      ).rejects.toThrow("recipient fixture");
    });
    expect(request).toHaveBeenCalledWith("prompt.submit", {
      ref: groupRef,
      text: "compare approaches",
      recipient: { kind: "agent", agentId: "ada" },
      commandId: expect.stringMatching(/^web-/u),
    });
  });

  it("reopens a persisted group with its authoritative revision when no live session exists", async () => {
    const groupRef = {
      profileId: profile.profileId,
      kind: "live",
      key: "ui/group-planning",
    } as const satisfies ZiggySessionRef;
    const openMain = vi.fn().mockResolvedValueOnce(mainRef).mockResolvedValueOnce(groupRef);
    const { client } = makeClient({
      openMain,
      listGroups: vi.fn(async () => ({
        profileId: profile.profileId,
        groups: [
          {
            groupId: "planning",
            conversationId: "conversation-planning",
            hostProfileId: profile.profileId,
            memberAgentIds: ["ada", "librarian"],
            defaultRecipient: { kind: "host" as const },
            revision: 8,
          },
        ],
      })),
    });
    const hook = await connectHook(client);
    await waitFor(() => expect(hook.result.current.groups).toHaveLength(1));

    expect(hook.result.current.groups[0]?.ref).toBeUndefined();
    await act(async () => {
      await hook.result.current.openGroup(hook.result.current.groups[0]!);
    });

    expect(openMain).toHaveBeenLastCalledWith(profile.profileId, {
      kind: "group",
      groupId: "planning",
      memberAgentIds: ["ada", "librarian"],
      defaultRecipient: { kind: "host" },
      expectedRevision: 8,
    });
    expect(hook.result.current.selectedRef).toEqual(groupRef);
  });

  it("restores the selected specialist after a tab refresh without storing transcript state", async () => {
    const first = makeClient({
      listAgents: vi.fn(async () => ({
        profileId: profile.profileId,
        agents: [{ id: "ada", description: "Plans implementation", tools: [] }],
      })),
    });
    const firstHook = await connectHook(first.client);
    await act(async () => {
      await firstHook.result.current.openSpecialist("ada");
    });
    firstHook.unmount();

    const second = makeClient({
      listAgents: vi.fn(async () => ({
        profileId: profile.profileId,
        agents: [{ id: "ada", description: "Plans implementation", tools: [] }],
      })),
    });
    const secondHook = await connectHook(second.client);
    await waitFor(() => expect(secondHook.result.current.selectedRef).toEqual(specialistRef));

    expect(second.fixture.openMain).toHaveBeenCalledExactlyOnceWith(profile.profileId);
    expect(second.fixture.openSpecialist).toHaveBeenCalledExactlyOnceWith(profile.profileId, "ada");
    const saved = sessionStorage.getItem(`ziggy:selected:v1:${profile.profileId}`);
    expect(saved).toContain('"kind":"specialist"');
    expect(saved).not.toContain("Earlier question");
  });

  it("falls back to main and clears a saved target missing from authoritative discovery", async () => {
    sessionStorage.setItem(
      `ziggy:selected:v1:${profile.profileId}`,
      JSON.stringify({ version: 1, target: { kind: "group", groupId: "deleted-room" } }),
    );
    const { client, fixture } = makeClient();
    const hook = await connectHook(client);
    await waitFor(() =>
      expect(sessionStorage.getItem(`ziggy:selected:v1:${profile.profileId}`)).toBeNull(),
    );

    expect(hook.result.current.selectedRef).toEqual(mainRef);
    expect(fixture.openMain).toHaveBeenCalledExactlyOnceWith(profile.profileId);
  });

  it("attaches the reopened live ref to a restored persisted group", async () => {
    const groupRef = {
      profileId: profile.profileId,
      kind: "live",
      key: "ui/group-planning",
    } as const satisfies ZiggySessionRef;
    sessionStorage.setItem(
      `ziggy:selected:v1:${profile.profileId}`,
      JSON.stringify({ version: 1, target: { kind: "group", groupId: "planning" } }),
    );
    const openMain = vi.fn().mockResolvedValueOnce(mainRef).mockResolvedValueOnce(groupRef);
    const { client } = makeClient({
      openMain,
      listGroups: vi.fn(async () => ({
        profileId: profile.profileId,
        groups: [
          {
            groupId: "planning",
            conversationId: "conversation-planning",
            hostProfileId: profile.profileId,
            memberAgentIds: ["ada", "librarian"],
            defaultRecipient: { kind: "all" as const },
            revision: 8,
          },
        ],
      })),
    });
    const hook = await connectHook(client);
    await waitFor(() => expect(hook.result.current.selectedRef).toEqual(groupRef));

    expect(hook.result.current.groups).toContainEqual(
      expect.objectContaining({ groupId: "planning", ref: groupRef }),
    );
    expect(hook.result.current.conversations).toContainEqual(
      expect.objectContaining({ ref: groupRef }),
    );
  });

  it("uses the latest pin revision and updates automation lifecycle after acknowledged actions", async () => {
    const { client, fixture } = makeClient({
      listPins: vi.fn(async () => ({ profileId: profile.profileId, revision: 7, pins: [] })),
      listAutomations: vi.fn(async () => ({
        profileId: profile.profileId,
        automations: [{ id: "morning", valid: true, lifecycle: "active" as const }],
      })),
    });
    const hook = await connectHook(client);
    await waitFor(() => expect(hook.result.current.sidebarLoading).toBe(false));

    await act(async () => {
      await hook.result.current.setConversationPin(mainRef, "Home");
    });
    expect(fixture.setPin).toHaveBeenCalledWith(
      profile.profileId,
      expect.objectContaining({ ref: mainRef, label: "Home", order: 0 }),
      7,
      expect.stringMatching(/^web-pin-/u),
    );

    await act(async () => {
      await hook.result.current.pauseAutomation("morning");
    });
    expect(fixture.pauseAutomation).toHaveBeenCalledWith(
      profile.profileId,
      "morning",
      expect.stringMatching(/^web-automation-/u),
    );
    expect(hook.result.current.automationSections.paused).toEqual([
      { id: "morning", lifecycle: "paused" },
    ]);
  });

  it("clears connecting when the WebSocket constructor throws and permits retry", async () => {
    const { client } = makeClient();
    const connector = vi
      .fn<GatewayConnector>()
      .mockImplementationOnce(() => {
        throw new Error("WebSocket blocked");
      })
      .mockReturnValue(client);
    const hook = renderHook(() => useZiggyGateway(connector));
    await act(async () => {
      await expect(
        hook.result.current.connect({ url: "ws://127.0.0.1:9876/ws", token: "token" }),
      ).rejects.toThrow("WebSocket blocked");
    });
    expect(hook.result.current.connection).toBe("closed");
    expect(hook.result.current.localError).toBe("WebSocket blocked");
    await act(async () => {
      await hook.result.current.connect({ url: "ws://127.0.0.1:9876/ws", token: "token" });
    });
    expect(hook.result.current.connection).toBe("open");
  });

  it("closes a failed bootstrap client so its reconnect loop cannot survive", async () => {
    const { client, fixture } = makeClient({
      state: "reconnecting",
      capabilities: vi.fn(async () => {
        throw new Error("request timed out");
      }),
    });
    const connector: GatewayConnector = () => client;
    const hook = renderHook(() => useZiggyGateway(connector));

    await act(async () => {
      await expect(
        hook.result.current.connect({ url: "ws://stale/ws", token: "expired" }),
      ).rejects.toThrow("request timed out");
    });

    expect(fixture.close).toHaveBeenCalledOnce();
    expect(hook.result.current.connection).toBe("closed");
    expect(hook.result.current.localError).toBe(
      "Could not connect. Check the endpoint and current runtime token.",
    );
  });

  it("keeps a recovered client alive when reconnect succeeds before the grace period", async () => {
    vi.useFakeTimers();
    let transportState: GatewayClient["state"] = "open";
    let emit: ((event: ZiggyClientEvent) => void) | undefined;
    const { client, fixture } = makeClient({
      onAny: vi.fn((handler) => {
        emit = handler;
        return () => undefined;
      }),
    });
    Object.defineProperty(client, "state", { get: () => transportState });
    const hook = await connectHook(client);

    act(() => {
      transportState = "reconnecting";
      emit?.({ event: "connection-state", state: "reconnecting" });
    });
    act(() => vi.advanceTimersByTime(9_999));
    expect(fixture.close).not.toHaveBeenCalled();

    act(() => {
      transportState = "open";
      emit?.({ event: "connection-state", state: "open" });
    });
    act(() => vi.advanceTimersByTime(1));

    expect(hook.result.current.connection).toBe("open");
    expect(fixture.close).not.toHaveBeenCalled();
    expect(hook.result.current.history).toEqual(initialHistory);
  });

  it("stops an unrecovered client after the grace period and blocks sidebar mutations", async () => {
    vi.useFakeTimers();
    let transportState: GatewayClient["state"] = "open";
    let emit: ((event: ZiggyClientEvent) => void) | undefined;
    const { client, fixture } = makeClient({
      onAny: vi.fn((handler) => {
        emit = handler;
        return () => undefined;
      }),
    });
    Object.defineProperty(client, "state", { get: () => transportState });
    const hook = await connectHook(client);

    act(() => {
      transportState = "reconnecting";
      emit?.({ event: "connection-state", state: "reconnecting" });
    });
    await act(async () => {
      await expect(hook.result.current.pauseAutomation("morning")).rejects.toThrow(
        "Wait for the connection before making changes",
      );
    });
    expect(fixture.pauseAutomation).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(10_000));

    expect(fixture.close).toHaveBeenCalledOnce();
    expect(hook.result.current.connection).toBe("closed");
    expect(hook.result.current.localError).toBe(
      "Connection lost. Reconnect with current endpoint and runtime token.",
    );
    expect(hook.result.current.history).toEqual(initialHistory);
  });

  it("keeps a persistent browser connection reconnecting beyond the legacy grace period", async () => {
    vi.useFakeTimers();
    let transportState: GatewayClient["state"] = "open";
    let emit: ((event: ZiggyClientEvent) => void) | undefined;
    const { client, fixture } = makeClient({
      onAny: vi.fn((handler) => {
        emit = handler;
        return () => undefined;
      }),
    });
    Object.defineProperty(client, "state", { get: () => transportState });
    const connector: GatewayConnector = () => client;
    const hook = renderHook(() => useZiggyGateway(connector));
    await act(async () => {
      await hook.result.current.connect({
        persistent: true,
        url: "ws://127.0.0.1:9876/ws",
      });
    });

    act(() => {
      transportState = "reconnecting";
      emit?.({ event: "connection-state", state: "reconnecting" });
      vi.advanceTimersByTime(30_000);
    });
    expect(fixture.close).not.toHaveBeenCalled();
    expect(hook.result.current.connection).toBe("reconnecting");

    act(() => {
      transportState = "open";
      emit?.({ event: "connection-state", state: "open" });
    });
    expect(hook.result.current.connection).toBe("open");
  });

  it("keeps a watch failure visible after history loads without marking transport offline", async () => {
    const { client } = makeClient({
      watchSession: vi.fn(async () => {
        throw new Error("replay window unavailable");
      }),
    });
    const hook = await connectHook(client);

    expect(hook.result.current.connection).toBe("open");
    expect(hook.result.current.history).toEqual(initialHistory);
    expect(hook.result.current.localError).toBe(
      "Live updates unavailable: replay window unavailable",
    );
  });

  it("ignores a stale connection bootstrap that resolves after a newer connection", async () => {
    const staleCapabilities = deferred<Awaited<ReturnType<GatewayClient["capabilities"]>>>();
    const staleProfile = {
      profileId: "prf_stale",
      name: "Stale",
      current: true,
      available: true,
    } as const satisfies ZiggyProfileSummary;
    const staleRef = {
      profileId: staleProfile.profileId,
      kind: "live",
      key: "local/main",
    } as const satisfies ZiggySessionRef;
    const stale = makeClient({
      capabilities: vi.fn(() => staleCapabilities.promise),
      listProfiles: vi.fn(async () => ({ profiles: [staleProfile] })),
      currentProfile: vi.fn(async () => ({
        profileId: staleProfile.profileId,
        name: staleProfile.name,
      })),
      openMain: vi.fn(async () => staleRef),
      listSessions: vi.fn(async () => ({
        profileId: staleProfile.profileId,
        live: [],
        stored: [],
      })),
    });
    const current = makeClient();
    const connector = vi
      .fn<GatewayConnector>()
      .mockReturnValueOnce(stale.client)
      .mockReturnValueOnce(current.client);
    const hook = renderHook(() => useZiggyGateway(connector));

    let staleConnect: Promise<void> | undefined;
    act(() => {
      staleConnect = hook.result.current.connect({ url: "ws://stale/ws", token: "stale" });
    });
    await act(async () => {
      await hook.result.current.connect({ url: "ws://current/ws", token: "current" });
    });
    staleCapabilities.resolve(capabilitiesResult(staleProfile.profileId, 1_000));
    await act(async () => {
      await staleConnect;
    });

    expect(hook.result.current.profile).toEqual(profile);
    expect(hook.result.current.selectedRef).toEqual(mainRef);
    expect(hook.result.current.selectedTitle).toBe("Squarey");
    expect(hook.result.current.maxPromptCodePoints).toBe(60_000);
  });

  it("ignores history that resolves after a newer conversation selection", async () => {
    const oldHistory = deferred<Awaited<ReturnType<GatewayClient["getSessionHistory"]>>>();
    const storedA = {
      profileId: profile.profileId,
      kind: "stored",
      id: "stored-a",
    } as const satisfies ZiggySessionRef;
    const storedB = {
      profileId: profile.profileId,
      kind: "stored",
      id: "stored-b",
    } as const satisfies ZiggySessionRef;
    const historyB = [
      { kind: "assistant", timestamp: "2026-09-15T13:00:00.000Z", text: "Current history" },
    ] as const satisfies ReadonlyArray<ZiggySessionHistoryEntry>;
    const { client, fixture } = makeClient({
      getSessionHistory: vi.fn(async (ref) => {
        if (ref.kind === "stored" && ref.id === storedA.id) return oldHistory.promise;
        return historyResult(ref, ref.kind === "stored" ? historyB : initialHistory);
      }),
    });
    const hook = await connectHook(client);
    const conversationA: ConversationSummary = {
      ref: storedA,
      title: "Old selection",
      subtitle: "Past conversation",
      active: false,
    };
    const conversationB: ConversationSummary = {
      ref: storedB,
      title: "Current selection",
      subtitle: "Past conversation",
      active: false,
    };

    let selectA: Promise<void> | undefined;
    act(() => {
      selectA = hook.result.current.selectConversation(conversationA);
    });
    await act(async () => {
      await hook.result.current.selectConversation(conversationB);
    });
    oldHistory.resolve(
      historyResult(storedA, [
        { kind: "assistant", timestamp: "2026-09-15T12:30:00.000Z", text: "Stale" },
      ]),
    );
    await act(async () => {
      await selectA;
    });

    expect(fixture.unwatchSession).toHaveBeenCalledWith(mainRef);
    expect(hook.result.current.selectedRef).toEqual(storedB);
    expect(hook.result.current.selectedTitle).toBe("Current selection");
    expect(hook.result.current.history).toEqual(historyB);
  });

  it("creates and pins a separate named chat without reopening main", async () => {
    const ref = { profileId: profile.profileId, kind: "live", key: "ui/chat-test" } as const;
    const { client, fixture } = makeClient();
    const request = vi.spyOn(client, "request").mockResolvedValue({ ref });
    const hook = await connectHook(client);
    await act(async () => {
      await hook.result.current.createChat("Planning");
    });
    expect(request).toHaveBeenCalledWith(
      "session.open",
      expect.objectContaining({
        name: expect.stringMatching(/^chat-/u),
        context: { kind: "local" },
      }),
    );
    expect(fixture.setPin).toHaveBeenCalledWith(
      profile.profileId,
      expect.objectContaining({ ref, label: "Planning" }),
      expect.any(Number),
      expect.any(String),
    );
    expect(hook.result.current.selectedRef).toEqual(ref);
    expect(hook.result.current.selectedTitle).toBe("Planning");
    expect(fixture.openMain).toHaveBeenCalledTimes(1);
  });

  it("steers by default while busy and explicitly queues follow-ups", async () => {
    const { client, fixture } = makeClient();
    const hook = await connectHook(client);
    await act(async () => {
      await hook.result.current.submit("Start");
    });
    await act(async () => {
      await hook.result.current.submit("Change direction");
    });
    await act(async () => {
      await hook.result.current.submit("Next task", undefined, "queue");
    });
    expect(fixture.submitPrompt).toHaveBeenCalledTimes(1);
    expect(fixture.steerSession).toHaveBeenCalledWith(
      mainRef,
      "Change direction",
      expect.any(String),
    );
    expect(fixture.followUp).toHaveBeenCalledWith(mainRef, "Next task", expect.any(String));
    expect(hook.result.current.pendingInputs.map((input) => input.mode)).toEqual([
      "steer",
      "queue",
    ]);
    expect(hook.result.current.busy).toBe(true);
  });

  it("preserves the selected conversation and transcript when send outcome is unknown", async () => {
    const outcomeUnknown = new ZiggyRequestOutcomeUnknownError("prompt.submit", {
      ref: mainRef,
      text: "New question",
      commandId: "web-test",
    });
    const { client } = makeClient({
      submitPrompt: vi.fn(async () => {
        throw outcomeUnknown;
      }),
    });
    const hook = await connectHook(client);

    await act(async () => {
      await expect(hook.result.current.submit("New question")).rejects.toBe(outcomeUnknown);
    });

    expect(hook.result.current.connection).toBe("open");
    expect(hook.result.current.selectedRef).toEqual(mainRef);
    expect(hook.result.current.history).toEqual(initialHistory);
    expect(hook.result.current.localError).toBe(
      "The connection closed after send. Check the conversation before sending again.",
    );
  });

  it("scopes automation detail runs to the selected automation", async () => {
    const selectedRun = automationRun("morning-weather", 200);
    const unrelatedRun = automationRun("mail-digest", 300);
    const { client } = makeClient({
      listAutomationRuns: vi.fn(async () => ({
        profileId: profile.profileId,
        runs: [unrelatedRun, selectedRun],
      })),
    });
    const hook = await connectHook(client);

    await act(async () => hook.result.current.loadAutomationDetail("morning-weather"));

    expect(hook.result.current.automationDetail?.automationId).toBe("morning-weather");
    expect(hook.result.current.automationDetail?.runs).toEqual([selectedRun]);
  });

  it("discards automation detail that resolves after a newer selection", async () => {
    const staleDefinition = deferred<Awaited<ReturnType<GatewayClient["showAutomation"]>>>();
    const { client } = makeClient({
      showAutomation: vi.fn(async (_profileId, automationId) => {
        if (automationId === "morning-weather") return staleDefinition.promise;
        return {
          profileId: profile.profileId,
          id: automationId,
          lifecycle: "paused" as const,
          source: "Read mail.",
        };
      }),
    });
    const hook = await connectHook(client);

    let staleLoad: Promise<void> | undefined;
    act(() => {
      staleLoad = hook.result.current.loadAutomationDetail("morning-weather");
    });
    await act(async () => hook.result.current.loadAutomationDetail("mail-digest"));
    staleDefinition.resolve({
      profileId: profile.profileId,
      id: "morning-weather",
      lifecycle: "active",
      source: "Check weather.",
    });
    await act(async () => staleLoad);

    expect(hook.result.current.automationDetail?.automationId).toBe("mail-digest");
    expect(hook.result.current.automationDetail?.definition?.source).toBe("Read mail.");
  });

  it("keeps available automation detail when run history fails", async () => {
    const { client } = makeClient({
      listAutomationRuns: vi.fn(async () => {
        throw new Error("run journal unavailable");
      }),
    });
    const hook = await connectHook(client);

    await act(async () => hook.result.current.loadAutomationDetail("morning-weather"));

    expect(hook.result.current.automationDetail?.definition?.id).toBe("morning-weather");
    expect(hook.result.current.automationDetail?.status?.lastTickStatus).toBe("ok");
    expect(hook.result.current.automationDetail?.runs).toEqual([]);
    expect(hook.result.current.automationDetail?.errors).toEqual([
      { source: "runs", message: "run journal unavailable" },
    ]);
  });

  it("saves automation source with the displayed source as the CAS expectation", async () => {
    const oldSource = "---\nversion: 1\ncron: 0 8 * * *\n---\nOld task.\n";
    const newSource = "---\nversion: 1\ncron: 30 8 * * *\n---\nNew task.\n";
    const saveAutomation = vi.fn(async (_profileId, id, source) => ({
      profileId: profile.profileId,
      id,
      lifecycle: "active" as const,
      source,
    }));
    const { client } = makeClient({
      saveAutomation,
      showAutomation: vi.fn(async (_profileId, id) => ({
        profileId: profile.profileId,
        id,
        lifecycle: "active" as const,
        source: oldSource,
      })),
    });
    const hook = await connectHook(client);
    await act(async () => hook.result.current.loadAutomationDetail("morning-weather"));

    await act(async () =>
      hook.result.current.saveAutomationDefinition("morning-weather", newSource, oldSource),
    );

    expect(saveAutomation).toHaveBeenCalledWith(
      profile.profileId,
      "morning-weather",
      newSource,
      oldSource,
      expect.stringMatching(/^web-automation-save-/),
    );
    expect(hook.result.current.automationDetail?.definition?.source).toBe(newSource);
  });

  it("does not apply a saved definition after automation detail selection changes", async () => {
    const saved = deferred<Awaited<ReturnType<GatewayClient["saveAutomation"]>>>();
    const { client } = makeClient({
      saveAutomation: vi.fn(async () => saved.promise),
    });
    const hook = await connectHook(client);
    await act(async () => hook.result.current.loadAutomationDetail("morning-weather"));

    let save: Promise<void> | undefined;
    act(() => {
      save = hook.result.current.saveAutomationDefinition(
        "morning-weather",
        "Updated weather.",
        "Check the weather.",
      );
    });
    await act(async () => hook.result.current.loadAutomationDetail("mail-digest"));
    saved.resolve({
      profileId: profile.profileId,
      id: "morning-weather",
      lifecycle: "active",
      source: "Updated weather.",
    });
    await act(async () => save);

    expect(hook.result.current.automationDetail?.automationId).toBe("mail-digest");
    expect(hook.result.current.automationDetail?.definition?.source).not.toBe("Updated weather.");
  });

  it("loads and saves an agent definition with the displayed source expectation", async () => {
    const oldSource = "---\nversion: 1\ndescription: Researcher\n---\n\nResearch carefully.\n";
    const newSource =
      "---\nversion: 1\ndescription: Evidence-first researcher\n---\n\nResearch carefully.\n";
    const saveAgent = vi.fn(async (_profileId, id, source) => ({
      profileId: profile.profileId,
      id,
      source,
    }));
    const { client } = makeClient({
      readAgentDocument: vi.fn(async (_profileId, id) => ({
        profileId: profile.profileId,
        id,
        source: oldSource,
      })),
      saveAgent,
    });
    const hook = await connectHook(client);
    await act(async () => hook.result.current.loadAgentDefinition("researcher"));

    await act(async () =>
      hook.result.current.saveAgentDefinition("researcher", newSource, oldSource),
    );

    expect(saveAgent).toHaveBeenCalledWith(
      profile.profileId,
      "researcher",
      newSource,
      oldSource,
      expect.stringMatching(/^web-agent-save-/),
    );
    expect(hook.result.current.agentDefinitionDetail?.document?.source).toBe(newSource);
  });

  it("does not restore a saved agent document after its editor closes", async () => {
    const saved = deferred<Awaited<ReturnType<GatewayClient["saveAgent"]>>>();
    const { client } = makeClient({ saveAgent: vi.fn(async () => saved.promise) });
    const hook = await connectHook(client);
    await act(async () => hook.result.current.loadAgentDefinition("researcher"));

    let save: Promise<void> | undefined;
    act(() => {
      save = hook.result.current.saveAgentDefinition(
        "researcher",
        "Updated researcher.",
        "Research carefully.",
      );
    });
    act(() => hook.result.current.clearAgentDefinition());
    saved.resolve({
      profileId: profile.profileId,
      id: "researcher",
      source: "Updated researcher.",
    });
    await act(async () => save);

    expect(hook.result.current.agentDefinitionDetail).toBeUndefined();
  });
});
