import type {
  ZiggyClientEvent,
  ZiggyConnectionState,
  ZiggyEventCursor,
  ZiggyGatewayEvent,
  ZiggyProfileId,
  ZiggyProfileSummary,
} from "./protocol";
import type {
  ZiggyConversationContext,
  ZiggySessionHistoryEntry,
  ZiggySessionHistoryResult,
  ZiggySessionRef,
  ZiggySessionShowResult,
} from "./protocol/conversations";
import type { ZiggyPin } from "./protocol/navigation";

export type ZiggyConversationKind = "main" | "specialist" | "group";

export interface ZiggyConversationIdentity {
  readonly profileId: ZiggyProfileId;
  readonly kind: ZiggyConversationKind;
  readonly ref?: ZiggySessionRef;
  readonly agentId?: string;
  readonly groupId?: string;
  readonly members?: ReadonlyArray<ZiggySessionRef>;
}

export interface ZiggyConversationState extends ZiggyConversationIdentity {
  readonly title: string;
  readonly status: "idle" | "working" | "stopping" | "closed";
  readonly events: ReadonlyArray<ZiggyGatewayEvent>;
  readonly history: ReadonlyArray<ZiggySessionHistoryEntry>;
  readonly cursor: ZiggyEventCursor | undefined;
  readonly reconciliations: ReadonlyArray<
    Extract<ZiggyClientEvent, { readonly event: "history-reconciliation" }>
  >;
  readonly seenEventIds: ReadonlyArray<string>;
}

export interface ZiggyGatewayState {
  readonly connection: ZiggyConnectionState;
  readonly epoch: string | undefined;
  readonly activeProfileId: ZiggyProfileId | undefined;
  readonly profiles: ReadonlyArray<ZiggyProfileSummary>;
  readonly conversations: Readonly<Record<string, ZiggyConversationState>>;
  readonly pins: Readonly<Record<string, ReadonlyArray<ZiggyPin>>>;
  readonly reconciliations: ReadonlyArray<
    Extract<ZiggyClientEvent, { readonly event: "history-reconciliation" }>
  >;
}

export type ZiggyGatewayAction =
  | { readonly type: "connection"; readonly state: ZiggyConnectionState }
  | { readonly type: "epoch"; readonly epoch: string }
  | { readonly type: "profile.select"; readonly profileId: ZiggyProfileId }
  | { readonly type: "profiles.replace"; readonly profiles: ReadonlyArray<ZiggyProfileSummary> }
  | { readonly type: "session.opened"; readonly session: ZiggySessionShowResult }
  | { readonly type: "history.loaded"; readonly result: ZiggySessionHistoryResult }
  | { readonly type: "event.received"; readonly event: ZiggyGatewayEvent }
  | {
      readonly type: "reconciliation";
      readonly event: Extract<ZiggyClientEvent, { readonly event: "history-reconciliation" }>;
    }
  | {
      readonly type: "pins.replace";
      readonly profileId: ZiggyProfileId;
      readonly pins: ReadonlyArray<ZiggyPin>;
    };

export const initialGatewayState = (
  activeProfileId: ZiggyProfileId | undefined = undefined,
): ZiggyGatewayState => ({
  connection: "connecting",
  epoch: undefined,
  activeProfileId,
  profiles: [],
  conversations: {},
  pins: {},
  reconciliations: [],
});

const keyOfRef = (ref: ZiggySessionRef): string =>
  ref.kind === "live" ? `${ref.profileId}:live:${ref.key}` : `${ref.profileId}:stored:${ref.id}`;

const keyOfEvent = (event: ZiggyGatewayEvent): string =>
  `${event.profileId}:${event.session.kind === "live" ? event.session.key : event.session.id}:${event.eventId}`;

const keyOfReconciliation = (
  event: Extract<ZiggyClientEvent, { readonly event: "history-reconciliation" }>,
): string =>
  [
    event.profileId,
    keyOfRef(event.session),
    event.reason,
    event.previousEpoch ?? "",
    event.previousSequence?.toString() ?? "",
    event.currentEpoch ?? "",
    event.currentSequence?.toString() ?? "",
  ].join(":");

const identityForSession = (
  profileId: ZiggyProfileId,
  ref: ZiggySessionRef,
  agentId: string | undefined,
  context: ZiggyConversationContext | undefined,
): ZiggyConversationIdentity => {
  if (context?.kind === "group") return { profileId, kind: "group", ref, groupId: context.groupId };
  if (agentId !== undefined) return { profileId, kind: "specialist", ref, agentId };
  return { profileId, kind: "main", ref };
};

const titleFor = (identity: ZiggyConversationIdentity): string => {
  if (identity.kind === "specialist") return identity.agentId ?? "Specialist";
  if (identity.kind === "group") return identity.groupId ?? "Group conversation";
  return "Main conversation";
};

const conversationFromSession = (session: ZiggySessionShowResult): ZiggyConversationState => {
  const live = session.live;
  const identity = identityForSession(session.profileId, session.ref, live?.agentId, live?.context);
  const status =
    session.kind === "live"
      ? live?.idle === true
        ? "idle"
        : "working"
      : session.terminalState === "completed"
        ? "idle"
        : "closed";
  return {
    ...identity,
    title: titleFor(identity),
    status,
    events: [],
    history: [],
    cursor: undefined,
    reconciliations: [],
    seenEventIds: [],
  };
};

const sessionStateForEvent = (
  state: ZiggyGatewayState,
  event: ZiggyGatewayEvent,
): ZiggyConversationState => {
  const key = keyOfRef(event.session);
  const existing = state.conversations[key];
  if (existing !== undefined) return existing;
  const liveKey = event.session.kind === "live" ? event.session.key : undefined;
  const identity: ZiggyConversationIdentity = liveKey?.startsWith("local/agents/")
    ? {
        profileId: event.profileId,
        kind: "specialist",
        ref: event.session,
        agentId: liveKey.slice("local/agents/".length),
      }
    : {
        profileId: event.profileId,
        kind: "main",
        ref: event.session,
      };
  return {
    ...identity,
    title: titleFor(identity),
    status: "working",
    events: [],
    history: [],
    cursor: undefined,
    reconciliations: [],
    seenEventIds: [],
  };
};

const sortEvents = (events: ReadonlyArray<ZiggyGatewayEvent>): ReadonlyArray<ZiggyGatewayEvent> =>
  [...events].sort(
    (left, right) =>
      left.epoch.localeCompare(right.epoch) ||
      left.seq - right.seq ||
      left.eventId.localeCompare(right.eventId),
  );

const applyEvent = (state: ZiggyGatewayState, event: ZiggyGatewayEvent): ZiggyGatewayState => {
  if (event.event === "replay-gap") return state;
  const key = keyOfRef(event.session);
  const current = sessionStateForEvent(state, event);
  const eventId = keyOfEvent(event);
  if (current.seenEventIds.includes(eventId)) return state;
  const events = sortEvents([...current.events, event]);
  const seenEventIds = [...current.seenEventIds, eventId].slice(-4_096);
  const nextStatus =
    event.event === "settled" || event.event === "error"
      ? event.event === "error"
        ? "closed"
        : "idle"
      : current.status === "closed"
        ? "working"
        : current.status;
  const next: ZiggyConversationState = {
    ...current,
    status: nextStatus,
    events,
    cursor:
      current.cursor === undefined || current.cursor.epoch !== event.epoch
        ? { epoch: event.epoch, seq: event.seq }
        : { epoch: event.epoch, seq: Math.max(current.cursor.seq, event.seq) },
    seenEventIds,
  };
  return {
    ...state,
    epoch: event.epoch,
    conversations: { ...state.conversations, [key]: next },
  };
};

export const reduceGatewayState = (
  state: ZiggyGatewayState,
  action: ZiggyGatewayAction,
): ZiggyGatewayState => {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "epoch":
      return state.epoch === action.epoch ? state : { ...state, epoch: action.epoch };
    case "profile.select":
      return { ...state, activeProfileId: action.profileId };
    case "profiles.replace":
      return { ...state, profiles: [...action.profiles] };
    case "session.opened": {
      const key = keyOfRef(action.session.ref);
      const current = state.conversations[key];
      const opened = conversationFromSession(action.session);
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [key]:
            current === undefined
              ? opened
              : {
                  ...current,
                  ...opened,
                  events: current.events,
                  history: current.history,
                  cursor: current.cursor,
                  reconciliations: current.reconciliations,
                  seenEventIds: current.seenEventIds,
                },
        },
      };
    }
    case "history.loaded": {
      const key = keyOfRef(action.result.ref);
      const fallback: ZiggyConversationState = {
        profileId: action.result.profileId,
        kind: "main",
        ref: action.result.ref,
        title: "Conversation",
        status: "idle",
        events: [],
        history: [],
        cursor: undefined,
        reconciliations: [],
        seenEventIds: [],
      };
      const current = state.conversations[key] ?? fallback;
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [key]: { ...current, history: [...action.result.entries] },
        },
      };
    }
    case "event.received":
      return applyEvent(state, action.event);
    case "reconciliation": {
      const reconciliationKey = keyOfReconciliation(action.event);
      if (
        state.reconciliations.some(
          (existing) => keyOfReconciliation(existing) === reconciliationKey,
        )
      ) {
        return state;
      }
      const key = keyOfRef(action.event.session);
      const current = state.conversations[key];
      if (current === undefined) {
        return {
          ...state,
          reconciliations: [...state.reconciliations, action.event],
        };
      }
      const next: ZiggyConversationState = {
        ...current,
        reconciliations: [...current.reconciliations, action.event],
      };
      return {
        ...state,
        reconciliations: [...state.reconciliations, action.event],
        conversations: { ...state.conversations, [key]: next },
      };
    }
    case "pins.replace":
      return {
        ...state,
        pins: {
          ...state.pins,
          [action.profileId]: [...action.pins].sort((a, b) => a.order - b.order),
        },
      };
  }
};

export interface ZiggyVisibleEvent {
  readonly id: string;
  readonly profileId: ZiggyProfileId;
  readonly session: ZiggySessionRef;
  readonly kind: "user" | "assistant" | "tool" | "voice" | "error" | "settled";
  readonly text?: string;
  readonly event: ZiggyGatewayEvent;
}

export const visibleEvents = (
  conversation: ZiggyConversationState,
): ReadonlyArray<ZiggyVisibleEvent> => {
  const visible: ZiggyVisibleEvent[] = [];
  for (const event of conversation.events) {
    if (event.event === "replay-gap") continue;
    if (event.event === "assistant-text") {
      visible.push({
        id: keyOfEvent(event),
        profileId: event.profileId,
        session: event.session,
        kind: "assistant",
        text: event.payload.snapshot,
        event,
      });
      continue;
    }
    if (event.event === "thinking") {
      visible.push({
        id: keyOfEvent(event),
        profileId: event.profileId,
        session: event.session,
        kind: "assistant",
        text: event.payload.delta,
        event,
      });
      continue;
    }
    if (event.event === "tool") {
      visible.push({
        id: keyOfEvent(event),
        profileId: event.profileId,
        session: event.session,
        kind: "tool",
        text: event.payload.detail ?? event.payload.toolName,
        event,
      });
      continue;
    }
    if (event.event === "voice") {
      visible.push({
        id: keyOfEvent(event),
        profileId: event.profileId,
        session: event.session,
        kind: "voice",
        text: event.payload.text,
        event,
      });
      continue;
    }
    if (event.event === "error") {
      visible.push({
        id: keyOfEvent(event),
        profileId: event.profileId,
        session: event.session,
        kind: "error",
        text: event.payload.message,
        event,
      });
      continue;
    }
    visible.push({
      id: keyOfEvent(event),
      profileId: event.profileId,
      session: event.session,
      kind: "settled",
      event,
    });
  }
  return visible;
};

const conversationForRef = (
  state: ZiggyGatewayState,
  ref: ZiggySessionRef,
): ZiggyConversationState | undefined => state.conversations[keyOfRef(ref)];

export const selectActiveProfileId = (state: ZiggyGatewayState): ZiggyProfileId | undefined =>
  state.activeProfileId;

export const selectConversation = (
  state: ZiggyGatewayState,
  ref: ZiggySessionRef,
): ZiggyConversationState | undefined => conversationForRef(state, ref);

export const selectVisibleEvents = (
  state: ZiggyGatewayState,
  ref: ZiggySessionRef,
): ReadonlyArray<ZiggyVisibleEvent> => {
  const conversation = conversationForRef(state, ref);
  return conversation === undefined ? [] : visibleEvents(conversation);
};

export const selectProfileConversations = (
  state: ZiggyGatewayState,
  profileId: ZiggyProfileId,
): ReadonlyArray<ZiggyConversationState> =>
  Object.values(state.conversations).filter((conversation) => conversation.profileId === profileId);

export const selectProfileMain = (
  state: ZiggyGatewayState,
  profileId: ZiggyProfileId,
): ZiggyConversationState | undefined =>
  selectProfileConversations(state, profileId).find((conversation) => conversation.kind === "main");

export const selectSpecialist = (
  state: ZiggyGatewayState,
  profileId: ZiggyProfileId,
  agentId: string,
): ZiggyConversationState | undefined =>
  selectProfileConversations(state, profileId).find(
    (conversation) => conversation.kind === "specialist" && conversation.agentId === agentId,
  );

export const projectProfileMain = (
  state: ZiggyGatewayState,
  profileId: ZiggyProfileId,
): ZiggyConversationProjection | undefined => {
  const conversation = selectProfileMain(state, profileId);
  return conversation === undefined ? undefined : projectConversation(conversation);
};

export interface ZiggyConversationProjection {
  readonly id: string;
  readonly profileId: ZiggyProfileId;
  readonly kind: ZiggyConversationKind;
  readonly title: string;
  readonly ref?: ZiggySessionRef;
  readonly members: ReadonlyArray<ZiggySessionRef>;
  readonly history: ReadonlyArray<ZiggySessionHistoryEntry>;
  readonly events: ReadonlyArray<ZiggyVisibleEvent>;
  readonly status: ZiggyConversationState["status"];
}

export const projectConversation = (
  conversation: ZiggyConversationState,
): ZiggyConversationProjection => {
  const projection: ZiggyConversationProjection = {
    id:
      conversation.kind === "group"
        ? `${conversation.profileId}:group:${conversation.groupId ?? "group"}`
        : keyOfRef(
            conversation.ref ?? {
              profileId: conversation.profileId,
              kind: "stored",
              id: "unknown",
            },
          ),
    profileId: conversation.profileId,
    kind: conversation.kind,
    title: conversation.title,
    members: conversation.members ?? (conversation.ref === undefined ? [] : [conversation.ref]),
    history: conversation.history,
    events: visibleEvents(conversation),
    status: conversation.status,
  };
  return conversation.ref === undefined ? projection : { ...projection, ref: conversation.ref };
};

export const projectSpecialist = (
  state: ZiggyGatewayState,
  profileId: ZiggyProfileId,
  agentId: string,
): ZiggyConversationProjection | undefined => {
  const conversation = selectSpecialist(state, profileId, agentId);
  return conversation === undefined ? undefined : projectConversation(conversation);
};

export interface ZiggyGroupProjectionOptions {
  readonly profileId: ZiggyProfileId;
  readonly groupId: string;
  readonly members: ReadonlyArray<ZiggySessionRef>;
  readonly title?: string;
}

export const projectGroup = (
  state: ZiggyGatewayState,
  options: ZiggyGroupProjectionOptions,
): ZiggyConversationProjection => {
  const members = options.members
    .filter((member) => member.profileId === options.profileId)
    .filter(
      (member, index, all) =>
        all.findIndex((candidate) => keyOfRef(candidate) === keyOfRef(member)) === index,
    );
  const memberConversations = members
    .map((member) => conversationForRef(state, member))
    .filter((conversation): conversation is ZiggyConversationState => conversation !== undefined);
  const events = memberConversations
    .flatMap((conversation) => visibleEvents(conversation))
    .sort((left, right) => {
      const leftEvent = left.event;
      const rightEvent = right.event;
      return (
        leftEvent.epoch.localeCompare(rightEvent.epoch) ||
        leftEvent.seq - rightEvent.seq ||
        left.id.localeCompare(right.id)
      );
    });
  const history = memberConversations
    .flatMap((conversation) => conversation.history)
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) || left.kind.localeCompare(right.kind),
    );
  return {
    id: `${options.profileId}:group:${options.groupId}`,
    profileId: options.profileId,
    kind: "group",
    title: options.title ?? options.groupId,
    members: [...members],
    history,
    events,
    status: memberConversations.some((conversation) => conversation.status === "working")
      ? "working"
      : "idle",
  };
};

export const selectGroupConversation = projectGroup;
export const reduce = reduceGatewayState;
export const visibleConversationEvents = visibleEvents;
