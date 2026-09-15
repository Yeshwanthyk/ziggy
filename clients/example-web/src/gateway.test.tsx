/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- React hook tests own disposable Promise fixtures and rejection cases at the test boundary. */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZiggyRequestOutcomeUnknownError,
  type ZiggyProfileId,
  type ZiggyProfileSummary,
  type ZiggySessionHistoryEntry,
  type ZiggySessionHistoryResult,
  type ZiggySessionRef,
  type ZiggySessionListResult,
  type ZiggySystemCapabilitiesResult,
} from "../../gateway-client/src/index";
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
    listSessions: vi.fn(async () => sessionListResult()),
    watchSession: vi.fn(async () => undefined),
    unwatchSession: vi.fn(async () => undefined),
    getSessionHistory: vi.fn(async (ref) => historyResult(ref)),
    submitPrompt: vi.fn(async () => undefined),
    abortSession: vi.fn(async () => undefined),
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

afterEach(cleanup);

beforeEach(() => vi.restoreAllMocks());

describe("useZiggyGateway", () => {
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
});
