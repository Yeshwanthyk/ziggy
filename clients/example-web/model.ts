import type { ZiggySessionKey, ZiggySessionRef } from "../gateway-client/src/index";

export type ViewName = "chat" | "agents" | "automations" | "memory";
export type DemoState =
  | "ready"
  | "loading"
  | "busy"
  | "stopping"
  | "watch-only"
  | "reconnecting"
  | "offline"
  | "empty"
  | "validation"
  | "request"
  | "ownership"
  | "reconciliation";
export type ComposerMode = "prompt" | "steer" | "follow-up";
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";
export type Tone = "neutral" | "success" | "warning" | "danger";
export type TurnState = "idle" | "running" | "stopping" | "watch-only" | "closed";
export type MessageRole = "user" | "assistant" | "tool" | "voice";

export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly author: string;
  text: string;
  readonly time: string;
  toolName?: string;
  toolState?: "running" | "complete" | "failed";
  detail?: string;
  specialist?: string;
  streaming?: boolean;
}

export interface Conversation {
  readonly id: string;
  readonly key: ZiggySessionKey;
  readonly ref?: ZiggySessionRef;
  readonly title: string;
  readonly subtitle: string;
  readonly kind: "bot" | "specialist" | "group" | "channel";
  readonly avatar: string;
  readonly updatedAt: string;
  readonly model: string;
  readonly participants: ReadonlyArray<string>;
  channel?: string;
  groupId?: string;
  messages: Message[];
  pinned: boolean;
  pinId?: string;
  unread: boolean;
  watched?: boolean;
  turnState: TurnState;
  closed: boolean;
  historyPage: number;
  historyCursor?: string;
  historyHasMore: boolean;
  recipient?: string;
  draft: string;
  lastError?: string;
}

export interface AgentRecord {
  readonly id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  tools: string[];
  status: "ready" | "needs-review" | "running";
  body: string;
}

export interface AutomationRecord {
  readonly id: string;
  name: string;
  schedule: string;
  timezone: string;
  prompt: string;
  status: "active" | "paused" | "invalid" | "running";
  lastRun: string;
  nextRun: string;
  source: string;
  runs: RunRecord[];
}

export interface RunRecord {
  readonly id: string;
  readonly state: "succeeded" | "failed" | "running";
  readonly summary: string;
  readonly time: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly summary: string;
  readonly entries: number;
  readonly cap: string;
  readonly updated: string;
  content: string;
  contentState?: "idle" | "loading" | "loaded" | "error";
}

export interface ExtensionRecord {
  readonly id: string;
  readonly description: string;
  readonly kind: string;
  readonly source: string;
  selected: boolean;
}

export interface ProfileRecord {
  id: string;
  name: string;
  tagline: string;
  model: string;
  provider: string;
  auth: "connected" | "missing" | "unknown";
}

export interface ProfileOption {
  readonly id: string;
  readonly name: string;
  readonly current: boolean;
  readonly available: boolean;
}

export interface AppState {
  mode: "demo" | "live";
  view: ViewName;
  demoState: DemoState;
  connectionState: ConnectionState;
  profile: ProfileRecord;
  profiles: ProfileOption[];
  conversations: Conversation[];
  selectedConversationId: string;
  composerMode: ComposerMode;
  detailsOpen: boolean;
  railOpen: boolean;
  operation?: { label: string; tone: Tone };
  agents: AgentRecord[];
  selectedAgentId: string;
  automations: AutomationRecord[];
  selectedAutomationId: string;
  memory: MemoryRecord[];
  selectedMemoryId: string;
  extensions: ExtensionRecord[];
  availableProviders: string[];
  availableModels: string[];
  authProviders: string[];
  pinRevision: number;
  memoryTab: "memory" | "extensions";
  search: string;
  loadingHistory: boolean;
  draftAgent: AgentRecord;
  draftAutomation: AutomationRecord;
}
const arrayValue = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const baseMessages = (): Message[] => [
  {
    id: "m-1",
    role: "user",
    author: "You",
    text: "What should I make room for this week?",
    time: "9:14 AM",
  },
  {
    id: "m-2",
    role: "assistant",
    author: "Squarey",
    text: "A small, honest reset. The open loops are not equally urgent: protect the writing block, close the two waiting decisions, and let the rest stay visible without asking for attention yet.",
    time: "9:14 AM",
  },
  {
    id: "m-3",
    role: "tool",
    author: "Squarey",
    text: "",
    time: "9:14 AM",
    toolName: "memory.search",
    toolState: "complete",
    detail: "3 relevant notes",
  },
  {
    id: "m-4",
    role: "assistant",
    author: "Squarey",
    text: "I would start with 90 quiet minutes for the thing you want to remember making. Then a 20-minute sweep for decisions. Want me to turn that into a short plan?",
    time: "9:15 AM",
  },
];

const makeConversations = (): Conversation[] => [
  {
    id: "squarey-home",
    key: "ui/home" as ZiggySessionKey,
    title: "Squarey",
    subtitle: "Home thread",
    kind: "bot",
    avatar: "squarey",
    updatedAt: "now",
    model: "gpt-5 · balanced",
    participants: ["Squarey"],
    messages: baseMessages(),
    pinned: true,
    unread: false,
    turnState: "idle",
    closed: false,
    historyPage: 1,
    historyHasMore: true,
    draft: "",
  },
  {
    id: "planning",
    key: "ui/planning" as ZiggySessionKey,
    title: "Plan the quiet launch",
    subtitle: "Squarey · 12 messages",
    kind: "bot",
    avatar: "squarey",
    updatedAt: "8m",
    model: "gpt-5 · balanced",
    participants: ["Squarey"],
    messages: [
      {
        id: "p-1",
        role: "user",
        author: "You",
        text: "Give this idea a smaller first shape.",
        time: "8:47 AM",
      },
      {
        id: "p-2",
        role: "assistant",
        author: "Squarey",
        text: "A one-page test with one person and one clear handoff. Keep the signal, remove the ceremony.",
        time: "8:48 AM",
      },
    ],
    pinned: true,
    unread: true,
    turnState: "idle",
    closed: false,
    historyPage: 1,
    historyHasMore: true,
    draft: "",
  },
  {
    id: "sage",
    key: "local/agents/sage" as ZiggySessionKey,
    title: "Sage",
    subtitle: "Specialist · research",
    kind: "specialist",
    avatar: "sage",
    updatedAt: "yesterday",
    model: "claude-sonnet · focused",
    participants: ["Sage", "Squarey"],
    messages: [
      {
        id: "s-1",
        role: "user",
        author: "You",
        text: "Find the question hiding underneath this draft.",
        time: "Yesterday",
      },
      {
        id: "s-2",
        role: "voice",
        author: "Sage",
        specialist: "Sage · research",
        text: "The draft is asking for permission to be useful before it asks to be impressive. That is the question worth keeping.",
        time: "Yesterday",
      },
      {
        id: "s-3",
        role: "assistant",
        author: "Squarey",
        text: "Sage found the useful edge: make the first version answer one real question, in public, with a clear next step.",
        time: "Yesterday",
      },
    ],
    pinned: false,
    unread: false,
    turnState: "idle",
    closed: false,
    historyPage: 1,
    historyHasMore: false,
    draft: "",
  },
  {
    id: "observatory",
    key: "ui/observatory" as ZiggySessionKey,
    title: "The observatory",
    subtitle: "Group room · 3 members",
    kind: "group",
    avatar: "group",
    updatedAt: "Tue",
    model: "gpt-5 · balanced",
    participants: ["Squarey", "Sage", "Scout"],
    messages: [
      {
        id: "o-1",
        role: "user",
        author: "You",
        text: "Let’s compare the two routes without forcing a decision.",
        time: "Tue",
      },
      {
        id: "o-2",
        role: "voice",
        author: "Sage",
        specialist: "Sage · research",
        text: "Route A has the cleaner learning loop. It asks less of the first person who tries it.",
        time: "Tue",
      },
      {
        id: "o-3",
        role: "voice",
        author: "Scout",
        specialist: "Scout · logistics",
        text: "Route B is easier to explain, but its handoff cost appears one step later.",
        time: "Tue",
      },
    ],
    pinned: false,
    unread: true,
    turnState: "idle",
    closed: false,
    historyPage: 1,
    historyHasMore: true,
    draft: "",
  },
  {
    id: "telegram-thread",
    key: "telegram/project-room" as ZiggySessionKey,
    title: "Project room",
    subtitle: "Telegram · watch only",
    kind: "channel",
    avatar: "channel",
    channel: "Telegram",
    updatedAt: "Mon",
    model: "gpt-5 · balanced",
    participants: ["Squarey", "Project room"],
    messages: [
      {
        id: "t-1",
        role: "user",
        author: "Project room",
        text: "The notes are in the shared thread. We can pick this up tomorrow.",
        time: "Mon",
      },
      {
        id: "t-2",
        role: "assistant",
        author: "Squarey",
        text: "Observed in Project room. This channel is available as a watch-only view in the desk.",
        time: "Mon",
      },
    ],
    pinned: false,
    unread: false,
    turnState: "watch-only",
    closed: false,
    historyPage: 1,
    historyHasMore: false,
    draft: "",
  },
];

const makeAgents = (): AgentRecord[] => [
  {
    id: "squarey",
    name: "Squarey",
    description: "The Profile's generalist operator and conversation host.",
    provider: "OpenAI",
    model: "gpt-5",
    tools: ["memory", "automations", "extensions"],
    status: "ready",
    body: "You are Squarey, a calm operator with a long memory. Make the next useful step legible.",
  },
  {
    id: "sage",
    name: "Sage",
    description: "A research specialist for finding the question underneath the work.",
    provider: "Anthropic",
    model: "claude-sonnet-4",
    tools: ["web-search", "memory"],
    status: "ready",
    body: "Look for the hidden question. Bring back a concise frame and the evidence that changed it.",
  },
  {
    id: "scout",
    name: "Scout",
    description: "A pragmatic specialist for sequencing logistics and handoffs.",
    provider: "OpenAI",
    model: "gpt-5-mini",
    tools: ["memory"],
    status: "needs-review",
    body: "Turn uncertain work into a sequence of small, testable handoffs.",
  },
];

const makeAutomations = (): AutomationRecord[] => [
  {
    id: "morning-brief",
    name: "Morning brief",
    schedule: "0 8 * * 1-5",
    timezone: "America/Toronto",
    prompt: "Prepare a short morning brief from the Profile's current notes.",
    status: "active",
    lastRun: "Today, 8:00 AM",
    nextRun: "Tomorrow, 8:00 AM",
    source:
      "schedule: 0 8 * * 1-5\ntimezone: America/Toronto\nprompt: Prepare a short morning brief from the Profile's current notes.",
    runs: [
      { id: "run-1", state: "succeeded", summary: "Delivered to Squarey", time: "Today, 8:00 AM" },
      {
        id: "run-2",
        state: "succeeded",
        summary: "Delivered to Squarey",
        time: "Yesterday, 8:00 AM",
      },
      { id: "run-3", state: "failed", summary: "Gate did not pass", time: "Mon, 8:00 AM" },
    ],
  },
  {
    id: "weekly-reflection",
    name: "Weekly reflection",
    schedule: "0 17 * * 5",
    timezone: "America/Toronto",
    prompt: "Ask what became clearer this week and preserve the useful answer.",
    status: "paused",
    lastRun: "Aug 22, 5:00 PM",
    nextRun: "Paused",
    source:
      "schedule: 0 17 * * 5\ntimezone: America/Toronto\nprompt: Ask what became clearer this week and preserve the useful answer.",
    runs: [
      { id: "run-4", state: "succeeded", summary: "Saved a reflection", time: "Aug 22, 5:00 PM" },
      { id: "run-5", state: "succeeded", summary: "Saved a reflection", time: "Aug 15, 5:00 PM" },
    ],
  },
  {
    id: "inbox-sweep",
    name: "Inbox sweep",
    schedule: "0 9 * * 1",
    timezone: "America/Toronto",
    prompt: "Review unfinished threads and name the one decision that would create the most room.",
    status: "invalid",
    lastRun: "Never",
    nextRun: "Needs validation",
    source: "schedule: 0 9 * * 1\ntimezone: America/Toronto\nprompt:",
    runs: [],
  },
];

const makeMemory = (): MemoryRecord[] => [
  {
    id: "shared",
    title: "Shared memory",
    scope: "shared",
    summary: "Durable facts that help every conversation stay oriented.",
    entries: 18,
    cap: "2,200 characters",
    updated: "12 minutes ago",
    content:
      "Squarey should make the next useful step legible. Keep plans small enough to start today.",
  },
  {
    id: "squarey-person",
    title: "Your memory",
    scope: "person",
    summary: "Context from this Profile's ongoing 1:1 work.",
    entries: 11,
    cap: "1,375 characters",
    updated: "Yesterday",
    content: "You prefer short plans, clear handoffs, and leaving a little room for surprise.",
  },
  {
    id: "observatory-group",
    title: "Observatory room",
    scope: "group",
    summary: "Context shared by the local group conversation.",
    entries: 7,
    cap: "1,375 characters",
    updated: "Tuesday",
    content:
      "The observatory is for comparing routes before choosing one. Avoid premature synthesis.",
  },
];

const makeExtensions = (): ExtensionRecord[] => [
  {
    id: "lossless-claw",
    description: "Bounded recall over selected session history.",
    kind: "skill+code",
    source: "bundled",
    selected: true,
  },
  {
    id: "web-search",
    description: "Search the web through an admitted provider.",
    kind: "skill+code",
    source: "bundled",
    selected: true,
  },
  {
    id: "ziggy-operations",
    description: "Profile operations, routines, memory, and resident guidance.",
    kind: "skill",
    source: "bundled",
    selected: true,
  },
  {
    id: "agent-browser",
    description: "Browser research for an explicitly admitted Profile agent.",
    kind: "skill+code",
    source: "remote-approved",
    selected: false,
  },
];

export const newAgentDraft = (): AgentRecord => ({
  id: "",
  name: "",
  description: "",
  provider: "OpenAI",
  model: "gpt-5",
  tools: [],
  status: "needs-review",
  body: "",
});

export const newAutomationDraft = (): AutomationRecord => ({
  id: "",
  name: "",
  schedule: "0 9 * * 1-5",
  timezone: "America/Toronto",
  prompt: "",
  status: "invalid",
  lastRun: "Never",
  nextRun: "Needs validation",
  source: "",
  runs: [],
});

const storedPins = (): Set<string> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("ziggy-example-pins") ?? "[]");
    return new Set(arrayValue(value).filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
};

export const createInitialState = (): AppState => {
  const initialConversations = makeConversations();
  const initialPins = storedPins();
  for (const conversation of initialConversations) {
    if (initialPins.size > 0) conversation.pinned = initialPins.has(conversation.id);
  }

  return {
    mode: "demo",
    view: "chat",
    demoState: "ready",
    connectionState: "open",
    profile: {
      id: "squarey",
      name: "Squarey",
      tagline: "A small operator with a long memory.",
      model: "gpt-5",
      provider: "OpenAI",
      auth: "connected",
    },
    profiles: [{ id: "squarey", name: "Squarey", current: true, available: true }],
    conversations: initialConversations,
    selectedConversationId: "squarey-home",
    composerMode: "prompt",
    detailsOpen: false,
    railOpen: false,
    agents: makeAgents(),
    selectedAgentId: "squarey",
    automations: makeAutomations(),
    selectedAutomationId: "morning-brief",
    memory: makeMemory(),
    selectedMemoryId: "shared",
    extensions: makeExtensions(),
    availableProviders: [],
    availableModels: [],
    authProviders: [],
    pinRevision: 0,
    memoryTab: "memory",
    search: "",
    loadingHistory: false,
    draftAgent: newAgentDraft(),
    draftAutomation: newAutomationDraft(),
  };
};
