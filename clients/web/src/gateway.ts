import {
  connectZiggy,
  dedupeSessionHistoryEntries,
  isSessionReference,
  mergeSessionHistoryEntries,
  ZiggyRequestOutcomeUnknownError,
  ZiggyGatewayError,
  type ZiggyAutomationDefinition,
  type ZiggyAutomationDestination,
  type ZiggyAutomationDocument,
  type ZiggyAutomationRun,
  type ZiggyAutomationStatusResult,
  type ZiggyClientEvent,
  type ZiggyConversationContext,
  type ZiggyGatewayClient,
  type ZiggyExtensionListResult,
  type ZiggyGatewayEvent,
  type ZiggyAgentDocument,
  type ZiggyModelDescriptor,
  type ZiggyModelStatusResult,
  type ZiggyModelThinkingLevel,
  type ZiggyPin,
  type ZiggyProviderAuthStatus,
  type ZiggyProfileAgent,
  type ZiggyProfileSummary,
  type ZiggyRecipientId,
  type ZiggySessionHistoryEntry,
  type ZiggySessionListResult,
  type ZiggySessionModelResult,
  type ZiggySessionSummaryResult,
  type ZiggySessionRef,
  type ZiggyAppContext,
  type ZiggyJsonValue,
  type ZiggyToolApp,
} from "../../../packages/ui-sdk/src/index";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ConversationSummary {
  readonly ref: ZiggySessionRef;
  readonly title: string;
  readonly subtitle: string;
  readonly active: boolean;
}

export interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly failed: boolean;
  readonly phase: "start" | "update" | "end";
  readonly app?: ZiggyToolApp;
}

export interface PinnedConversationSummary extends ConversationSummary {
  readonly pinId: string;
}

export type AutomationDestinationOption = ZiggyAutomationDestination;

export interface AgentSummary {
  readonly id: string;
  readonly description: string;
}

export interface AgentDefinitionDetail {
  readonly agentId: string;
  readonly document?: ZiggyAgentDocument;
  readonly error?: string;
  readonly loading: boolean;
}

export interface GroupConversationSummary {
  readonly ref?: Extract<ZiggySessionRef, { readonly kind: "live" }>;
  readonly groupId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly memberAgentIds: ReadonlyArray<string>;
  readonly defaultRecipient?: ZiggyRecipientId;
  readonly revision: number;
  readonly active: boolean;
}

export interface OpenGroupInput {
  readonly groupId: string;
  readonly memberAgentIds: ReadonlyArray<string>;
  readonly defaultRecipient?: ZiggyRecipientId;
  readonly expectedRevision?: number;
  readonly title?: string;
}

export interface AutomationSummary {
  readonly id: string;
  readonly gateState?: ZiggyAutomationDefinition["gateState"];
  readonly lifecycle: ZiggyAutomationDefinition["lifecycle"];
  readonly schedule?: string;
  readonly timezone?: string;
  readonly message?: string;
}

export interface AutomationSections {
  readonly active: ReadonlyArray<AutomationSummary>;
  readonly paused: ReadonlyArray<AutomationSummary>;
  readonly attention: ReadonlyArray<AutomationSummary>;
}

export interface AutomationDetailError {
  readonly source: "definition" | "runs" | "scheduler";
  readonly message: string;
}

export interface AutomationDetail {
  readonly automationId: string;
  readonly definition?: ZiggyAutomationDocument;
  readonly errors: ReadonlyArray<AutomationDetailError>;
  readonly loading: boolean;
  readonly runs: ReadonlyArray<ZiggyAutomationRun>;
  readonly status?: ZiggyAutomationStatusResult;
}

export interface ConnectInput {
  readonly persistent?: boolean;
  readonly url: string;
  readonly token?: string;
}

export interface ModelSettingsState {
  readonly extensions?: ZiggyExtensionListResult;
  readonly extensionNotice?: string;
  readonly extensionBusy?: string;
  readonly restartRequired?: boolean;
  readonly availableModels: ReadonlyArray<ZiggyModelDescriptor>;
  readonly error?: string;
  readonly loading: boolean;
  readonly models: ReadonlyArray<ZiggyModelDescriptor>;
  readonly providers: ReadonlyArray<ZiggyProviderAuthStatus>;
  readonly saving: boolean;
  readonly status?: ZiggyModelStatusResult;
}

export type GatewayClient = Pick<
  ZiggyGatewayClient,
  | "abortSession"
  | "capabilities"
  | "close"
  | "currentProfile"
  | "getSessionHistory"
  | "listAgents"
  | "listAutomationRuns"
  | "listAutomations"
  | "listGroups"
  | "listModels"
  | "listExtensionsForProfile"
  | "addExtension"
  | "removeExtension"
  | "listDestinations"
  | "listPins"
  | "listProfiles"
  | "listSessions"
  | "sessionModelStatus"
  | "setSessionModel"
  | "setSessionThinking"
  | "listSessionSummaries"
  | "resumeSession"
  | "modelStatus"
  | "onAny"
  | "openMain"
  | "openSpecialist"
  | "pauseAutomation"
  | "removePin"
  | "request"
  | "resumeAutomation"
  | "runAutomation"
  | "saveAutomation"
  | "readAgentDocument"
  | "saveAgent"
  | "showAutomation"
  | "automationStatus"
  | "setPin"
  | "setModel"
  | "state"
  | "uploadImage"
  | "submitPrompt"
  | "steerSession"
  | "followUp"
  | "unwatchSession"
  | "watchSession"
  | "availableModels"
  | "authStatus"
  | "callAppTool"
  | "readAppResource"
>;

export type GatewayConnector = (input: ConnectInput) => GatewayClient;

const defaultConnector: GatewayConnector = (input) => connectZiggy(input);

const listAutomationDestinations = async (
  client: GatewayClient,
  profileId: ZiggyProfileSummary["profileId"],
): Promise<ReadonlyArray<AutomationDestinationOption>> => {
  const entries: Array<AutomationDestinationOption> = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  while (true) {
    const page = await client.listDestinations(profileId, after);
    entries.push(...page.entries);
    if (page.nextCursor === undefined) return entries;
    if (seenCursors.has(page.nextCursor))
      throw new Error("Destination pagination did not advance.");
    seenCursors.add(page.nextCursor);
    after = page.nextCursor;
  }
};

const RECONNECT_GRACE_PERIOD_MS = 10_000;
const SELECTION_STORAGE_PREFIX = "ziggy:selected:v1:";
const PROFILE_STORAGE_PREFIX = "ziggy:profile:v1:";

type StoredSelectionTarget =
  | { readonly kind: "main" }
  | { readonly kind: "specialist"; readonly agentId: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "ref"; readonly ref: ZiggySessionRef };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeStoredSelection = (value: unknown): StoredSelectionTarget | undefined => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.target)) return undefined;
  const target = value.target;
  if (target.kind === "main" && Object.keys(target).length === 1) return { kind: "main" };
  if (
    target.kind === "specialist" &&
    typeof target.agentId === "string" &&
    target.agentId.length > 0 &&
    Object.keys(target).length === 2
  )
    return { kind: "specialist", agentId: target.agentId };
  if (
    target.kind === "group" &&
    typeof target.groupId === "string" &&
    target.groupId.length > 0 &&
    Object.keys(target).length === 2
  )
    return { kind: "group", groupId: target.groupId };
  if (target.kind === "ref" && isSessionReference(target.ref) && Object.keys(target).length === 2)
    return { kind: "ref", ref: target.ref };
  return undefined;
};

const readStoredSelection = (
  profileId: ZiggyProfileSummary["profileId"],
): StoredSelectionTarget | undefined => {
  try {
    const encoded = globalThis.sessionStorage?.getItem(`${SELECTION_STORAGE_PREFIX}${profileId}`);
    return encoded === null || encoded === undefined
      ? undefined
      : decodeStoredSelection(JSON.parse(encoded));
  } catch {
    return undefined;
  }
};

const writeStoredSelection = (
  profileId: ZiggyProfileSummary["profileId"],
  target: StoredSelectionTarget,
): void => {
  try {
    globalThis.sessionStorage?.setItem(
      `${SELECTION_STORAGE_PREFIX}${profileId}`,
      JSON.stringify({ version: 1, target }),
    );
  } catch {
    // Selection persistence is optional when tab storage is unavailable.
  }
};

const clearStoredSelection = (profileId: ZiggyProfileSummary["profileId"]): void => {
  try {
    globalThis.sessionStorage?.removeItem(`${SELECTION_STORAGE_PREFIX}${profileId}`);
  } catch {
    // Selection persistence is optional when tab storage is unavailable.
  }
};

const readStoredProfile = (endpoint: string): string | undefined => {
  try {
    return globalThis.sessionStorage?.getItem(`${PROFILE_STORAGE_PREFIX}${endpoint}`) ?? undefined;
  } catch {
    return undefined;
  }
};

const writeStoredProfile = (endpoint: string, profileId: string): void => {
  try {
    globalThis.sessionStorage?.setItem(`${PROFILE_STORAGE_PREFIX}${endpoint}`, profileId);
  } catch {
    // Profile persistence is optional when browser storage is unavailable.
  }
};

const refKey = (ref: ZiggySessionRef): string =>
  ref.kind === "live" ? `${ref.profileId}:live:${ref.key}` : `${ref.profileId}:stored:${ref.id}`;

const sameRef = (left: ZiggySessionRef | undefined, right: ZiggySessionRef): boolean =>
  left !== undefined && refKey(left) === refKey(right);

const titleFromKey = (key: string, profileName: string): string => {
  if (key === "local/main") return profileName;
  const finalPart = key.split("/").at(-1) ?? key;
  return finalPart
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/^./u, (value) => value.toLocaleUpperCase());
};

const displayName = (value: string): string =>
  value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/^./u, (character) => character.toLocaleUpperCase());

const upsertConversation = (
  conversations: ReadonlyArray<ConversationSummary>,
  conversation: ConversationSummary,
): ReadonlyArray<ConversationSummary> =>
  conversations.some((candidate) => sameRef(candidate.ref, conversation.ref))
    ? conversations.map((candidate) =>
        sameRef(candidate.ref, conversation.ref) ? conversation : candidate,
      )
    : [...conversations, conversation];

export const useZiggyGateway = (connector: GatewayConnector = defaultConnector) => {
  const [connection, setConnection] = useState<"closed" | "connecting" | "open" | "reconnecting">(
    "closed",
  );
  const [profiles, setProfiles] = useState<ReadonlyArray<ZiggyProfileSummary>>([]);
  const [profile, setProfile] = useState<ZiggyProfileSummary>();
  // Exact `ziggy` CLI argument for the resident's own Profile, supplied by the server.
  const [residentCliTarget, setResidentCliTarget] = useState<string>();
  const [conversations, setConversations] = useState<ReadonlyArray<ConversationSummary>>([]);
  const [pins, setPins] = useState<ReadonlyArray<ZiggyPin>>([]);
  const [pinRevision, setPinRevision] = useState(0);
  const [agents, setAgents] = useState<ReadonlyArray<AgentSummary>>([]);
  const [agentDefinitionDetail, setAgentDefinitionDetail] = useState<AgentDefinitionDetail>();
  const [groups, setGroups] = useState<ReadonlyArray<GroupConversationSummary>>([]);
  const [automations, setAutomations] = useState<ReadonlyArray<AutomationSummary>>([]);
  const [automationDestinations, setAutomationDestinations] = useState<
    ReadonlyArray<AutomationDestinationOption>
  >([]);
  const [automationRuns, setAutomationRuns] = useState<
    Readonly<Record<string, ZiggyAutomationRun | undefined>>
  >({});
  const [startingAutomation, setStartingAutomation] = useState<string>();
  const [automationDetail, setAutomationDetail] = useState<AutomationDetail>();
  const [modelSettings, setModelSettings] = useState<ModelSettingsState>();
  const [sessionModel, setSessionModel] = useState<{
    readonly value?: ZiggySessionModelResult;
    readonly error?: string;
    readonly pending: boolean;
  }>({ pending: false });
  const [sessionSummaries, setSessionSummaries] = useState<{
    readonly value?: ZiggySessionSummaryResult;
    readonly error?: string;
    readonly pending: boolean;
  }>({ pending: false });
  const sessionSummariesGenerationRef = useRef(0);
  const sessionModelGenerationRef = useRef(0);
  const extensionGenerationRef = useRef(0);
  const extensionMutationRef = useRef(false);
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [sidebarBusy, setSidebarBusy] = useState(false);
  const [selectedRef, setSelectedRef] = useState<ZiggySessionRef>();
  // Only live web UI (`ui`) sessions can serve views; every other session is watch-only here.
  const [uiLive, setUiLive] = useState<ReadonlySet<string>>(new Set());
  const [selectedTitle, setSelectedTitle] = useState("Ziggy");
  const [history, setHistory] = useState<ReadonlyArray<ZiggySessionHistoryEntry>>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [tools, setTools] = useState<ReadonlyArray<ToolActivity>>([]);
  const [pendingUser, setPendingUser] = useState<string>();
  const [pendingUserImages, setPendingUserImages] = useState<ReadonlyArray<string>>([]);
  // What this conversation's views added with `ui/update-model-context`; sent once with the next
  // prompt, one entry per server.
  const [appContext, setAppContextState] = useState<ReadonlyArray<ZiggyAppContext>>([]);
  useEffect(() => {
    if (pendingUser === undefined) setPendingUserImages([]);
  }, [pendingUser]);
  useEffect(
    () => () => {
      for (const url of pendingUserImages) URL.revokeObjectURL(url);
    },
    [pendingUserImages],
  );
  const [busy, setBusy] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<
    ReadonlyArray<{
      id: string;
      ref: ZiggySessionRef;
      text: string;
      mode: "steer" | "queue";
      imageCount?: number;
      occurrence: number;
    }>
  >([]);
  useEffect(() => {
    if (selectedRef === undefined) return;
    setPendingInputs((current) =>
      current.filter(
        (input) =>
          !sameRef(selectedRef, input.ref) ||
          history.filter((entry) => entry.kind === "user" && entry.text === input.text).length <
            input.occurrence,
      ),
    );
  }, [history, selectedRef]);
  const [localError, setLocalError] = useState<string>();
  const [reconciling, setReconciling] = useState(false);
  const [maxPromptCodePoints, setMaxPromptCodePoints] = useState(16_000);

  const clientRef = useRef<GatewayClient | undefined>(undefined);
  const endpointRef = useRef<string | undefined>(undefined);
  const persistentConnectionRef = useRef(false);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const selectedRefRef = useRef<ZiggySessionRef | undefined>(undefined);
  const profileRef = useRef<ZiggyProfileSummary | undefined>(undefined);
  const pinRevisionRef = useRef(0);
  const sidebarGenerationRef = useRef(0);
  const automationDetailGenerationRef = useRef(0);
  const agentDefinitionGenerationRef = useRef(0);
  const modelSettingsGenerationRef = useRef(0);
  const sidebarMutationRef = useRef(false);
  const historyGenerationRef = useRef(0);
  const activityActiveRef = useRef(false);
  const unselectedEventsRef = useRef<ZiggyGatewayEvent[]>([]);
  const selectionGenerationRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const reconciliationInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const loadHistoryRef = useRef<
    ((ref: ZiggySessionRef, before?: string) => Promise<void>) | undefined
  >(undefined);
  const loadSessionModelRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const loadSessionSummariesRef = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    selectedRefRef.current = selectedRef;
  }, [selectedRef]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    pinRevisionRef.current = pinRevision;
  }, [pinRevision]);

  useEffect(() => {
    if (connection !== "reconnecting") return;
    if (persistentConnectionRef.current) return;
    const client = clientRef.current;
    if (client === undefined) return;
    const timer = globalThis.setTimeout(() => {
      if (clientRef.current !== client || client.state === "open") return;
      client.close();
      setConnection("closed");
      setLocalError("Connection lost. Reconnect with current endpoint and runtime token.");
    }, RECONNECT_GRACE_PERIOD_MS);
    return () => globalThis.clearTimeout(timer);
  }, [connection]);

  const requireOpenSidebarClient = useCallback((client: GatewayClient): void => {
    if (client.state === "open") return;
    const error = new Error(
      "Ziggy is reconnecting. Wait for the connection before making changes.",
    );
    setLocalError(error.message);
    throw error;
  }, []);

  const loadHistory = useCallback(async (ref: ZiggySessionRef, before?: string): Promise<void> => {
    const client = clientRef.current;
    if (client === undefined) return;
    const generation = ++historyGenerationRef.current;
    setLoadingHistory(true);
    try {
      const result = await client.getSessionHistory(ref, before);
      if (generation !== historyGenerationRef.current || !sameRef(selectedRefRef.current, ref))
        return;
      setHistory((current) =>
        before === undefined
          ? mergeSessionHistoryEntries(result.entries, current)
          : dedupeSessionHistoryEntries([...result.entries, ...current]),
      );
      setHistoryCursor(result.nextCursor);
      setHasMoreHistory(result.hasMore);
      if (before === undefined && !activityActiveRef.current) {
        setPendingUser(undefined);
        setStreamText("");
        setTools([]);
      }
    } catch (cause) {
      if (generation === historyGenerationRef.current && sameRef(selectedRefRef.current, ref)) {
        setLocalError(
          cause instanceof Error ? cause.message : "Conversation history is unavailable.",
        );
      }
    } finally {
      if (generation === historyGenerationRef.current) setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    loadHistoryRef.current = loadHistory;
  }, [loadHistory]);

  const replaceConversationActivity = useCallback((event: ZiggyGatewayEvent): void => {
    if (!sameRef(selectedRefRef.current, event.session)) return;
    if (event.event === "session-state") {
      if (event.payload.scope === "transcript") {
        historyGenerationRef.current += 1;
        setHistory([]);
        setHistoryCursor(undefined);
        setHasMoreHistory(false);
        setPendingUser(undefined);
        setStreamText("");
        setTools([]);
        setBusy(false);
        void loadHistoryRef.current?.(event.session);
        void loadSessionSummariesRef.current?.();
      }
      void loadSessionModelRef.current?.();
      return;
    }
    if (event.event === "assistant-text") {
      activityActiveRef.current = true;
      setStreamText(event.payload.snapshot);
      setBusy(true);
      return;
    }
    if (event.event === "thinking") {
      activityActiveRef.current = true;
      setBusy(true);
      return;
    }
    if (event.event === "tool") {
      activityActiveRef.current = true;
      setBusy(true);
      setTools((current) => {
        const next: ToolActivity = {
          id: event.payload.toolCallId,
          name: event.payload.toolName,
          detail: event.payload.detail,
          failed: event.payload.failed,
          phase: event.payload.phase,
          ...(event.payload.app === undefined ? {} : { app: event.payload.app }),
        };
        const index = current.findIndex((tool) => tool.id === next.id);
        return index < 0
          ? [...current, next]
          : current.map((tool, itemIndex) => (itemIndex === index ? next : tool));
      });
      return;
    }
    if (event.event === "automation-result") {
      setHistory((current) =>
        dedupeSessionHistoryEntries([
          ...current,
          {
            kind: "automation-result",
            automationId: event.payload.automationId,
            runId: event.payload.runId,
            text: event.payload.text,
            timestamp: event.payload.timestamp,
          },
        ]),
      );
      return;
    }
    if (event.event === "settled") {
      // Keep the streamed reply on screen; loadHistory clears it in the same render that adds
      // the stored message, so the reply does not blink out and back in.
      activityActiveRef.current = false;
      setBusy(false);
      void loadHistoryRef.current?.(event.session);
      return;
    }
    if (event.event === "error") {
      activityActiveRef.current = false;
      setBusy(false);
      setLocalError(event.payload.message);
    }
  }, []);

  const handleEvent = useCallback(
    (event: ZiggyClientEvent): void => {
      if (event.event === "connection-state") {
        setConnection(event.state);
        return;
      }
      if (event.event === "history-reconciliation") {
        if (!sameRef(selectedRefRef.current, event.session) || reconciliationInFlightRef.current)
          return;
        reconciliationInFlightRef.current = true;
        setReconciling(true);
        void loadHistoryRef.current?.(event.session).finally(() => {
          reconciliationInFlightRef.current = false;
          setReconciling(false);
        });
        return;
      }
      if (!sameRef(selectedRefRef.current, event.session)) {
        unselectedEventsRef.current.push(event);
        if (unselectedEventsRef.current.length > 256) unselectedEventsRef.current.shift();
        return;
      }
      replaceConversationActivity(event);
    },
    [replaceConversationActivity],
  );

  const selectConversation = useCallback(
    async (conversation: ConversationSummary, remember = true): Promise<void> => {
      const client = clientRef.current;
      if (client === undefined) return;
      if (remember) {
        writeStoredSelection(
          conversation.ref.profileId,
          conversation.ref.kind === "live" && conversation.ref.key === "local/main"
            ? { kind: "main" }
            : { kind: "ref", ref: conversation.ref },
        );
      }
      const previous = selectedRefRef.current;
      const selectionGeneration = ++selectionGenerationRef.current;
      historyGenerationRef.current += 1;
      selectedRefRef.current = conversation.ref;
      setSelectedRef(conversation.ref);
      setSelectedTitle(conversation.title);
      setHistory([]);
      setHistoryCursor(undefined);
      setHasMoreHistory(false);
      setStreamText("");
      setTools([]);
      setAppContextState([]);
      setPendingUser(undefined);
      activityActiveRef.current = false;
      setBusy(false);
      setLocalError(undefined);
      setReconciling(false);
      const openingEvents = unselectedEventsRef.current;
      unselectedEventsRef.current = [];
      for (const event of openingEvents) replaceConversationActivity(event);
      if (previous?.kind === "live" && !sameRef(previous, conversation.ref)) {
        await client.unwatchSession(previous).catch(() => undefined);
      }
      if (selectionGeneration !== selectionGenerationRef.current) return;
      if (conversation.ref.kind === "live") {
        try {
          if (conversation.ref.key.startsWith("ui/chat-")) {
            await client.request("session.open", {
              profileId: conversation.ref.profileId,
              context: { kind: "local" },
              name: conversation.ref.key.slice(3),
            });
            // The open made it a live web UI session; don't wait for a sidebar refresh to say so.
            const key = refKey(conversation.ref);
            setUiLive((current) => (current.has(key) ? current : new Set([...current, key])));
          }
          await client.watchSession(conversation.ref);
        } catch (cause) {
          setLocalError(
            cause instanceof Error
              ? `Live updates unavailable: ${cause.message}`
              : "Live updates are unavailable for this conversation.",
          );
        }
      }
      if (selectionGeneration !== selectionGenerationRef.current) return;
      await loadHistory(conversation.ref);
    },
    [loadHistory, replaceConversationActivity],
  );

  const buildConversationList = useCallback(
    (
      selectedProfile: ZiggyProfileSummary,
      mainRef: ZiggySessionRef,
      result: ZiggySessionListResult,
    ): ReadonlyArray<ConversationSummary> => {
      const main: ConversationSummary = {
        ref: mainRef,
        title: selectedProfile.name,
        subtitle: "Main conversation",
        active: result.live.some(
          (session) => refKey(session.ref) === refKey(mainRef) && !session.idle,
        ),
      };
      const live = result.live
        .filter((session) => session.kind === "ui" && refKey(session.ref) !== refKey(mainRef))
        .map((session): ConversationSummary => ({
          ref: session.ref,
          title: titleFromKey(session.ref.key, selectedProfile.name),
          subtitle: session.agentId === undefined ? "Conversation" : "Specialist",
          active: !session.idle,
        }));
      return [main, ...live];
    },
    [],
  );

  const refreshSidebarFor = useCallback(
    async (
      client: GatewayClient,
      selectedProfile: ZiggyProfileSummary,
      mainRef: ZiggySessionRef,
      restoreSelection = false,
    ): Promise<void> => {
      const generation = ++sidebarGenerationRef.current;
      const restoreSelectionGeneration = selectionGenerationRef.current;
      setSidebarLoading(true);
      const [
        sessionResult,
        pinResult,
        agentResult,
        groupResult,
        automationResult,
        destinationResult,
      ] = await Promise.allSettled([
        client.listSessions(selectedProfile.profileId),
        client.listPins(selectedProfile.profileId),
        client.listAgents(selectedProfile.profileId),
        client.listGroups(selectedProfile.profileId),
        client.listAutomations(selectedProfile.profileId),
        listAutomationDestinations(client, selectedProfile.profileId),
      ]);
      if (
        generation !== sidebarGenerationRef.current ||
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId
      )
        return;
      const nextConversations =
        sessionResult.status === "fulfilled"
          ? buildConversationList(selectedProfile, mainRef, sessionResult.value)
          : undefined;
      if (nextConversations !== undefined) {
        setConversations(nextConversations);
      }
      if (sessionResult.status === "fulfilled")
        setUiLive(
          new Set(
            sessionResult.value.live
              .filter((session) => session.kind === "ui")
              .map((session) => refKey(session.ref)),
          ),
        );
      setAutomationDestinations(
        destinationResult.status === "fulfilled" ? destinationResult.value : [],
      );
      const liveGroups =
        sessionResult.status === "fulfilled"
          ? sessionResult.value.live.flatMap((session) =>
              session.context?.kind === "group" ? [{ session, context: session.context }] : [],
            )
          : [];
      const nextGroups: ReadonlyArray<GroupConversationSummary> | undefined =
        groupResult.status === "fulfilled"
          ? groupResult.value.groups.map((group): GroupConversationSummary => {
              const live = liveGroups.find(({ context }) => context.groupId === group.groupId);
              return {
                ...(live === undefined ? {} : { ref: live.session.ref }),
                groupId: group.groupId,
                title: displayName(group.groupId),
                subtitle: `${group.memberAgentIds.length} agents`,
                memberAgentIds: group.memberAgentIds,
                defaultRecipient: group.defaultRecipient,
                revision: group.revision,
                active: live !== undefined && !live.session.idle,
              };
            })
          : sessionResult.status === "fulfilled"
            ? liveGroups.map(({ session, context }): GroupConversationSummary => ({
                ref: session.ref,
                groupId: context.groupId,
                title: displayName(context.groupId),
                subtitle: `${context.memberAgentIds?.length ?? 0} agents`,
                memberAgentIds: context.memberAgentIds ?? [],
                defaultRecipient: context.defaultRecipient,
                revision: context.expectedRevision ?? 0,
                active: !session.idle,
              }))
            : undefined;
      if (nextGroups !== undefined) setGroups(nextGroups);
      if (pinResult.status === "fulfilled") {
        pinRevisionRef.current = pinResult.value.revision;
        setPinRevision(pinResult.value.revision);
        setPins(pinResult.value.pins);
      }
      if (agentResult.status === "fulfilled") {
        setAgents(
          agentResult.value.agents.map((agent: ZiggyProfileAgent) => ({
            id: agent.id,
            description: agent.description,
          })),
        );
      }
      if (automationResult.status === "fulfilled") {
        setAutomations(
          automationResult.value.automations.map((automation) => ({
            id: automation.id,
            gateState: automation.gateState,
            lifecycle: automation.lifecycle,
            schedule: automation.schedule,
            timezone: automation.timezone,
            message: automation.message,
          })),
        );
      }
      if (
        [
          sessionResult,
          pinResult,
          agentResult,
          groupResult,
          automationResult,
          destinationResult,
        ].some((result) => result.status === "rejected")
      ) {
        setLocalError("Some sidebar data could not be refreshed.");
      }
      setSidebarLoading(false);

      if (
        !restoreSelection ||
        restoreSelectionGeneration !== selectionGenerationRef.current ||
        client.state !== "open"
      )
        return;
      const saved = readStoredSelection(selectedProfile.profileId);
      if (saved === undefined || saved.kind === "main") return;
      try {
        if (saved.kind === "specialist") {
          if (agentResult.status !== "fulfilled") return;
          if (!agentResult.value.agents.some((agent) => agent.id === saved.agentId)) {
            clearStoredSelection(selectedProfile.profileId);
            return;
          }
          const ref = await client.openSpecialist(selectedProfile.profileId, saved.agentId);
          if (
            generation !== sidebarGenerationRef.current ||
            restoreSelectionGeneration !== selectionGenerationRef.current
          )
            return;
          const conversation: ConversationSummary = {
            ref,
            title: displayName(saved.agentId),
            subtitle: "Specialist",
            active: false,
          };
          setConversations((current) => upsertConversation(current, conversation));
          await selectConversation(conversation, false);
          return;
        }
        if (saved.kind === "group") {
          if (nextGroups === undefined) return;
          const group = nextGroups.find((candidate) => candidate.groupId === saved.groupId);
          if (group === undefined) {
            clearStoredSelection(selectedProfile.profileId);
            return;
          }
          if (group.ref !== undefined) {
            await selectConversation({ ...group, ref: group.ref }, false);
            return;
          }
          const ref = await client.openMain(selectedProfile.profileId, {
            kind: "group",
            groupId: group.groupId,
            memberAgentIds: group.memberAgentIds,
            defaultRecipient: group.defaultRecipient,
            expectedRevision: group.revision,
          });
          if (
            ref.kind === "live" &&
            generation === sidebarGenerationRef.current &&
            restoreSelectionGeneration === selectionGenerationRef.current
          ) {
            const reopened: GroupConversationSummary = { ...group, ref };
            const conversation: ConversationSummary = {
              ref,
              title: reopened.title,
              subtitle: reopened.subtitle,
              active: reopened.active,
            };
            setGroups((current) =>
              current.map((candidate) =>
                candidate.groupId === reopened.groupId ? reopened : candidate,
              ),
            );
            setConversations((current) => upsertConversation(current, conversation));
            await selectConversation(conversation, false);
          }
          return;
        }
        if (nextConversations === undefined || pinResult.status !== "fulfilled") return;
        const savedPin = pinResult.value.pins.find((pin) => sameRef(pin.ref, saved.ref));
        const listed = nextConversations.find((candidate) => sameRef(candidate.ref, saved.ref));
        // A pin label is the name the person gave the chat; it wins over the key-derived title.
        const conversation =
          (listed !== undefined && savedPin?.label !== undefined
            ? { ...listed, title: savedPin.label }
            : listed) ??
          [savedPin]
            .filter((pin) => pin !== undefined)
            .map((pin): ConversationSummary => ({
              ref: pin.ref,
              title:
                pin.label ??
                (pin.ref.kind === "live"
                  ? titleFromKey(pin.ref.key, selectedProfile.name)
                  : "Past conversation"),
              subtitle: "Pinned conversation",
              active: false,
            }))[0];
        if (conversation === undefined) {
          clearStoredSelection(selectedProfile.profileId);
          return;
        }
        await selectConversation(conversation, false);
      } catch {
        // Main remains selected when the saved target cannot be reopened.
      }
    },
    [buildConversationList, selectConversation],
  );

  const connect = useCallback(
    async ({ persistent = false, url, token }: ConnectInput): Promise<void> => {
      unsubscribeRef.current?.();
      clientRef.current?.close();
      selectedRefRef.current = undefined;
      setSelectedRef(undefined);
      unselectedEventsRef.current = [];
      setAutomationDestinations([]);
      setAutomationRuns({});
      setStartingAutomation(undefined);
      const connectionGeneration = ++connectionGenerationRef.current;
      persistentConnectionRef.current = persistent;
      selectionGenerationRef.current += 1;
      automationDetailGenerationRef.current += 1;
      agentDefinitionGenerationRef.current += 1;
      modelSettingsGenerationRef.current += 1;
      setAutomationDetail(undefined);
      setAgentDefinitionDetail(undefined);
      setModelSettings(undefined);
      setConnection("connecting");
      setLocalError(undefined);
      let client: GatewayClient | undefined;
      try {
        const endpoint = new URL(url);
        if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
          throw new Error("Use a ws:// or wss:// WebSocket endpoint.");
        }
        client = connector({ url, token });
        clientRef.current = client;
        endpointRef.current = url;
        unsubscribeRef.current = client.onAny(handleEvent);
        const [capabilities, listedProfiles, current] = await Promise.all([
          client.capabilities(),
          client.listProfiles(),
          client.currentProfile(),
        ]);
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== client
        )
          return;
        setMaxPromptCodePoints(capabilities.bounds.maxPromptCodePoints);
        setProfiles(listedProfiles.profiles);
        setResidentCliTarget(current.cliTarget);
        const storedProfileId = readStoredProfile(url);
        const selectedProfile =
          listedProfiles.profiles.find(
            (candidate) => candidate.profileId === storedProfileId && candidate.available,
          ) ??
          listedProfiles.profiles.find(
            (candidate) => candidate.profileId === current.profileId && candidate.available,
          ) ??
          listedProfiles.profiles.find((candidate) => candidate.available);
        if (selectedProfile === undefined) throw new Error("No available Ziggy Profile was found.");
        profileRef.current = selectedProfile;
        setProfile(selectedProfile);
        const mainRef = await client.openMain(selectedProfile.profileId);
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== client
        )
          return;
        const conversation: ConversationSummary = {
          ref: mainRef,
          title: selectedProfile.name,
          subtitle: "Main conversation",
          active: false,
        };
        setConversations([conversation]);
        await selectConversation(conversation, false);
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== client
        )
          return;
        setConnection(client.state);
        void refreshSidebarFor(client, selectedProfile, mainRef, true);
      } catch (cause) {
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          (client !== undefined && clientRef.current !== client)
        )
          return;
        if (client === undefined) {
          setConnection("closed");
          setLocalError(cause instanceof Error ? cause.message : "Invalid WebSocket endpoint.");
        } else if (client.state === "open") {
          setConnection("open");
          setLocalError(cause instanceof Error ? cause.message : "Could not connect to Ziggy.");
        } else {
          client.close();
          setConnection("closed");
          setLocalError("Could not connect. Check the endpoint and current runtime token.");
        }
        throw cause;
      }
    },
    [connector, handleEvent, refreshSidebarFor, selectConversation],
  );

  const refreshSidebar = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const selectedProfile = profileRef.current;
    if (client === undefined || selectedProfile === undefined) return;
    const mainRef: ZiggySessionRef = {
      profileId: selectedProfile.profileId,
      kind: "live",
      key: "local/main",
    };
    await refreshSidebarFor(client, selectedProfile, mainRef);
  }, [refreshSidebarFor]);

  const switchProfile = useCallback(
    async (profileId: ZiggyProfileSummary["profileId"]): Promise<void> => {
      const client = clientRef.current;
      const current = profileRef.current;
      const selectedProfile = profiles.find(
        (candidate) => candidate.profileId === profileId && candidate.available,
      );
      if (
        client === undefined ||
        current === undefined ||
        selectedProfile === undefined ||
        current.profileId === selectedProfile.profileId ||
        sidebarMutationRef.current
      )
        return;
      requireOpenSidebarClient(client);
      sidebarMutationRef.current = true;
      setSidebarBusy(true);
      setLocalError(undefined);
      unselectedEventsRef.current = [];
      try {
        const mainRef = await client.openMain(selectedProfile.profileId);
        if (clientRef.current !== client) return;
        const previous = selectedRefRef.current;
        sidebarGenerationRef.current += 1;
        selectionGenerationRef.current += 1;
        historyGenerationRef.current += 1;
        automationDetailGenerationRef.current += 1;
        agentDefinitionGenerationRef.current += 1;
        modelSettingsGenerationRef.current += 1;
        profileRef.current = selectedProfile;
        setProfile(selectedProfile);
        selectedRefRef.current = undefined;
        setSelectedRef(undefined);
        setConversations([]);
        setPins([]);
        pinRevisionRef.current = 0;
        setPinRevision(0);
        setAgents([]);
        setGroups([]);
        setAutomations([]);
        setAutomationRuns({});
        setStartingAutomation(undefined);
        setAutomationDestinations([]);
        setAutomationDetail(undefined);
        setAgentDefinitionDetail(undefined);
        setModelSettings(undefined);
        setPendingInputs([]);
        setHistory([]);
        setHistoryCursor(undefined);
        setHasMoreHistory(false);
        setStreamText("");
        setTools([]);
        setPendingUser(undefined);
        setBusy(false);
        setReconciling(false);
        if (previous?.kind === "live") await client.unwatchSession(previous).catch(() => undefined);
        const conversation: ConversationSummary = {
          ref: mainRef,
          title: selectedProfile.name,
          subtitle: "Main conversation",
          active: false,
        };
        setConversations([conversation]);
        await selectConversation(conversation, false);
        const endpoint = endpointRef.current;
        if (endpoint !== undefined) writeStoredProfile(endpoint, selectedProfile.profileId);
        await refreshSidebarFor(client, selectedProfile, mainRef, true);
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : "Could not switch Ziggy Profile.");
        throw cause;
      } finally {
        sidebarMutationRef.current = false;
        setSidebarBusy(false);
      }
    },
    [profiles, refreshSidebarFor, requireOpenSidebarClient, selectConversation],
  );

  const openSpecialist = useCallback(
    async (agentId: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || sidebarMutationRef.current)
        return;
      requireOpenSidebarClient(client);
      sidebarMutationRef.current = true;
      setSidebarBusy(true);
      setLocalError(undefined);
      try {
        const ref = await client.openSpecialist(selectedProfile.profileId, agentId);
        if (clientRef.current !== client || profileRef.current?.profileId !== ref.profileId) return;
        const conversation: ConversationSummary = {
          ref,
          title: displayName(agentId),
          subtitle: "Specialist",
          active: false,
        };
        setConversations((current) => upsertConversation(current, conversation));
        await selectConversation(conversation);
        writeStoredSelection(selectedProfile.profileId, { kind: "specialist", agentId });
      } catch (cause) {
        setLocalError(
          cause instanceof ZiggyRequestOutcomeUnknownError
            ? "The connection closed while opening the specialist. Refresh before trying again."
            : cause instanceof Error
              ? cause.message
              : "The specialist conversation could not be opened.",
        );
        throw cause;
      } finally {
        sidebarMutationRef.current = false;
        setSidebarBusy(false);
      }
    },
    [requireOpenSidebarClient, selectConversation],
  );

  const openGroup = useCallback(
    async (group: OpenGroupInput | GroupConversationSummary): Promise<void> => {
      if ("ref" in group && group.ref !== undefined) {
        await selectConversation({ ...group, ref: group.ref });
        writeStoredSelection(group.ref.profileId, { kind: "group", groupId: group.groupId });
        return;
      }
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || sidebarMutationRef.current)
        return;
      requireOpenSidebarClient(client);
      sidebarMutationRef.current = true;
      setSidebarBusy(true);
      setLocalError(undefined);
      const context: Extract<ZiggyConversationContext, { readonly kind: "group" }> = {
        kind: "group",
        groupId: group.groupId,
        memberAgentIds: group.memberAgentIds,
        ...(group.defaultRecipient === undefined
          ? {}
          : { defaultRecipient: group.defaultRecipient }),
        ...(("revision" in group ? group.revision : group.expectedRevision) === undefined
          ? {}
          : { expectedRevision: "revision" in group ? group.revision : group.expectedRevision }),
      };
      try {
        const ref = await client.openMain(selectedProfile.profileId, context);
        if (clientRef.current !== client || profileRef.current?.profileId !== ref.profileId) return;
        if (ref.kind !== "live") throw new Error("The gateway returned a non-live group session.");
        const conversation: ConversationSummary = {
          ref,
          title: group.title ?? displayName(group.groupId),
          subtitle: `${group.memberAgentIds.length} agents`,
          active: false,
        };
        const summary: GroupConversationSummary = {
          ...conversation,
          ref,
          groupId: group.groupId,
          memberAgentIds: group.memberAgentIds,
          ...(group.defaultRecipient === undefined
            ? {}
            : { defaultRecipient: group.defaultRecipient }),
          revision: "revision" in group ? group.revision : (group.expectedRevision ?? 0),
        };
        setGroups((current) => [
          ...current.filter((candidate) => candidate.groupId !== summary.groupId),
          summary,
        ]);
        setConversations((current) => upsertConversation(current, conversation));
        await selectConversation(conversation);
        writeStoredSelection(selectedProfile.profileId, { kind: "group", groupId: group.groupId });
      } catch (cause) {
        setLocalError(
          cause instanceof ZiggyRequestOutcomeUnknownError
            ? "The connection closed while opening the group. Refresh before trying again."
            : cause instanceof Error
              ? cause.message
              : "The group conversation could not be opened.",
        );
        throw cause;
      } finally {
        sidebarMutationRef.current = false;
        setSidebarBusy(false);
      }
    },
    [requireOpenSidebarClient, selectConversation],
  );

  const setConversationPin = useCallback(
    async (ref: ZiggySessionRef, label?: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || sidebarMutationRef.current)
        return;
      requireOpenSidebarClient(client);
      sidebarMutationRef.current = true;
      setSidebarBusy(true);
      setLocalError(undefined);
      const existing = pins.find((pin) => sameRef(pin.ref, ref));
      const pin: ZiggyPin = {
        id: existing?.id ?? `pin-${crypto.randomUUID()}`,
        ref,
        order: existing?.order ?? Math.max(-1, ...pins.map((candidate) => candidate.order)) + 1,
        ...(label === undefined ? {} : { label }),
      };
      try {
        const result = await client.setPin(
          selectedProfile.profileId,
          pin,
          pinRevisionRef.current,
          `web-pin-${crypto.randomUUID()}`,
        );
        pinRevisionRef.current = result.revision;
        setPinRevision(result.revision);
        setPins(result.pins);
      } catch (cause) {
        setLocalError(
          cause instanceof ZiggyRequestOutcomeUnknownError
            ? "The pin update outcome is unknown. Refresh before trying again."
            : cause instanceof Error
              ? cause.message
              : "The conversation could not be pinned.",
        );
        throw cause;
      } finally {
        sidebarMutationRef.current = false;
        setSidebarBusy(false);
      }
    },
    [pins, requireOpenSidebarClient],
  );

  const removeConversationPin = useCallback(
    async (pinId: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || sidebarMutationRef.current)
        return;
      requireOpenSidebarClient(client);
      sidebarMutationRef.current = true;
      setSidebarBusy(true);
      setLocalError(undefined);
      try {
        const result = await client.removePin(
          selectedProfile.profileId,
          pinId,
          pinRevisionRef.current,
          `web-unpin-${crypto.randomUUID()}`,
        );
        pinRevisionRef.current = result.revision;
        setPinRevision(result.revision);
        setPins(result.pins);
      } catch (cause) {
        setLocalError(
          cause instanceof ZiggyRequestOutcomeUnknownError
            ? "The pin removal outcome is unknown. Refresh before trying again."
            : cause instanceof Error
              ? cause.message
              : "The pin could not be removed.",
        );
        throw cause;
      } finally {
        sidebarMutationRef.current = false;
        setSidebarBusy(false);
      }
    },
    [requireOpenSidebarClient],
  );

  const loadModelSettings = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const selectedProfile = profileRef.current;
    if (client === undefined || selectedProfile === undefined || client.state !== "open") return;
    const generation = ++modelSettingsGenerationRef.current;
    const extensionGeneration = extensionGenerationRef.current;
    setModelSettings((current) => ({
      availableModels: current?.availableModels ?? [],
      loading: true,
      models: current?.models ?? [],
      providers: current?.providers ?? [],
      saving: current?.saving ?? false,
      ...(current?.extensionBusy === undefined ? {} : { extensionBusy: current.extensionBusy }),
      ...(current?.status === undefined ? {} : { status: current.status }),
      ...(current?.extensions === undefined ? {} : { extensions: current.extensions }),
      ...(current?.extensionNotice === undefined
        ? {}
        : { extensionNotice: current.extensionNotice }),
    }));
    const [statusResult, modelsResult, availableResult, authResult, extensionsResult] =
      await Promise.allSettled([
        client.modelStatus(selectedProfile.profileId),
        client.listModels(selectedProfile.profileId),
        client.availableModels(selectedProfile.profileId),
        client.authStatus(selectedProfile.profileId),
        client.listExtensionsForProfile(selectedProfile.profileId),
      ]);
    if (
      generation !== modelSettingsGenerationRef.current ||
      clientRef.current !== client ||
      profileRef.current?.profileId !== selectedProfile.profileId
    )
      return;
    const failures = [
      statusResult,
      modelsResult,
      availableResult,
      authResult,
      extensionsResult,
    ].filter((result): result is PromiseRejectedResult => result.status === "rejected");
    setModelSettings((current) => ({
      availableModels: availableResult.status === "fulfilled" ? availableResult.value.models : [],
      ...(failures.length === 0
        ? {}
        : {
            error: failures
              .map((failure) =>
                failure.reason instanceof Error ? failure.reason.message : "Settings unavailable",
              )
              .join(" · "),
          }),
      loading: false,
      models: modelsResult.status === "fulfilled" ? modelsResult.value.models : [],
      providers: authResult.status === "fulfilled" ? authResult.value.providers : [],
      saving: false,
      ...(current?.extensionBusy === undefined ? {} : { extensionBusy: current.extensionBusy }),
      ...(extensionsResult.status === "fulfilled" &&
      extensionGeneration === extensionGenerationRef.current &&
      current?.extensionBusy === undefined
        ? { extensions: extensionsResult.value }
        : current?.extensions === undefined
          ? {}
          : { extensions: current.extensions }),
      ...(current?.restartRequired === undefined
        ? {}
        : { restartRequired: current.restartRequired }),
      ...(current?.extensionNotice === undefined
        ? {}
        : { extensionNotice: current.extensionNotice }),
      ...(statusResult.status === "fulfilled" ? { status: statusResult.value } : {}),
    }));
  }, []);

  const clearModelSettings = useCallback((): void => {
    modelSettingsGenerationRef.current += 1;
    extensionGenerationRef.current += 1;
    setModelSettings(undefined);
  }, []);

  const saveModelSettings = useCallback(
    async (
      providerId: string,
      modelId: string,
      thinking: ZiggyModelThinkingLevel,
    ): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || client.state !== "open") {
        const error = new Error("Connect to Ziggy before saving model settings.");
        setModelSettings((current) =>
          current === undefined ? current : { ...current, error: error.message, saving: false },
        );
        throw error;
      }
      const generation = modelSettingsGenerationRef.current;
      setModelSettings((current) =>
        current === undefined ? current : { ...current, error: undefined, saving: true },
      );
      try {
        await client.setModel(
          selectedProfile.profileId,
          providerId,
          modelId,
          thinking,
          `web-model-save-${crypto.randomUUID()}`,
        );
        if (
          generation !== modelSettingsGenerationRef.current ||
          clientRef.current !== client ||
          profileRef.current?.profileId !== selectedProfile.profileId
        )
          return;
        await loadModelSettings();
      } catch (cause) {
        if (
          generation !== modelSettingsGenerationRef.current ||
          clientRef.current !== client ||
          profileRef.current?.profileId !== selectedProfile.profileId
        )
          throw cause;
        setModelSettings((current) =>
          current === undefined
            ? current
            : {
                ...current,
                error:
                  cause instanceof ZiggyRequestOutcomeUnknownError
                    ? "The model change outcome is unknown. Reload settings before trying again."
                    : cause instanceof Error
                      ? cause.message
                      : "The model setting could not be saved.",
                saving: false,
              },
        );
        throw cause;
      }
    },
    [loadModelSettings],
  );

  const toggleExtension = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    const client = clientRef.current;
    const profile = profileRef.current;
    if (
      client === undefined ||
      profile === undefined ||
      client.state !== "open" ||
      extensionMutationRef.current
    )
      return;
    extensionMutationRef.current = true;
    const generation = modelSettingsGenerationRef.current;
    const extensionGeneration = ++extensionGenerationRef.current;
    const stale = () =>
      generation !== modelSettingsGenerationRef.current ||
      extensionGeneration !== extensionGenerationRef.current ||
      clientRef.current !== client ||
      profileRef.current?.profileId !== profile.profileId;
    setModelSettings((current) =>
      current === undefined
        ? current
        : {
            ...current,
            extensionBusy: id,
            extensionNotice: undefined,
          },
    );
    try {
      const result = enabled
        ? await client.removeExtension(
            profile.profileId,
            id,
            `web-extension-${crypto.randomUUID()}`,
          )
        : await client.addExtension(profile.profileId, id, `web-extension-${crypto.randomUUID()}`);
      if (stale()) return;
      // A confirmed mutation is authoritative even if the subsequent listing fails.
      setModelSettings((current) =>
        current === undefined || current.extensions === undefined
          ? current
          : {
              ...current,
              extensions: {
                ...current.extensions,
                selected: result.selected
                  ? [...new Set([...current.extensions.selected, id])]
                  : current.extensions.selected.filter((selectedId) => selectedId !== id),
              },
              restartRequired: current.restartRequired === true || result.restartRequired,
              extensionNotice: result.changed
                ? "Extension selection updated."
                : "Extension selection was already up to date.",
            },
      );
      try {
        const extensions = await client.listExtensionsForProfile(profile.profileId);
        if (!stale())
          setModelSettings((current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  extensions,
                },
          );
      } catch {
        if (!stale())
          setModelSettings((current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  extensionNotice: "Extension selection updated; the list could not be refreshed.",
                },
          );
      }
    } catch (cause) {
      if (stale()) return;
      const unknown = cause instanceof ZiggyRequestOutcomeUnknownError;
      const details = cause instanceof ZiggyGatewayError ? cause.details : undefined;
      const reason =
        details === undefined
          ? cause instanceof Error
            ? cause.message
            : "Extension change failed."
          : `${details.operation} failed at ${details.stage}: ${details.message}`;
      setModelSettings((current) =>
        current === undefined
          ? current
          : {
              ...current,
              extensionNotice: unknown
                ? "Extension change outcome is unknown; checking the current selection."
                : reason,
            },
      );
      if (unknown || details?.selectionChanged === true) {
        try {
          const extensions = await client.listExtensionsForProfile(profile.profileId);
          if (!stale())
            setModelSettings((current) =>
              current === undefined
                ? current
                : {
                    ...current,
                    extensions,
                  },
            );
        } catch {
          if (!stale())
            setModelSettings((current) =>
              current === undefined
                ? current
                : {
                    ...current,
                    extensionNotice: `${unknown ? "Extension change outcome is unknown" : reason}; could not refresh selection. Retry loading settings.`,
                  },
            );
        }
      }
    } finally {
      extensionMutationRef.current = false;
      if (!stale()) {
        setModelSettings((current) =>
          current === undefined
            ? current
            : {
                ...current,
                extensionBusy: undefined,
              },
        );
        extensionGenerationRef.current += 1;
      }
    }
  }, []);

  const loadSessionSummaries = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const profile = profileRef.current;
    const ref = selectedRefRef.current;
    const generation = ++sessionSummariesGenerationRef.current;
    if (
      client === undefined ||
      client.state !== "open" ||
      profile === undefined ||
      ref?.kind !== "live"
    ) {
      setSessionSummaries({ pending: false });
      return;
    }

    setSessionSummaries((current) => ({ ...current, pending: true, error: undefined }));
    try {
      const value = await client.listSessionSummaries(ref);
      if (
        generation === sessionSummariesGenerationRef.current &&
        clientRef.current === client &&
        profileRef.current?.profileId === profile.profileId &&
        sameRef(selectedRefRef.current, ref)
      )
        setSessionSummaries({ value, pending: false });
    } catch (cause) {
      if (
        generation === sessionSummariesGenerationRef.current &&
        clientRef.current === client &&
        profileRef.current?.profileId === profile.profileId &&
        sameRef(selectedRefRef.current, ref)
      )
        setSessionSummaries((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Past sessions unavailable",
          pending: false,
        }));
    }
  }, []);

  useEffect(() => {
    loadSessionSummariesRef.current = loadSessionSummaries;
  }, [loadSessionSummaries]);

  const loadSessionModel = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const ref = selectedRefRef.current;
    const generation = ++sessionModelGenerationRef.current;
    if (client === undefined || client.state !== "open" || ref?.kind !== "live") {
      setSessionModel({ pending: false });
      return;
    }

    setSessionModel({ pending: true });
    try {
      const value = await client.sessionModelStatus(ref);
      if (
        generation === sessionModelGenerationRef.current &&
        clientRef.current === client &&
        sameRef(selectedRefRef.current, ref)
      )
        setSessionModel({ value, pending: false });
    } catch (cause) {
      if (
        generation === sessionModelGenerationRef.current &&
        clientRef.current === client &&
        sameRef(selectedRefRef.current, ref)
      )
        setSessionModel({
          error: cause instanceof Error ? cause.message : "Session model unavailable",
          pending: false,
        });
    }
  }, []);

  useEffect(() => {
    loadSessionModelRef.current = loadSessionModel;
  }, [loadSessionModel]);

  const changeSessionModel = useCallback(
    async (providerId: string, modelId: string): Promise<void> => {
      const client = clientRef.current;
      const ref = selectedRefRef.current;
      if (
        client === undefined ||
        ref?.kind !== "live" ||
        client.state !== "open" ||
        busy ||
        sessionModel.pending
      )
        return;

      const generation = ++sessionModelGenerationRef.current;
      setSessionModel((current) => ({ ...current, pending: true, error: undefined }));
      try {
        const value = await client.setSessionModel(
          ref,
          providerId,
          modelId,
          `web-session-model-${crypto.randomUUID()}`,
        );
        if (
          generation === sessionModelGenerationRef.current &&
          clientRef.current === client &&
          sameRef(selectedRefRef.current, ref)
        )
          setSessionModel({ value, pending: false });
      } catch (cause) {
        if (
          generation === sessionModelGenerationRef.current &&
          clientRef.current === client &&
          sameRef(selectedRefRef.current, ref)
        )
          setSessionModel((current) => ({
            ...current,
            pending: false,
            error: cause instanceof Error ? cause.message : "Session model switch failed",
          }));
      }
    },
    [busy, sessionModel.pending],
  );

  const changeSessionThinking = useCallback(
    async (thinking: ZiggyModelThinkingLevel): Promise<void> => {
      const client = clientRef.current;
      const ref = selectedRefRef.current;
      if (
        client === undefined ||
        ref?.kind !== "live" ||
        client.state !== "open" ||
        busy ||
        sessionModel.pending
      )
        return;

      const generation = ++sessionModelGenerationRef.current;
      setSessionModel((current) => ({ ...current, pending: true, error: undefined }));
      try {
        const value = await client.setSessionThinking(
          ref,
          thinking,
          `web-session-thinking-${crypto.randomUUID()}`,
        );
        if (
          generation === sessionModelGenerationRef.current &&
          clientRef.current === client &&
          sameRef(selectedRefRef.current, ref)
        )
          setSessionModel({ value, pending: false });
      } catch (cause) {
        if (
          generation === sessionModelGenerationRef.current &&
          clientRef.current === client &&
          sameRef(selectedRefRef.current, ref)
        )
          setSessionModel((current) => ({
            ...current,
            pending: false,
            error: cause instanceof Error ? cause.message : "Session thinking switch failed",
          }));
      }
    },
    [busy, sessionModel.pending],
  );

  const resumePastSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const client = clientRef.current;
      const ref = selectedRefRef.current;
      if (
        client === undefined ||
        client.state !== "open" ||
        ref?.kind !== "live" ||
        busy ||
        sessionSummaries.pending
      )
        return;

      const generation = ++sessionSummariesGenerationRef.current;
      setSessionSummaries((current) => ({ ...current, pending: true, error: undefined }));
      try {
        const result = await client.resumeSession(
          ref,
          sessionId,
          `web-resume-${crypto.randomUUID()}`,
        );
        if (
          generation !== sessionSummariesGenerationRef.current ||
          clientRef.current !== client ||
          !sameRef(selectedRefRef.current, ref)
        )
          return;

        if (!result.cancelled) {
          historyGenerationRef.current += 1;
          setHistory([]);
          setHistoryCursor(undefined);
          setHasMoreHistory(false);
          setPendingUser(undefined);
          setStreamText("");
          setTools([]);
          await Promise.all([loadHistory(ref), loadSessionModel()]);
        }

        await loadSessionSummaries();
      } catch (cause) {
        if (
          generation === sessionSummariesGenerationRef.current &&
          clientRef.current === client &&
          sameRef(selectedRefRef.current, ref)
        ) {
          setSessionSummaries((current) => ({
            ...current,
            pending: false,
            error: cause instanceof Error ? cause.message : "Could not resume session",
          }));
        }
      }
    },
    [busy, sessionSummaries.pending, loadHistory, loadSessionModel, loadSessionSummaries],
  );

  const loadAutomationDetail = useCallback(
    async (automationId: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined) return;
      requireOpenSidebarClient(client);
      const generation = ++automationDetailGenerationRef.current;
      setAutomationDetail({ automationId, errors: [], loading: true, runs: [] });
      const [definitionResult, statusResult, runsResult] = await Promise.allSettled([
        client.showAutomation(selectedProfile.profileId, automationId),
        client.automationStatus(selectedProfile.profileId),
        client.listAutomationRuns(selectedProfile.profileId, automationId),
      ]);
      if (
        generation !== automationDetailGenerationRef.current ||
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId
      )
        return;
      const errors: AutomationDetailError[] = [];
      const addError = (
        source: AutomationDetailError["source"],
        result: PromiseRejectedResult,
      ): void => {
        errors.push({
          source,
          message: result.reason instanceof Error ? result.reason.message : `${source} unavailable`,
        });
      };
      if (definitionResult.status === "rejected") addError("definition", definitionResult);
      if (statusResult.status === "rejected") addError("scheduler", statusResult);
      if (runsResult.status === "rejected") addError("runs", runsResult);
      const runs =
        runsResult.status === "fulfilled"
          ? runsResult.value.runs
              .filter((run) => run.automationId === automationId)
              .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
          : [];
      setAutomationDetail({
        automationId,
        ...(definitionResult.status === "fulfilled" ? { definition: definitionResult.value } : {}),
        errors,
        loading: false,
        runs,
        ...(statusResult.status === "fulfilled" ? { status: statusResult.value } : {}),
      });
    },
    [requireOpenSidebarClient],
  );

  const clearAutomationDetail = useCallback((): void => {
    automationDetailGenerationRef.current += 1;
    setAutomationDetail(undefined);
  }, []);

  const loadAgentDefinition = useCallback(async (agentId: string): Promise<void> => {
    const client = clientRef.current;
    const selectedProfile = profileRef.current;
    if (client === undefined || selectedProfile === undefined) return;
    const generation = ++agentDefinitionGenerationRef.current;
    setAgentDefinitionDetail({ agentId, loading: true });
    try {
      const document = await client.readAgentDocument(selectedProfile.profileId, agentId);
      if (
        generation !== agentDefinitionGenerationRef.current ||
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId
      )
        return;
      setAgentDefinitionDetail({ agentId, document, loading: false });
    } catch (cause) {
      if (
        generation !== agentDefinitionGenerationRef.current ||
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId
      )
        return;
      setAgentDefinitionDetail({
        agentId,
        error: cause instanceof Error ? cause.message : "The agent definition is unavailable.",
        loading: false,
      });
    }
  }, []);

  const clearAgentDefinition = useCallback((): void => {
    agentDefinitionGenerationRef.current += 1;
    setAgentDefinitionDetail(undefined);
  }, []);

  const saveAgentDefinition = useCallback(
    async (agentId: string, source: string, expectedSource: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined) {
        const error = new Error("Connect to Ziggy before saving an agent definition.");
        setLocalError(error.message);
        throw error;
      }
      requireOpenSidebarClient(client);
      const generation = agentDefinitionGenerationRef.current;
      const document = await client.saveAgent(
        selectedProfile.profileId,
        agentId,
        source,
        expectedSource,
        `web-agent-save-${crypto.randomUUID()}`,
      );
      if (
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId ||
        generation !== agentDefinitionGenerationRef.current
      )
        return;
      setAgentDefinitionDetail((current) =>
        current?.agentId === agentId ? { agentId, document, loading: false } : current,
      );
      const mainRef: ZiggySessionRef = {
        profileId: selectedProfile.profileId,
        kind: "live",
        key: "local/main",
      };
      await refreshSidebarFor(client, selectedProfile, mainRef);
    },
    [refreshSidebarFor, requireOpenSidebarClient],
  );

  const saveAutomationDefinition = useCallback(
    async (automationId: string, source: string, expectedSource: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined) {
        const error = new Error("Connect to Ziggy before saving an automation definition.");
        setLocalError(error.message);
        throw error;
      }
      requireOpenSidebarClient(client);
      const generation = automationDetailGenerationRef.current;
      const saved = await client.saveAutomation(
        selectedProfile.profileId,
        automationId,
        source,
        expectedSource,
        `web-automation-save-${crypto.randomUUID()}`,
      );
      if (
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId ||
        generation !== automationDetailGenerationRef.current
      )
        return;
      setAutomationDetail((current) =>
        current?.automationId === automationId ? { ...current, definition: saved } : current,
      );
      const mainRef: ZiggySessionRef = {
        profileId: selectedProfile.profileId,
        kind: "live",
        key: "local/main",
      };
      await refreshSidebarFor(client, selectedProfile, mainRef);
    },
    [refreshSidebarFor, requireOpenSidebarClient],
  );

  const refreshAutomationRuns = useCallback(
    async (client: GatewayClient, selectedProfile: ZiggyProfileSummary, automationId: string) => {
      const result = await client.listAutomationRuns(selectedProfile.profileId, automationId);
      if (
        clientRef.current !== client ||
        profileRef.current?.profileId !== selectedProfile.profileId
      )
        return;
      const runs = result.runs
        .filter((run) => run.automationId === automationId)
        .sort((a, b) => b.recordedAtMs - a.recordedAtMs);
      const latest =
        runs.find((run) => run.state === "running" || run.state === "claimed") ??
        runs.find((run) => run.state !== "skipped-busy") ??
        runs[0];
      setAutomationRuns((current) => ({ ...current, [automationId]: latest }));
      setAutomationDetail((current) =>
        current?.automationId === automationId
          ? { ...current, runs, errors: current.errors.filter((error) => error.source !== "runs") }
          : current,
      );
      return latest;
    },
    [],
  );

  useEffect(() => {
    const client = clientRef.current;
    if (connection !== "open" || client === undefined || profile === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await Promise.allSettled(
        automations.map((automation) => refreshAutomationRuns(client, profile, automation.id)),
      );
      if (!cancelled) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection, profile, automations, refreshAutomationRuns]);

  const updateAutomation = useCallback(
    async (automationId: string, action: "pause" | "resume" | "run"): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || sidebarMutationRef.current)
        return;
      requireOpenSidebarClient(client);
      sidebarMutationRef.current = true;
      setSidebarBusy(true);
      if (action === "run") setStartingAutomation(automationId);
      setLocalError(undefined);
      try {
        const commandId = `web-automation-${crypto.randomUUID()}`;
        if (action === "run") {
          const result = await client.runAutomation(
            selectedProfile.profileId,
            automationId,
            commandId,
          );
          if (
            clientRef.current !== client ||
            profileRef.current?.profileId !== selectedProfile.profileId
          )
            return;
          await refreshAutomationRuns(client, selectedProfile, automationId);
          if (result.outcome === "skipped-busy")
            setLocalError(
              "This automation is already running. This attempt did not start or send any broadcasts.",
            );
        } else {
          const result =
            action === "pause"
              ? await client.pauseAutomation(selectedProfile.profileId, automationId, commandId)
              : await client.resumeAutomation(selectedProfile.profileId, automationId, commandId);
          setAutomations((current) =>
            current.map((automation) =>
              automation.id === result.id
                ? { ...automation, lifecycle: result.lifecycle }
                : automation,
            ),
          );
        }
      } catch (cause) {
        if (
          clientRef.current !== client ||
          profileRef.current?.profileId !== selectedProfile.profileId
        )
          return;
        if (action === "run" && cause instanceof ZiggyRequestOutcomeUnknownError) {
          const run = await refreshAutomationRuns(client, selectedProfile, automationId).catch(
            () => undefined,
          );
          if (run?.state === "running" || run?.state === "claimed") return;
        }
        setLocalError(
          cause instanceof ZiggyRequestOutcomeUnknownError
            ? "The connection stopped waiting for this action. Check Recent runs before retrying; it may still be running."
            : cause instanceof Error
              ? cause.message
              : "The automation action failed.",
        );
        throw cause;
      } finally {
        sidebarMutationRef.current = false;
        setSidebarBusy(false);
        setStartingAutomation(undefined);
      }
    },
    [requireOpenSidebarClient, refreshAutomationRuns],
  );

  const pauseAutomation = useCallback(
    (automationId: string): Promise<void> => updateAutomation(automationId, "pause"),
    [updateAutomation],
  );
  const resumeAutomation = useCallback(
    (automationId: string): Promise<void> => updateAutomation(automationId, "resume"),
    [updateAutomation],
  );
  const runAutomation = useCallback(
    (automationId: string): Promise<void> => updateAutomation(automationId, "run"),
    [updateAutomation],
  );

  const createChat = useCallback(
    async (title: string): Promise<void> => {
      const client = clientRef.current;
      const selectedProfile = profileRef.current;
      if (client === undefined || selectedProfile === undefined || client.state !== "open") {
        throw new Error("Connect before creating a chat.");
      }
      const { ref } = await client.request("session.open", {
        profileId: selectedProfile.profileId,
        context: { kind: "local" },
        name: `chat-${crypto.randomUUID()}`,
      });
      await setConversationPin(ref, title);
      const conversation: ConversationSummary = {
        ref,
        title,
        subtitle: "Conversation",
        active: false,
      };
      setConversations((current) => upsertConversation(current, conversation));
      await selectConversation(conversation);
    },
    [selectConversation, setConversationPin],
  );

  const submit = useCallback(
    async (
      text: string,
      recipient?: ZiggyRecipientId,
      mode: "steer" | "queue" = "steer",
      files: ReadonlyArray<File> = [],
    ): Promise<void> => {
      const client = clientRef.current;
      const ref = selectedRefRef.current;
      if (client === undefined || ref?.kind !== "live") return;
      if (client.state !== "open") {
        const error = new Error("Ziggy is reconnecting. Wait for the connection before sending.");
        setLocalError(error.message);
        throw error;
      }
      setLocalError(undefined);
      const commandId = `web-${crypto.randomUUID()}`;
      const images: Array<string> = [];
      try {
        for (const file of files) images.push(await client.uploadImage(file));
        if (!sameRef(selectedRefRef.current, ref))
          throw new Error("The conversation changed. Send the images again.");
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : "The image could not be uploaded.");
        throw cause;
      }
      const attachments = images.length === 0 ? undefined : { images };
      if (files.length === 0 ? busy : activityActiveRef.current) {
        const occurrence =
          history.filter((entry) => entry.kind === "user" && entry.text === text).length +
          pendingInputs.filter((input) => sameRef(ref, input.ref) && input.text === text).length +
          1;
        setPendingInputs((current) => [
          ...current,
          {
            id: commandId,
            ref,
            text,
            mode,
            occurrence,
            ...(images.length === 0 ? {} : { imageCount: images.length }),
          },
        ]);
        try {
          if (mode === "queue") await client.followUp(ref, text, commandId, attachments);
          else await client.steerSession(ref, text, commandId, attachments);
        } catch (cause) {
          setPendingInputs((current) => current.filter((input) => input.id !== commandId));
          setLocalError(
            cause instanceof Error ? cause.message : "Could not send while responding.",
          );
          throw cause;
        }
        return;
      }
      setPendingUserImages(files.map((file) => URL.createObjectURL(file)));
      setPendingUser(text);
      activityActiveRef.current = true;
      setBusy(true);
      const context = appContext.length === 0 ? undefined : appContext;
      const promptAttachments = context === undefined ? attachments : { ...attachments, context };
      try {
        if (recipient === undefined) {
          await client.submitPrompt(ref, text, commandId, promptAttachments);
        } else {
          await client.request("prompt.submit", {
            ref,
            text,
            recipient,
            commandId,
            ...promptAttachments,
          });
        }
        if (context !== undefined)
          setAppContextState((current) => current.filter((entry) => !context.includes(entry)));
      } catch (cause) {
        activityActiveRef.current = false;
        setBusy(false);
        setPendingUser(undefined);
        setLocalError(
          cause instanceof ZiggyRequestOutcomeUnknownError
            ? "The connection closed after send. Check the conversation before sending again."
            : cause instanceof Error
              ? cause.message
              : "The message could not be sent.",
        );
        throw cause;
      }
    },
    [appContext, busy, history, pendingInputs],
  );

  // A view is bound to the conversation it mounted in; once another one is selected, its calls
  // fail and its context is dropped rather than reaching the newly selected session.
  const setAppContext = useCallback((ref: ZiggySessionRef, server: string, text: string): void => {
    if (!sameRef(selectedRefRef.current, ref)) return;
    setAppContextState((current) => {
      const others = current.filter((entry) => entry.server !== server);
      return text.trim().length === 0 ? others : [...others, { server, text }].slice(-4);
    });
  }, []);

  const callAppTool = useCallback(
    async (
      ref: ZiggySessionRef,
      server: string,
      resourceUri: string,
      tool: string,
      args: { readonly [key: string]: ZiggyJsonValue },
    ): Promise<ZiggyJsonValue> => {
      const client = clientRef.current;
      if (client === undefined) throw new Error("Ziggy is not connected.");
      if (!sameRef(selectedRefRef.current, ref))
        throw new Error("This view's conversation is no longer selected.");
      return client.callAppTool(ref, server, resourceUri, tool, args);
    },
    [],
  );

  const readAppResource = useCallback(
    async (ref: ZiggySessionRef, server: string, uri: string): Promise<ZiggyJsonValue> => {
      const client = clientRef.current;
      if (client === undefined) throw new Error("Ziggy is not connected.");
      if (!sameRef(selectedRefRef.current, ref))
        throw new Error("This view's conversation is no longer selected.");
      return client.readAppResource(ref, server, uri);
    },
    [],
  );

  const abort = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const ref = selectedRefRef.current;
    if (client === undefined || ref?.kind !== "live") return;
    await client.abortSession(ref, `web-stop-${crypto.randomUUID()}`);
  }, []);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const ref = selectedRefRef.current;
    if (ref !== undefined && historyCursor !== undefined) await loadHistory(ref, historyCursor);
  }, [historyCursor, loadHistory]);

  const pinnedConversations = useMemo<ReadonlyArray<PinnedConversationSummary>>(
    () =>
      [...pins]
        .sort((left, right) => left.order - right.order)
        .map((pin) => {
          const conversation = conversations.find((candidate) => sameRef(candidate.ref, pin.ref));
          const fallbackTitle =
            pin.ref.kind === "live"
              ? titleFromKey(pin.ref.key, profile?.name ?? "Ziggy")
              : "Past conversation";
          return {
            pinId: pin.id,
            ref: pin.ref,
            title: pin.label ?? conversation?.title ?? fallbackTitle,
            subtitle: conversation?.subtitle ?? "Pinned conversation",
            active: conversation?.active ?? false,
          };
        }),
    [conversations, pins, profile?.name],
  );

  const automationSections = useMemo<AutomationSections>(
    () => ({
      active: automations.filter((automation) => automation.lifecycle === "active"),
      paused: automations.filter((automation) => automation.lifecycle === "paused"),
      attention: automations.filter((automation) => automation.lifecycle === "conflict"),
    }),
    [automations],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        connectionGenerationRef.current += 1;
        selectionGenerationRef.current += 1;
        unsubscribeRef.current?.();
        clientRef.current?.close();
      });
    };
  }, []);

  return {
    abort,
    appContext,
    setAppContext,
    callAppTool,
    readAppResource,
    agentDefinitionDetail,
    automationDetail,
    automationRuns,
    startingAutomation,
    automationDestinations,
    pendingInputs: pendingInputs.filter(
      (input) => selectedRef !== undefined && sameRef(selectedRef, input.ref),
    ),
    busy,
    clearAutomationDetail,
    clearAgentDefinition,
    toggleExtension,
    clearModelSettings,
    connect,
    connection,
    conversations,
    agents,
    automationSections,
    groups,
    hasMoreHistory,
    history,
    loadEarlier,
    loadingHistory,
    loadAutomationDetail,
    loadAgentDefinition,
    loadModelSettings,
    localError,
    maxPromptCodePoints,
    modelSettings,
    sessionModel,
    loadSessionModel,
    changeSessionModel,
    changeSessionThinking,
    sessionSummaries,
    loadSessionSummaries,
    resumePastSession,
    openGroup,
    openSpecialist,
    pauseAutomation,
    pendingUser,
    pendingUserImages,
    pinnedConversations,
    profile,
    profiles,
    reconciling,
    refreshSidebar,
    residentCliTarget,
    removeConversationPin,
    resumeAutomation,
    runAutomation,
    saveAutomationDefinition,
    saveAgentDefinition,
    saveModelSettings,
    selectedRef,
    /** Only a live web UI session can run an interactive view; others show a note. */
    selectedServesViews: selectedRef?.kind === "live" && uiLive.has(refKey(selectedRef)),
    selectedTitle,
    selectConversation,
    setConversationPin,
    sidebarBusy,
    sidebarLoading,
    streamText,
    submit,
    switchProfile,
    createChat,
    tools,
  };
};
