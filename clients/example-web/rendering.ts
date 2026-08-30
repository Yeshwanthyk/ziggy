import { identitySvg } from "./blobs";
import { create, maybe, required } from "./dom";
import type {
  AgentRecord,
  AppState,
  AutomationRecord,
  ComposerMode,
  ConnectionState,
  Conversation,
  DemoState,
  MemoryRecord,
  Message,
  RunRecord,
  Tone,
  TurnState,
} from "./model";

export interface RenderingDependencies {
  readonly state: AppState;
  readonly app: HTMLDivElement;
  readonly viewRoot: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly backdrop: HTMLElement;
  readonly detailsPanel: HTMLElement;
  readonly detailsBody: HTMLElement;
  readonly connectionLabel: HTMLElement;
  readonly profileName: HTMLElement;
  readonly profileAvatar: HTMLElement;
  readonly profilePresence: HTMLElement;
  readonly residentCaption: HTMLElement;
  readonly openDetailsButton: HTMLButtonElement;
  readonly closeDetailsButton: HTMLButtonElement;
  readonly selectedConversation: () => Conversation | undefined;
  readonly selectedAgent: () => AgentRecord | undefined;
  readonly selectedAutomation: () => AutomationRecord | undefined;
  readonly selectedMemory: () => MemoryRecord | undefined;
  readonly gatewayRequest: (method: string, params: unknown) => Promise<unknown>;
  readonly isRecord: (value: unknown) => value is Record<string, unknown>;
  readonly stringValue: (value: unknown, fallback?: string) => string;
  readonly arrayValue: (value: unknown) => ReadonlyArray<unknown>;
  readonly errorMessage: (cause: unknown) => string;
  readonly showToast: (message: string, tone?: Tone) => void;
  readonly setOperation: (label: string, tone?: Tone) => void;
  readonly clearOperation: () => void;
  readonly closeDetails: () => void;
}

let state!: AppState;
let app!: HTMLDivElement;
let viewRoot!: HTMLElement;
let sidebar!: HTMLElement;
let backdrop!: HTMLElement;
let detailsPanel!: HTMLElement;
let detailsBody!: HTMLElement;
let connectionLabel!: HTMLElement;
let profileName!: HTMLElement;
let profileAvatar!: HTMLElement;
let profilePresence!: HTMLElement;
let residentCaption!: HTMLElement;
let openDetailsButton!: HTMLButtonElement;
let closeDetailsButton!: HTMLButtonElement;
let selectedConversation!: () => Conversation | undefined;
let selectedAgent!: () => AgentRecord | undefined;
let selectedAutomation!: () => AutomationRecord | undefined;
let selectedMemory!: () => MemoryRecord | undefined;
let gatewayRequest!: RenderingDependencies["gatewayRequest"];
let isRecord!: RenderingDependencies["isRecord"];
let stringValue!: RenderingDependencies["stringValue"];
let arrayValue!: RenderingDependencies["arrayValue"];
let errorMessage!: RenderingDependencies["errorMessage"];
let showToast!: RenderingDependencies["showToast"];
let setOperation!: RenderingDependencies["setOperation"];
let clearOperation!: RenderingDependencies["clearOperation"];
let closeDetails!: RenderingDependencies["closeDetails"];

const isCurrentProfileEffect = (profileId: string, generation: number): boolean =>
  state.mode === "live" && state.profile.id === profileId && state.profileGeneration === generation;

export const configureRendering = (dependencies: RenderingDependencies): void => {
  state = dependencies.state;
  app = dependencies.app;
  viewRoot = dependencies.viewRoot;
  sidebar = dependencies.sidebar;
  backdrop = dependencies.backdrop;
  detailsPanel = dependencies.detailsPanel;
  detailsBody = dependencies.detailsBody;
  connectionLabel = dependencies.connectionLabel;
  profileName = dependencies.profileName;
  profileAvatar = dependencies.profileAvatar;
  profilePresence = dependencies.profilePresence;
  residentCaption = dependencies.residentCaption;
  openDetailsButton = dependencies.openDetailsButton;
  closeDetailsButton = dependencies.closeDetailsButton;
  selectedConversation = dependencies.selectedConversation;
  selectedAgent = dependencies.selectedAgent;
  selectedAutomation = dependencies.selectedAutomation;
  selectedMemory = dependencies.selectedMemory;
  gatewayRequest = dependencies.gatewayRequest;
  isRecord = dependencies.isRecord;
  stringValue = dependencies.stringValue;
  arrayValue = dependencies.arrayValue;
  errorMessage = dependencies.errorMessage;
  showToast = dependencies.showToast;
  setOperation = dependencies.setOperation;
  clearOperation = dependencies.clearOperation;
  closeDetails = dependencies.closeDetails;
};

const avatarInto = (
  target: Element,
  id: string,
  size: "small" | "medium" | "large" = "small",
): void => {
  target.replaceChildren(identitySvg(id, size));
};

const statusText = (status: DemoState | ConnectionState | TurnState): string => {
  const labels: Record<DemoState | ConnectionState | TurnState, string> = {
    ready: "Ready",
    idle: "Ready",
    loading: "Loading",
    busy: "Busy",
    running: "Running",
    stopping: "Stopping",
    "watch-only": "Watch only",
    connecting: "Connecting",
    open: "Live",
    reconnecting: "Reconnecting",
    closed: "Offline",
    offline: "Offline",
    empty: "Empty",
    validation: "Needs validation",
    request: "Request pending",
    ownership: "Ownership",
    reconciliation: "Reconciling",
  };
  return labels[status];
};

const activeStatus = (): DemoState | ConnectionState =>
  state.mode === "demo" ? state.demoState : state.connectionState;

const renderConnectionStatus = (): void => {
  const status = activeStatus();
  const label = statusText(status);
  connectionLabel.textContent = label;
  const chip = required<HTMLElement>("#connection-chip");
  chip.dataset.state = status;
  chip.classList.toggle("is-demo", state.mode === "demo" && status === "ready");
  chip.querySelector<HTMLElement>(".status-led")?.setAttribute("aria-label", label);
  const tone: Tone =
    status === "offline" || status === "closed"
      ? "danger"
      : status === "reconnecting" || status === "loading"
        ? "warning"
        : "success";
  for (const led of document.querySelectorAll<HTMLElement>(
    ".connection-chip .status-led, .resident-status .status-led",
  )) {
    led.style.background =
      tone === "danger"
        ? "var(--danger)"
        : tone === "warning"
          ? "var(--warning)"
          : tone === "success"
            ? "var(--success)"
            : "var(--quiet)";
  }
  profilePresence.className = `presence-dot ${tone === "success" ? "presence-ready" : ""}`;
  residentCaption.textContent =
    state.mode === "demo"
      ? "Fixture mode · no resident connected"
      : state.connectionState === "open"
        ? `Connected to ${state.profile.name}`
        : statusText(state.connectionState);
};

const renderRosterRow = (conversation: Conversation): HTMLElement => {
  const button = create("button", "roster-row");
  button.type = "button";
  button.dataset.conversation = conversation.id;
  button.classList.toggle(
    "is-selected",
    conversation.id === state.selectedConversationId && state.view === "chat",
  );
  button.setAttribute("aria-label", `${conversation.title}, ${conversation.subtitle}`);
  const avatar = create("span");
  avatarInto(avatar, conversation.avatar, "small");
  const copy = create("span", "roster-copy");
  copy.append(
    create("span", "roster-title", conversation.title),
    create("span", "roster-subtitle", conversation.subtitle),
  );
  const meta = create("span", "roster-meta");
  meta.append(create("span", "roster-time", conversation.updatedAt));
  if (conversation.unread) meta.append(create("span", "unread-dot"));
  button.append(avatar, copy, meta);
  return button;
};

const renderRosterList = (
  target: HTMLElement,
  conversations: ReadonlyArray<Conversation>,
  emptyText: string,
): void => {
  target.replaceChildren();
  if (conversations.length === 0) {
    target.append(create("p", "roster-empty", emptyText));
    return;
  }
  for (const conversation of conversations) target.append(renderRosterRow(conversation));
};

const renderSidebar = (): void => {
  const query = state.search.trim().toLocaleLowerCase();
  const matches = (conversation: Conversation): boolean =>
    query.length === 0 ||
    `${conversation.title} ${conversation.subtitle} ${conversation.participants.join(" ")}`
      .toLocaleLowerCase()
      .includes(query);
  const conversations = state.conversations.filter(matches);
  const pinned = conversations.filter((conversation) => conversation.pinned);
  const specialists = conversations.filter((conversation) => conversation.kind === "specialist");
  const recent = conversations.filter(
    (conversation) => !conversation.pinned && conversation.kind !== "specialist",
  );
  renderRosterList(
    required<HTMLElement>("#pinned-list"),
    pinned,
    query.length > 0 ? "No pinned match." : "Pin a conversation to keep it here.",
  );
  renderRosterList(
    required<HTMLElement>("#recent-list"),
    recent,
    query.length > 0 ? "No recent match." : "Your recent conversations appear here.",
  );
  renderRosterList(
    required<HTMLElement>("#specialists-list"),
    specialists,
    "No specialists connected yet.",
  );
  required<HTMLElement>("#conversation-count").textContent = String(state.conversations.length);
  required<HTMLElement>("#automation-count").textContent = String(state.automations.length);
  profileName.textContent = state.profile.name;
  avatarInto(profileAvatar, "squarey", "small");
  const profileSelect = required<HTMLSelectElement>("#profile-select");
  profileSelect.replaceChildren(
    ...state.profiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.available ? profile.name : `${profile.name} · unavailable`;
      option.selected = profile.id === state.profile.id;
      option.disabled = !profile.available;
      return option;
    }),
  );
  profileSelect.disabled = state.mode === "live" && state.profiles.length < 2;
  for (const item of document.querySelectorAll<HTMLElement>(".nav-item[data-view]")) {
    const isActive = item.dataset.view === state.view;
    item.classList.toggle("is-active", isActive);
    if (isActive) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
};

const stateBanner = (conversation: Conversation | undefined): HTMLElement | undefined => {
  const demoState = state.mode === "demo" ? state.demoState : undefined;
  const connection = state.mode === "live" ? state.connectionState : undefined;
  const watchOnly = conversation?.turnState === "watch-only" || demoState === "watch-only";
  let title = "";
  let copy = "";
  let tone: Tone = "neutral";
  let symbol = "•";
  if (connection === "connecting") {
    title = "Connecting";
    copy = "The resident is opening a secure local channel.";
    tone = "warning";
    symbol = "↗";
  } else if (connection === "reconnecting" || demoState === "reconnecting") {
    title = "Reconnecting";
    copy =
      "Visible messages stay here while the resident reconnects. New events will reconcile when it returns.";
    tone = "warning";
    symbol = "↻";
  } else if (connection === "closed" || demoState === "offline") {
    title = "Offline";
    copy = "The transcript is still available. Connect a resident to send a new turn.";
    tone = "danger";
    symbol = "×";
  } else if (watchOnly) {
    title = "Watch only";
    copy = "This channel is visible here, but input remains with its owning channel adapter.";
    tone = "neutral";
    symbol = "◉";
  } else if (demoState === "loading") {
    title = "Loading history";
    copy = "Restoring the latest bounded transcript page.";
    tone = "warning";
    symbol = "…";
  } else if (demoState === "busy") {
    title = "Squarey is working";
    copy = "The turn is active. You can steer it or stop the run.";
    tone = "warning";
    symbol = "◌";
  } else if (demoState === "stopping") {
    title = "Stopping";
    copy = "The resident is completing the abort boundary. Keep this conversation open.";
    tone = "warning";
    symbol = "■";
  } else if (demoState === "validation") {
    title = "Validation needed";
    copy = "This operation is blocked until the current definition or agent passes validation.";
    tone = "danger";
    symbol = "!";
  } else if (demoState === "request") {
    title = "Request pending";
    copy = "The command has been accepted locally and is waiting for the resident response.";
    tone = "warning";
    symbol = "→";
  } else if (demoState === "ownership") {
    title = "Resident-owned";
    copy =
      "One Profile resident owns this conversation. Browser controls are requests, never transcript writers.";
    tone = "success";
    symbol = "◆";
  } else if (demoState === "reconciliation") {
    title = "Reconciliation in progress";
    copy = "Local intent is being checked against the server projection before the roster changes.";
    tone = "warning";
    symbol = "⇄";
  }
  if (title.length === 0) return undefined;
  const banner = create("div", "state-banner");
  banner.dataset.tone = tone;
  const glyph = create("span", "state-symbol", symbol);
  const copyElement = create("span");
  copyElement.append(create("strong", undefined, title), create("p", undefined, copy));
  banner.append(glyph, copyElement);
  return banner;
};

const specialistIdentity = (name: string | undefined): string => {
  const normalized = name?.toLocaleLowerCase() ?? "";
  if (normalized.includes("scout")) return "scout";
  if (normalized.includes("sage")) return "sage";
  return "squarey";
};

const authorIdentity = (author: string, fallback: string): string => {
  const normalized = author.toLocaleLowerCase();
  if (normalized.includes("sage")) return "sage";
  if (normalized.includes("scout")) return "scout";
  if (normalized.includes("squarey")) return "squarey";
  return fallback;
};

const renderMessage = (message: Message, conversation: Conversation): HTMLElement => {
  if (message.role === "tool") {
    const tool = create("div", "tool-event");
    const glyph = create("span", "tool-glyph", "⌁");
    const copy = create("span");
    copy.append(create("span", "tool-name", message.toolName ?? "Tool activity"));
    if (message.detail !== undefined)
      copy.append(create("span", "tool-detail", ` · ${message.detail}`));
    const status = create(
      "span",
      "tool-state",
      message.toolState === "failed"
        ? "Failed"
        : message.toolState === "running"
          ? "Running"
          : "Complete",
    );
    status.classList.toggle("is-running", message.toolState === "running");
    status.classList.toggle("is-failed", message.toolState === "failed");
    tool.append(glyph, copy, status);
    return tool;
  }
  if (message.role === "voice") {
    const row = create("article", "message-row message-specialist");
    row.dataset.role = "assistant";
    row.dataset.message = message.id;
    row.dataset.specialist = specialistIdentity(message.specialist);
    const avatar = create("span", "message-avatar message-avatar-specialist");
    avatarInto(avatar, specialistIdentity(message.specialist), "medium");
    const content = create("div", "message-content");
    const meta = create("div", "message-meta");
    meta.append(
      create("strong", undefined, message.specialist ?? message.author),
      create("span", "message-role", "specialist"),
      create("time", undefined, message.time),
    );
    content.append(meta, create("p", "message-text", message.text));
    const actions = create("div", "message-actions");
    const copyButton = create("button", "message-action", "Copy");
    copyButton.type = "button";
    copyButton.dataset.action = "copy-message";
    copyButton.dataset.messageId = message.id;
    actions.append(copyButton);
    content.append(actions);
    row.append(avatar, content);
    return row;
  }
  const row = create("article", "message-row");
  row.dataset.role = message.role;
  row.dataset.message = message.id;
  const avatar = create("span", "message-avatar");
  avatarInto(
    avatar,
    message.role === "user" ? "group" : authorIdentity(message.author, conversation.avatar),
    "medium",
  );
  const content = create("div", "message-content");
  const meta = create("div", "message-meta");
  meta.append(create("strong", undefined, message.author), create("time", undefined, message.time));
  const text = create("p", "message-text", message.text);
  content.append(meta, text);
  const actions = create("div", "message-actions");
  const copyButton = create("button", "message-action", "Copy");
  copyButton.type = "button";
  copyButton.dataset.action = "copy-message";
  copyButton.dataset.messageId = message.id;
  actions.append(copyButton);
  content.append(actions);
  row.append(avatar, content);
  if (message.streaming) row.classList.add("is-streaming");
  return row;
};

const renderSkeleton = (): HTMLElement => {
  const stack = create("div", "skeleton-stack");
  stack.append(
    create("div", "skeleton-line short"),
    create("div", "skeleton-line"),
    create("div", "skeleton-line mid"),
    create("div", "skeleton-line"),
    create("div", "skeleton-line short"),
  );
  return stack;
};

const renderTranscript = (conversation: Conversation | undefined): HTMLElement => {
  const transcript = create("div", "transcript");
  transcript.id = "transcript";
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", "Conversation transcript");
  if (state.demoState === "loading" || state.loadingHistory) {
    transcript.classList.add("is-loading");
    transcript.append(renderSkeleton());
    return transcript;
  }
  if (
    conversation === undefined ||
    state.demoState === "empty" ||
    conversation.messages.length === 0
  ) {
    const empty = create("div", "empty-conversation");
    const inner = create("div", "empty-conversation-inner");
    inner.append(
      create("span", "eyebrow", "No transcript yet"),
      create("h2", undefined, "Give this thread a first question."),
      create("p", undefined, "Your draft stays local to this conversation until you choose Send."),
    );
    empty.append(inner);
    transcript.append(empty);
    return transcript;
  }
  for (const message of conversation.messages)
    transcript.append(renderMessage(message, conversation));
  return transcript;
};

const renderComposer = (conversation: Conversation | undefined): HTMLElement => {
  const recipient = conversation?.title ?? state.profile.name;
  const shell = create("div", "composer-shell");
  const composer = create("form", "composer");
  composer.id = "composer-form";
  const modes = create("div", "composer-modes");
  const modeLabels: Readonly<Record<ComposerMode, string>> = {
    prompt: "Prompt",
    steer: "Steer",
    "follow-up": "Follow up",
  };
  for (const mode of ["prompt", "steer", "follow-up"] as const) {
    const button = create("button", "mode-button", modeLabels[mode]);
    button.type = "button";
    button.dataset.action = "composer-mode";
    button.dataset.mode = mode;
    button.classList.toggle("is-active", state.composerMode === mode);
    button.setAttribute("aria-pressed", String(state.composerMode === mode));
    modes.append(button);
  }
  if (conversation?.kind === "group" && state.composerMode === "prompt") {
    const recipient = create("select", "recipient-select");
    recipient.id = "group-recipient";
    recipient.setAttribute("aria-label", "Group recipient");
    const choices = [
      { value: "everyone", label: "Everyone" },
      { value: "host", label: state.profile.name },
      ...conversation.participants
        .filter((participant) => participant !== state.profile.name)
        .map((participant) => ({ value: participant, label: participant })),
    ];
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = `To: ${choice.label}`;
      option.selected = choice.value === (conversation.recipient ?? "host");
      recipient.append(option);
    }
    modes.append(recipient);
  }
  const help = create(
    "span",
    "mode-help",
    state.composerMode === "prompt"
      ? "Starts a new turn"
      : state.composerMode === "steer"
        ? "Redirects the active turn"
        : "Queues after settle",
  );
  modes.append(help);
  const box = create("div", "composer-box");
  const textarea = create("textarea");
  textarea.id = "composer-input";
  textarea.name = "text";
  textarea.rows = 1;
  textarea.placeholder =
    conversation?.turnState === "watch-only"
      ? "Watch-only conversation"
      : state.composerMode === "steer"
        ? "Redirect the active turn…"
        : state.composerMode === "follow-up"
          ? "Queue a follow-up…"
          : `Message ${recipient}…`;
  textarea.value = conversation?.draft ?? "";
  textarea.disabled =
    conversation === undefined ||
    conversation.turnState === "watch-only" ||
    conversation.closed ||
    state.connectionState === "closed" ||
    state.demoState === "offline" ||
    state.demoState === "loading" ||
    state.demoState === "stopping" ||
    state.demoState === "reconnecting";
  textarea.setAttribute("aria-label", `Message ${recipient}`);
  const submit = create(
    "button",
    "button-primary composer-submit",
    state.composerMode === "steer"
      ? "Steer"
      : state.composerMode === "follow-up"
        ? "Queue"
        : "Send",
  );
  submit.type = "submit";
  submit.dataset.action = "submit-composer";
  submit.disabled =
    textarea.disabled ||
    conversation?.turnState === "stopping" ||
    state.demoState === "request" ||
    (state.demoState === "busy" && state.composerMode === "prompt");
  const abort = create(
    "button",
    "button-danger composer-submit",
    conversation?.turnState === "stopping" ? "Stopping…" : "Stop",
  );
  abort.type = "button";
  abort.dataset.action = "abort-conversation";
  abort.disabled = conversation?.turnState !== "running" && state.demoState !== "busy";
  const controls = create("div", "composer-controls");
  controls.append(submit, abort);
  box.append(textarea, controls);
  const footer = create("div", "composer-footer");
  footer.append(create("span", "composer-hint", "⌘ Enter to send"));
  const status = create(
    "span",
    "composer-status",
    conversation?.turnState === "watch-only"
      ? "Watch-only channel"
      : conversation?.turnState === "running"
        ? "Turn in progress"
        : conversation?.turnState === "stopping"
          ? "Stopping…"
          : conversation?.closed
            ? "Session closed"
            : (state.operation?.label ?? "Draft stays with this thread"),
  );
  if (state.operation !== undefined) status.dataset.tone = state.operation.tone;
  footer.append(status);
  composer.append(modes, box, footer);
  shell.append(composer);
  return shell;
};

const renderConversation = (): HTMLElement => {
  const conversation = selectedConversation();
  const root = create("div", "conversation-view");
  const header = create("header", "conversation-header");
  const heading = create("div", "conversation-heading");
  const avatar = create("span");
  avatarInto(avatar, conversation?.avatar ?? "squarey", "medium");
  const headingCopy = create("div", "conversation-heading-copy");
  headingCopy.append(
    create("h1", undefined, conversation?.title ?? "New conversation"),
    create("p", undefined, conversation?.subtitle ?? "Squarey · local Profile"),
  );
  heading.append(avatar, headingCopy);
  const actions = create("div", "conversation-actions");
  const watch = create(
    "button",
    "button-secondary",
    conversation?.turnState === "watch-only" || conversation?.watched === true
      ? "Watching"
      : "Watch",
  );
  watch.type = "button";
  watch.dataset.action = "watch-conversation";
  watch.disabled =
    conversation === undefined || (state.mode === "demo" && state.demoState === "offline");
  watch.innerHTML = `<span aria-hidden="true">◉</span><span class="watch-label">${conversation?.turnState === "watch-only" || conversation?.watched === true ? "Watching" : "Watch"}</span>`;
  const pin = create("button", "button-secondary", conversation?.pinned ? "Pinned" : "Pin");
  pin.type = "button";
  pin.dataset.action = "toggle-pin";
  pin.disabled = conversation === undefined;
  pin.innerHTML = `<span aria-hidden="true">${conversation?.pinned ? "★" : "☆"}</span><span class="pin-label">${conversation?.pinned ? "Pinned" : "Pin"}</span>`;
  actions.append(watch, pin);
  header.append(heading, actions);
  root.append(header);
  const banner = stateBanner(conversation);
  if (banner !== undefined) root.append(banner);
  const wrap = create("div", "transcript-wrap");
  const historyToolbar = create("div", "history-toolbar");
  const historyButton = create("button", "button-quiet", "↑ Load earlier");
  historyButton.type = "button";
  historyButton.dataset.action = "load-history";
  historyButton.disabled =
    conversation === undefined || !conversation.historyHasMore || state.demoState === "loading";
  const historyCount = create(
    "span",
    "history-count",
    conversation === undefined ? "No messages" : `${conversation.messages.length} visible messages`,
  );
  historyToolbar.append(historyButton, historyCount);
  wrap.append(historyToolbar, renderTranscript(conversation));
  root.append(wrap);
  const activity = create("div", "activity-strip");
  const activityState =
    conversation?.turnState === "running" || state.demoState === "busy"
      ? "busy"
      : conversation?.lastError !== undefined
        ? "error"
        : "ready";
  activity.dataset.state = activityState;
  activity.append(
    create("span", "activity-pip"),
    create(
      "span",
      undefined,
      conversation?.lastError ??
        (activityState === "busy"
          ? "Squarey is thinking · live activity appears here"
          : conversation?.turnState === "watch-only"
            ? "Listening for channel events"
            : "Ready for the next turn"),
    ),
  );
  root.append(activity, renderComposer(conversation));
  return root;
};

const dataCell = (label: string, value: string): HTMLElement => {
  const cell = create("div", "data-cell");
  cell.append(create("span", undefined, label), create("strong", undefined, value));
  return cell;
};

export const renderConversationDetails = (): void => {
  const conversation = selectedConversation();
  detailsBody.replaceChildren();
  if (conversation === undefined) {
    detailsBody.append(create("p", "detail-copy", "Choose a conversation to inspect its route."));
    return;
  }
  const inner = create("div", "detail-inner");
  const title = create("div", "detail-title");
  const avatar = create("span");
  avatarInto(avatar, conversation.avatar, "large");
  const titleCopy = create("div", "detail-title-copy");
  titleCopy.append(
    create("h2", undefined, conversation.title),
    create("p", undefined, conversation.subtitle),
  );
  title.append(avatar, titleCopy);
  inner.append(title);
  const route = create("section", "detail-section");
  route.append(
    create("h3", undefined, "Routing"),
    create(
      "p",
      "detail-copy",
      conversation.kind === "channel"
        ? `${conversation.channel ?? "Channel"} is a watch-only projection.`
        : conversation.kind === "group"
          ? "One host Profile owns the canonical group transcript."
          : conversation.kind === "specialist"
            ? "A specialist voice inside this Profile; not a separate resident."
            : "The Profile bot owns this local conversation.",
    ),
  );
  const grid = create("div", "detail-grid");
  grid.append(
    dataCell("Owner", state.profile.name),
    dataCell("Reference", conversation.key),
    dataCell("Writer", "Resident"),
    dataCell(
      "Turn",
      statusText(conversation.turnState === "idle" ? "ready" : conversation.turnState),
    ),
  );
  route.append(grid);
  inner.append(route);
  const participants = create("section", "detail-section");
  participants.append(create("h3", undefined, "Participants"));
  const chips = create("div", "chip-list");
  for (const participant of conversation.participants) {
    const chip = create("span", "chip");
    chip.append(create("span", "chip-dot"), create("span", undefined, participant));
    chips.append(chip);
  }
  participants.append(chips);
  inner.append(participants);
  const model = create("section", "detail-section");
  model.append(create("h3", undefined, "Model & provider"));
  const form = create("div", "form-grid");
  const providerLabel = create("label", "field");
  providerLabel.append(create("span", "field-label", "Provider"));
  const provider = create("select");
  provider.id = "provider-select";
  const providerOptions = Array.from(
    new Set([
      state.profile.provider,
      ...(state.availableProviders.length > 0
        ? state.availableProviders
        : ["OpenAI", "Anthropic", "OpenRouter"]),
    ]),
  );
  for (const option of providerOptions) {
    const item = create("option", undefined, option);
    item.value = option;
    item.selected = option === state.profile.provider;
    provider.append(item);
  }
  providerLabel.append(provider);
  const modelLabel = create("label", "field");
  modelLabel.append(create("span", "field-label", "Model"));
  const modelSelect = create("select");
  modelSelect.id = "model-select";
  const modelOptions = Array.from(
    new Set([
      state.profile.model,
      ...(state.availableModels.length > 0
        ? state.availableModels
        : ["gpt-5", "gpt-5-mini", "claude-sonnet-4"]),
    ]),
  );
  for (const option of modelOptions) {
    const item = create("option", undefined, option);
    item.value = option;
    item.selected = option === state.profile.model;
    modelSelect.append(item);
  }
  modelLabel.append(modelSelect);
  form.append(providerLabel, modelLabel);
  const auth = create("div", "status-line");
  auth.dataset.tone =
    state.profile.auth === "connected"
      ? "success"
      : state.profile.auth === "missing"
        ? "danger"
        : "warning";
  const authLabel =
    state.profile.auth === "connected"
      ? state.authProviders.length > 0
        ? `Authenticated · ${state.authProviders.join(", ")}`
        : "Authenticated"
      : state.profile.auth === "missing"
        ? "Authentication required"
        : "Auth status unknown";
  auth.append(create("span", "status-led"), create("strong", undefined, authLabel));
  form.append(auth);
  model.append(form);
  inner.append(model);
  const actions = create("section", "detail-section");
  actions.append(create("h3", undefined, "Session controls"));
  const actionRow = create("div", "form-actions");
  const channelReadonly = conversation.kind === "channel";
  const close = create(
    "button",
    conversation.closed ? "button-primary" : "button-secondary",
    channelReadonly ? "Watch-only session" : conversation.closed ? "Reopen" : "Close session",
  );
  close.type = "button";
  close.disabled = channelReadonly;
  if (!channelReadonly)
    close.dataset.action = conversation.closed ? "reopen-session" : "close-session";
  actionRow.append(close);
  if (conversation.kind === "channel") {
    const watchButton = create("button", "button-secondary", "Watch channel");
    watchButton.type = "button";
    watchButton.dataset.action = "watch-conversation";
    actionRow.append(watchButton);
  }
  actions.append(actionRow);
  inner.append(actions);
  detailsBody.append(inner);
};

export const renderDetailsVisibility = (): void => {
  detailsPanel.classList.toggle("is-open", state.detailsOpen);
  detailsPanel.setAttribute("aria-hidden", String(!state.detailsOpen));
  detailsPanel.inert = !state.detailsOpen;
  openDetailsButton.setAttribute("aria-expanded", String(state.detailsOpen));
  let detailsBackdrop = maybe<HTMLElement>("#details-backdrop", app);
  if (detailsBackdrop === undefined) {
    detailsBackdrop = create("div", "details-backdrop");
    detailsBackdrop.id = "details-backdrop";
    detailsBackdrop.hidden = true;
    app.append(detailsBackdrop);
    detailsBackdrop.addEventListener("click", () => closeDetails());
  }
  detailsBackdrop.hidden = !state.detailsOpen;
};

const renderChatView = (): HTMLElement => {
  const wrapper = create("div");
  wrapper.append(renderConversation());
  return wrapper;
};

const panelShell = (
  kicker: string,
  title: string,
  copy: string,
  actionLabel: string,
  action: string,
): HTMLElement => {
  const root = create("div", "panel-view");
  const heading = create("header", "panel-heading");
  const headingCopy = create("div", "panel-heading-copy");
  headingCopy.append(
    create("span", "panel-kicker", kicker),
    create("h1", undefined, title),
    create("p", undefined, copy),
  );
  const button = create("button", "button-primary", actionLabel);
  button.type = "button";
  button.dataset.action = action;
  heading.append(headingCopy, button);
  root.append(heading);
  return root;
};

const listHeading = (title: string, count: number): HTMLElement => {
  const heading = create("div", "panel-list-heading");
  heading.append(create("strong", undefined, title), create("span", undefined, `${count} total`));
  return heading;
};

const listItem = (
  id: string,
  title: string,
  subtitle: string,
  stateLabel: string,
  selected: boolean,
  action: string,
  avatarId?: string,
): HTMLButtonElement => {
  const button = create("button", "panel-list-item");
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  button.classList.toggle("is-selected", selected);
  const leading = create("span");
  if (avatarId !== undefined) avatarInto(leading, avatarId, "small");
  else leading.append(create("span", "status-led"));
  const copy = create("span", "panel-list-item-copy");
  copy.append(create("strong", undefined, title), create("span", undefined, subtitle));
  const status = create("span", "list-state", stateLabel);
  button.append(leading, copy, status);
  return button;
};

const renderAgentDetail = (agent: AgentRecord | undefined): HTMLElement => {
  const detail = create("article", "panel-detail");
  const inner = create("div", "detail-inner");
  if (agent === undefined) {
    const empty = create("div", "empty-conversation");
    empty.append(create("p", "detail-copy", "Choose an agent to inspect its policy."));
    detail.append(empty);
    return detail;
  }
  const title = create("div", "detail-title");
  const avatar = create("span");
  avatarInto(
    avatar,
    agent.id === "sage" ? "sage" : agent.id === "scout" ? "scout" : "squarey",
    "large",
  );
  const copy = create("div", "detail-title-copy");
  copy.append(create("h2", undefined, agent.name), create("p", undefined, agent.description));
  title.append(avatar, copy);
  inner.append(title);
  const overview = create("section", "detail-section");
  overview.append(create("h3", undefined, "Effective runtime"));
  const grid = create("div", "detail-grid");
  grid.append(
    dataCell("Provider", agent.provider),
    dataCell("Model", agent.model),
    dataCell(
      "Status",
      agent.status === "needs-review"
        ? "Needs validation"
        : agent.status === "running"
          ? "Running"
          : "Ready",
    ),
    dataCell("Owner", state.profile.name),
  );
  overview.append(grid);
  const chips = create("div", "chip-list");
  for (const tool of agent.tools) {
    const chip = create("span", "chip");
    chip.append(create("span", "chip-dot"), create("span", undefined, tool));
    chips.append(chip);
  }
  if (agent.tools.length > 0) overview.append(chips);
  inner.append(overview);
  const editor = create("form", "detail-section");
  editor.id = "agent-editor";
  editor.dataset.agentId = agent.id;
  editor.append(create("h3", undefined, "Agent brief"));
  const brief = create("p", "detail-copy", agent.body);
  brief.dataset.agentBrief = agent.id;
  editor.append(brief);
  const actions = create("div", "form-actions");
  const validate = create("button", "button-secondary", "Validate");
  validate.type = "button";
  validate.dataset.action = "validate-agent";
  const run = create("button", "button-primary", "Run a task");
  run.type = "button";
  run.dataset.action = "run-agent";
  run.dataset.id = agent.id;
  actions.append(validate, run);
  editor.append(
    actions,
    create(
      "p",
      "form-status",
      state.demoState === "validation"
        ? "Validation has not passed yet."
        : agent.status === "needs-review"
          ? "Validate before this specialist can run."
          : "Ready for a fresh one-shot specialist run.",
    ),
  );
  inner.append(editor);
  const conversation = state.conversations.find(
    (item) => item.id === agent.id || item.key === `local/agents/${agent.id}`,
  );
  const openSection = create("section", "detail-section");
  openSection.append(create("h3", undefined, "Conversation"));
  const open = create(
    "button",
    "button-quiet",
    conversation === undefined ? "Open specialist thread" : "Open specialist thread",
  );
  open.type = "button";
  open.dataset.action = "open-agent-conversation";
  open.dataset.id = agent.id;
  openSection.append(open);
  inner.append(openSection);
  detail.append(inner);
  return detail;
};

export const loadAgentDetails = async (agent: AgentRecord): Promise<void> => {
  if (state.mode === "demo") return;
  const profileId = state.profile.id;
  const generation = state.profileGeneration;
  setOperation(`Reading ${agent.name}…`, "warning");
  try {
    const value = await gatewayRequest("agent.show", { id: agent.id });
    if (!isCurrentProfileEffect(profileId, generation) || !state.agents.includes(agent)) return;
    const source = isRecord(value) && isRecord(value.agent) ? value.agent : value;
    if (!isRecord(source)) throw new Error("Resident returned no agent projection");
    agent.description = stringValue(source.description, agent.description);
    agent.provider = stringValue(source.provider, agent.provider);
    agent.model = stringValue(source.model, agent.model);
    agent.tools = arrayValue(source.tools).filter(
      (tool): tool is string => typeof tool === "string",
    );
    agent.body = agent.description;
    showToast(`${agent.name} details loaded`, "success");
  } catch (cause) {
    if (isCurrentProfileEffect(profileId, generation))
      showToast(`Agent details unavailable: ${errorMessage(cause)}`, "warning");
  } finally {
    if (isCurrentProfileEffect(profileId, generation)) clearOperation();
  }
};

const renderAgentsView = (): HTMLElement => {
  const root = panelShell(
    "Profile roster",
    "Agents",
    "Named voices stay inside the served Profile. Validate policy before asking a specialist to run.",
    "Create agent",
    "new-agent",
  );
  const content = create("div", "panel-content");
  const list = create("div", "panel-list");
  list.append(listHeading("Profile agents", state.agents.length));
  for (const agent of state.agents) {
    const status =
      agent.status === "ready" ? "Ready" : agent.status === "running" ? "Running" : "Review";
    const row = listItem(
      agent.id,
      agent.name,
      agent.description,
      status,
      agent.id === state.selectedAgentId,
      "select-agent",
      agent.id === "sage" ? "sage" : agent.id === "scout" ? "scout" : "squarey",
    );
    row
      .querySelector<HTMLElement>(".list-state")
      ?.classList.add(
        agent.status === "ready"
          ? "is-valid"
          : agent.status === "running"
            ? "is-active"
            : "is-draft",
      );
    list.append(row);
  }
  content.append(
    list,
    state.selectedAgentId === "draft" ? renderNewAgentDetail() : renderAgentDetail(selectedAgent()),
  );
  root.append(content);
  return root;
};

const renderNewAgentDetail = (): HTMLElement => {
  const detail = create("article", "panel-detail");
  const inner = create("div", "detail-inner");
  const title = create("div", "detail-title");
  title.append(
    identitySvg("scout", "medium"),
    (() => {
      const copy = create("div", "detail-title-copy");
      copy.append(
        create("h2", undefined, "New agent"),
        create("p", undefined, "Create a named specialist in this Profile."),
      );
      return copy;
    })(),
  );
  inner.append(title);
  const form = create("form", "form-grid");
  form.id = "new-agent-form";
  const row = create("div", "form-row");
  const idField = create("label", "field");
  idField.append(create("span", "field-label", "Agent id"));
  const id = create("input");
  id.name = "id";
  id.required = true;
  id.pattern = "[a-z0-9][a-z0-9-]{0,47}";
  id.placeholder = "e.g. archivist";
  id.value = state.draftAgent.id;
  idField.append(id);
  const nameField = create("label", "field");
  nameField.append(create("span", "field-label", "Display name"));
  const name = create("input");
  name.name = "name";
  name.required = true;
  name.placeholder = "Archivist";
  name.value = state.draftAgent.name;
  nameField.append(name);
  row.append(idField, nameField);
  form.append(row);
  const description = create("label", "field");
  description.append(create("span", "field-label", "Description"));
  const descriptionInput = create("textarea");
  descriptionInput.name = "description";
  descriptionInput.required = true;
  descriptionInput.placeholder = "What is this specialist good at?";
  descriptionInput.value = state.draftAgent.description;
  description.append(descriptionInput);
  form.append(description);
  const body = create("label", "field");
  body.append(create("span", "field-label", "Working brief"));
  const bodyInput = create("textarea");
  bodyInput.name = "body";
  bodyInput.required = true;
  bodyInput.placeholder = "Give the agent a concise operating brief.";
  bodyInput.value = state.draftAgent.body;
  body.append(bodyInput);
  form.append(body);
  const actions = create("div", "form-actions");
  const validate = create("button", "button-secondary", "Validate draft");
  validate.type = "button";
  validate.dataset.action = "validate-agent-draft";
  const save = create("button", "button-primary", "Create agent");
  save.type = "submit";
  actions.append(validate, save);
  form.append(
    actions,
    create(
      "p",
      "form-status",
      state.demoState === "validation"
        ? "The draft needs a valid id, description, and brief."
        : "New agents remain pending until the resident accepts the request.",
    ),
  );
  inner.append(form);
  detail.append(inner);
  return detail;
};

const runStatusClass = (status: AutomationRecord["status"]): string =>
  status === "active"
    ? "is-active"
    : status === "paused"
      ? "is-paused"
      : status === "invalid"
        ? "is-invalid"
        : "is-active";

const renderRunList = (runs: ReadonlyArray<RunRecord>): HTMLElement => {
  const list = create("div", "run-list");
  if (runs.length === 0) {
    list.append(
      create(
        "p",
        "detail-copy",
        "No runs yet. Manual runs will appear here after the resident reports an outcome.",
      ),
    );
    return list;
  }
  for (const run of runs) {
    const row = create("div", "run-row");
    const led = create("span", "run-led");
    led.dataset.state = run.state;
    const copy = create("span", "run-copy");
    copy.append(create("strong", undefined, run.summary), create("span", undefined, run.id));
    row.append(led, copy, create("time", "run-time", run.time));
    list.append(row);
  }
  return list;
};

const renderAutomationDetail = (automation: AutomationRecord | undefined): HTMLElement => {
  const detail = create("article", "panel-detail");
  const inner = create("div", "detail-inner");
  if (automation === undefined) {
    detail.append(
      create("div", "empty-conversation", "Choose a routine to inspect its source and runs."),
    );
    return detail;
  }
  const title = create("div", "detail-title");
  title.append(
    identitySvg("squarey", "medium"),
    (() => {
      const copy = create("div", "detail-title-copy");
      copy.append(
        create("h2", undefined, automation.name || "New routine"),
        create("p", undefined, `${automation.id || "draft"} · ${automation.status}`),
      );
      return copy;
    })(),
  );
  inner.append(title);
  const form = create("form", "form-grid");
  form.id = "automation-editor";
  form.dataset.automationId = automation.id;
  const row = create("div", "form-row");
  const name = create("label", "field");
  name.append(create("span", "field-label", "Name"));
  const nameInput = create("input");
  nameInput.name = "name";
  nameInput.required = true;
  nameInput.value = automation.name;
  nameInput.placeholder = "Morning brief";
  name.append(nameInput);
  const schedule = create("label", "field");
  schedule.append(create("span", "field-label", "Cron schedule"));
  const scheduleInput = create("input");
  scheduleInput.name = "schedule";
  scheduleInput.required = true;
  scheduleInput.value = automation.schedule;
  scheduleInput.placeholder = "0 8 * * 1-5";
  schedule.append(scheduleInput);
  row.append(name, schedule);
  form.append(row);
  const timezone = create("label", "field");
  timezone.append(create("span", "field-label", "Timezone"));
  const timezoneInput = create("input");
  timezoneInput.name = "timezone";
  timezoneInput.required = true;
  timezoneInput.value = automation.timezone;
  timezone.append(timezoneInput);
  form.append(timezone);
  const promptField = create("label", "field");
  promptField.append(create("span", "field-label", "Prompt"));
  const prompt = create("textarea");
  prompt.name = "prompt";
  prompt.required = true;
  prompt.value = automation.prompt;
  prompt.placeholder = "What should the routine ask Squarey to do?";
  promptField.append(prompt);
  form.append(promptField);
  const formActions = create("div", "form-actions");
  const validate = create("button", "button-secondary", "Validate");
  validate.type = "button";
  validate.dataset.action = "validate-automation";
  const save = create("button", "button-primary", "Save changes");
  save.type = "submit";
  formActions.append(validate, save);
  form.append(formActions);
  const formStatus = create(
    "p",
    "form-status",
    state.demoState === "validation" || automation.status === "invalid"
      ? "Needs validation before it can run."
      : "Source is ready to save through the resident.",
  );
  formStatus.dataset.automationStatus = "true";
  formStatus.dataset.tone = automation.status === "invalid" ? "danger" : "neutral";
  form.append(formStatus);
  inner.append(form);
  const sourceSection = create("section", "detail-section");
  sourceSection.append(create("h3", undefined, "Resident source"));
  sourceSection.append(
    create(
      "pre",
      "source-block",
      automation.source || "Source will be available after the resident creates this routine.",
    ),
  );
  inner.append(sourceSection);
  const scheduleSection = create("section", "detail-section");
  scheduleSection.append(create("h3", undefined, "Schedule activity"));
  const grid = create("div", "activity-grid");
  for (let index = 0; index < 42; index += 1) {
    const cell = create("span", "activity-cell");
    const level = (index * 7 + automation.id.length * 3) % 5;
    if (level > 0) cell.dataset.level = String(level);
    cell.title = level === 0 ? "No run" : `${level} run${level === 1 ? "" : "s"}`;
    grid.append(cell);
  }
  scheduleSection.append(
    grid,
    create("p", "field-help", `${automation.lastRun} · next ${automation.nextRun}`),
  );
  inner.append(scheduleSection);
  const runs = create("section", "detail-section");
  runs.append(create("h3", undefined, "Recent runs"), renderRunList(automation.runs));
  const runActions = create("div", "form-actions");
  const pause = create(
    "button",
    automation.status === "paused" ? "button-primary" : "button-secondary",
    automation.status === "paused" ? "Resume" : "Pause",
  );
  pause.type = "button";
  pause.dataset.action = automation.status === "paused" ? "resume-automation" : "pause-automation";
  const run = create("button", "button-secondary", "Run now");
  run.type = "button";
  run.dataset.action = "run-automation";
  run.disabled = automation.status === "invalid";
  runActions.append(pause, run);
  runs.append(runActions);
  inner.append(runs);
  detail.append(inner);
  return detail;
};

export const loadAutomationSource = async (automation: AutomationRecord): Promise<void> => {
  if (state.mode === "demo") return;
  const profileId = state.profile.id;
  const generation = state.profileGeneration;
  setOperation(`Reading ${automation.name}…`, "warning");
  try {
    const value = await gatewayRequest("automation.show", { id: automation.id });
    if (!isCurrentProfileEffect(profileId, generation) || !state.automations.includes(automation))
      return;
    if (!isRecord(value)) throw new Error("Resident returned no automation document");
    automation.source = stringValue(value.source, automation.source);
    showToast(`${automation.name} source loaded`, "success");
  } catch (cause) {
    if (isCurrentProfileEffect(profileId, generation))
      showToast(`Automation source unavailable: ${errorMessage(cause)}`, "warning");
  } finally {
    if (isCurrentProfileEffect(profileId, generation)) clearOperation();
  }
};

const renderAutomationsView = (): HTMLElement => {
  const root = panelShell(
    "Profile routines",
    "Automations",
    "Schedules remain owned by the resident. Edit definitions, inspect activity, and keep conflicts visible.",
    "Create routine",
    "new-automation",
  );
  const content = create("div", "panel-content");
  const list = create("div", "panel-list");
  list.append(listHeading("Routines", state.automations.length));
  for (const automation of state.automations) {
    const status =
      automation.status === "active"
        ? "Active"
        : automation.status === "paused"
          ? "Paused"
          : automation.status === "invalid"
            ? "Invalid"
            : "Running";
    const row = listItem(
      automation.id,
      automation.name,
      `${automation.schedule} · ${automation.timezone}`,
      status,
      automation.id === state.selectedAutomationId,
      "select-automation",
    );
    row.querySelector<HTMLElement>(".list-state")?.classList.add(runStatusClass(automation.status));
    list.append(row);
  }
  content.append(
    list,
    state.selectedAutomationId === "draft"
      ? renderNewAutomationDetail()
      : renderAutomationDetail(selectedAutomation()),
  );
  root.append(content);
  return root;
};

const renderNewAutomationDetail = (): HTMLElement => {
  const draft = state.draftAutomation;
  const temp = { ...draft, name: draft.name || "New routine", id: "draft" };
  const detail = renderAutomationDetail(temp);
  detail.querySelector("#automation-editor")?.setAttribute("data-new", "true");
  return detail;
};

const renderMemoryDetail = (memory: MemoryRecord | undefined): HTMLElement => {
  const detail = create("article", "panel-detail");
  const inner = create("div", "detail-inner");
  if (memory === undefined) {
    detail.append(create("div", "empty-conversation", "Choose a memory scope to inspect it."));
    return detail;
  }
  const title = create("div", "detail-title");
  title.append(
    identitySvg("squarey", "medium"),
    (() => {
      const copy = create("div", "detail-title-copy");
      copy.append(
        create("h2", undefined, memory.title),
        create("p", undefined, `${memory.scope} scope · updated ${memory.updated}`),
      );
      return copy;
    })(),
  );
  inner.append(title);
  const overview = create("section", "detail-section");
  overview.append(
    create("h3", undefined, "Memory boundary"),
    create("p", "detail-copy", memory.summary),
  );
  const grid = create("div", "detail-grid");
  grid.append(
    dataCell("Entries", String(memory.entries)),
    dataCell("Cap", memory.cap),
    dataCell("Scope", memory.scope),
    dataCell("Updated", memory.updated),
  );
  overview.append(grid);
  inner.append(overview);
  const content = create("section", "detail-section");
  content.append(create("h3", undefined, "Bounded content"));
  if (memory.contentState === "loading") {
    content.append(renderSkeleton());
  } else {
    const pre = create("p", "detail-copy", memory.content);
    pre.style.whiteSpace = "pre-wrap";
    content.append(pre);
  }
  inner.append(content);
  const note = create("div", "status-line");
  note.dataset.tone =
    memory.contentState === "error"
      ? "danger"
      : memory.contentState === "loading"
        ? "warning"
        : "success";
  note.append(
    create("span", "status-led"),
    create(
      "strong",
      undefined,
      memory.contentState === "loading"
        ? "Requesting through the gateway…"
        : memory.contentState === "error"
          ? "Content request failed"
          : "Read through the gateway",
    ),
  );
  inner.append(note);
  detail.append(inner);
  return detail;
};

const renderMemoryList = (): HTMLElement => {
  const list = create("div", "panel-list");
  list.append(listHeading("Memory scopes", state.memory.length));
  for (const memory of state.memory) {
    const row = listItem(
      memory.id,
      memory.title,
      `${memory.entries} entries · ${memory.scope}`,
      "Read-only",
      memory.id === state.selectedMemoryId,
      "select-memory",
    );
    row.querySelector<HTMLElement>(".list-state")?.classList.add("is-valid");
    list.append(row);
  }
  return list;
};

export const loadMemoryContent = async (memory: MemoryRecord): Promise<void> => {
  if (state.mode === "demo") return;
  const profileId = state.profile.id;
  const generation = state.profileGeneration;
  memory.contentState = "loading";
  setOperation("Reading bounded memory…", "warning");
  try {
    const value = await gatewayRequest("memory.show", { path: memory.id });
    if (!isCurrentProfileEffect(profileId, generation) || !state.memory.includes(memory)) return;
    if (!isRecord(value)) throw new Error("Resident returned no memory document");
    memory.content = stringValue(value.content);
    memory.contentState = "loaded";
    showToast("Memory scope loaded", "success");
  } catch (cause) {
    if (isCurrentProfileEffect(profileId, generation)) {
      memory.contentState = "error";
      showToast(`Memory scope unavailable: ${errorMessage(cause)}`, "danger");
    }
  } finally {
    if (isCurrentProfileEffect(profileId, generation)) clearOperation();
  }
};

const renderExtensions = (): HTMLElement => {
  const detail = create("article", "panel-detail");
  const inner = create("div", "detail-inner");
  const title = create("div", "detail-title");
  title.append(
    identitySvg("sage", "medium"),
    (() => {
      const copy = create("div", "detail-title-copy");
      copy.append(
        create("h2", undefined, "Extensions"),
        create("p", undefined, "Admitted resources for this Profile"),
      );
      return copy;
    })(),
  );
  inner.append(title);
  const intro = create("section", "detail-section");
  intro.append(
    create("h3", undefined, "Selection"),
    create(
      "p",
      "detail-copy",
      "Add, remove, and validate through the resident. The browser renders the projection and never opens local Profile files.",
    ),
  );
  const extensionList = create("div");
  for (const extension of state.extensions) {
    const row = create("div", "extension-row");
    const copy = create("div", "extension-copy");
    copy.append(
      create("strong", undefined, extension.id),
      create("span", undefined, extension.description),
    );
    const meta = create("div", "extension-meta");
    const selected = create("span", "tag", extension.selected ? "Selected" : "Available");
    if (extension.selected) selected.classList.add("is-selected");
    meta.append(
      selected,
      create("span", "tag", extension.kind),
      create("span", "tag", extension.source),
    );
    const controls = create("div", "form-actions");
    const button = create(
      "button",
      extension.selected ? "button-secondary" : "button-primary",
      extension.selected ? "Remove" : "Add",
    );
    button.type = "button";
    button.dataset.action = extension.selected ? "remove-extension" : "add-extension";
    button.dataset.id = extension.id;
    controls.append(button);
    copy.append(meta);
    row.append(copy, controls);
    extensionList.append(row);
  }
  intro.append(extensionList);
  const actions = create("div", "form-actions");
  const validate = create("button", "button-secondary", "Validate selection");
  validate.type = "button";
  validate.dataset.action = "validate-extensions";
  actions.append(validate);
  intro.append(actions);
  inner.append(intro);
  const status = create("section", "detail-section");
  status.append(create("h3", undefined, "Preflight"));
  const statusLine = create("div", "status-line");
  statusLine.dataset.tone = state.demoState === "validation" ? "warning" : "success";
  statusLine.append(
    create("span", "status-led"),
    create(
      "strong",
      undefined,
      state.demoState === "validation"
        ? "Validation pending"
        : `${state.extensions.filter((extension) => extension.selected).length} selected extensions ready`,
    ),
  );
  status.append(statusLine);
  inner.append(status);
  detail.append(inner);
  return detail;
};

const renderMemoryView = (): HTMLElement => {
  const root = panelShell(
    "Profile context",
    "Memory & extensions",
    "Inspect bounded memory scopes and the resources admitted to this Profile. Writes remain agent- and Profile-owned.",
    "Validate selection",
    "validate-extensions",
  );
  const tabs = create("div", "tab-row");
  for (const tab of ["memory", "extensions"] as const) {
    const button = create("button", "tab-button", tab === "memory" ? "Memory" : "Extensions");
    button.type = "button";
    button.dataset.action = "memory-tab";
    button.dataset.tab = tab;
    button.classList.toggle("is-active", state.memoryTab === tab);
    button.setAttribute("aria-pressed", String(state.memoryTab === tab));
    tabs.append(button);
  }
  root.append(tabs);
  const content = create("div", "panel-content");
  content.append(
    state.memoryTab === "memory"
      ? renderMemoryList()
      : (() => {
          const list = create("div", "panel-list");
          list.append(listHeading("Admitted extensions", state.extensions.length));
          for (const extension of state.extensions) {
            const row = listItem(
              extension.id,
              extension.kind,
              extension.description,
              extension.selected ? "Selected" : "Available",
              false,
              "noop",
              "sage",
            );
            row.disabled = true;
            list.append(row);
          }
          return list;
        })(),
  );
  content.append(
    state.memoryTab === "memory" ? renderMemoryDetail(selectedMemory()) : renderExtensions(),
  );
  root.append(content);
  return root;
};

const renderView = (): void => {
  const view =
    state.view === "chat"
      ? renderChatView()
      : state.view === "agents"
        ? renderAgentsView()
        : state.view === "automations"
          ? renderAutomationsView()
          : renderMemoryView();
  viewRoot.replaceChildren(view);
  const context =
    state.view === "chat"
      ? "Conversations"
      : state.view === "agents"
        ? "Agents"
        : state.view === "automations"
          ? "Automations"
          : "Memory & extensions";
  required<HTMLElement>("#topbar-context").textContent = context;
  renderConversationDetails();
};

export const syncRailVisibility = (): void => {
  const compact = window.matchMedia("(max-width: 700px)").matches;
  const hidden = compact && !state.railOpen;
  sidebar.setAttribute("aria-hidden", String(hidden));
  sidebar.inert = hidden;
};

export const renderApp = (): void => {
  app.dataset.view = state.view;
  app.dataset.mode = state.mode;
  renderSidebar();
  renderConnectionStatus();
  renderView();
  renderDetailsVisibility();
  sidebar.classList.toggle("is-open", state.railOpen);
  syncRailVisibility();
  backdrop.hidden = !state.railOpen;
};
