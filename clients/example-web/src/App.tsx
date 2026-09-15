import Stack, { VStack } from "@nkzw/stack";
import { ArrowUp, Menu, PanelLeftClose, Search, Settings2, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ZiggySessionHistoryEntry } from "../../gateway-client/src/index";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bot-avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { ConnectionDialog, readSavedConnection } from "@/components/connection-dialog";
import { type ConversationSummary, useZiggyGateway } from "@/gateway";

const avatar = (name: string, active = false, size = 36) => (
  <BotAvatar active={active} className="bot-avatar" name={name} size={size} />
);

const historyKey = (entry: ZiggySessionHistoryEntry, index: number): string =>
  `${entry.timestamp}:${entry.kind}:${entry.kind === "tool" ? entry.toolName : entry.text.slice(0, 24)}:${index}`;

function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  readonly conversation: ConversationSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      className="conversation-row"
      data-selected={selected || undefined}
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
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

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query.length === 0
      ? gateway.conversations
      : gateway.conversations.filter((conversation) =>
          `${conversation.title} ${conversation.subtitle}`.toLocaleLowerCase().includes(query),
        );
  }, [gateway.conversations, search]);

  const connect = async (url: string, token: string): Promise<void> => {
    const attempt = ++connectionAttemptRef.current;
    try {
      await gateway.connect({ url, token });
      if (attempt === connectionAttemptRef.current) setConnectionOpen(false);
    } catch {
      if (attempt === connectionAttemptRef.current) setConnectionOpen(true);
    }
  };

  useEffect(() => {
    if (autoConnectStartedRef.current) return;
    const saved = readSavedConnection();
    if (saved === undefined) return;
    autoConnectStartedRef.current = true;
    void connect(saved.url, saved.token);
  });

  const send = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || gateway.busy) return;
    try {
      await gateway.submit(text);
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

  const connected = gateway.connection === "open" || gateway.connection === "reconnecting";
  const selectedIsLive = gateway.selectedRef?.kind === "live";

  return (
    <div className="app-shell">
      <aside className="sidebar" data-open={sidebarOpen || undefined}>
        <Stack alignCenter between className="sidebar-heading">
          <strong>Ziggy</strong>
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
          <VStack gap={4} className="conversation-list">
            {filteredConversations.length === 0 ? (
              <p className="rail-empty">Conversations appear here after you connect.</p>
            ) : (
              filteredConversations.map((conversation) => (
                <ConversationRow
                  conversation={conversation}
                  key={`${conversation.ref.kind}:${conversation.ref.kind === "live" ? conversation.ref.key : conversation.ref.id}`}
                  onSelect={() => {
                    setSidebarOpen(false);
                    void gateway.selectConversation(conversation);
                  }}
                  selected={
                    conversation.ref.kind === "live"
                      ? gateway.selectedRef?.kind === "live" &&
                        gateway.selectedRef.key === conversation.ref.key
                      : gateway.selectedRef?.kind === "stored" &&
                        gateway.selectedRef.id === conversation.ref.id
                  }
                />
              ))
            )}
          </VStack>
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
            {gateway.loadingHistory && gateway.history.length === 0 ? (
              <div className="history-skeleton" aria-label="Loading conversation">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {gateway.history.length === 0 &&
            gateway.pendingUser === undefined &&
            !gateway.loadingHistory ? (
              <div className="welcome-state">
                {avatar(gateway.profile?.name ?? "Squarey", false, 56)}
                <h1>
                  {connected ? `Talk with ${gateway.profile?.name ?? "Squarey"}` : "Meet Squarey"}
                </h1>
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
