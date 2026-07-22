import type { ApprovalDecision, FinalModelResponse, SessionEnvelope } from "@ziggy/protocol";
import type {
  ApprovalOverlay,
  ConnectionState,
  OverlayState,
  SessionProjection,
  TranscriptItem,
  TuiAction,
  TuiCommand,
  TuiIntent,
  TuiState,
  TuiTransition,
  TurnState,
} from "./model.ts";

export function reduceTui(state: TuiState, action: TuiAction): TuiTransition {
  switch (action.type) {
    case "main-ensured": {
      const generation = state.resumeGeneration + 1;
      return transition(
        {
          ...state,
          sessions: mergeSession(state.sessions, action.session),
          error: null,
        },
        [
          {
            type: "resume-session",
            generation,
            sessionId: action.session.sessionId,
            sinceSeq: 0,
          },
        ],
      );
    }
    case "sessions-listed":
      return transition({
        ...state,
        sessions: listedSessions(state, action.sessions),
        error: null,
      });
    case "replay-started": {
      if (action.generation !== state.resumeGeneration) return transition(state);
      const existing =
        state.displayed.kind === "loaded" &&
        state.displayed.projection.summary.sessionId === action.session.sessionId
          ? state.displayed.projection
          : undefined;
      const projection: SessionProjection = existing ?? {
        summary: action.session,
        lastAppliedSeq: 0,
        pendingEnvelopes: [],
        transcript: [],
        turn: activeTurnFrom(action.session),
        pendingApproval: null,
      };
      const connection: ConnectionState =
        projection.lastAppliedSeq >= action.replayThroughSeq
          ? { kind: "live" }
          : { kind: "replaying", throughSeq: action.replayThroughSeq };
      return transition({
        ...state,
        connection,
        displayed: {
          kind: "loaded",
          projection: {
            ...projection,
            summary: summaryWith(action.session, projection.lastAppliedSeq, projection.turn),
          },
        },
        sessions: mergeSession(state.sessions, action.session),
        error: null,
      });
    }
    case "envelope-received":
      return action.generation === state.resumeGeneration
        ? transition(applyEnvelope(state, action.envelope))
        : transition(state);
    case "composer-changed":
      return transition({ ...state, composer: action.value });
    case "command-admitted":
      return admitCommand(state, action.command);
    case "intent":
      return applyIntent(state, action.intent);
    case "connection-lost":
      return action.generation === state.resumeGeneration
        ? transition({
            ...state,
            connection: { kind: "disconnected", message: action.message },
          })
        : transition(state);
    case "retry-started":
      return action.generation === state.resumeGeneration
        ? transition({
            ...state,
            connection: { kind: "retrying", attempt: action.attempt },
            error: null,
          })
        : transition(state);
    case "outcome-unknown":
      return action.generation === state.resumeGeneration
        ? transition({
            ...state,
            connection: { kind: "outcome-unknown", message: action.message },
            composer: action.composer,
            error: action.message,
          })
        : transition(state);
    case "failure":
      return action.generation === undefined || action.generation === state.resumeGeneration
        ? transition({ ...state, error: action.message })
        : transition(state);
    case "clear-error":
      return transition({ ...state, error: null });
  }
}

function applyIntent(state: TuiState, intent: TuiIntent): TuiTransition {
  if (intent === "detach") {
    return transition(state, [{ type: "detach" }]);
  }
  if (intent === "dismiss") {
    if (state.overlay.kind === "none") return transition(state);
    if (state.overlay.kind === "sessions") {
      const pending = pendingApproval(state);
      return transition({ ...state, overlay: pending ?? { kind: "none" } });
    }
    return transition({ ...state, overlay: { kind: "none" } });
  }
  if (intent === "sessions") {
    const selectedIndex = selectedSessionIndex(state);
    return transition({ ...state, overlay: { kind: "sessions", selectedIndex }, error: null }, [
      { type: "list-sessions" },
    ]);
  }
  if (intent === "move-up" || intent === "move-down") {
    return movePicker(state, intent === "move-up" ? -1 : 1);
  }
  if (intent === "approve" || intent === "deny") {
    return resolveApproval(state, intent);
  }
  if (intent === "enter" && state.overlay.kind === "sessions") {
    return selectSession(state);
  }
  if (intent === "enter" && state.overlay.kind === "approval") {
    return emitApproval(state, state.overlay);
  }
  if (intent === "interrupt") {
    return interrupt(state);
  }
  if (intent === "follow-up") {
    return submitFollowUp(state);
  }
  if (intent === "enter") {
    return submitComposer(state);
  }
  return transition(state);
}

function submitComposer(state: TuiState): TuiTransition {
  const blocked = mutationBlocked(state);
  if (blocked !== undefined) return blocked;
  const context = submissionContext(state);
  if (context === undefined) return transition(state);
  if (context.turn.kind === "active") {
    return transition(state, [
      {
        type: "steer-turn",
        generation: state.resumeGeneration,
        request: {
          sessionId: context.sessionId,
          expectedTurnId: context.turn.turnId,
          message: context.message,
        },
      },
    ]);
  }
  return transition(state, [
    {
      type: "start-turn",
      generation: state.resumeGeneration,
      request: { sessionId: context.sessionId, message: context.message },
    },
  ]);
}

function submitFollowUp(state: TuiState): TuiTransition {
  const blocked = mutationBlocked(state);
  if (blocked !== undefined) return blocked;
  const context = submissionContext(state);
  if (context === undefined) return transition(state);
  if (context.turn.kind !== "active") {
    return transition({ ...state, error: "A follow-up needs an active Turn." });
  }
  return transition(state, [
    {
      type: "queue-follow-up",
      generation: state.resumeGeneration,
      request: { sessionId: context.sessionId, message: context.message },
    },
  ]);
}

function submissionContext(
  state: TuiState,
): { readonly sessionId: string; readonly message: string; readonly turn: TurnState } | undefined {
  const message = state.composer.trim();
  if (message.length === 0 || state.displayed.kind !== "loaded") return undefined;
  return {
    sessionId: state.displayed.projection.summary.sessionId,
    message,
    turn: state.displayed.projection.turn,
  };
}

function interrupt(state: TuiState): TuiTransition {
  const blocked = mutationBlocked(state);
  if (blocked !== undefined) return blocked;
  if (state.displayed.kind !== "loaded") return transition(state);
  const projection = state.displayed.projection;
  if (projection.turn.kind !== "active") return transition(state);
  const turnId = projection.turn.turnId;
  return transition(state, [
    {
      type: "interrupt-turn",
      generation: state.resumeGeneration,
      request: {
        sessionId: projection.summary.sessionId,
        expectedTurnId: turnId,
      },
    },
  ]);
}

function movePicker(state: TuiState, delta: number): TuiTransition {
  if (state.overlay.kind !== "sessions" || state.sessions.length === 0) return transition(state);
  const selectedIndex = Math.min(
    state.sessions.length - 1,
    Math.max(0, state.overlay.selectedIndex + delta),
  );
  return transition({ ...state, overlay: { kind: "sessions", selectedIndex } });
}

function selectSession(state: TuiState): TuiTransition {
  if (state.overlay.kind !== "sessions") return transition(state);
  const session = state.sessions[state.overlay.selectedIndex];
  if (session === undefined) {
    return transition({ ...state, overlay: { kind: "none" } });
  }
  const currentId =
    state.displayed.kind === "loaded" ? state.displayed.projection.summary.sessionId : undefined;
  if (currentId === session.sessionId) {
    return transition({ ...state, overlay: { kind: "none" } });
  }
  const generation = state.resumeGeneration + 1;
  return transition(state, [
    { type: "resume-session", generation, sessionId: session.sessionId, sinceSeq: 0 },
  ]);
}

function admitCommand(state: TuiState, command: TuiCommand): TuiTransition {
  switch (command.type) {
    case "resume-session":
      if (command.generation !== state.resumeGeneration + 1) return transition(state);
      return transition({
        ...state,
        connection: { kind: "connecting" },
        displayed: { kind: "empty" },
        overlay: { kind: "none" },
        resumeGeneration: command.generation,
        error: null,
      });
    case "start-turn":
    case "steer-turn":
    case "queue-follow-up":
      return command.generation === state.resumeGeneration
        ? transition({ ...state, composer: "", error: null })
        : transition(state);
    case "ensure-main":
    case "list-sessions":
    case "interrupt-turn":
    case "resolve-approval":
    case "detach":
      return transition(state);
  }
}

function resolveApproval(state: TuiState, decision: ApprovalDecision): TuiTransition {
  if (state.overlay.kind !== "approval" || !state.overlay.choices.includes(decision)) {
    return transition(state);
  }
  return emitApproval(state, { ...state.overlay, selected: decision });
}

function emitApproval(state: TuiState, overlay: ApprovalOverlay): TuiTransition {
  const blocked = mutationBlocked(state);
  if (blocked !== undefined) return blocked;
  if (state.displayed.kind !== "loaded") return transition(state);
  return transition({ ...state, overlay: { kind: "none" }, error: null }, [
    {
      type: "resolve-approval",
      generation: state.resumeGeneration,
      request: {
        sessionId: state.displayed.projection.summary.sessionId,
        approvalId: overlay.approvalId,
        decision: overlay.selected,
      },
    },
  ]);
}

function applyEnvelope(state: TuiState, envelope: SessionEnvelope): TuiState {
  if (
    state.displayed.kind !== "loaded" ||
    envelope.event.sessionId !== state.displayed.projection.summary.sessionId
  ) {
    return state;
  }
  const projection = state.displayed.projection;
  if (
    envelope.seq <= projection.lastAppliedSeq ||
    projection.pendingEnvelopes.some((pending) => pending.seq === envelope.seq)
  ) {
    return state;
  }
  if (envelope.seq > projection.lastAppliedSeq + 1) {
    const pendingEnvelopes = [...projection.pendingEnvelopes, envelope].sort(
      (left, right) => left.seq - right.seq,
    );
    return withProjection(state, { ...projection, pendingEnvelopes });
  }

  let next = applyContiguous(state, envelope);
  while (next.displayed.kind === "loaded") {
    const first = next.displayed.projection.pendingEnvelopes[0];
    if (first === undefined || first.seq !== next.displayed.projection.lastAppliedSeq + 1) break;
    next = applyContiguous(next, first);
  }
  return finishReplay(next);
}

function applyContiguous(state: TuiState, envelope: SessionEnvelope): TuiState {
  if (state.displayed.kind !== "loaded") return state;
  const current = state.displayed.projection;
  const pendingEnvelopes = current.pendingEnvelopes.filter(
    (pending) => pending.seq !== envelope.seq,
  );
  const applied = projectEvent(current, envelope);
  const projection: SessionProjection = {
    ...applied.projection,
    lastAppliedSeq: envelope.seq,
    pendingEnvelopes,
    summary: summaryWith(applied.projection.summary, envelope.seq, applied.projection.turn),
  };
  const overlay: OverlayState =
    envelope.event.type === "approval-resolved" &&
    state.overlay.kind === "approval" &&
    state.overlay.approvalId === envelope.event.approvalId
      ? { kind: "none" }
      : (applied.overlay ?? state.overlay);
  return {
    ...state,
    displayed: { kind: "loaded", projection },
    sessions: mergeSession(state.sessions, projection.summary),
    overlay,
    error: applied.error === undefined ? state.error : applied.error,
  };
}

function projectEvent(
  projection: SessionProjection,
  envelope: SessionEnvelope,
): {
  readonly projection: SessionProjection;
  readonly overlay?: OverlayState;
  readonly error?: string | null;
} {
  const event = envelope.event;
  switch (event.type) {
    case "session-started":
      return { projection };
    case "turn-started":
      return {
        projection: {
          ...projection,
          turn: { kind: "active", turnId: event.turnId },
          transcript: appendUser(projection.transcript, {
            kind: "user",
            turnId: event.turnId,
            mode: event.origin === "follow-up" ? "follow-up" : "message",
            text: event.message,
          }),
        },
      };
    case "step-started":
      return {
        projection: {
          ...projection,
          turn: { kind: "active", turnId: event.turnId, model: event.model },
        },
      };
    case "model-chunk":
      return event.kind === "text"
        ? {
            projection: {
              ...projection,
              transcript: updateAssistant(
                projection.transcript,
                event.turnId,
                event.stepId,
                (text) => `${text}${event.delta}`,
                true,
              ),
            },
          }
        : { projection };
    case "model-response": {
      const completed = responseText(event.response);
      return {
        projection: {
          ...projection,
          transcript: updateAssistant(
            projection.transcript,
            event.turnId,
            event.stepId,
            (text) => (completed.length === 0 ? text : completed),
            false,
          ),
        },
      };
    }
    case "tool-call":
      return {
        projection: {
          ...projection,
          transcript: appendActivity(
            projection.transcript,
            event.turnId,
            `Tool requested · ${event.toolName}`,
            "normal",
          ),
        },
      };
    case "tool-result":
      return event.isError
        ? {
            projection: {
              ...projection,
              transcript: appendActivity(
                projection.transcript,
                event.turnId,
                "Tool returned an error",
                "error",
              ),
            },
          }
        : { projection };
    case "step-ended":
      return { projection };
    case "turn-ended": {
      const transcript =
        event.status === "completed"
          ? projection.transcript
          : appendActivity(
              projection.transcript,
              event.turnId,
              event.status === "failed" ? "Turn failed" : "Turn interrupted",
              event.status === "failed" ? "error" : "normal",
            );
      return { projection: { ...projection, turn: { kind: "idle" }, transcript } };
    }
    case "steer-received":
      return {
        projection: {
          ...projection,
          transcript: appendUser(projection.transcript, {
            kind: "user",
            turnId: event.turnId,
            mode: "steer",
            text: event.message,
          }),
        },
      };
    case "follow-up-received":
      return {
        projection: {
          ...projection,
          transcript: appendActivity(
            projection.transcript,
            event.turnId,
            `Follow-up queued · ${event.message}`,
            "normal",
          ),
        },
      };
    case "interrupt-received":
      return {
        projection: {
          ...projection,
          transcript: appendActivity(
            projection.transcript,
            event.turnId,
            "Interrupt requested",
            "normal",
          ),
        },
      };
    case "approval-requested": {
      const selected = firstDecision(event.choices);
      if (selected === undefined) {
        return { projection, error: "Approval request had no supported decision." };
      }
      const approval: ApprovalOverlay = {
        kind: "approval",
        approvalId: event.approvalId,
        prompt: event.prompt,
        choices: event.choices,
        selected,
      };
      return {
        projection: { ...projection, pendingApproval: approval },
        overlay: approval,
      };
    }
    case "approval-resolved":
      return {
        projection: {
          ...projection,
          pendingApproval:
            projection.pendingApproval?.approvalId === event.approvalId
              ? null
              : projection.pendingApproval,
          transcript: appendActivity(
            projection.transcript,
            event.turnId,
            `Approval ${event.decision === "approve" ? "approved" : "denied"}`,
            "normal",
          ),
        },
      };
  }
}

function finishReplay(state: TuiState): TuiState {
  if (
    state.connection.kind === "replaying" &&
    state.displayed.kind === "loaded" &&
    state.displayed.projection.lastAppliedSeq >= state.connection.throughSeq
  ) {
    return { ...state, connection: { kind: "live" } };
  }
  return state;
}

function responseText(response: FinalModelResponse): string {
  return response.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("");
}

function updateAssistant(
  transcript: ReadonlyArray<TranscriptItem>,
  turnId: string,
  stepId: string,
  update: (text: string) => string,
  streaming: boolean,
): ReadonlyArray<TranscriptItem> {
  let found = false;
  const updated = transcript.map((item): TranscriptItem => {
    if (item.kind !== "assistant" || item.turnId !== turnId || item.stepId !== stepId) return item;
    found = true;
    return { ...item, text: update(item.text), streaming };
  });
  return found
    ? updated
    : [...updated, { kind: "assistant", turnId, stepId, text: update(""), streaming }];
}

function appendUser(
  transcript: ReadonlyArray<TranscriptItem>,
  item: Extract<TranscriptItem, { readonly kind: "user" }>,
): ReadonlyArray<TranscriptItem> {
  return [...transcript, item];
}

function appendActivity(
  transcript: ReadonlyArray<TranscriptItem>,
  turnId: string,
  text: string,
  tone: "normal" | "error",
): ReadonlyArray<TranscriptItem> {
  return [...transcript, { kind: "activity", turnId, text, tone }];
}

function firstDecision(choices: ReadonlyArray<ApprovalDecision>): ApprovalDecision | undefined {
  return choices.includes("deny") ? "deny" : choices.includes("approve") ? "approve" : undefined;
}

function summaryWith(summary: SessionProjection["summary"], seq: number, turn: TurnState) {
  const base = {
    sessionId: summary.sessionId,
    createdAt: summary.createdAt,
    lastSeq: Math.max(summary.lastSeq, seq),
  };
  return turn.kind === "active" ? { ...base, activeTurnId: turn.turnId } : base;
}

function activeTurnFrom(summary: SessionProjection["summary"]): TurnState {
  return summary.activeTurnId === undefined
    ? { kind: "idle" }
    : { kind: "active", turnId: summary.activeTurnId };
}

function selectedSessionIndex(state: TuiState): number {
  if (state.displayed.kind !== "loaded") return 0;
  const sessionId = state.displayed.projection.summary.sessionId;
  const index = state.sessions.findIndex((session) => session.sessionId === sessionId);
  return index < 0 ? 0 : index;
}

function listedSessions(
  state: TuiState,
  sessions: ReadonlyArray<SessionProjection["summary"]>,
): ReadonlyArray<SessionProjection["summary"]> {
  if (state.displayed.kind !== "loaded") return sortSessions(sessions);
  const current = state.displayed.projection.summary;
  const listedCurrent = sessions.find((session) => session.sessionId === current.sessionId);
  if (listedCurrent === undefined || listedCurrent.lastSeq <= current.lastSeq) {
    return mergeSession(sessions, current);
  }
  return sortSessions(sessions);
}

function mergeSession(
  sessions: ReadonlyArray<SessionProjection["summary"]>,
  session: SessionProjection["summary"],
): ReadonlyArray<SessionProjection["summary"]> {
  return sortSessions([
    ...sessions.filter((candidate) => candidate.sessionId !== session.sessionId),
    session,
  ]);
}

function sortSessions(
  sessions: ReadonlyArray<SessionProjection["summary"]>,
): ReadonlyArray<SessionProjection["summary"]> {
  return [...sessions].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}

function withProjection(state: TuiState, projection: SessionProjection): TuiState {
  return { ...state, displayed: { kind: "loaded", projection } };
}

function pendingApproval(state: TuiState): ApprovalOverlay | undefined {
  return state.displayed.kind === "loaded"
    ? (state.displayed.projection.pendingApproval ?? undefined)
    : undefined;
}

function mutationBlocked(state: TuiState): TuiTransition | undefined {
  if (state.connection.kind === "live") return undefined;
  const label = state.connection.kind.replace("-", " ");
  return transition({
    ...state,
    error: `Mutations are unavailable while ${label}. Composer text was preserved.`,
  });
}

function transition(state: TuiState, commands: ReadonlyArray<TuiCommand> = []): TuiTransition {
  return { state, commands };
}
