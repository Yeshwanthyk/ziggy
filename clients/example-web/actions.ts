import type { ZiggySessionKey } from "../gateway-client/src/index";
import { maybe } from "./dom";
import { newAgentDraft, newAutomationDraft } from "./model";
import type {
  AgentRecord,
  AppState,
  AutomationRecord,
  Conversation,
  ExtensionRecord,
  Message,
  Tone,
} from "./model";

export interface ActionDependencies {
  readonly state: AppState;
  readonly viewRoot: HTMLElement;
  readonly connectionDialog: HTMLDialogElement;
  readonly gatewayUrlInput: HTMLInputElement;
  readonly connectionError: HTMLElement;
  readonly selectedConversation: () => Conversation | undefined;
  readonly selectedAgent: () => AgentRecord | undefined;
  readonly selectedAutomation: () => AutomationRecord | undefined;
  readonly gatewayRequest: (method: string, params: unknown) => Promise<unknown>;
  readonly applyHistoryResult: (conversation: Conversation, value: unknown) => void;
  readonly applyProfileResult: (value: unknown) => void;
  readonly sessionFromValue: (value: unknown) => Conversation | undefined;
  readonly parseResponseArray: (
    value: unknown,
    keys: ReadonlyArray<string>,
  ) => ReadonlyArray<unknown>;
  readonly isRecord: (value: unknown) => value is Record<string, unknown>;
  readonly stringValue: (value: unknown, fallback?: string) => string;
  readonly arrayValue: (value: unknown) => ReadonlyArray<unknown>;
  readonly errorMessage: (cause: unknown) => string;
  readonly nowLabel: () => string;
  readonly announce: (message: string) => void;
  readonly showToast: (message: string, tone?: Tone) => void;
  readonly setOperation: (label: string, tone?: Tone) => void;
  readonly clearOperation: () => void;
  readonly persistPins: () => void;
  readonly commandId: (prefix: string) => string;
  readonly renderApp: () => void;
}

let state!: AppState;
let viewRoot!: HTMLElement;
let connectionDialog!: HTMLDialogElement;
let gatewayUrlInput!: HTMLInputElement;
let connectionError!: HTMLElement;
let selectedConversation!: () => Conversation | undefined;
let selectedAgent!: () => AgentRecord | undefined;
let selectedAutomation!: () => AutomationRecord | undefined;
let gatewayRequest!: ActionDependencies["gatewayRequest"];
let applyHistoryResult!: ActionDependencies["applyHistoryResult"];
let applyProfileResult!: ActionDependencies["applyProfileResult"];
let sessionFromValue!: ActionDependencies["sessionFromValue"];
let parseResponseArray!: ActionDependencies["parseResponseArray"];
let isRecord!: ActionDependencies["isRecord"];
let stringValue!: ActionDependencies["stringValue"];
let arrayValue!: ActionDependencies["arrayValue"];
let errorMessage!: ActionDependencies["errorMessage"];
let nowLabel!: ActionDependencies["nowLabel"];
let announce!: ActionDependencies["announce"];
let showToast!: ActionDependencies["showToast"];
let setOperation!: ActionDependencies["setOperation"];
let clearOperation!: ActionDependencies["clearOperation"];
let persistPins!: ActionDependencies["persistPins"];
let commandId!: ActionDependencies["commandId"];
let renderApp!: ActionDependencies["renderApp"];
let streamTimer: ReturnType<typeof setInterval> | undefined;
let streamStopTimer: ReturnType<typeof setTimeout> | undefined;

const sessionReference = (conversation: Conversation): ZiggySessionKey | NonNullable<Conversation["ref"]> =>
  conversation.ref ?? conversation.key;

export const configureActions = (dependencies: ActionDependencies): void => {
  state = dependencies.state;
  viewRoot = dependencies.viewRoot;
  connectionDialog = dependencies.connectionDialog;
  gatewayUrlInput = dependencies.gatewayUrlInput;
  connectionError = dependencies.connectionError;
  selectedConversation = dependencies.selectedConversation;
  selectedAgent = dependencies.selectedAgent;
  selectedAutomation = dependencies.selectedAutomation;
  gatewayRequest = dependencies.gatewayRequest;
  applyHistoryResult = dependencies.applyHistoryResult;
  applyProfileResult = dependencies.applyProfileResult;
  sessionFromValue = dependencies.sessionFromValue;
  parseResponseArray = dependencies.parseResponseArray;
  isRecord = dependencies.isRecord;
  stringValue = dependencies.stringValue;
  arrayValue = dependencies.arrayValue;
  errorMessage = dependencies.errorMessage;
  nowLabel = dependencies.nowLabel;
  announce = dependencies.announce;
  showToast = dependencies.showToast;
  setOperation = dependencies.setOperation;
  clearOperation = dependencies.clearOperation;
  persistPins = dependencies.persistPins;
  commandId = dependencies.commandId;
  renderApp = dependencies.renderApp;
};

export const openConnection = (): void => {
  connectionError.textContent = "";
  if (typeof connectionDialog.showModal === "function") connectionDialog.showModal();
  else connectionDialog.setAttribute("open", "true");
  gatewayUrlInput.focus();
};

const saveDraftFromComposer = (): string => {
  const input = maybe<HTMLTextAreaElement>("#composer-input", viewRoot);
  const conversation = selectedConversation();
  if (input !== undefined && conversation !== undefined) conversation.draft = input.value;
  return input?.value.trim() ?? "";
};

const finishStream = (conversation: Conversation, text: string): void => {
  if (streamTimer !== undefined) window.clearInterval(streamTimer);
  streamTimer = undefined;
  conversation.messages = conversation.messages.map((message) =>
    message.id === "demo-stream" ? { ...message, text, streaming: false } : message,
  );
  conversation.turnState = "idle";
  state.demoState = "ready";
  renderApp();
  announce("Squarey finished the response");
};

const stopDemoStream = (conversation: Conversation): void => {
  if (streamTimer !== undefined) window.clearInterval(streamTimer);
  if (streamStopTimer !== undefined) window.clearTimeout(streamStopTimer);
  streamTimer = undefined;
  conversation.turnState = "stopping";
  state.demoState = "stopping";
  renderApp();
  streamStopTimer = window.setTimeout(() => {
    conversation.turnState = "idle";
    state.demoState = "ready";
    renderApp();
    announce("The turn stopped");
  }, 360);
};

const runDemoPrompt = (conversation: Conversation, text: string): void => {
  if (streamTimer !== undefined) window.clearInterval(streamTimer);
  conversation.messages.push({
    id: `demo-user-${Date.now()}`,
    role: "user",
    author: "You",
    text,
    time: nowLabel(),
  });
  conversation.messages.push({
    id: "demo-stream",
    role: "assistant",
    author: conversation.title,
    text: "",
    time: nowLabel(),
    streaming: true,
  });
  conversation.draft = "";
  conversation.turnState = "running";
  state.demoState = "busy";
  renderApp();
  const response =
    conversation.kind === "group"
      ? "I’ll keep the routes separate for now, then name the smallest test that can teach us which one to choose."
      : conversation.kind === "specialist"
        ? "I’m looking at the underlying question first. Give me one constraint you do not want to trade away."
        : "I’m with you. I’ll keep this small, make the next step visible, and leave the useful uncertainty intact.";
  let index = 0;
  streamTimer = window.setInterval(() => {
    index += 3;
    const snapshot = response.slice(0, index);
    const current = state.conversations.find((item) => item.id === conversation.id);
    if (current === undefined || current.turnState === "stopping") return;
    current.messages = current.messages.map((message) =>
      message.id === "demo-stream" ? { ...message, text: snapshot } : message,
    );
    renderApp();
    if (index >= response.length) finishStream(current, response);
  }, 52);
};

export const submitComposer = async (): Promise<void> => {
  const conversation = selectedConversation();
  const text = saveDraftFromComposer();
  if (conversation === undefined || text.length === 0) return;
  if (conversation.turnState === "watch-only") {
    showToast("This channel is watch only. The owning adapter keeps input.", "warning");
    return;
  }
  if (conversation.closed) {
    showToast("Reopen this session before sending a turn.", "warning");
    return;
  }
  if (state.mode === "demo") {
    runDemoPrompt(conversation, text);
    return;
  }
  conversation.draft = "";
  conversation.turnState = state.composerMode === "prompt" ? "running" : "running";
  setOperation(
    state.composerMode === "prompt"
      ? "Requesting a turn…"
      : state.composerMode === "steer"
        ? "Sending steer…"
        : "Queueing follow-up…",
    "warning",
  );
  const method =
    state.composerMode === "prompt"
      ? "prompt.submit"
      : state.composerMode === "steer"
        ? "session.steer"
        : "session.follow-up";
  const requestCommandId = commandId(state.composerMode);
  const recipient =
    conversation.kind === "group" &&
    state.composerMode === "prompt" &&
    conversation.recipient !== undefined &&
    conversation.recipient !== "everyone"
      ? conversation.recipient === "host"
        ? { kind: "host" as const }
        : { kind: "agent" as const, agentId: conversation.recipient }
      : undefined;
  conversation.messages.push({
    id: `user-${requestCommandId}`,
    role: "user",
    author:
      state.composerMode === "prompt"
        ? "You"
        : state.composerMode === "steer"
          ? "You · steer"
          : "You · follow up",
    text,
    time: nowLabel(),
  });
  renderApp();
  try {
    await gatewayRequest(method, {
      session: sessionReference(conversation),
      text,
      commandId: requestCommandId,
      ...(recipient === undefined ? {} : { recipient }),
    });
    showToast(
      state.composerMode === "prompt"
        ? "Prompt accepted"
        : state.composerMode === "steer"
          ? "Steer accepted"
          : "Follow-up queued",
      "success",
    );
    announce("Request accepted by the resident");
  } catch (cause) {
    conversation.turnState = "idle";
    conversation.lastError = errorMessage(cause);
    showToast(conversation.lastError, "danger");
  } finally {
    clearOperation();
  }
};

export const abortConversation = async (): Promise<void> => {
  const conversation = selectedConversation();
  if (conversation === undefined) return;
  if (state.mode === "demo") {
    stopDemoStream(conversation);
    return;
  }
  conversation.turnState = "stopping";
  setOperation("Stopping turn…", "warning");
  renderApp();
  try {
    await gatewayRequest("session.abort", {
      session: sessionReference(conversation),
      commandId: commandId("abort"),
    });
    showToast("Abort requested", "success");
  } catch (cause) {
    conversation.lastError = errorMessage(cause);
    showToast(conversation.lastError, "danger");
  } finally {
    conversation.turnState = "idle";
    clearOperation();
  }
};

export const loadHistory = async (conversation: Conversation): Promise<void> => {
  if (conversation.historyHasMore === false || state.loadingHistory) return;
  state.loadingHistory = true;
  renderApp();
  if (state.mode === "demo") {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 280));
    const earlier: Message[] = [
      {
        id: `older-${conversation.historyPage}-1`,
        role: "assistant",
        author: conversation.title,
        text: "Earlier context is kept bounded and ordered by the resident.",
        time: "Earlier",
      },
      {
        id: `older-${conversation.historyPage}-2`,
        role: "user",
        author: "You",
        text: "Keep the shape honest and easy to return to.",
        time: "Earlier",
      },
    ];
    conversation.messages = [...earlier, ...conversation.messages];
    conversation.historyPage += 1;
    conversation.historyHasMore = conversation.historyPage < 3;
    state.loadingHistory = false;
    renderApp();
    announce("Earlier messages loaded");
    return;
  }
  try {
    const value = await gatewayRequest("session.history", {
      session: sessionReference(conversation),
      ...(conversation.historyCursor === undefined ? {} : { cursor: conversation.historyCursor }),
    });
    applyHistoryResult(conversation, value);
    conversation.historyPage += 1;
    showToast("History reconciled", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    state.loadingHistory = false;
    renderApp();
  }
};

export const togglePin = async (): Promise<void> => {
  const conversation = selectedConversation();
  if (conversation === undefined) return;
  const next = !conversation.pinned;
  conversation.pinned = next;
  persistPins();
  setOperation(next ? "Pinning conversation…" : "Unpinning conversation…", "warning");
  if (state.mode === "live") {
    try {
      if (!next && conversation.pinId === undefined)
        throw new Error("Pinned session identity is stale; refresh the roster before unpinning.");
      const params: Record<string, unknown> = {
        session: sessionReference(conversation),
        commandId: commandId("pin"),
        expectedRevision: state.pinRevision,
      };
      if (conversation.pinId !== undefined) params.pinId = conversation.pinId;
      if (next) {
        params.order = state.conversations.filter((item) => item.pinned).length - 1;
        params.label = conversation.title;
      }
      const result = await gatewayRequest(next ? "pin.set" : "pin.remove", params);
      if (isRecord(result)) {
        if (typeof result.revision === "number" && Number.isSafeInteger(result.revision))
          state.pinRevision = result.revision;
        const pins = arrayValue(result.pins);
        const matching = pins.find((item) => {
          if (!isRecord(item) || !isRecord(item.ref)) return false;
          return stringValue(item.ref.key) === conversation.key;
        });
        if (isRecord(matching)) {
          const pinId = stringValue(matching.id);
          if (pinId.length > 0) conversation.pinId = pinId;
        } else if (!next) {
          delete conversation.pinId;
        }
      }
      showToast(next ? "Pinned on the resident" : "Unpinned on the resident", "success");
    } catch (cause) {
      conversation.pinned = !next;
      persistPins();
      showToast(`Server pin did not reconcile: ${errorMessage(cause)}`, "danger");
    }
  } else {
    showToast(next ? "Pinned in this demo roster" : "Removed from pinned", "success");
  }
  clearOperation();
};

export const watchConversation = async (): Promise<void> => {
  const conversation = selectedConversation();
  if (conversation === undefined) return;
  if (conversation.turnState === "watch-only") {
    showToast("This channel is already watch-only", "neutral");
    return;
  }
  if (conversation.watched === true) {
    showToast("Already watching this conversation", "neutral");
    return;
  }
  setOperation("Opening watch…", "warning");
  if (state.mode === "demo") {
    conversation.watched = true;
    state.demoState = "watch-only";
    showToast("Watch-only view opened", "success");
    clearOperation();
    return;
  }
  try {
    await gatewayRequest("session.watch", {
      session: sessionReference(conversation),
      commandId: commandId("watch"),
    });
    conversation.watched = true;
    showToast("Watching live session", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const closeConversation = async (): Promise<void> => {
  const conversation = selectedConversation();
  if (conversation === undefined || conversation.closed) return;
  if (conversation.kind === "channel") {
    showToast("External channels are watch-only in this desk", "warning");
    return;
  }
  setOperation("Closing session…", "warning");
  if (state.mode === "demo") {
    conversation.closed = true;
    conversation.turnState = "closed";
    showToast("Session closed", "success");
    clearOperation();
    return;
  }
  try {
    await gatewayRequest("session.close", {
      session: sessionReference(conversation),
      commandId: commandId("close"),
    });
    conversation.closed = true;
    conversation.turnState = "closed";
    showToast("Session closed", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const reopenConversation = async (): Promise<void> => {
  const conversation = selectedConversation();
  if (conversation === undefined || !conversation.closed) return;
  if (conversation.kind === "channel") {
    showToast("External channels are watch-only in this desk", "warning");
    return;
  }
  setOperation("Reopening session…", "warning");
  if (state.mode === "demo") {
    conversation.closed = false;
    conversation.turnState = "idle";
    showToast("Session reopened", "success");
    clearOperation();
    return;
  }
  try {
    const agentId =
      conversation.kind === "specialist" ? conversation.key.split("/").at(-1) : undefined;
    await gatewayRequest("session.open", {
      context: { kind: "local" },
      ...(agentId === undefined ? {} : { agentId }),
    });
    conversation.closed = false;
    conversation.turnState = "idle";
    showToast("Session reopened", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const updateModel = async (provider: string, model: string): Promise<void> => {
  state.profile.provider = provider;
  state.profile.model = model;
  if (state.mode === "demo") {
    showToast(`Demo model set to ${provider} · ${model}`, "success");
    renderApp();
    return;
  }
  setOperation("Saving model selection…", "warning");
  try {
    const value = await gatewayRequest("model.set", {
      provider,
      model,
      commandId: commandId("model"),
    });
    applyProfileResult(value);
    showToast("Model selection saved", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

const agentFromForm = (form: HTMLFormElement): AgentRecord => {
  const value = (name: string): string => stringValue(new FormData(form).get(name));
  return {
    id: value("id").trim(),
    name: value("name").trim(),
    description: value("description").trim(),
    provider: value("provider") || "OpenAI",
    model: value("model") || "gpt-5",
    tools: [],
    status: "needs-review",
    body: value("body").trim(),
  };
};

export const validateAgentDraft = async (form?: HTMLFormElement): Promise<void> => {
  const candidate = form === undefined ? selectedAgent() : agentFromForm(form);
  if (candidate === undefined) return;
  const valid =
    candidate.id.length > 0 &&
    candidate.name.length > 0 &&
    candidate.description.length > 0 &&
    candidate.body.length > 0;
  if (state.mode === "demo") {
    if (valid) {
      state.draftAgent = candidate;
      showToast("Agent brief validated", "success");
    } else showToast("Add an id, description, and working brief", "danger");
    renderApp();
    return;
  }
  setOperation("Validating agent…", "warning");
  try {
    await gatewayRequest("agent.validate", {
      id: candidate.id,
      body: candidate.body,
      commandId: commandId("agent-validate"),
    });
    showToast("Agent validated", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const runAgent = async (id: string): Promise<void> => {
  const agent = state.agents.find((item) => item.id === id);
  if (agent === undefined) return;
  if (agent.status === "needs-review" || state.demoState === "validation") {
    showToast("Validate this agent before running it", "warning");
    return;
  }
  if (state.mode === "demo") {
    agent.status = "running";
    renderApp();
    window.setTimeout(() => {
      agent.status = "ready";
      showToast(`${agent.name} completed a one-shot run`, "success");
      renderApp();
    }, 650);
    return;
  }
  setOperation(`Running ${agent.name}…`, "warning");
  agent.status = "running";
  renderApp();
  try {
    await gatewayRequest("agent.run", {
      id,
      task: `Give a concise update for ${agent.name}.`,
      commandId: commandId("agent-run"),
    });
    showToast(`${agent.name} run accepted`, "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    agent.status = "ready";
    clearOperation();
  }
};

export const createAgent = async (form: HTMLFormElement): Promise<void> => {
  const candidate = agentFromForm(form);
  if (
    candidate.id.length === 0 ||
    candidate.name.length === 0 ||
    candidate.description.length === 0 ||
    candidate.body.length === 0
  ) {
    showToast("Complete the agent draft before creating it", "danger");
    return;
  }
  if (state.mode === "demo") {
    state.agents.push(candidate);
    state.selectedAgentId = candidate.id;
    state.draftAgent = newAgentDraft();
    showToast(`${candidate.name} created in the fixture Profile`, "success");
    renderApp();
    return;
  }
  setOperation("Creating agent…", "warning");
  try {
    await gatewayRequest("agent.create", {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      body: candidate.body,
      commandId: commandId("agent-create"),
    });
    state.agents.push(candidate);
    state.selectedAgentId = candidate.id;
    showToast(`${candidate.name} created`, "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const openAgentConversation = (id: string): void => {
  const agent = state.agents.find((item) => item.id === id);
  if (agent === undefined) return;
  if (state.mode === "live") {
    setOperation(`Opening ${agent.name}…`, "warning");
    void gatewayRequest("session.open", { context: { kind: "local" }, agentId: id })
      .then(async (value) => {
        const session = sessionFromValue(value);
        if (session === undefined) throw new Error("Resident did not return a specialist session");
        await gatewayRequest("session.watch", { session: session.ref ?? session.key });
        session.watched = true;
        if (!state.conversations.some((item) => item.id === session.id))
          state.conversations.push(session);
        state.selectedConversationId = session.id;
        state.view = "chat";
        showToast(`${agent.name} specialist thread opened`, "success");
        renderApp();
        void loadHistory(session);
      })
      .catch((cause: unknown) => showToast(errorMessage(cause), "danger"))
      .finally(clearOperation);
    return;
  }
  let conversation = state.conversations.find((item) => item.key === `local/agents/${id}`);
  if (conversation === undefined) {
    conversation = {
      id: `specialist-${id}`,
      key: `local/agents/${id}` as ZiggySessionKey,
      title: agent.name,
      subtitle: `Specialist · ${agent.description.split(".")[0] ?? "focused work"}`,
      kind: "specialist",
      avatar: id === "sage" ? "sage" : id === "scout" ? "scout" : "squarey",
      updatedAt: "now",
      model: `${agent.model} · focused`,
      participants: [agent.name, state.profile.name],
      messages: [],
      pinned: false,
      unread: false,
      turnState: "idle",
      closed: false,
      historyPage: 1,
      historyHasMore: false,
      draft: "",
    };
    state.conversations.push(conversation);
  }
  state.selectedConversationId = conversation.id;
  state.view = "chat";
  renderApp();
};

const automationFromForm = (form: HTMLFormElement): AutomationRecord => {
  const data = new FormData(form);
  const value = (name: string): string => stringValue(data.get(name)).trim();
  const existing = selectedAutomation();
  return {
    id:
      form.dataset.new === "true"
        ? value("name")
            .toLocaleLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-|-$/gu, "")
        : (existing?.id ?? "draft"),
    name: value("name"),
    schedule: value("schedule"),
    timezone: value("timezone"),
    prompt: value("prompt"),
    status: "invalid",
    lastRun: existing?.lastRun ?? "Never",
    nextRun: existing?.nextRun ?? "Needs validation",
    source: `---\nversion: 1\ncron: ${value("schedule")}\ntimezone: ${value("timezone")}\nbroadcast: none\n---\n\n${value("prompt")}\n`,
    runs: existing?.runs ?? [],
  };
};

export const validateAutomation = async (form?: HTMLFormElement): Promise<void> => {
  const candidate = form === undefined ? selectedAutomation() : automationFromForm(form);
  if (candidate === undefined) return;
  const cronShape = candidate.schedule.split(/\s+/u).filter(Boolean).length >= 5;
  const valid =
    candidate.name.length > 0 &&
    cronShape &&
    candidate.timezone.length > 0 &&
    candidate.prompt.length > 0;
  if (state.mode === "demo") {
    if (!valid) {
      showToast("Add a name, five-part cron, timezone, and prompt", "danger");
      return;
    }
    candidate.status = "active";
    candidate.nextRun = "Next scheduled occurrence";
    if (form?.dataset.new === "true") {
      state.automations.push(candidate);
      state.selectedAutomationId = candidate.id;
    } else {
      const current = selectedAutomation();
      if (current !== undefined) Object.assign(current, candidate);
    }
    showToast("Automation validated", "success");
    renderApp();
    return;
  }
  setOperation("Validating automation…", "warning");
  try {
    await gatewayRequest("automation.validate", {
      id: candidate.id,
      source: candidate.source,
      commandId: commandId("automation-validate"),
    });
    showToast("Automation validated", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const saveAutomation = async (form: HTMLFormElement): Promise<void> => {
  const candidate = automationFromForm(form);
  const isNew = form.dataset.new === "true";
  if (candidate.name.length === 0 || candidate.prompt.length === 0) {
    showToast("Complete the routine before saving", "danger");
    return;
  }
  if (state.mode === "demo") {
    candidate.status =
      candidate.schedule.split(/\s+/u).filter(Boolean).length >= 5 ? "active" : "invalid";
    if (form.dataset.new === "true") {
      state.automations.push(candidate);
      state.selectedAutomationId = candidate.id;
      state.draftAutomation = newAutomationDraft();
    } else {
      const current = selectedAutomation();
      if (current !== undefined) Object.assign(current, candidate);
    }
    showToast("Automation saved in the fixture Profile", "success");
    renderApp();
    return;
  }
  setOperation("Saving automation…", "warning");
  try {
    let expectedSource = selectedAutomation()?.source ?? "";
    if (isNew) {
      await gatewayRequest("automation.create", {
        id: candidate.id,
        commandId: commandId("automation-create"),
      });
      const created = await gatewayRequest("automation.show", { id: candidate.id });
      if (isRecord(created)) expectedSource = stringValue(created.source);
    }
    await gatewayRequest("automation.save", {
      id: candidate.id,
      source: candidate.source,
      expectedSource,
      commandId: commandId("automation-save"),
    });
    if (isNew) {
      state.automations.push(candidate);
      state.selectedAutomationId = candidate.id;
    } else {
      const current = selectedAutomation();
      if (current !== undefined) Object.assign(current, candidate);
    }
    showToast("Automation saved", "success");
  } catch (cause) {
    showToast(`Save did not reconcile: ${errorMessage(cause)}`, "danger");
    state.demoState = "reconciliation";
  } finally {
    clearOperation();
  }
};

export const createAutomationDraft = (): void => {
  state.selectedAutomationId = "draft";
  state.draftAutomation = newAutomationDraft();
  renderApp();
};

export const pauseOrResumeAutomation = async (resume: boolean): Promise<void> => {
  const automation = selectedAutomation();
  if (automation === undefined) return;
  const nextStatus: AutomationRecord["status"] = resume ? "active" : "paused";
  if (state.mode === "demo") {
    automation.status = nextStatus;
    automation.nextRun = resume ? "Next scheduled occurrence" : "Paused";
    showToast(resume ? "Automation resumed" : "Automation paused", "success");
    renderApp();
    return;
  }
  setOperation(resume ? "Resuming automation…" : "Pausing automation…", "warning");
  try {
    await gatewayRequest(resume ? "automation.resume" : "automation.pause", {
      id: automation.id,
      commandId: commandId(resume ? "automation-resume" : "automation-pause"),
    });
    automation.status = nextStatus;
    automation.nextRun = resume ? "Next scheduled occurrence" : "Paused";
    showToast(resume ? "Automation resumed" : "Automation paused", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const runAutomation = async (): Promise<void> => {
  const automation = selectedAutomation();
  if (automation === undefined) return;
  if (automation.status === "invalid" || state.demoState === "validation") {
    showToast("Validate the automation before running it", "warning");
    return;
  }
  automation.status = "running";
  if (state.mode === "demo") {
    renderApp();
    window.setTimeout(() => {
      automation.status = "active";
      automation.lastRun = "Just now";
      automation.runs.unshift({
        id: `run-demo-${automation.runs.length + 1}`,
        state: "succeeded",
        summary: "Manual run completed",
        time: "Just now",
      });
      showToast("Manual automation run completed", "success");
      renderApp();
    }, 650);
    return;
  }
  setOperation("Starting manual run…", "warning");
  try {
    await gatewayRequest("automation.run", {
      id: automation.id,
      commandId: commandId("automation-run"),
    });
    showToast("Manual run accepted", "success");
  } catch (cause) {
    automation.status = "active";
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const loadExtensions = async (): Promise<void> => {
  if (state.mode === "demo") return;
  try {
    const value = await gatewayRequest("extension.list-for-profile", {});
    if (!isRecord(value)) return;
    const available = parseResponseArray(value, ["available"]);
    const selected = new Set(
      arrayValue(value.selected).filter((item): item is string => typeof item === "string"),
    );
    state.extensions = available.flatMap((item): ExtensionRecord[] => {
      if (!isRecord(item)) return [];
      const id = stringValue(item.id);
      if (id.length === 0) return [];
      return [
        {
          id,
          description: stringValue(item.description, "Extension resource"),
          kind: stringValue(item.kind, "skill"),
          source: stringValue(item.source, "profile"),
          selected: selected.has(id),
        },
      ];
    });
  } catch (cause) {
    showToast(`Extensions unavailable: ${errorMessage(cause)}`, "warning");
  }
};

export const setExtensionSelected = async (id: string, selected: boolean): Promise<void> => {
  const extension = state.extensions.find((item) => item.id === id);
  if (extension === undefined) return;
  if (state.mode === "demo") {
    extension.selected = selected;
    showToast(`${id} ${selected ? "added" : "removed"}`, "success");
    renderApp();
    return;
  }
  setOperation(`${selected ? "Adding" : "Removing"} ${id}…`, "warning");
  try {
    await gatewayRequest(selected ? "extension.add" : "extension.remove", { id });
    extension.selected = selected;
    showToast(`${id} ${selected ? "added" : "removed"}`, "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};

export const validateExtensions = async (): Promise<void> => {
  if (state.mode === "demo") {
    state.demoState = "ready";
    showToast("Extension selection is valid", "success");
    renderApp();
    return;
  }
  setOperation("Validating extensions…", "warning");
  try {
    await gatewayRequest("extension.validate", {});
    showToast("Extension selection validated", "success");
  } catch (cause) {
    showToast(errorMessage(cause), "danger");
  } finally {
    clearOperation();
  }
};
