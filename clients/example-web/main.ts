import {
  connectZiggy,
  isMethodParams,
  ZIGGY_METHODS,
  type ZiggyGatewayClient,
  type ZiggyClientEvent,
  type ZiggyMethod,
  type ZiggyRequestMap,
  type ZiggyResultMap,
  type ZiggySessionKey,
  type ZiggySessionRef,
} from "../gateway-client/src/index";
import { create, maybe, required } from "./dom";
import {
  abortConversation,
  closeConversation,
  configureActions,
  createAgent,
  createAutomationDraft,
  loadExtensions,
  loadHistory,
  openAgentConversation,
  openConnection,
  pauseOrResumeAutomation,
  reopenConversation,
  runAgent,
  runAutomation,
  saveAutomation,
  setExtensionSelected,
  submitComposer,
  togglePin,
  updateModel,
  validateAgentDraft,
  validateAutomation,
  validateExtensions,
  watchConversation,
} from "./actions";
import {
  configureRendering,
  loadAgentDetails,
  loadAutomationSource,
  loadMemoryContent,
  renderApp,
  renderConversationDetails,
  renderDetailsVisibility,
  syncRailVisibility,
} from "./rendering";

import {
  createInitialState,
  type AgentRecord,
  type AppState,
  type AutomationRecord,
  type Conversation,
  type DemoState,
  type ExtensionRecord,
  type MemoryRecord,
  type Message,
  type MessageRole,
  type ProfileRecord,
  type ProfileOption,
  type RunRecord,
  type Tone,
  type ViewName,
} from "./model";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const arrayValue = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Request failed";

const nowLabel = (): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());

const timestampLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? fallback
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

const state: AppState = createInitialState();
const app = required<HTMLDivElement>("#app");
const viewRoot = required<HTMLElement>("#view-root");
const sidebar = required<HTMLElement>("#sidebar");
const backdrop = required<HTMLElement>("#mobile-backdrop");
const detailsPanel = required<HTMLElement>("#details-panel");
const detailsBody = required<HTMLElement>("#details-body");
const toastRegion = required<HTMLElement>("#toast-region");
const liveRegion = required<HTMLElement>("#live-region");
const demoStateInput = required<HTMLSelectElement>("#demo-state");
const connectionLabel = required<HTMLElement>("#connection-label");
const profileName = required<HTMLElement>("#profile-name");
const profileAvatar = required<HTMLElement>("#profile-avatar");
const profilePresence = required<HTMLElement>("#profile-presence");
const residentCaption = required<HTMLElement>("#resident-caption");
const connectionDialog = required<HTMLDialogElement>("#connection-dialog");
const connectionForm = required<HTMLFormElement>("#connection-form");
const gatewayUrlInput = required<HTMLInputElement>("#gateway-url");
const gatewayTokenInput = required<HTMLInputElement>("#gateway-token");
const connectionError = required<HTMLElement>("#connection-error");
const openDetailsButton = required<HTMLButtonElement>("#open-details");
const closeDetailsButton = required<HTMLButtonElement>("#close-details");
const openRailButton = required<HTMLButtonElement>("#open-rail");
const closeRailButton = required<HTMLButtonElement>("#close-rail");
const searchInput = required<HTMLInputElement>("#conversation-search");

let client: ZiggyGatewayClient | undefined;
let clientUnsubscribe: (() => void) | undefined;
let nextConversationNumber = 1;
let nextCommandNumber = 1;
let profileLoadGeneration = 0;
const commandNamespace = crypto.randomUUID().slice(0, 12);

const gatewayCall = <Method extends ZiggyMethod>(
  gateway: ZiggyGatewayClient,
  method: Method,
  params: ZiggyRequestMap[Method],
): Promise<ZiggyResultMap[Method]> => gateway.request(method, params);

const isZiggyMethod = (value: string): value is ZiggyMethod =>
  ZIGGY_METHODS.some((method) => method === value);

const checkedGatewayCall = (
  gateway: ZiggyGatewayClient,
  method: string,
  params: unknown,
): Promise<unknown> => {
  if (!isZiggyMethod(method) || !isMethodParams(method, params))
    return Promise.reject(new Error(`Invalid Ziggy gateway parameters for ${method}`));
  return gatewayCall(gateway, method, params);
};

const selectedConversation = (): Conversation | undefined =>
  state.conversations.find((conversation) => conversation.id === state.selectedConversationId);

const selectedAgent = (): AgentRecord | undefined =>
  state.agents.find((agent) => agent.id === state.selectedAgentId);

const selectedAutomation = (): AutomationRecord | undefined =>
  state.automations.find((automation) => automation.id === state.selectedAutomationId);

const selectedMemory = (): MemoryRecord | undefined =>
  state.memory.find((memory) => memory.id === state.selectedMemoryId);

const announce = (message: string): void => {
  liveRegion.textContent = "";
  window.setTimeout(() => (liveRegion.textContent = message), 20);
};

const showToast = (message: string, tone: Tone = "neutral"): void => {
  const toast = create("div", "toast");
  toast.dataset.tone = tone;
  const symbol = create(
    "span",
    "toast-symbol",
    tone === "danger" ? "!" : tone === "success" ? "✓" : "•",
  );
  const copy = create("span", undefined, message);
  toast.append(symbol, copy);
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4_500);
};

const setOperation = (label: string, tone: Tone = "neutral"): void => {
  state.operation = { label, tone };
  renderApp();
};

const clearOperation = (): void => {
  delete state.operation;
  renderApp();
};

const persistPins = (): void => {
  try {
    localStorage.setItem(
      "ziggy-example-pins",
      JSON.stringify(
        state.conversations
          .filter((conversation) => conversation.pinned)
          .map((conversation) => conversation.id),
      ),
    );
  } catch {
    // Storage is an enhancement. The roster remains usable when it is unavailable.
  }
};

const parseResponseArray = (
  value: unknown,
  keys: ReadonlyArray<string>,
): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
};

const gatewayRequest = async (method: string, params: unknown): Promise<unknown> => {
  const resident = client;
  if (resident === undefined) throw new Error("Connect a Ziggy resident before sending a request.");
  const gateway = {
    request: (candidateMethod: string, candidateParams: unknown): Promise<unknown> =>
      checkedGatewayCall(resident, candidateMethod, candidateParams),
  };
  const value = isRecord(params) ? params : {};
  const profileId = state.profile.id.startsWith("prf_") ? state.profile.id : "prf_squarey";
  const sessionRef = (raw: unknown): Record<string, unknown> => {
    if (
      isRecord(raw) &&
      typeof raw.profileId === "string" &&
      ((raw.kind === "live" && typeof raw.key === "string") ||
        (raw.kind === "stored" && typeof raw.id === "string"))
    )
      return raw;
    return { profileId, kind: "live", key: stringValue(raw) };
  };
  switch (method) {
    case "system.capabilities":
    case "profile.current":
    case "profile.list":
      return gateway.request(method, {});
    case "session.list":
      return gateway.request(method, { profileId });
    case "session.show":
      return gateway.request(method, { ref: sessionRef(value.session ?? value.ref) });
    case "session.open":
      return gateway.request(method, {
        profileId,
        context: isRecord(value.context) ? value.context : { kind: "local" },
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "session.history":
      return gateway.request(method, {
        ref: sessionRef(value.session ?? value.ref),
        ...(value.cursor === undefined ? {} : { before: String(value.cursor) }),
      });
    case "session.watch":
      return gateway.request(method, {
        ref: sessionRef(value.session ?? value.ref),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
        ...(typeof value.afterSeq === "number" ? { afterSeq: value.afterSeq } : {}),
        ...(typeof value.epoch === "string" ? { epoch: value.epoch } : {}),
      });
    case "session.unwatch":
    case "session.close":
    case "session.abort":
      return gateway.request(method, {
        ref: sessionRef(value.session ?? value.ref),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "prompt.submit":
    case "session.steer":
    case "session.follow-up":
      return gateway.request(method, {
        ref: sessionRef(value.session ?? value.ref),
        text: stringValue(value.text),
        ...(isRecord(value.recipient) ? { recipient: value.recipient } : {}),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "agent.list":
    case "model.status":
    case "model.available":
    case "auth.status":
    case "automation.list":
    case "automation.status":
    case "memory.list":
    case "extension.list-for-profile":
    case "extension.validate":
    case "pin.list":
      return gateway.request(method, { profileId });
    case "agent.show":
      return gateway.request(method, {
        profileId,
        agentId: stringValue(value.agentId ?? value.id),
      });
    case "agent.create":
      return gateway.request(method, {
        profileId,
        agentId: stringValue(value.agentId ?? value.id),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "agent.validate":
      return gateway.request(method, {
        profileId,
        ...(typeof value.agentId === "string" || typeof value.id === "string"
          ? { agentId: stringValue(value.agentId ?? value.id) }
          : {}),
      });
    case "agent.run":
      return gateway.request(method, {
        profileId,
        agentId: stringValue(value.agentId ?? value.id),
        task: stringValue(value.task ?? value.prompt),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "model.list":
      return gateway.request(method, {
        profileId,
        ...(typeof value.providerId === "string" || typeof value.provider === "string"
          ? { providerId: stringValue(value.providerId ?? value.provider) }
          : {}),
      });
    case "model.set":
      return gateway.request(method, {
        profileId,
        providerId: stringValue(value.providerId ?? value.provider),
        modelId: stringValue(value.modelId ?? value.model),
        ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "automation.show":
    case "automation.validate":
      return gateway.request(method, {
        profileId,
        automationId: stringValue(value.automationId ?? value.id),
      });
    case "automation.create":
      return gateway.request(method, {
        profileId,
        automationId: stringValue(value.automationId ?? value.id),
        commandId: stringValue(value.commandId, commandId("automation-create")),
      });
    case "automation.save":
      return gateway.request(method, {
        profileId,
        automationId: stringValue(value.automationId ?? value.id),
        source: stringValue(value.source),
        expectedSource: stringValue(value.expectedSource),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "automation.pause":
    case "automation.resume":
      return gateway.request(method, {
        profileId,
        automationId: stringValue(value.automationId ?? value.id),
        ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
      });
    case "automation.run":
      return gateway.request(method, {
        profileId,
        automationId: stringValue(value.automationId ?? value.id),
        commandId: stringValue(value.commandId, commandId("automation-run")),
      });
    case "automation.runs":
      return gateway.request(method, {
        profileId,
        ...(typeof value.automationId === "string" || typeof value.id === "string"
          ? { automationId: stringValue(value.automationId ?? value.id) }
          : {}),
      });
    case "memory.show":
      return gateway.request(method, { profileId, path: stringValue(value.path, "MEMORY.md") });
    case "extension.add":
    case "extension.remove":
      return gateway.request(method, { profileId, id: stringValue(value.id) });
    case "pin.set": {
      const session = value.session ?? value.ref;
      const rawPinId = stringValue(value.pinId);
      const pinId =
        rawPinId.length > 0
          ? rawPinId
          : `pin-${stringValue(session).replace(/[^A-Za-z0-9_-]/gu, "-")}`;
      const pin: Record<string, unknown> = {
        id: pinId,
        ref: sessionRef(session),
        order:
          typeof value.order === "number" && Number.isSafeInteger(value.order) ? value.order : 0,
      };
      if (typeof value.label === "string") pin.label = value.label;
      const expectedRevision =
        typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision)
          ? value.expectedRevision
          : state.pinRevision;
      const command = stringValue(value.commandId, commandId("pin"));
      return gateway.request(method, { profileId, pin, expectedRevision, commandId: command });
    }
    case "pin.remove": {
      const pinId = stringValue(value.pinId);
      if (pinId.length === 0)
        throw new Error("Pinned session identity is stale; refresh the roster before unpinning.");
      const expectedRevision =
        typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision)
          ? value.expectedRevision
          : state.pinRevision;
      const command = stringValue(value.commandId, commandId("pin"));
      return gateway.request(method, { profileId, pinId, expectedRevision, commandId: command });
    }
    default:
      return gateway.request(method, params);
  }
};

const commandId = (prefix: string): string =>
  `${prefix}-${commandNamespace}-${nextCommandNumber++}`;

const profileFromResult = (value: unknown): ProfileRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const source = isRecord(value.profile) ? value.profile : value;
  const authValue = stringValue(source.auth ?? source.authStatus, "unknown");
  const auth: ProfileRecord["auth"] =
    authValue === "connected" || authValue === "authenticated"
      ? "connected"
      : authValue === "missing"
        ? "missing"
        : "unknown";
  return {
    id: stringValue(source.id ?? source.profileId, state.profile.id),
    name: stringValue(source.name ?? source.label, state.profile.name),
    tagline: stringValue(source.tagline ?? source.description, state.profile.tagline),
    model: stringValue(source.model ?? source.modelId, state.profile.model),
    provider: stringValue(source.provider ?? source.providerId, state.profile.provider),
    auth,
  };
};

const applyProfileResult = (value: unknown): void => {
  const profile = profileFromResult(value);
  if (profile !== undefined) {
    state.profile = profile;
    state.profiles = state.profiles.map((candidate) => ({
      ...candidate,
      current: candidate.id === profile.id,
    }));
  }
};

const applyProfileList = (value: unknown): void => {
  const profiles = parseResponseArray(value, ["profiles"]);
  const next = profiles.flatMap((item): ProfileOption[] => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.profileId ?? item.id);
    const name = stringValue(item.name);
    if (id.length === 0 || name.length === 0) return [];
    return [{ id, name, current: item.current === true, available: item.available !== false }];
  });
  if (next.length > 0) state.profiles = next;
};

const sessionFromValue = (value: unknown): Conversation | undefined => {
  if (!isRecord(value)) return undefined;
  const source = isRecord(value.live) ? value.live : value;
  const ref = isRecord(source.ref) ? source.ref : isRecord(value.ref) ? value.ref : undefined;
  const rawKey = stringValue(source.key ?? source.session ?? source.id ?? ref?.key);
  if (!/^(?:local|ui|telegram|discord|slack)\//u.test(rawKey)) return undefined;
  const existing = state.conversations.find((conversation) => conversation.key === rawKey);
  if (existing !== undefined) return existing;
  const channel = stringValue(source.channel, rawKey.split("/")[0]);
  const context = isRecord(source.context) ? source.context : undefined;
  const external =
    channel === "telegram" ||
    channel === "discord" ||
    channel === "slack" ||
    rawKey.startsWith("telegram/") ||
    rawKey.startsWith("discord/") ||
    rawKey.startsWith("slack/");
  const specialist = rawKey.startsWith("local/agents/");
  const group = context?.kind === "group";
  const kind: Conversation["kind"] = external
    ? "channel"
    : group
      ? "group"
      : specialist
        ? "specialist"
        : "bot";
  const id = rawKey.replace(/[^A-Za-z0-9_-]/gu, "-");
  const agentId = stringValue(source.agentId, rawKey.split("/").at(-1) ?? "");
  const fallbackTitle = specialist
    ? agentId || "Specialist"
    : external
      ? (rawKey.split("/").at(-1) ?? "Channel")
      : state.profile.name;
  const memberAgentIds = arrayValue(context?.memberAgentIds).filter(
    (member): member is string => typeof member === "string",
  );
  const subtitle =
    kind === "channel"
      ? `${channel || "Channel"} · watch only`
      : kind === "group"
        ? `Group room · ${memberAgentIds.length + 1} members`
        : kind === "specialist"
          ? `Specialist · ${agentId || "local Profile"}`
          : `${state.profile.name} · live session`;
  const session: Conversation = {
    id,
    key: rawKey as ZiggySessionKey,
    ...(ref === undefined ? {} : { ref: ref as ZiggySessionRef }),
    title: stringValue(source.title ?? source.name, group ? "Group room" : fallbackTitle),
    subtitle,
    kind,
    avatar:
      kind === "channel"
        ? "channel"
        : kind === "specialist"
          ? agentId === "sage"
            ? "sage"
            : agentId === "scout"
              ? "scout"
              : "sage"
          : kind === "group"
            ? "observatory"
            : "squarey",
    updatedAt: "now",
    model: state.profile.model,
    participants:
      kind === "group"
        ? [state.profile.name, ...memberAgentIds]
        : specialist && agentId.length > 0
          ? [state.profile.name, agentId]
          : [state.profile.name],
    messages: [],
    pinned: false,
    unread: false,
    turnState: kind === "channel" ? "watch-only" : "idle",
    closed: false,
    historyPage: 1,
    historyHasMore: true,
    draft: "",
  };
  if (kind === "channel") session.channel = channel || "Channel";
  if (kind === "group") {
    session.groupId = stringValue(context?.groupId);
    const defaultRecipient = isRecord(context?.defaultRecipient)
      ? context.defaultRecipient
      : undefined;
    session.recipient =
      defaultRecipient?.kind === "all"
        ? "everyone"
        : defaultRecipient?.kind === "agent"
          ? stringValue(defaultRecipient.agentId, "host")
          : "host";
  }
  return session;
};

const sessionKeyValue = (value: unknown): string =>
  isRecord(value) ? stringValue(value.key ?? value.id) : stringValue(value);

const applySessionList = (value: unknown): void => {
  if (!isRecord(value)) return;
  const live = parseResponseArray(value.live ?? value.sessions ?? value.items, [
    "live",
    "sessions",
    "items",
  ]);
  const next: Conversation[] = [];
  for (const item of live) {
    const session = sessionFromValue(item);
    if (session === undefined) continue;
    if (!next.some((conversation) => conversation.id === session.id)) next.push(session);
  }
  const stored = parseResponseArray(value.stored, ["stored"]);
  for (const item of stored) {
    if (!isRecord(item) || !isRecord(item.ref) || item.ref.kind !== "stored") continue;
    const storedId = stringValue(item.ref.id);
    if (storedId.length === 0) continue;
    const id = `stored-${storedId.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
    const conversation: Conversation = {
      id,
      key: `ui/stored-${id}` as ZiggySessionKey,
      ref: {
        profileId: stringValue(item.ref.profileId, state.profile.id) as `prf_${string}`,
        kind: "stored",
        id: storedId,
      },
      title: `Past conversation ${next.length + 1}`,
      subtitle: `${typeof item.entryCount === "number" ? item.entryCount : 0} messages · ${stringValue(item.terminalState, "complete")}`,
      kind: "bot",
      avatar: "squarey",
      updatedAt: stringValue(item.createdAt, "earlier"),
      model: state.profile.model,
      participants: [state.profile.name],
      messages: [],
      pinned: false,
      unread: false,
      turnState: "closed",
      closed: true,
      historyPage: 1,
      historyHasMore: true,
      draft: "",
    };
    next.push(conversation);
  }
  state.conversations = next;
  state.selectedConversationId = next[0]?.id ?? "";
};

const messagesFromHistory = (value: unknown): Message[] => {
  const entries = parseResponseArray(value, ["messages", "entries", "history"]);
  return entries.flatMap((entry, index): Message[] => {
    if (!isRecord(entry)) return [];
    const roleValue = stringValue(entry.role ?? entry.kind, "assistant");
    const role: MessageRole =
      roleValue === "user"
        ? "user"
        : roleValue === "tool"
          ? "tool"
          : roleValue === "voice"
            ? "voice"
            : "assistant";
    const text = stringValue(entry.text ?? entry.content ?? entry.message);
    if (text.length === 0 && role !== "tool") return [];
    const message: Message = {
      id: stringValue(entry.id, `history-${index}`),
      role,
      author: stringValue(
        entry.author ?? entry.agent,
        role === "user" ? "You" : state.profile.name,
      ),
      text,
      time: stringValue(entry.time ?? entry.timestamp ?? entry.createdAt, "Earlier"),
    };
    if (role === "voice")
      message.specialist = stringValue(entry.specialist ?? entry.agent, "Specialist");
    if (role === "tool") {
      message.toolName = stringValue(entry.toolName ?? entry.tool, "Tool activity");
      message.toolState = "complete";
    }
    return [message];
  });
};

const applyHistoryResult = (conversation: Conversation, value: unknown): void => {
  const messages = messagesFromHistory(value);
  if (messages.length > 0)
    conversation.messages =
      conversation.historyPage > 1 ? [...messages, ...conversation.messages] : messages;
  if (isRecord(value)) {
    conversation.historyHasMore = value.hasMore === true;
    const nextCursor = stringValue(value.nextCursor);
    if (nextCursor.length > 0) conversation.historyCursor = nextCursor;
    else if (!conversation.historyHasMore) delete conversation.historyCursor;
  }
};

const closeDetails = (restoreFocus = false): void => {
  state.detailsOpen = false;
  renderDetailsVisibility();
  if (restoreFocus) openDetailsButton.focus();
};

const openDetails = (): void => {
  state.detailsOpen = true;
  renderConversationDetails();
  renderDetailsVisibility();
  closeDetailsButton.focus();
};

const closeRail = (): void => {
  state.railOpen = false;
  sidebar.classList.remove("is-open");
  backdrop.hidden = true;
  syncRailVisibility();
  openRailButton.focus();
};

const openRail = (): void => {
  state.railOpen = true;
  sidebar.classList.add("is-open");
  backdrop.hidden = false;
  syncRailVisibility();
  maybe<HTMLButtonElement>(".nav-item", sidebar)?.focus();
};

const selectConversation = (id: string): void => {
  const conversation = state.conversations.find((item) => item.id === id);
  if (conversation === undefined) return;
  state.selectedConversationId = id;
  conversation.unread = false;
  state.view = "chat";
  closeRail();
  renderApp();
  if (state.mode === "live") void loadHistory(conversation);
};

const selectView = (view: ViewName): void => {
  state.view = view;
  closeRail();
  closeDetails();
  renderApp();
};

configureRendering({
  state,
  app,
  viewRoot,
  sidebar,
  backdrop,
  detailsPanel,
  detailsBody,
  connectionLabel,
  profileName,
  profileAvatar,
  profilePresence,
  residentCaption,
  openDetailsButton,
  closeDetailsButton,
  selectedConversation,
  selectedAgent,
  selectedAutomation,
  selectedMemory,
  gatewayRequest,
  isRecord,
  stringValue,
  arrayValue,
  errorMessage,
  showToast,
  setOperation,
  clearOperation,
  closeDetails,
});

configureActions({
  state,
  viewRoot,
  connectionDialog,
  gatewayUrlInput,
  connectionError,
  selectedConversation,
  selectedAgent,
  selectedAutomation,
  gatewayRequest,
  applyHistoryResult,
  applyProfileResult,
  sessionFromValue,
  parseResponseArray,
  isRecord,
  stringValue,
  arrayValue,
  errorMessage,
  nowLabel,
  announce,
  showToast,
  setOperation,
  clearOperation,
  persistPins,
  commandId,
  renderApp,
});

const isCurrentProfileLoad = (profileId: string, generation: number): boolean =>
  state.profile.id === profileId &&
  state.profileGeneration === generation &&
  profileLoadGeneration === generation;

const loadLiveProjections = async (profileId: string, generation: number): Promise<void> => {
  if (state.mode !== "live") return;
  try {
    const result = await gatewayRequest("agent.list", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const agents = parseResponseArray(result, ["agents"]);
    const nextAgents = agents.flatMap((item): AgentRecord[] => {
      if (!isRecord(item)) return [];
      const id = stringValue(item.id);
      if (id.length === 0) return [];
      return [
        {
          id,
          name: id,
          description: stringValue(item.description, "Profile specialist"),
          provider: stringValue(item.provider, state.profile.provider),
          model: stringValue(item.model, state.profile.model),
          tools: arrayValue(item.tools).filter((tool): tool is string => typeof tool === "string"),
          status: "ready",
          body: stringValue(item.description, "Profile specialist"),
        },
      ];
    });
    state.agents = nextAgents;
  } catch (cause) {
    showToast(`Agents unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("automation.list", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const automations = parseResponseArray(result, ["automations"]);
    const nextAutomations = automations.flatMap((item): AutomationRecord[] => {
      if (!isRecord(item)) return [];
      const id = stringValue(item.id);
      if (id.length === 0) return [];
      const valid = item.valid !== false;
      const status: AutomationRecord["status"] =
        item.lifecycle === "paused" ? "paused" : valid ? "active" : "invalid";
      return [
        {
          id,
          name: id,
          schedule: stringValue(item.schedule, "Manual only"),
          timezone: stringValue(item.timezone, "Local timezone"),
          prompt: stringValue(
            item.message,
            "Automation definition available through the resident.",
          ),
          status,
          lastRun: "Not loaded",
          nextRun:
            status === "paused"
              ? "Paused"
              : status === "invalid"
                ? "Needs validation"
                : "Next occurrence",
          source: "",
          runs: [],
        },
      ];
    });
    state.automations = nextAutomations;
  } catch (cause) {
    showToast(`Automations unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("automation.status", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const schedules = parseResponseArray(result, ["schedules"]);
    for (const item of schedules) {
      if (!isRecord(item)) continue;
      const automation = state.automations.find(
        (candidate) => candidate.id === stringValue(item.automationId),
      );
      if (automation === undefined) continue;
      const definitionState = stringValue(item.definitionState);
      if (definitionState === "invalid" || definitionState === "deleted")
        automation.status = "invalid";
      const nextScheduledAtMs = item.nextScheduledAtMs;
      if (typeof nextScheduledAtMs === "number")
        automation.nextRun = timestampLabel(nextScheduledAtMs, automation.nextRun);
    }
    if (
      isRecord(result) &&
      typeof result.activeRunCount === "number" &&
      result.activeRunCount > 0
    ) {
      const latest = isRecord(result.latestRun) ? stringValue(result.latestRun.automationId) : "";
      const automation = state.automations.find((candidate) => candidate.id === latest);
      if (automation !== undefined && automation.status === "active") automation.status = "running";
    }
  } catch (cause) {
    showToast(`Automation status unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("automation.runs", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const runs = parseResponseArray(result, ["runs"]);
    const grouped = new Map<string, RunRecord[]>();
    for (const item of runs) {
      if (!isRecord(item)) continue;
      const automationId = stringValue(item.automationId);
      if (automationId.length === 0) continue;
      const stateValue = stringValue(item.state);
      const runState: RunRecord["state"] =
        stateValue === "running" || stateValue === "claimed"
          ? "running"
          : stateValue === "completed"
            ? "succeeded"
            : "failed";
      const run: RunRecord = {
        id: stringValue(item.runId, `run-${grouped.get(automationId)?.length ?? 0}`),
        state: runState,
        summary:
          stateValue === "completed"
            ? "Completed successfully"
            : stateValue === "running" || stateValue === "claimed"
              ? "Run in progress"
              : stringValue(item.failureCategory, "Run did not complete"),
        time: timestampLabel(item.recordedAtMs, "Recently observed"),
      };
      const list = grouped.get(automationId) ?? [];
      list.push(run);
      grouped.set(automationId, list);
    }
    for (const automation of state.automations) {
      const runsForAutomation = grouped.get(automation.id);
      if (runsForAutomation === undefined) continue;
      automation.runs = runsForAutomation;
      automation.lastRun = runsForAutomation[0]?.time ?? automation.lastRun;
    }
  } catch (cause) {
    showToast(`Automation runs unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("memory.list", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const documents = parseResponseArray(result, ["documents"]);
    const nextMemory = documents.flatMap((item): MemoryRecord[] => {
      if (!isRecord(item)) return [];
      const id = stringValue(item.path);
      if (id.length === 0) return [];
      const scope = stringValue(item.scope, "shared");
      return [
        {
          id,
          title:
            scope === "shared"
              ? "Shared memory"
              : scope === "person"
                ? "Your memory"
                : "Group memory",
          scope,
          summary: `${stringValue(item.state, "present")} document from the served Profile.`,
          entries: typeof item.entryCount === "number" ? item.entryCount : 0,
          cap: typeof item.cap === "number" ? `${item.cap} characters` : "Bounded",
          updated: "Recently observed",
          content: "Select this scope to request its bounded content.",
        },
      ];
    });
    state.memory = nextMemory;
  } catch (cause) {
    showToast(`Memory unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("model.status", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    if (isRecord(result)) {
      const provider = stringValue(result.providerId, state.profile.provider);
      const model = stringValue(result.modelId, state.profile.model);
      state.profile.provider = provider;
      state.profile.model = model;
      state.profile.auth = result.authConfigured === true ? "connected" : "missing";
    }
  } catch (cause) {
    showToast(`Model status unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("model.available", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const models = parseResponseArray(result, ["models"]);
    const providers: string[] = [];
    const modelIds: string[] = [];
    for (const item of models) {
      if (!isRecord(item)) continue;
      const providerId = stringValue(item.providerId);
      const modelId = stringValue(item.modelId);
      if (providerId.length > 0 && !providers.includes(providerId)) providers.push(providerId);
      if (modelId.length > 0 && !modelIds.includes(modelId)) modelIds.push(modelId);
    }
    state.availableProviders = providers;
    state.availableModels = modelIds;
  } catch (cause) {
    showToast(`Available models unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("auth.status", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    const providers = parseResponseArray(result, ["providers"]);
    state.authProviders = providers.flatMap((item): string[] => {
      if (!isRecord(item) || item.configured !== true) return [];
      const name = stringValue(item.name ?? item.id);
      return name.length > 0 ? [name] : [];
    });
    if (providers.length > 0)
      state.profile.auth = state.authProviders.length > 0 ? "connected" : "missing";
  } catch (cause) {
    showToast(`Provider auth status unavailable: ${errorMessage(cause)}`, "warning");
  }
  try {
    const result = await gatewayRequest("pin.list", { profileId });
    if (!isCurrentProfileLoad(profileId, generation)) return;
    for (const conversation of state.conversations) {
      conversation.pinned = false;
      delete conversation.pinId;
    }
    if (
      isRecord(result) &&
      typeof result.revision === "number" &&
      Number.isSafeInteger(result.revision)
    )
      state.pinRevision = result.revision;
    const pins = parseResponseArray(result, ["pins"]);
    for (const item of pins) {
      if (!isRecord(item)) continue;
      const ref = isRecord(item.ref) ? item.ref : undefined;
      const conversation = state.conversations.find((candidate) =>
        candidate.ref?.kind === "stored"
          ? stringValue(ref?.id) === candidate.ref.id
          : stringValue(ref?.key) === candidate.key,
      );
      if (conversation !== undefined) {
        conversation.pinned = true;
        const pinId = stringValue(item.id);
        if (pinId.length > 0) conversation.pinId = pinId;
      }
    }
  } catch (cause) {
    showToast(`Pinned conversations unavailable: ${errorMessage(cause)}`, "warning");
  }
};

const loadSelectedProfile = async (profileId: string, generation: number): Promise<void> => {
  const sessions = await gatewayRequest("session.list", {});
  if (!isCurrentProfileLoad(profileId, generation)) return;
  applySessionList(sessions);
  await Promise.all(
    state.conversations
      .filter((conversation) => conversation.ref?.kind !== "stored")
      .map(async (conversation) => {
        await gatewayRequest("session.watch", { session: conversation.ref ?? conversation.key });
        conversation.watched = true;
      }),
  );
  if (!isCurrentProfileLoad(profileId, generation)) return;
  await loadLiveProjections(profileId, generation);
  if (!isCurrentProfileLoad(profileId, generation)) return;
  await loadExtensions(profileId, generation);
};

const switchProfile = async (profileId: string): Promise<void> => {
  if (state.mode !== "live") return;
  const selected = state.profiles.find((profile) => profile.id === profileId && profile.available);
  if (selected === undefined) {
    showToast("That Profile resident is unavailable", "warning");
    renderApp();
    return;
  }
  const generation = ++profileLoadGeneration;
  state.profileGeneration = generation;
  setOperation(`Switching to ${selected.name}…`, "warning");
  renderApp();
  try {
    await Promise.allSettled(
      state.conversations.map((conversation) =>
        gatewayRequest("session.unwatch", { session: conversation.ref ?? conversation.key }),
      ),
    );
    if (profileLoadGeneration !== generation || state.profileGeneration !== generation) return;
    for (const conversation of state.conversations) {
      conversation.historyGeneration = (conversation.historyGeneration ?? 0) + 1;
      conversation.historyLoading = false;
      conversation.reconciling = false;
    }
    state.loadingHistory = false;
    state.profile = {
      ...state.profile,
      id: selected.id,
      name: selected.name,
      tagline: "Profile resident",
      provider: "",
      model: "",
      auth: "unknown",
    };
    state.profiles = state.profiles.map((profile) => ({
      ...profile,
      current: profile.id === selected.id,
    }));
    state.conversations = [];
    state.selectedConversationId = "";
    state.agents = [];
    state.automations = [];
    state.memory = [];
    state.extensions = [];
    state.pinRevision = 0;
    renderApp();
    await loadSelectedProfile(selected.id, generation);
    if (isCurrentProfileLoad(selected.id, generation))
      showToast(`Switched to ${selected.name}`, "success");
  } catch (cause) {
    if (profileLoadGeneration === generation && state.profileGeneration === generation)
      showToast(errorMessage(cause), "danger");
  } finally {
    if (profileLoadGeneration === generation) clearOperation();
  }
};

const loadLiveState = async (): Promise<void> => {
  if (state.mode !== "live") return;
  const generation = ++profileLoadGeneration;
  state.profileGeneration = generation;
  const selectedProfileId = state.profile.id;
  state.connectionState = client?.state ?? "connecting";
  state.demoState = "ready";
  setOperation("Reading resident capabilities…", "warning");
  renderApp();
  try {
    const capabilities = await gatewayRequest("system.capabilities", {});
    if (profileLoadGeneration !== generation) return;
    const capabilityVersion = isRecord(capabilities)
      ? stringValue(capabilities.protocolVersion ?? capabilities.version, "1")
      : "1";
    if (capabilityVersion.length === 0)
      throw new Error("Resident did not return a protocol version");
    const profiles = await gatewayRequest("profile.list", {});
    if (profileLoadGeneration !== generation) return;
    applyProfileList(profiles);
    const selected = state.profiles.find(
      (profile) => profile.id === selectedProfileId && profile.available,
    );
    if (selected === undefined) {
      const profile = await gatewayRequest("profile.current", {});
      if (profileLoadGeneration !== generation) return;
      applyProfileResult(profile);
    } else {
      state.profile = { ...state.profile, id: selected.id, name: selected.name };
      state.profiles = state.profiles.map((profile) => ({
        ...profile,
        current: profile.id === selected.id,
      }));
    }
    const profileId = state.profile.id;
    await loadSelectedProfile(profileId, generation);
    if (!isCurrentProfileLoad(profileId, generation)) return;
    state.connectionState = client?.state ?? "open";
    showToast(`Connected to ${state.profile.name}`, "success");
  } catch (cause) {
    if (profileLoadGeneration !== generation || state.profileGeneration !== generation) return;
    state.connectionState = client?.state === "reconnecting" ? "reconnecting" : "closed";
    showToast(errorMessage(cause), "danger");
  } finally {
    if (profileLoadGeneration === generation) clearOperation();
  }
};

const handleGatewayEvent = (event: ZiggyClientEvent): void => {
  if (event.event === "connection-state") {
    state.connectionState = event.state;
    renderApp();
    announce(event.state === "open" ? "Resident connected" : `Resident ${event.state}`);
    if (event.state === "open") void loadLiveState();
    return;
  }
  if (event.profileId !== state.profile.id) return;
  if (event.event === "history-reconciliation") {
    state.demoState = "reconciliation";
    showToast(`History reconciliation: ${event.reason.replaceAll("-", " ")}`, "warning");
    const conversation = state.conversations.find(
      (item) => item.key === sessionKeyValue(event.session),
    );
    if (conversation !== undefined) {
      conversation.messages = [];
      conversation.historyPage = 0;
      conversation.historyHasMore = true;
      conversation.reconciling = true;
      delete conversation.historyCursor;
      void loadHistory(conversation, { reconcile: true });
    }
    renderApp();
    return;
  }
  const conversation = state.conversations.find(
    (item) => item.key === sessionKeyValue(event.session),
  );
  if (conversation === undefined) return;
  if (event.event === "assistant-text") {
    const current = conversation.messages.find((message) => message.id === "live-stream");
    if (current === undefined)
      conversation.messages.push({
        id: "live-stream",
        role: "assistant",
        author: conversation.title,
        text: event.payload.snapshot,
        time: nowLabel(),
        streaming: true,
      });
    else {
      current.text = event.payload.snapshot;
      current.streaming = true;
    }
    conversation.turnState = "running";
    renderApp();
    return;
  }
  if (event.event === "thinking") {
    conversation.turnState = "running";
    delete conversation.lastError;
    const activity = maybe<HTMLElement>(".activity-strip", viewRoot);
    if (activity !== undefined) activity.textContent = `Thinking · ${event.payload.delta}`;
    return;
  }
  if (event.event === "tool") {
    const id = `tool-${event.payload.toolCallId}`;
    const existing = conversation.messages.find((message) => message.id === id);
    const toolState: Message["toolState"] = event.payload.failed
      ? "failed"
      : event.payload.phase === "end"
        ? "complete"
        : "running";
    if (existing === undefined) {
      const toolMessage: Message = {
        id,
        role: "tool",
        author: conversation.title,
        text: "",
        time: nowLabel(),
        toolName: event.payload.toolName,
        toolState,
      };
      if (event.payload.detail !== undefined) toolMessage.detail = event.payload.detail;
      conversation.messages.push(toolMessage);
    } else {
      conversation.messages = conversation.messages.map((message) => {
        if (message.id !== id) return message;
        const updated = { ...message, toolState };
        if (event.payload.detail !== undefined) updated.detail = event.payload.detail;
        return updated;
      });
    }
    renderApp();
    return;
  }
  if (event.event === "voice") {
    conversation.messages.push({
      id: `voice-${conversation.messages.length}`,
      role: "voice",
      author: event.payload.agentId,
      specialist: event.payload.agentId,
      text: event.payload.text,
      time: nowLabel(),
    });
    renderApp();
    return;
  }
  if (event.event === "settled") {
    conversation.messages = conversation.messages.map((message) =>
      message.id === "live-stream" ? { ...message, streaming: false } : message,
    );
    conversation.turnState = "idle";
    delete conversation.lastError;
    renderApp();
    announce("Turn settled");
    return;
  }
  if (event.event === "error") {
    conversation.turnState = "idle";
    conversation.lastError = event.payload.message;
    renderApp();
    showToast(event.payload.message, "danger");
    announce("Conversation error");
  }
};

const connectLive = async (): Promise<void> => {
  const url = gatewayUrlInput.value.trim();
  const token = gatewayTokenInput.value;
  if (url.length === 0 || token.length === 0) {
    connectionError.textContent = "Enter both an endpoint and a session token.";
    return;
  }
  connectionError.textContent = "";
  clientUnsubscribe?.();
  client?.close();
  state.mode = "live";
  state.connectionState = "connecting";
  state.operation = { label: "Connecting…", tone: "warning" };
  renderApp();
  try {
    client = connectZiggy({ url, token });
    clientUnsubscribe = client.onAny(handleGatewayEvent);
    connectionDialog.close();
    await loadLiveState();
  } catch (cause) {
    state.connectionState = "closed";
    connectionError.textContent = errorMessage(cause);
    showToast(errorMessage(cause), "danger");
    renderApp();
  }
};

const switchToDemo = (demoState: DemoState): void => {
  state.profileGeneration = ++profileLoadGeneration;
  clientUnsubscribe?.();
  clientUnsubscribe = undefined;
  client?.close();
  client = undefined;
  state.mode = "demo";
  state.demoState = demoState;
  state.connectionState = "open";
  delete state.operation;
  if (demoState === "watch-only") {
    const channel = state.conversations.find((conversation) => conversation.kind === "channel");
    if (channel !== undefined) {
      state.selectedConversationId = channel.id;
      channel.turnState = "watch-only";
    }
  }
  renderApp();
};

const copyMessage = async (messageId: string): Promise<void> => {
  const conversation = selectedConversation();
  const message = conversation?.messages.find((item) => item.id === messageId);
  if (message === undefined || message.text.length === 0) return;
  try {
    await navigator.clipboard.writeText(message.text);
    showToast("Message copied", "success");
  } catch {
    showToast("Copy is unavailable in this browser", "warning");
  }
};

const newConversation = (): void => {
  const name = `New thread ${nextConversationNumber++}`;
  if (state.mode === "live") {
    const profileId = state.profile.id;
    const generation = state.profileGeneration;
    setOperation("Opening conversation…", "warning");
    void gatewayRequest("session.open", {
      name: name.toLocaleLowerCase().replace(/\s+/gu, "-"),
      commandId: commandId("open"),
    })
      .then(async (value) => {
        if (!isCurrentProfileLoad(profileId, generation)) return;
        const session = sessionFromValue(value);
        if (session !== undefined) {
          await gatewayRequest("session.watch", { session: session.ref ?? session.key });
          if (!isCurrentProfileLoad(profileId, generation)) return;
          session.watched = true;
        }
        if (session !== undefined && !state.conversations.some((item) => item.id === session.id))
          state.conversations.push(session);
        if (session !== undefined) state.selectedConversationId = session.id;
        showToast("Conversation opened", "success");
      })
      .catch((cause: unknown) => {
        if (isCurrentProfileLoad(profileId, generation)) showToast(errorMessage(cause), "danger");
      })
      .finally(() => {
        if (isCurrentProfileLoad(profileId, generation)) clearOperation();
      });
    return;
  }
  const conversation: Conversation = {
    id: `new-${nextConversationNumber}`,
    key: `ui/new-${nextConversationNumber}` as ZiggySessionKey,
    title: name,
    subtitle: "Squarey · new thread",
    kind: "bot",
    avatar: "squarey",
    updatedAt: "now",
    model: `${state.profile.model} · balanced`,
    participants: [state.profile.name],
    messages: [],
    pinned: false,
    unread: false,
    turnState: "idle",
    closed: false,
    historyPage: 1,
    historyHasMore: false,
    draft: "",
  };
  state.conversations.unshift(conversation);
  state.selectedConversationId = conversation.id;
  showToast("New conversation ready", "success");
  renderApp();
};

const newGroupConversation = (): void => {
  if (state.mode === "demo") {
    const group = state.conversations.find((conversation) => conversation.kind === "group");
    if (group !== undefined) selectConversation(group.id);
    return;
  }
  const memberAgentIds = state.agents.map((agent) => agent.id).slice(0, 4);
  if (memberAgentIds.length === 0) {
    showToast("Create at least one Profile specialist before opening a group room", "warning");
    return;
  }
  const groupId = `room-${Date.now().toString(36)}`;
  const profileId = state.profile.id;
  const generation = state.profileGeneration;
  setOperation("Opening group room…", "warning");
  void gatewayRequest("session.open", {
    context: {
      kind: "group",
      groupId,
      memberAgentIds,
      defaultRecipient: { kind: "host" },
    },
    commandId: commandId("open-group"),
  })
    .then(async (opened) => {
      if (!isCurrentProfileLoad(profileId, generation)) return;
      const ref = isRecord(opened) ? opened.ref : undefined;
      const shown = await gatewayRequest("session.show", { ref });
      if (!isCurrentProfileLoad(profileId, generation)) return;
      const conversation = sessionFromValue(shown);
      if (conversation === undefined) throw new Error("Resident did not return the group room");
      await gatewayRequest("session.watch", { session: conversation.ref ?? conversation.key });
      if (!isCurrentProfileLoad(profileId, generation)) return;
      conversation.watched = true;
      if (!state.conversations.some((item) => item.id === conversation.id))
        state.conversations.unshift(conversation);
      state.selectedConversationId = conversation.id;
      state.view = "chat";
      showToast("Group room opened", "success");
      renderApp();
    })
    .catch((cause: unknown) => {
      if (isCurrentProfileLoad(profileId, generation)) showToast(errorMessage(cause), "danger");
    })
    .finally(() => {
      if (isCurrentProfileLoad(profileId, generation)) clearOperation();
    });
};

const actionElement = (target: EventTarget | null): HTMLElement | undefined =>
  target instanceof Element
    ? (target.closest<HTMLElement>("[data-action]") ?? undefined)
    : undefined;

const handleAction = (action: string, element: HTMLElement): void => {
  const id = element.dataset.id;
  if (action === "new-conversation") newConversation();
  else if (action === "new-group") newGroupConversation();
  else if (action === "open-connection") openConnection();
  else if (action === "toggle-pin") void togglePin();
  else if (action === "watch-conversation") void watchConversation();
  else if (action === "load-history") {
    const conversation = selectedConversation();
    if (conversation !== undefined) void loadHistory(conversation);
  } else if (action === "composer-mode") {
    const mode = element.dataset.mode;
    if (mode === "prompt" || mode === "steer" || mode === "follow-up") {
      state.composerMode = mode;
      renderApp();
      maybe<HTMLTextAreaElement>("#composer-input", viewRoot)?.focus();
    }
  } else if (action === "abort-conversation") void abortConversation();
  else if (action === "close-session") void closeConversation();
  else if (action === "reopen-session") void reopenConversation();
  else if (action === "copy-message" && id !== undefined) void copyMessage(id);
  else if (action === "select-agent" && id !== undefined) {
    state.selectedAgentId = id;
    renderApp();
    const agent = selectedAgent();
    if (agent !== undefined) void loadAgentDetails(agent);
  } else if (action === "new-agent") {
    state.selectedAgentId = "draft";
    renderApp();
  } else if (action === "validate-agent") {
    const form = maybe<HTMLFormElement>("#agent-editor", viewRoot);
    void validateAgentDraft(form);
  } else if (action === "validate-agent-draft") {
    const form = maybe<HTMLFormElement>("#new-agent-form", viewRoot);
    void validateAgentDraft(form);
  } else if (action === "run-agent" && id !== undefined) void runAgent(id);
  else if (action === "open-agent-conversation" && id !== undefined) openAgentConversation(id);
  else if (action === "select-automation" && id !== undefined) {
    state.selectedAutomationId = id;
    renderApp();
    const automation = selectedAutomation();
    if (automation !== undefined) void loadAutomationSource(automation);
  } else if (action === "new-automation") createAutomationDraft();
  else if (action === "validate-automation") {
    const form = maybe<HTMLFormElement>("#automation-editor", viewRoot);
    void validateAutomation(form);
  } else if (action === "pause-automation") void pauseOrResumeAutomation(false);
  else if (action === "resume-automation") void pauseOrResumeAutomation(true);
  else if (action === "run-automation") void runAutomation();
  else if (action === "select-memory" && id !== undefined) {
    state.selectedMemoryId = id;
    renderApp();
    const memory = selectedMemory();
    if (memory !== undefined) void loadMemoryContent(memory);
  } else if (action === "memory-tab") {
    const tab = element.dataset.tab;
    if (tab === "memory" || tab === "extensions") {
      state.memoryTab = tab;
      renderApp();
    }
  } else if (action === "add-extension" && id !== undefined) void setExtensionSelected(id, true);
  else if (action === "remove-extension" && id !== undefined) void setExtensionSelected(id, false);
  else if (action === "validate-extensions") void validateExtensions();
};

app.addEventListener("click", (event) => {
  const action = actionElement(event.target);
  if (action !== undefined) {
    const actionName = action.dataset.action;
    if (actionName !== undefined) handleAction(actionName, action);
    return;
  }
  const viewButton =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>(".nav-item[data-view]")
      : undefined;
  const requestedView = viewButton?.dataset.view;
  if (
    requestedView === "chat" ||
    requestedView === "agents" ||
    requestedView === "automations" ||
    requestedView === "memory"
  ) {
    selectView(requestedView);
    return;
  }
  const conversationButton =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-conversation]")
      : undefined;
  if (conversationButton?.dataset.conversation !== undefined)
    selectConversation(conversationButton.dataset.conversation);
});

app.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === "composer-form") {
    event.preventDefault();
    void submitComposer();
  } else if (form.id === "new-agent-form") {
    event.preventDefault();
    void createAgent(form);
  } else if (form.id === "agent-editor") {
    event.preventDefault();
    void validateAgentDraft(form);
  } else if (form.id === "automation-editor") {
    event.preventDefault();
    void saveAutomation(form);
  }
});

connectionForm.addEventListener("submit", (event) => {
  const submitter = event.submitter;
  if (submitter instanceof HTMLButtonElement && submitter.value === "cancel") return;
  event.preventDefault();
  void connectLive();
});

app.addEventListener("input", (event) => {
  if (!(event.target instanceof HTMLTextAreaElement)) return;
  if (event.target.id === "composer-input") {
    const conversation = selectedConversation();
    if (conversation !== undefined) conversation.draft = event.target.value;
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.id === "profile-select")
    void switchProfile(target.value);
  else if (target instanceof HTMLSelectElement && target.id === "group-recipient") {
    const conversation = selectedConversation();
    if (conversation !== undefined) conversation.recipient = target.value;
  } else if (target instanceof HTMLSelectElement && target.id === "demo-state")
    switchToDemo(target.value as DemoState);
  else if (target instanceof HTMLSelectElement && target.id === "provider-select") {
    const model =
      maybe<HTMLSelectElement>("#model-select", detailsPanel)?.value ?? state.profile.model;
    void updateModel(target.value, model);
  } else if (target instanceof HTMLSelectElement && target.id === "model-select") {
    const provider =
      maybe<HTMLSelectElement>("#provider-select", detailsPanel)?.value ?? state.profile.provider;
    void updateModel(provider, target.value);
  }
});

openDetailsButton.addEventListener("click", openDetails);
closeDetailsButton.addEventListener("click", () => closeDetails(true));
openRailButton.addEventListener("click", openRail);
closeRailButton.addEventListener("click", closeRail);
backdrop.addEventListener("click", closeRail);
window.addEventListener("resize", syncRailVisibility);

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
  if (event.key === "Escape") {
    if (state.detailsOpen) closeDetails(true);
    if (state.railOpen) closeRail();
    return;
  }
  if (typing) {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      target instanceof HTMLTextAreaElement &&
      target.id === "composer-input"
    ) {
      event.preventDefault();
      void submitComposer();
    }
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key.toLocaleLowerCase() === "n") {
    event.preventDefault();
    newConversation();
  }
});

const initialDemoState = new URLSearchParams(window.location.search).get("state");
if (
  initialDemoState !== null &&
  [
    "ready",
    "loading",
    "busy",
    "stopping",
    "watch-only",
    "reconnecting",
    "offline",
    "empty",
    "validation",
    "request",
    "ownership",
    "reconciliation",
  ].includes(initialDemoState)
) {
  state.demoState = initialDemoState as DemoState;
  demoStateInput.value = state.demoState;
}
renderApp();
if (new URLSearchParams(window.location.search).get("mode") === "live") openConnection();
