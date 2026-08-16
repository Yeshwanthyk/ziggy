import {
  connectZiggy,
  type ZiggyGatewayClient,
  type ZiggyGatewayEvent,
  type ZiggyLiveSession,
  type ZiggySessionKey,
  type ZiggyStoredSession,
} from "../gateway-client/src/index";

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing example element: ${selector}`);
  return element;
};

const connectionForm = required<HTMLFormElement>("#connection-form");
const portInput = required<HTMLInputElement>("#port");
const tokenInput = required<HTMLInputElement>("#token");
const connectionState = required<HTMLElement>("#connection-state");
const operationStatus = required<HTMLElement>("#operation-status");
const openForm = required<HTMLFormElement>("#open-form");
const openSessionButton = required<HTMLButtonElement>("#open-session");
const sessionNameInput = required<HTMLInputElement>("#session-name");
const liveSessions = required<HTMLElement>("#live-sessions");
const storedSessions = required<HTMLElement>("#stored-sessions");
const chatSession = required<HTMLElement>("#chat-session");
const chatLog = required<HTMLElement>("#chat-log");
const promptForm = required<HTMLFormElement>("#prompt-form");
const sendPromptButton = required<HTMLButtonElement>("#send-prompt");
const promptInput = required<HTMLTextAreaElement>("#prompt");
const watchSession = required<HTMLElement>("#watch-session");
const watchLog = required<HTMLElement>("#watch-log");

let client: ZiggyGatewayClient | undefined;
let activeChat: ZiggySessionKey | undefined;
let activeWatch: ZiggySessionKey | undefined;
let assistantMessage: HTMLElement | undefined;

const showError = (cause: unknown): void => {
  const message = cause instanceof Error ? cause.message : String(cause);
  operationStatus.textContent = message;
};

const messageElement = (role: "user" | "assistant", text: string): HTMLElement => {
  const message = document.createElement("p");
  message.className = `message ${role}`;
  message.textContent = text;
  return message;
};

const appendWatch = (event: ZiggyGatewayEvent): void => {
  if (!("session" in event) || event.session !== activeWatch) return;
  const line = document.createElement("div");
  line.textContent = `${event.event}  ${JSON.stringify(event.payload)}`;
  watchLog.append(line);
  watchLog.scrollTop = watchLog.scrollHeight;
};

const handleEvent = (event: ZiggyGatewayEvent): void => {
  if (event.event === "connection-state") {
    connectionState.textContent = event.payload.state;
    connectionState.dataset.state = event.payload.state;
    const connected = event.payload.state === "open";
    openSessionButton.disabled = !connected;
    sendPromptButton.disabled = !connected || activeChat === undefined;
    if (connected) {
      operationStatus.textContent = "";
      void refreshSessions();
    }
    return;
  }
  appendWatch(event);
  if (event.session !== activeChat) return;
  if (event.event === "assistant-text") {
    if (assistantMessage === undefined) {
      assistantMessage = messageElement("assistant", "");
      chatLog.append(assistantMessage);
    }
    assistantMessage.textContent = event.payload.snapshot;
    chatLog.scrollTop = chatLog.scrollHeight;
  } else if (event.event === "settled" || event.event === "error") {
    assistantMessage = undefined;
    sendPromptButton.disabled = client?.state !== "open";
  }
};

const sessionRow = (session: ZiggyLiveSession): HTMLElement => {
  const row = document.createElement("div");
  row.className = "session-row";
  const label = document.createElement("code");
  label.textContent = `${session.key} · ${session.idle ? "idle" : "working"}`;
  const watch = document.createElement("button");
  watch.type = "button";
  watch.textContent = "Watch";
  watch.addEventListener("click", () => {
    if (client === undefined) return;
    watch.disabled = true;
    void client
      .request("session.watch", { session: session.key })
      .then(() => {
        activeWatch = session.key;
        watchSession.textContent = `Watching ${session.key}`;
        watchLog.textContent = "Waiting for new events…";
      })
      .catch(showError)
      .finally(() => (watch.disabled = false));
  });
  row.append(label, watch);
  return row;
};

const storedRow = (session: ZiggyStoredSession): HTMLElement => {
  const row = document.createElement("div");
  row.className = "session-row";
  const label = document.createElement("code");
  label.title = session.path;
  label.textContent = `${session.id} · ${session.createdAt}`;
  row.append(label);
  return row;
};

const replaceList = (
  target: HTMLElement,
  items: ReadonlyArray<HTMLElement>,
  emptyText: string,
): void => {
  target.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }
  target.append(...items);
};

async function refreshSessions(): Promise<void> {
  if (client === undefined || client.state !== "open") return;
  liveSessions.textContent = "Loading live sessions…";
  storedSessions.textContent = "Loading stored transcripts…";
  try {
    const result = await client.request("session.list", {});
    replaceList(liveSessions, result.live.map(sessionRow), "No live sessions.");
    replaceList(storedSessions, result.stored.map(storedRow), "No stored transcripts.");
  } catch (cause) {
    showError(cause);
  }
}

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  client?.close();
  activeChat = undefined;
  activeWatch = undefined;
  assistantMessage = undefined;
  chatSession.textContent = "No UI session open";
  const emptyChat = document.createElement("p");
  emptyChat.className = "empty";
  emptyChat.textContent = "Open a UI session to start a conversation.";
  chatLog.replaceChildren(emptyChat);
  watchSession.textContent = "No channel session watched";
  watchLog.textContent = "Choose Watch beside a live session.";
  liveSessions.textContent = "Connecting…";
  storedSessions.textContent = "Connecting…";
  connectionState.textContent = "connecting";
  connectionState.dataset.state = "connecting";
  operationStatus.textContent = "";
  openSessionButton.disabled = true;
  sendPromptButton.disabled = true;
  try {
    client = connectZiggy({
      url: `ws://127.0.0.1:${portInput.value}/ws`,
      token: tokenInput.value,
    });
    client.onAny(handleEvent);
  } catch (cause) {
    connectionState.textContent = "closed";
    connectionState.dataset.state = "closed";
    showError(cause);
  }
});

openForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (client === undefined) return showError(new Error("Connect to Ziggy first."));
  openSessionButton.disabled = true;
  void client
    .request("session.open", { name: sessionNameInput.value })
    .then(({ session }) => {
      activeChat = session;
      assistantMessage = undefined;
      chatSession.textContent = session;
      chatLog.replaceChildren();
      sendPromptButton.disabled = false;
      return refreshSessions();
    })
    .catch(showError)
    .finally(() => (openSessionButton.disabled = client?.state !== "open"));
});

promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (client === undefined || activeChat === undefined) {
    return showError(new Error("Open a UI session first."));
  }
  const text = promptInput.value.trim();
  if (text.length === 0) return;
  chatLog.querySelector(".empty")?.remove();
  chatLog.append(messageElement("user", text));
  assistantMessage = undefined;
  promptInput.value = "";
  sendPromptButton.disabled = true;
  void client.request("prompt.submit", { session: activeChat, text }).catch((cause) => {
    showError(cause);
    sendPromptButton.disabled = client?.state !== "open";
  });
});
