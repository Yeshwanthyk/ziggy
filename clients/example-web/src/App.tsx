import Stack from "@nkzw/stack";
import {
  ArrowUp,
  Menu,
  PanelLeftClose,
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
} from "../../gateway-client/src/index";
import { AutomationRow } from "@/components/automation-row";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bot-avatar";
import { GroupDialog } from "@/components/group-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarSection } from "@/components/sidebar-section";
import { Textarea } from "@/components/ui/textarea";
import { ConnectionDialog, readSavedConnection } from "@/components/connection-dialog";
import { type ConversationSummary, useZiggyGateway } from "@/gateway";

const avatar = (name: string, active = false, size = 36) => (
  <BotAvatar active={active} className="bot-avatar" name={name} size={size} />
);

const historyKey = (entry: ZiggySessionHistoryEntry, index: number): string =>
  `${entry.timestamp}:${entry.kind}:${entry.kind === "tool" ? entry.toolName : entry.text.slice(0, 24)}:${index}`;

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
}: {
  readonly active?: boolean;
  readonly description: string;
  readonly disabled?: boolean;
  readonly name: string;
  readonly onSelect: () => void;
  readonly selected?: boolean;
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
        <span>{description}</span>
      </span>
    </button>
  );
}

function HistoryEntry({
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
  return (
    <article className={`message ${entry.kind}`}>
      <div className="message-author">{entry.kind === "user" ? "You" : assistantName}</div>
      <div className="message-body">{entry.text}</div>
    </article>
  );
}

export function App() {
  const gateway = useZiggyGateway();
  const [connectionOpen, setConnectionOpen] = useState(() => readSavedConnection() === undefined);
  const [startupPending, setStartupPending] = useState(() => readSavedConnection() !== undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupError, setGroupError] = useState<string>();
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

  useEffect(() => {
    const current = selectedGroup?.defaultRecipient;
    setRecipient(
      current?.kind === "agent" ? current.agentId : current?.kind === "host" ? "host" : "all",
    );
  }, [selectedGroup]);

  const connect = async (url: string, token: string): Promise<void> => {
    const attempt = ++connectionAttemptRef.current;
    setStartupPending(true);
    try {
      await gateway.connect({ url, token });
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
    if (saved === undefined) return;
    autoConnectStartedRef.current = true;
    void connect(saved.url, saved.token);
  });

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

  const send = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || gateway.busy) return;
    const target: ZiggyRecipientId | undefined =
      selectedGroup === undefined
        ? undefined
        : recipient === "all"
          ? { kind: "all" }
          : recipient === "host"
            ? { kind: "host" }
            : { kind: "agent", agentId: recipient };
    try {
      await gateway.submit(text, target);
      setDraft((current) => (current.trim() === text ? "" : current));
    } catch {
      // The gateway keeps the precise error and the draft stays available for review.
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
          <strong>Ziggy</strong>
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
              empty={
                startupPending ? "Restoring main chat…" : "Connect to open your main conversation."
              }
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
              empty={
                sidebarPending
                  ? "Restoring pinned chats…"
                  : connected
                    ? "Pin a chat to keep it close."
                    : "Connect to see pinned chats."
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
                    : "Connect to see direct agents."
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
                    : "Connect to see group conversations."
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
                    : "Connect to see automations."
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
            aria-label="Connection settings"
            className="settings-button"
            onClick={() => setConnectionOpen(true)}
            size="icon"
            variant="ghost"
          >
            <Settings2 />
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
                      : "Connect to begin"}
            </span>
          </div>
          <Button
            aria-label={selectedPin === undefined ? "Pin conversation" : "Unpin conversation"}
            className={`header-action ${selectedPin === undefined ? "" : "is-selected"}`}
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
                {avatar(gateway.selectedTitle, false, 56)}
                <h1>{connected ? `Talk with ${gateway.selectedTitle}` : "Meet Squarey"}</h1>
                <p>
                  {connected
                    ? "Start with what is on your mind. This conversation stays with your local Profile."
                    : "Connect this tab to the local Ziggy resident to open your main conversation."}
                </p>
                {connected ? null : (
                  <Button onClick={() => setConnectionOpen(true)}>Connect</Button>
                )}
              </div>
            ) : null}
            {gateway.history.map((entry, index) => (
              <HistoryEntry
                assistantName={gateway.selectedTitle}
                entry={entry}
                key={historyKey(entry, index)}
              />
            ))}
            {gateway.pendingUser === undefined ? null : (
              <article className="message user optimistic">
                <div className="message-author">You</div>
                <div className="message-body">{gateway.pendingUser}</div>
              </article>
            )}
            {gateway.tools.map((tool) => (
              <div className="tool-line live" key={tool.id}>
                <span className={tool.failed ? "tool-dot is-error" : "tool-dot"} />
                <span>{tool.name}</span>
                <span>
                  {tool.phase === "end" ? (tool.failed ? "failed" : "finished") : "working"}
                </span>
              </div>
            ))}
            {gateway.streamText.length === 0 ? null : (
              <article className="message assistant streaming">
                <div className="message-author">{gateway.selectedTitle}</div>
                <div className="message-body">{gateway.streamText}</div>
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
          <form className="composer" onSubmit={(event) => void send(event)}>
            <Textarea
              aria-label={`Message ${gateway.selectedTitle}`}
              disabled={!connected || !selectedIsLive}
              maxLength={gateway.maxPromptCodePoints}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={composerKeyDown}
              placeholder={
                !connected
                  ? "Connect to begin"
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
            ) : (
              <Button
                aria-label="Send message"
                className="send-button"
                disabled={!connected || !selectedIsLive || draft.trim().length === 0}
                size="icon"
                type="submit"
              >
                <ArrowUp />
              </Button>
            )}
          </form>
          <p>Enter to send · Shift+Enter for a new line</p>
        </div>
      </main>

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
      <ConnectionDialog
        error={gateway.localError}
        onConnect={connect}
        onOpenChange={setConnectionOpen}
        open={connectionOpen}
        pending={gateway.connection === "connecting"}
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
