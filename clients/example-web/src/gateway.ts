import {
  connectZiggy,
  ZiggyRequestOutcomeUnknownError,
  type ZiggyClientEvent,
  type ZiggyGatewayClient,
  type ZiggyGatewayEvent,
  type ZiggyProfileSummary,
  type ZiggySessionHistoryEntry,
  type ZiggySessionRef,
} from "../../gateway-client/src/index";
import { useCallback, useEffect, useRef, useState } from "react";

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
}

export interface ConnectInput {
  readonly url: string;
  readonly token: string;
}

export type GatewayClient = Pick<
  ZiggyGatewayClient,
  | "abortSession"
  | "capabilities"
  | "close"
  | "currentProfile"
  | "getSessionHistory"
  | "listProfiles"
  | "listSessions"
  | "onAny"
  | "openMain"
  | "state"
  | "submitPrompt"
  | "unwatchSession"
  | "watchSession"
>;

export type GatewayConnector = (input: ConnectInput) => GatewayClient;

const defaultConnector: GatewayConnector = (input) => connectZiggy(input);

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

export const useZiggyGateway = (connector: GatewayConnector = defaultConnector) => {
  const [connection, setConnection] = useState<"closed" | "connecting" | "open" | "reconnecting">(
    "closed",
  );
  const [profiles, setProfiles] = useState<ReadonlyArray<ZiggyProfileSummary>>([]);
  const [profile, setProfile] = useState<ZiggyProfileSummary>();
  const [conversations, setConversations] = useState<ReadonlyArray<ConversationSummary>>([]);
  const [selectedRef, setSelectedRef] = useState<ZiggySessionRef>();
  const [selectedTitle, setSelectedTitle] = useState("Squarey");
  const [history, setHistory] = useState<ReadonlyArray<ZiggySessionHistoryEntry>>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [tools, setTools] = useState<ReadonlyArray<ToolActivity>>([]);
  const [pendingUser, setPendingUser] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [reconciling, setReconciling] = useState(false);
  const [maxPromptCodePoints, setMaxPromptCodePoints] = useState(16_000);

  const clientRef = useRef<GatewayClient | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const selectedRefRef = useRef<ZiggySessionRef | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const reconciliationInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const loadHistoryRef = useRef<
    ((ref: ZiggySessionRef, before?: string) => Promise<void>) | undefined
  >(undefined);

  useEffect(() => {
    selectedRefRef.current = selectedRef;
  }, [selectedRef]);

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
        before === undefined ? result.entries : [...result.entries, ...current],
      );
      setHistoryCursor(result.nextCursor);
      setHasMoreHistory(result.hasMore);
      if (before === undefined) {
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
    if (event.event === "assistant-text") {
      setStreamText(event.payload.snapshot);
      setBusy(true);
      return;
    }
    if (event.event === "thinking") {
      setBusy(true);
      return;
    }
    if (event.event === "tool") {
      setBusy(true);
      setTools((current) => {
        const next: ToolActivity = {
          id: event.payload.toolCallId,
          name: event.payload.toolName,
          detail: event.payload.detail,
          failed: event.payload.failed,
          phase: event.payload.phase,
        };
        const index = current.findIndex((tool) => tool.id === next.id);
        return index < 0
          ? [...current, next]
          : current.map((tool, itemIndex) => (itemIndex === index ? next : tool));
      });
      return;
    }
    if (event.event === "settled") {
      setBusy(false);
      void loadHistoryRef.current?.(event.session);
      return;
    }
    if (event.event === "error") {
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
      replaceConversationActivity(event);
    },
    [replaceConversationActivity],
  );

  const selectConversation = useCallback(
    async (conversation: ConversationSummary): Promise<void> => {
      const client = clientRef.current;
      if (client === undefined) return;
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
      setPendingUser(undefined);
      setBusy(false);
      setLocalError(undefined);
      setReconciling(false);
      if (previous?.kind === "live" && !sameRef(previous, conversation.ref)) {
        await client.unwatchSession(previous).catch(() => undefined);
      }
      if (selectionGeneration !== selectionGenerationRef.current) return;
      if (conversation.ref.kind === "live") {
        try {
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
    [loadHistory],
  );

  const buildConversationList = useCallback(
    async (
      client: GatewayClient,
      selectedProfile: ZiggyProfileSummary,
      mainRef: ZiggySessionRef,
    ): Promise<ReadonlyArray<ConversationSummary>> => {
      const result = await client.listSessions(selectedProfile.profileId);
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

  const connect = useCallback(
    async ({ url, token }: ConnectInput): Promise<void> => {
      unsubscribeRef.current?.();
      clientRef.current?.close();
      const connectionGeneration = ++connectionGenerationRef.current;
      selectionGenerationRef.current += 1;
      setConnection("connecting");
      setLocalError(undefined);
      const client = connector({ url, token });
      clientRef.current = client;
      unsubscribeRef.current = client.onAny(handleEvent);
      try {
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
        const selectedProfile =
          listedProfiles.profiles.find(
            (candidate) => candidate.profileId === current.profileId && candidate.available,
          ) ?? listedProfiles.profiles.find((candidate) => candidate.available);
        if (selectedProfile === undefined) throw new Error("No available Ziggy Profile was found.");
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
        const nextConversations = await buildConversationList(client, selectedProfile, mainRef);
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== client
        )
          return;
        setConversations(nextConversations);
        await selectConversation(conversation);
        setConnection(client.state);
      } catch (cause) {
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== client
        )
          return;
        setConnection(client.state === "open" ? "open" : "closed");
        setLocalError(cause instanceof Error ? cause.message : "Could not connect to Ziggy.");
        throw cause;
      }
    },
    [buildConversationList, connector, handleEvent, selectConversation],
  );

  const submit = useCallback(
    async (text: string): Promise<void> => {
      const client = clientRef.current;
      const ref = selectedRefRef.current;
      if (client === undefined || ref?.kind !== "live" || busy) return;
      setLocalError(undefined);
      setPendingUser(text);
      setBusy(true);
      try {
        await client.submitPrompt(ref, text, `web-${crypto.randomUUID()}`);
      } catch (cause) {
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
    [busy],
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
    busy,
    connect,
    connection,
    conversations,
    hasMoreHistory,
    history,
    loadEarlier,
    loadingHistory,
    localError,
    maxPromptCodePoints,
    pendingUser,
    profile,
    profiles,
    reconciling,
    selectedRef,
    selectedTitle,
    selectConversation,
    streamText,
    submit,
    tools,
  };
};
