import type {
  ZiggyClientEvent,
  ZiggyProfileId,
  ZiggySessionHistoryEntry,
  ZiggySessionRef,
} from "../../../../packages/ui-sdk/src/index";
import type { GatewayClient, GatewayConnector } from "@/gateway";

/** Named sample states the gallery renders the real app against. */
export const fixtureScenarios = ["conversation", "working", "empty"] as const;
export type FixtureScenario = (typeof fixtureScenarios)[number];

export const isFixtureScenario = (value: string | null): value is FixtureScenario =>
  fixtureScenarios.some((scenario) => scenario === value);

const profileId: ZiggyProfileId = "prf_000000000000000000000001";
const profileName = "Squarey";
const epoch = "fixture-epoch";
const mainRef = { profileId, kind: "live", key: "local/main" } as const satisfies ZiggySessionRef;

const at = (minute: number): string => new Date(Date.UTC(2026, 8, 30, 15, minute)).toISOString();

const conversation: ReadonlyArray<ZiggySessionHistoryEntry> = [
  { kind: "user", timestamp: at(40), text: "What creative tools are installed on this machine?" },
  { kind: "tool", timestamp: at(40), toolName: "bash", phase: "start", failed: false },
  { kind: "tool", timestamp: at(41), toolName: "bash", phase: "end", failed: false },
  { kind: "tool", timestamp: at(41), toolName: "read", phase: "end", failed: false },
  {
    kind: "assistant",
    timestamp: at(42),
    text: [
      "Yes, Blender and CAD tools really are installed. I checked each one itself. Here's the practical inventory:",
      "",
      "**3D / CAD / engineering**",
      "",
      "- Blender 4.3.2, including working headless Python",
      "- OpenSCAD 2021.01",
      "- FreeCAD 1.0: Python geometry works, but its CLI launchers crash here",
      "- KiCad CLI 9.0.2 for circuit boards",
      "",
      "**Images / video / OCR**",
      "",
      "- ImageMagick, FFmpeg and ffprobe",
      "- Tesseract and OCRmyPDF",
    ].join("\n"),
  },
  { kind: "user", timestamp: at(45), text: "Great. Keep an eye on the weather for Saturday?" },
  {
    kind: "assistant",
    timestamp: at(46),
    text: "Done. I'll check the forecast every morning at 8 and tell you if rain shows up.",
  },
  {
    kind: "automation-result",
    timestamp: at(47),
    automationId: "morning-weather",
    runId: "run-1",
    text: "Saturday looks clear: 21°C, light wind, 5% chance of rain.",
  },
];

const histories = (scenario: FixtureScenario): Map<string, Array<ZiggySessionHistoryEntry>> =>
  new Map([["local/main", scenario === "empty" ? [] : [...conversation]]]);

const refKey = (ref: ZiggySessionRef): string => (ref.kind === "live" ? ref.key : ref.id);

/**
 * A local stand-in for the resident gateway. It answers every client call with sample data and
 * replays a short streamed reply on submit, so the gallery exercises the real hook and App.
 */
export const fixtureConnector =
  (scenario: FixtureScenario): GatewayConnector =>
  () => {
    const store = histories(scenario);
    const listeners = new Set<(event: ZiggyClientEvent) => void>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let seq = 0;

    const emit = (event: ZiggyClientEvent): void => {
      for (const listener of listeners) listener(event);
    };
    const later = (ms: number, run: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    };
    const base = (session: ZiggySessionRef) => ({
      eventId: `fixture-${++seq}`,
      epoch,
      seq,
      profileId,
      session,
    });
    const streamReply = (session: ZiggySessionRef, reply: string, settle: boolean): void => {
      emit({
        ...base(session),
        event: "tool",
        payload: {
          phase: "start",
          toolCallId: `tool-${seq}`,
          toolName: "web_search",
          failed: false,
        },
      });
      const words = reply.split(" ");
      words.forEach((_, index) =>
        later(250 + index * 60, () => {
          const snapshot = words.slice(0, index + 1).join(" ");
          emit({ ...base(session), event: "assistant-text", payload: { delta: "", snapshot } });
        }),
      );
      if (!settle) return;
      later(400 + words.length * 60, () => {
        store.get(refKey(session))?.push({ kind: "assistant", timestamp: at(50), text: reply });
        emit({ ...base(session), event: "settled", payload: {} });
      });
    };
    const submit = async (
      session: ZiggySessionRef,
      text: string,
      images?: ReadonlyArray<string>,
    ): Promise<void> => {
      store.get(refKey(session))?.push({
        kind: "user",
        timestamp: at(49),
        text,
        ...(images === undefined ? {} : { imageCount: images.length }),
      });
      streamReply(session, `You said: “${text}”. This reply comes from the gallery fixture.`, true);
    };

    const client: GatewayClient = {
      state: "open",
      close: () => {
        for (const timer of timers) clearTimeout(timer);
        listeners.clear();
      },
      onAny: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      capabilities: async () => ({
        protocolVersion: 1,
        defaultProfileId: profileId,
        serverEpoch: epoch,
        methods: [],
        events: [],
        bounds: { maxPromptCodePoints: 60_000, replayWindow: 256, maxHistoryEntries: 64 },
      }),
      listProfiles: async () => ({
        profiles: [{ profileId, name: profileName, current: true, available: true }],
      }),
      currentProfile: async () => ({ profileId, name: profileName, cliTarget: "squarey" }),
      openMain: async () => mainRef,
      openSpecialist: async (_profile, agentId) => {
        const ref = { profileId, kind: "live", key: `local/agents/${agentId}` } as const;
        if (!store.has(ref.key)) store.set(ref.key, []);
        return ref;
      },
      listSessions: async () => ({
        profileId,
        live: [{ ref: mainRef, kind: "ui", idle: scenario !== "working" }],
        stored: [],
      }),
      listSessionSummaries: async () => ({
        profileId,
        canResume: true,
        currentSessionId: null,
        sessions: [],
        truncated: false,
      }),
      resumeSession: async (ref, sessionId) => ({ profileId, ref, sessionId, cancelled: false }),
      getSessionHistory: async (ref) => ({
        profileId,
        ref,
        entries: [...(store.get(refKey(ref)) ?? [])],
        terminalState: "completed",
        truncated: false,
        hasMore: false,
      }),
      watchSession: async (ref) => {
        if (scenario === "working" && refKey(ref) === "local/main")
          streamReply(
            ref,
            "Checking the forecast for Saturday across three sources before I set this up…",
            false,
          );
      },
      unwatchSession: async () => undefined,
      uploadImage: async () => crypto.randomUUID(),
      callAppTool: async () => {
        throw new Error("The gallery has no MCP servers.");
      },
      readAppResource: async () => {
        throw new Error("The gallery has no MCP servers.");
      },
      submitPrompt: async (ref, text, _commandId, attachments) =>
        submit(ref, text, attachments?.images),
      steerSession: async (ref, text, _commandId, attachments) =>
        submit(ref, text, attachments?.images),
      followUp: async (ref, text, _commandId, attachments) =>
        submit(ref, text, attachments?.images),
      abortSession: async (ref) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        emit({ ...base(ref), event: "settled", payload: {} });
      },
      request: async () => {
        throw new Error("The gallery fixture does not answer raw gateway requests.");
      },
      listAgents: async () => ({
        profileId,
        agents: [
          {
            id: "researcher",
            description: "Finds and checks sources for Squarey.",
            tools: ["read", "web_search"],
          },
          { id: "arty", description: "Makes slides, docs and trackers.", tools: ["write"] },
        ],
      }),
      readAgentDocument: async (_profile, id) => ({
        profileId,
        id,
        source: `---\nversion: 1\ndescription: ${id}\n---\n\nHelp carefully.\n`,
      }),
      saveAgent: async (_profile, id, source) => ({ profileId, id, source }),
      listGroups: async () => ({
        profileId,
        groups: [
          {
            groupId: "weekend-plans",
            conversationId: "weekend-plans",
            hostProfileId: profileId,
            memberAgentIds: ["researcher", "arty"],
            defaultRecipient: { kind: "all" },
            revision: 1,
          },
        ],
      }),
      listPins: async () => ({ profileId, pins: [], revision: 0 }),
      setPin: async (_profile, pin, revision) => ({
        profileId,
        pins: [pin],
        revision: revision + 1,
      }),
      removePin: async () => ({ profileId, pins: [], revision: 1 }),
      listAutomations: async () => ({
        profileId,
        automations: [
          {
            id: "morning-weather",
            valid: true,
            lifecycle: "active",
            schedule: "0 8 * * *",
          },
          {
            id: "weekly-review",
            valid: true,
            lifecycle: "paused",
            schedule: "0 17 * * 5",
          },
        ],
      }),
      showAutomation: async (_profile, id) => ({
        profileId,
        id,
        lifecycle: "active",
        source: "---\nschedule: 0 8 * * *\n---\nCheck Saturday's forecast.",
      }),
      saveAutomation: async (_profile, id, source) => ({
        profileId,
        id,
        lifecycle: "active",
        source,
      }),
      automationStatus: async () => ({
        profileId,
        observedAtMs: 1_790_000_000_000,
        heartbeatAtMs: 1_790_000_000_000,
        lastTickAtMs: 1_790_000_000_000,
        lastTickStatus: "ok",
        lastTickError: null,
        schedules: [],
        activeRunCount: 0,
        latestRun: null,
        latestErrorRun: null,
      }),
      listAutomationRuns: async () => ({ profileId, runs: [] }),
      pauseAutomation: async (_profile, id) => ({ profileId, id, lifecycle: "paused" }),
      resumeAutomation: async (_profile, id) => ({ profileId, id, lifecycle: "active" }),
      runAutomation: async (_profile, automationId) => ({
        profileId,
        automationId,
        accepted: true,
        outcome: "executed",
        runOutcome: { kind: "executed", delivery: { kind: "resolved", targets: [] } },
      }),
      listDestinations: async () => ({ profileId, entries: [] }),
      listExtensionsForProfile: async () => ({
        profileId,
        available: [],
        selected: [],
        skipped: [],
        truncated: false,
      }),
      addExtension: async (_profile, id) => ({
        profileId,
        id,
        changed: true,
        selected: true,
        restartRequired: true,
      }),
      removeExtension: async (_profile, id) => ({
        profileId,
        id,
        changed: true,
        selected: false,
        restartRequired: true,
      }),
      modelStatus: async () => ({
        profileId,
        providerId: "openai",
        modelId: "gpt-5",
        thinking: "medium",
        authConfigured: true,
      }),
      listModels: async () => ({ profileId, models: fixtureModels, truncated: false }),
      availableModels: async () => ({ profileId, models: fixtureModels, truncated: false }),
      setModel: async (_profile, providerId, modelId, thinking) => ({
        profileId,
        providerId,
        modelId,
        thinking: thinking ?? null,
      }),
      authStatus: async () => ({
        profileId,
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            supportsApiKeyLogin: true,
            supportsOauth: true,
            configured: true,
            type: "oauth",
          },
        ],
      }),
      sessionModelStatus: async (ref) => ({
        profileId,
        ref,
        providerId: "openai",
        modelId: "gpt-5",
        thinking: "medium",
      }),
      setSessionModel: async (ref, providerId, modelId) => ({
        profileId,
        ref,
        providerId,
        modelId,
        thinking: "medium",
      }),
      setSessionThinking: async (ref, thinking) => ({
        profileId,
        ref,
        providerId: "openai",
        modelId: "gpt-5",
        thinking,
      }),
    };
    return client;
  };

const fixtureModels = [
  {
    providerId: "openai",
    modelId: "gpt-5",
    name: "GPT-5",
    thinkingLevels: ["low", "medium", "high"] as const,
  },
];
