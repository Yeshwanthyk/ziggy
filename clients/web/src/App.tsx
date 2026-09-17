import { NewChatDialog } from "@/components/new-chat-dialog";
import Stack from "@nkzw/stack";
import {
  ArrowUp,
  ChevronDown,
  Menu,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type {
  ZiggyRecipientId,
  ZiggySessionHistoryEntry,
  ZiggySessionRef,
} from "../../../packages/ui-sdk/src/index";
import { AutomationRow } from "@/components/automation-row";
import { groupCompletedActivity, ToolActivity } from "@/components/tool-activity";
import { AutomationDetailDialog } from "@/components/automation-detail-dialog";
import { AgentDefinitionDialog } from "@/components/agent-definition-dialog";
import { Button } from "@/components/ui/button";
import { PrismArt } from "@/components/prism-art";
import { BotAvatar } from "@/components/bot-avatar";
import { GroupDialog } from "@/components/group-dialog";
import { MessageMarkdown } from "@/components/message-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarSection } from "@/components/sidebar-section";
import { Textarea } from "@/components/ui/textarea";
import { readSavedConnection, SettingsDialog } from "@/components/connection-dialog";
import { type ConversationSummary, useZiggyGateway } from "@/gateway";

const avatar = (name: string, active = false, size = 36) => (
  <BotAvatar active={active} className="bot-avatar" name={name} size={size} />
);

const historyKey = (entry: ZiggySessionHistoryEntry, index: number): string =>
  `${entry.timestamp}:${entry.kind}:${
    entry.kind === "tool"
      ? entry.toolName
      : entry.kind === "automation-result"
        ? `${entry.automationId}:${entry.runId}`
        : entry.text.slice(0, 24)
  }:${index}`;

const sameSession = (left: ZiggySessionRef | undefined, right: ZiggySessionRef): boolean =>
  left?.profileId === right.profileId &&
  left.kind === right.kind &&
  (left.kind === "live" && right.kind === "live"
    ? left.key === right.key
    : left.kind === "stored" && right.kind === "stored" && left.id === right.id);

function ConversationRow({
  conversation,
  disabled = false,
  selected,
  onSelect,
}: {
  readonly conversation: ConversationSummary;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      className="conversation-row"
      data-selected={selected || undefined}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      {avatar(conversation.title, conversation.active)}
      <span className="conversation-copy">
        <strong>{conversation.title}</strong>
        <span>{conversation.subtitle}</span>
      </span>
    </button>
  );
}

function ActionRow({
  active = false,
  description,
  disabled = false,
  name,
  onSelect,
  selected = false,
  shortDescription = description,
}: {
  readonly active?: boolean;
  readonly description: string;
  readonly disabled?: boolean;
  readonly name: string;
  readonly onSelect: () => void;
  readonly selected?: boolean;
  readonly shortDescription?: string;
}) {
  return (
    <button
      className="conversation-row"
      data-selected={selected || undefined}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      {avatar(name, active)}
      <span className="conversation-copy">
        <strong>{name}</strong>
        <span title={description}>{shortDescription}</span>
      </span>
    </button>
  );
}

export function HistoryEntry({
  assistantName,
  entry,
}: {
  readonly assistantName: string;
  readonly entry: ZiggySessionHistoryEntry;
}) {
  if (entry.kind === "tool") {
    return (
      <div className="tool-line">
        <span className={entry.failed ? "tool-dot is-error" : "tool-dot"} />
        <span>{entry.toolName}</span>
        <span>{entry.phase === "start" ? "started" : entry.failed ? "failed" : "finished"}</span>
      </div>
    );
  }
  if (entry.kind === "automation-result") {
    return (
      <article className="message assistant automation-result">
        <div className="message-author">Automation · {entry.automationId}</div>
        <div className="message-body">
          <MessageMarkdown>{entry.text}</MessageMarkdown>
        </div>
      </article>
    );
  }
  return (
    <article className={`message ${entry.kind}`}>
      <div className="message-author">{entry.kind === "user" ? "You" : assistantName}</div>
      <div className="message-body">
        {entry.kind === "assistant" ? <MessageMarkdown>{entry.text}</MessageMarkdown> : entry.text}
      </div>
    </article>
  );
}

export function App() {
  const gateway = useZiggyGateway();
  const [connectionOpen, setConnectionOpen] = useState(() => readSavedConnection() === undefined);
  const [hosted, setHosted] = useState(false);
  const [pairingRequired, setPairingRequired] = useState(false);
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [startupPending, setStartupPending] = useState(() => readSavedConnection() !== undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupError, setGroupError] = useState<string>();
  const [selectedAutomationId, setSelectedAutomationId] = useState<string>();
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [recipient, setRecipient] = useState("all");
  const [localAction, setLocalAction] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);
  const firstHistoryKeyRef = useRef<string | undefined>(undefined);
  const autoConnectStartedRef = useRef(false);
  const connectionAttemptRef = useRef(0);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [gateway.pendingUser, gateway.streamText, gateway.tools]);

  useEffect(() => {
    const first = gateway.history[0];
    const nextKey = first === undefined ? undefined : historyKey(first, 0);
    if (nextKey !== undefined && firstHistoryKeyRef.current === undefined)
      endRef.current?.scrollIntoView({ block: "end" });
    firstHistoryKeyRef.current = nextKey;
  }, [gateway.history]);

  useEffect(() => {
    firstHistoryKeyRef.current = undefined;
  }, [gateway.selectedRef]);

  useEffect(() => {
    setNewChatOpen(false);
    setGroupDialogOpen(false);
    setSelectedAutomationId(undefined);
    setAgentEditorOpen(false);
    setDraft("");
    setLocalAction(undefined);
  }, [gateway.profile?.profileId]);

  const sidebarItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = (...values: ReadonlyArray<string | undefined>): boolean =>
      query.length === 0 || values.join(" ").toLocaleLowerCase().includes(query);
    return {
      agents: gateway.agents.filter((agent) => matches(agent.id, agent.description)),
      automations: [
        ...gateway.automationSections.active,
        ...gateway.automationSections.paused,
        ...gateway.automationSections.attention,
      ].filter((automation) =>
        matches(automation.id, automation.schedule, automation.message, automation.lifecycle),
      ),
      groups: gateway.groups.filter((group) => matches(group.title, ...group.memberAgentIds)),
      pins: gateway.pinnedConversations.filter((pin) => matches(pin.title, pin.subtitle)),
    };
  }, [
    gateway.agents,
    gateway.automationSections,
    gateway.groups,
    gateway.pinnedConversations,
    search,
  ]);

  const mainConversation = gateway.conversations.find(
    (conversation) => conversation.ref.kind === "live" && conversation.ref.key === "local/main",
  );
  const selectedGroup = gateway.groups.find(
    (group) => group.ref !== undefined && sameSession(gateway.selectedRef, group.ref),
  );
  const selectedPin = gateway.pinnedConversations.find((pin) =>
    sameSession(gateway.selectedRef, pin.ref),
  );
  const selectedAgent = gateway.agents.find(
    (agent) =>
      gateway.selectedRef?.kind === "live" &&
      gateway.selectedRef.key === `local/agents/${agent.id}`,
  );
  const selectedAutomation = [
    ...gateway.automationSections.active,
    ...gateway.automationSections.paused,
    ...gateway.automationSections.attention,
  ].find((automation) => automation.id === selectedAutomationId);

  useEffect(() => {
    const current = selectedGroup?.defaultRecipient;
    setRecipient(
      current?.kind === "agent" ? current.agentId : current?.kind === "host" ? "host" : "all",
    );
  }, [selectedGroup]);

  const connect = async (url: string, token?: string, persistent = false): Promise<void> => {
    const attempt = ++connectionAttemptRef.current;
    setStartupPending(true);
    try {
      await gateway.connect({ persistent, url, token });
      if (attempt === connectionAttemptRef.current) setConnectionOpen(false);
    } catch {
      if (attempt === connectionAttemptRef.current) setConnectionOpen(true);
    } finally {
      if (attempt === connectionAttemptRef.current) setStartupPending(false);
    }
  };

  useEffect(() => {
    if (autoConnectStartedRef.current) return;
    const saved = readSavedConnection();
    autoConnectStartedRef.current = true;
    const pairingCode = new URLSearchParams(location.hash.slice(1)).get("code");
    const pairing =
      pairingCode === null
        ? Promise.resolve<Response | undefined>(undefined)
        : fetch("/auth/pair", {
            body: pairingCode,
            credentials: "include",
            method: "POST",
          }).then((response) => {
            history.replaceState(null, "", `${location.pathname}${location.search}`);
            return response;
          });
    void pairing
      .then((response) => {
        if (response !== undefined && response.status !== 204) throw new Error("pairing failed");
        return fetch("/auth/status", { credentials: "include" });
      })
      .then(async (response) => {
        if (response.status !== 204 && response.status !== 401) {
          if (saved !== undefined) await connect(saved.url, saved.token);
          return;
        }
        setHosted(true);
        if (response.status === 401) {
          setPairingRequired(true);
          setConnectionOpen(true);
          return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        await connect(`${protocol}//${location.host}/ws`, undefined, true);
      })
      .catch(() => {
        setStartupPending(false);
        globalThis.setTimeout(() => {
          autoConnectStartedRef.current = false;
          setDiscoveryAttempt((current) => current + 1);
        }, 1_000);
      });
  }, [discoveryAttempt]);

  useEffect(() => {
    if (!hosted || gateway.connection !== "reconnecting") return;
    let stopped = false;
    const check = (): void => {
      void fetch("/auth/status", { credentials: "include" })
        .then((response) => {
          if (stopped || response.status !== 401) return;
          setPairingRequired(true);
          setConnectionOpen(true);
        })
        .catch(() => undefined);
    };
    check();
    const timer = globalThis.setInterval(check, 2_000);

    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [gateway.connection, hosted]);

  const runSidebarAction = async (key: string, action: () => Promise<void>): Promise<boolean> => {
    setLocalAction(key);
    try {
      await action();
      return true;
    } catch {
      return false;
    } finally {
      setLocalAction((current) => (current === key ? undefined : current));
    }
  };

  const createGroup = async (draft: {
    readonly groupId: string;
    readonly memberAgentIds: ReadonlyArray<string>;
    readonly title: string;
  }): Promise<void> => {
    setLocalAction("group:create");
    setGroupError(undefined);
    try {
      await gateway.openGroup({ ...draft, defaultRecipient: { kind: "all" } });
      setGroupDialogOpen(false);
      setSidebarOpen(false);
    } catch (cause) {
      setGroupError(cause instanceof Error ? cause.message : "The group could not be opened.");
    } finally {
      setLocalAction((current) => (current === "group:create" ? undefined : current));
    }
  };

  const send = async (event?: FormEvent, mode: "steer" | "queue" = "steer"): Promise<void> => {
    event?.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    const target: ZiggyRecipientId | undefined =
      selectedGroup === undefined
        ? undefined
        : recipient === "all"
          ? { kind: "all" }
          : recipient === "host"
            ? { kind: "host" }
            : { kind: "agent", agentId: recipient };
    try {
      setDraft("");
      await gateway.submit(text, target, mode);
    } catch {
      setDraft((current) => (current.length === 0 ? text : current));
    }
  };

  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const connected = gateway.connection === "open";
  const selectedIsLive = gateway.selectedRef?.kind === "live";
  const sidebarPending = startupPending || gateway.sidebarLoading;

  return (
    <div className="app-shell">
      <aside className="sidebar" data-open={sidebarOpen || undefined}>
        <Stack alignCenter between className="sidebar-heading">
          <span className="ziggy-brand">
            <PrismArt compact />
            <span className="ziggy-brand-copy">
              <strong>Ziggy</strong>
              {gateway.profiles.length > 1 ? (
                <label className="profile-switcher">
                  <span>{gateway.profile?.name ?? "Profile"}</span>
                  <ChevronDown aria-hidden="true" />
                  <select
                    aria-label="Ziggy Profile"
                    disabled={!connected || gateway.sidebarBusy}
                    onChange={(event) => {
                      const selected = gateway.profiles.find(
                        (profile) => profile.profileId === event.target.value,
                      );
                      if (selected !== undefined) void gateway.switchProfile(selected.profileId);
                    }}
                    value={gateway.profile?.profileId ?? ""}
                  >
                    {gateway.profiles.map((profile) => (
                      <option
                        disabled={!profile.available}
                        key={profile.profileId}
                        value={profile.profileId}
                      >
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : gateway.profile === undefined ? null : (
                <span className="profile-name-static">{gateway.profile.name}</span>
              )}
            </span>
          </span>
          <Stack alignCenter gap={2}>
            <Button
              aria-label="Refresh sidebar"
              className="compact-icon"
              disabled={!connected || gateway.sidebarLoading}
              onClick={() => void gateway.refreshSidebar()}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={gateway.sidebarLoading ? "is-spinning" : ""} />
            </Button>
            <Button
              aria-label="Close conversations"
              className="mobile-only"
              onClick={() => setSidebarOpen(false)}
              size="icon"
              variant="ghost"
            >
              <PanelLeftClose />
            </Button>
          </Stack>
        </Stack>
        <label className="conversation-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search conversations</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            type="search"
            value={search}
          />
        </label>
        <ScrollArea className="conversation-scroll">
          <div className="conversation-list">
            <SidebarSection
              title="Main chat"
              empty={startupPending ? "Restoring main chat…" : undefined}
            >
              {mainConversation === undefined ? null : (
                <ConversationRow
                  conversation={mainConversation}
                  disabled={!connected}
                  onSelect={() => {
                    setSidebarOpen(false);
                    void gateway.selectConversation(mainConversation);
                  }}
                  selected={sameSession(gateway.selectedRef, mainConversation.ref)}
                />
              )}
            </SidebarSection>

            <SidebarSection
              title="Pinned"
              action={{
                label: "New chat",
                icon: <Plus />,
                disabled: !connected || gateway.sidebarBusy,
                onClick: () => setNewChatOpen(true),
              }}
              empty={
                sidebarPending
                  ? "Restoring pinned chats…"
                  : connected
                    ? "Create a chat or pin an existing conversation."
                    : undefined
              }
            >
              {sidebarItems.pins.map((pin) => (
                <ConversationRow
                  conversation={pin}
                  disabled={!connected}
                  key={pin.pinId}
                  onSelect={() => {
                    setSidebarOpen(false);
                    void gateway.selectConversation(pin);
                  }}
                  selected={sameSession(gateway.selectedRef, pin.ref)}
                />
              ))}
            </SidebarSection>

            <SidebarSection
              title="Direct agents"
              empty={
                sidebarPending
                  ? "Loading direct agents…"
                  : connected
                    ? "No Profile specialists are available."
                    : undefined
              }
            >
              {sidebarItems.agents.map((agent) => (
                <ActionRow
                  active={gateway.conversations.some(
                    (conversation) =>
                      conversation.ref.kind === "live" &&
                      conversation.ref.key === `local/agents/${agent.id}` &&
                      conversation.active,
                  )}
                  description={agent.description}
                  shortDescription={agent.description
                    .split(/\.\s/u)[0]
                    ?.replace(/ for Squarey\.?$/u, "")}
                  disabled={!connected || gateway.sidebarBusy}
                  key={agent.id}
                  name={agent.id}
                  onSelect={() => {
                    setSidebarOpen(false);
                    void runSidebarAction(`agent:${agent.id}`, () =>
                      gateway.openSpecialist(agent.id),
                    );
                  }}
                  selected={
                    gateway.selectedRef?.kind === "live" &&
                    gateway.selectedRef.key === `local/agents/${agent.id}`
                  }
                />
              ))}
            </SidebarSection>

            <SidebarSection
              action={{
                disabled: !connected || gateway.agents.length === 0,
                label: "Create group conversation",
                icon: <Plus />,
                onClick: () => {
                  setGroupError(undefined);
                  setGroupDialogOpen(true);
                },
              }}
              title="Groups"
              empty={
                sidebarPending
                  ? "Loading group conversations…"
                  : connected
                    ? "Bring specialists into one conversation."
                    : undefined
              }
            >
              {sidebarItems.groups.map((group) => (
                <ActionRow
                  active={group.active}
                  description={`${group.memberAgentIds.length} member${group.memberAgentIds.length === 1 ? "" : "s"}`}
                  disabled={!connected || gateway.sidebarBusy}
                  key={group.groupId}
                  name={group.title}
                  onSelect={() => {
                    setSidebarOpen(false);
                    void runSidebarAction(`group:${group.groupId}`, () => gateway.openGroup(group));
                  }}
                  selected={group.ref !== undefined && sameSession(gateway.selectedRef, group.ref)}
                />
              ))}
            </SidebarSection>

            <SidebarSection
              title="Automations"
              empty={
                sidebarPending
                  ? "Loading automations…"
                  : connected
                    ? "No automations are configured."
                    : undefined
              }
            >
              {sidebarItems.automations.map((automation) => (
                <AutomationRow
                  automation={automation}
                  busy={
                    !connected ||
                    gateway.sidebarBusy ||
                    localAction === `automation:${automation.id}`
                  }
                  key={automation.id}
                  onInspect={() => {
                    setSelectedAutomationId(automation.id);
                    void gateway.loadAutomationDetail(automation.id).catch(() => undefined);
                  }}
                  onPause={() =>
                    void runSidebarAction(`automation:${automation.id}`, () =>
                      gateway.pauseAutomation(automation.id),
                    )
                  }
                  onResume={() =>
                    void runSidebarAction(`automation:${automation.id}`, () =>
                      gateway.resumeAutomation(automation.id),
                    )
                  }
                  onRun={() =>
                    void runSidebarAction(`automation:${automation.id}`, () =>
                      gateway.runAutomation(automation.id),
                    )
                  }
                />
              ))}
            </SidebarSection>
            {sidebarPending ? <p className="sidebar-loading">Refreshing…</p> : null}
          </div>
        </ScrollArea>
        <Stack alignCenter gap={12} className="profile-footer">
          {avatar(gateway.profile?.name ?? "Squarey")}
          <span>
            <strong>{gateway.profile?.name ?? "Squarey"}</strong>
            <small>{gateway.connection === "open" ? "Connected" : gateway.connection}</small>
          </span>
          <Button
            aria-label="Settings"
            className="settings-button"
            onClick={() => {
              setConnectionOpen(true);
              if (connected) void gateway.loadModelSettings();
            }}
            size="sm"
            variant="ghost"
          >
            <Settings2 />
            <span>Settings</span>
          </Button>
        </Stack>
      </aside>

      <main className="conversation-main">
        <Stack alignCenter className="conversation-header" gap={12}>
          <Button
            aria-label="Open conversations"
            className="mobile-only"
            onClick={() => setSidebarOpen(true)}
            size="icon"
            variant="ghost"
          >
            <Menu />
          </Button>
          {avatar(gateway.selectedTitle, gateway.busy, 30)}
          <div className="conversation-title">
            <strong>{gateway.selectedTitle}</strong>
            <span>
              {gateway.reconciling
                ? "Refreshing conversation…"
                : gateway.busy
                  ? "Working"
                  : gateway.selectedRef?.kind === "stored"
                    ? "Past conversation"
                    : gateway.connection === "open"
                      ? "Ready"
                      : "Offline"}
            </span>
          </div>
          <div className="header-actions">
            <Button
              aria-label="Edit agent"
              disabled={!connected}
              hidden={selectedAgent === undefined}
              onClick={() => {
                if (selectedAgent === undefined) return;
                setAgentEditorOpen(true);
                void gateway.loadAgentDefinition(selectedAgent.id);
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Pencil />
            </Button>
            <Button
              aria-label={selectedPin === undefined ? "Pin conversation" : "Unpin conversation"}
              className={selectedPin === undefined ? "" : "is-selected"}
              disabled={!connected || gateway.selectedRef === undefined || gateway.sidebarBusy}
              onClick={() => {
                const ref = gateway.selectedRef;
                if (ref === undefined) return;
                void runSidebarAction("pin", () =>
                  selectedPin === undefined
                    ? gateway.setConversationPin(ref, gateway.selectedTitle)
                    : gateway.removeConversationPin(selectedPin.pinId),
                );
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Star />
            </Button>
          </div>
        </Stack>

        <ScrollArea className="transcript-scroll">
          <div className="transcript">
            {gateway.hasMoreHistory ? (
              <Button
                className="load-earlier"
                disabled={gateway.loadingHistory}
                onClick={() => void gateway.loadEarlier()}
                size="sm"
                variant="ghost"
              >
                {gateway.loadingHistory ? "Loading…" : "Load earlier"}
              </Button>
            ) : null}
            {(gateway.loadingHistory || startupPending) && gateway.history.length === 0 ? (
              <div className="history-skeleton" aria-label="Loading conversation">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {gateway.history.length === 0 &&
            gateway.pendingUser === undefined &&
            !gateway.loadingHistory &&
            !startupPending ? (
              <div className="welcome-state">
                <PrismArt />
                <h1>{connected ? `Talk with ${gateway.selectedTitle}` : "Meet Squarey"}</h1>
                <p>
                  {connected
                    ? "Start with what is on your mind. This conversation stays with your local Profile."
                    : "Connect to Squarey to open your conversations and start chatting."}
                </p>
                {connected ? null : (
                  <Button onClick={() => setConnectionOpen(true)}>Connect</Button>
                )}
              </div>
            ) : null}
            {groupCompletedActivity(
              gateway.history,
              (entry) => entry.kind === "tool" && entry.phase === "end" && !entry.failed,
            ).map((entries, groupIndex) => (
              <ToolActivity count={entries.length} key={groupIndex}>
                {entries.map((entry, index) => (
                  <HistoryEntry
                    assistantName={gateway.selectedTitle}
                    entry={entry}
                    key={historyKey(entry, index)}
                  />
                ))}
              </ToolActivity>
            ))}
            {gateway.pendingUser === undefined ? null : (
              <article className="message user optimistic">
                <div className="message-author">You</div>
                <div className="message-body">{gateway.pendingUser}</div>
              </article>
            )}
            {groupCompletedActivity(
              gateway.tools,
              (tool) => tool.phase === "end" && !tool.failed,
            ).map((tools, groupIndex) => (
              <ToolActivity count={tools.length} key={groupIndex}>
                {tools.map((tool) => (
                  <div className="tool-line live" key={tool.id}>
                    <span className={tool.failed ? "tool-dot is-error" : "tool-dot"} />
                    <span>{tool.name}</span>
                    <span>
                      {tool.phase === "end" ? (tool.failed ? "failed" : "finished") : "working"}
                    </span>
                  </div>
                ))}
              </ToolActivity>
            ))}
            {gateway.streamText.length === 0 ? null : (
              <article className="message assistant streaming">
                <div className="message-author">{gateway.selectedTitle}</div>
                <div className="message-body">
                  <MessageMarkdown>{gateway.streamText}</MessageMarkdown>
                </div>
              </article>
            )}
            {gateway.localError === undefined ? null : (
              <div className="conversation-error" role="alert">
                {gateway.localError}
              </div>
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>

        <div className="composer-wrap">
          <div className="composer-panel">
            {selectedGroup === undefined ? null : (
              <label className="recipient-control">
                <span>Send to</span>
                <select onChange={(event) => setRecipient(event.target.value)} value={recipient}>
                  <option value="all">Everyone</option>
                  <option value="host">{gateway.profile?.name ?? "Host"}</option>
                  {selectedGroup.memberAgentIds.map((agentId) => (
                    <option key={agentId} value={agentId}>
                      {agentId}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {gateway.pendingInputs.length > 0 ? (
              <section className="pending-inputs" aria-label="Pending messages">
                <strong>Pending from this tab · {gateway.pendingInputs.length}</strong>
                {gateway.pendingInputs.map((input) => (
                  <div key={input.id}>
                    <span>{input.mode === "queue" ? "Queued" : "Steering"}</span>
                    <p>{input.text}</p>
                  </div>
                ))}
              </section>
            ) : null}
            <form className="composer" onSubmit={(event) => void send(event)}>
              <Textarea
                aria-label={`Message ${gateway.selectedTitle}`}
                disabled={!connected || !selectedIsLive}
                maxLength={gateway.maxPromptCodePoints}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={composerKeyDown}
                placeholder={
                  !connected
                    ? "Offline"
                    : selectedIsLive
                      ? `Message ${gateway.selectedTitle}`
                      : "Past conversations are read only"
                }
                rows={1}
                value={draft}
              />
              {gateway.busy ? (
                <Button
                  aria-label="Stop generating"
                  className="send-button"
                  onClick={() => void gateway.abort()}
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  <Square />
                </Button>
              ) : null}
              {gateway.busy ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={draft.trim().length === 0 || !connected}
                  onClick={() => void send(undefined, "queue")}
                >
                  Queue
                </Button>
              ) : null}
              <Button
                aria-label={gateway.busy ? "Steer response" : "Send message"}
                className="send-button"
                disabled={!connected || !selectedIsLive || draft.trim().length === 0}
                size="icon"
                type="submit"
              >
                <ArrowUp />
              </Button>
            </form>
            <p className="composer-hint">
              {gateway.busy
                ? "Enter to steer · Queue to send after this response"
                : "Enter to send"}{" "}
              · Shift+Enter for a new line
            </p>
          </div>
        </div>
      </main>

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onCreate={gateway.createChat}
      />
      {sidebarOpen ? (
        <button
          aria-label="Close conversations"
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}
      <GroupDialog
        agents={gateway.agents}
        error={groupError}
        onCreate={createGroup}
        onOpenChange={setGroupDialogOpen}
        open={groupDialogOpen}
        pending={localAction === "group:create"}
      />
      <AutomationDetailDialog
        automation={selectedAutomation}
        available={connected}
        detail={gateway.automationDetail}
        destinations={gateway.automationDestinations}
        onOpenChange={(open) => {
          if (open) return;
          setSelectedAutomationId(undefined);
          gateway.clearAutomationDetail();
        }}
        onRefresh={() => {
          if (selectedAutomationId !== undefined)
            void gateway.loadAutomationDetail(selectedAutomationId).catch(() => undefined);
        }}
        onSave={async (source, expectedSource) => {
          if (selectedAutomationId === undefined) return;
          await gateway.saveAutomationDefinition(selectedAutomationId, source, expectedSource);
        }}
        open={selectedAutomationId !== undefined}
      />
      <AgentDefinitionDialog
        agent={selectedAgent}
        available={connected}
        detail={gateway.agentDefinitionDetail}
        onOpenChange={(open) => {
          setAgentEditorOpen(open);
          if (!open) gateway.clearAgentDefinition();
        }}
        onRefresh={() => {
          if (selectedAgent !== undefined) void gateway.loadAgentDefinition(selectedAgent.id);
        }}
        onSave={async (source, expectedSource) => {
          if (selectedAgent === undefined) return;
          await gateway.saveAgentDefinition(selectedAgent.id, source, expectedSource);
          setAgentEditorOpen(false);
          gateway.clearAgentDefinition();
        }}
        open={agentEditorOpen && selectedAgent !== undefined}
      />
      <SettingsDialog
        connected={connected}
        connectionError={gateway.localError}
        connectionPending={gateway.connection === "connecting"}
        modelSettings={gateway.modelSettings}
        hosted={hosted}
        pairingRequired={pairingRequired}
        onConnect={connect}
        onOpenChange={(open) => {
          setConnectionOpen(open);
          if (!open) gateway.clearModelSettings();
        }}
        onRetrySettings={gateway.loadModelSettings}
        onSaveModel={gateway.saveModelSettings}
        open={connectionOpen}
        profileName={gateway.profile?.name ?? "Squarey"}
      />
      <div aria-live="polite" className="sr-only">
        {gateway.busy
          ? "Squarey is working"
          : gateway.streamText.length > 0
            ? "Response complete"
            : ""}
      </div>
    </div>
  );
}
