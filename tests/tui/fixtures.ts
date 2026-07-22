import type {
  SessionEnvelope,
  SessionEvent,
  SessionSummary,
} from "../../packages/protocol/src/index.ts";
import {
  createInitialState,
  reduceTui,
  type TuiAction,
  type TuiState,
} from "../../packages/tui/src/index.ts";

export const MAIN_SUMMARY: SessionSummary = {
  sessionId: "main",
  createdAt: "2026-07-21T09:00:00.000Z",
  lastSeq: 0,
};

export const RESEARCH_SUMMARY: SessionSummary = {
  sessionId: "research-notes",
  createdAt: "2026-07-21T10:00:00.000Z",
  lastSeq: 12,
};

export function envelope(seq: number, event: SessionEvent): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq,
    emittedAt: "2026-07-21T09:00:00.000Z",
    event,
  };
}

export function sessionStarted(sessionId = "main"): SessionEvent {
  return {
    type: "session-started",
    sessionId,
    snapshot: { systemPrompt: "You are Ziggy.", tools: [] },
  };
}

export function turnStarted(message = "Inspect the queue.", turnId = "turn-1"): SessionEvent {
  return {
    type: "turn-started",
    sessionId: "main",
    turnId,
    message,
    origin: "user",
  };
}

export function modelChunk(delta: string, seqStep = "step-1"): SessionEvent {
  return {
    type: "model-chunk",
    sessionId: "main",
    turnId: "turn-1",
    stepId: seqStep,
    contentIndex: 0,
    kind: "text",
    delta,
  };
}

export function modelResponse(text: string): SessionEvent {
  return {
    type: "model-response",
    sessionId: "main",
    turnId: "turn-1",
    stepId: "step-1",
    response: {
      api: "fixture",
      provider: "fixture",
      model: "fixture-model",
      content: [{ type: "text", text }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
      },
      stopReason: "stop",
      timestamp: 1,
    },
  };
}

export function loadedState(replayThroughSeq = 0): TuiState {
  return runActions(createInitialState(), [
    { type: "replay-started", generation: 0, session: MAIN_SUMMARY, replayThroughSeq },
  ]);
}

export function runActions(initial: TuiState, actions: ReadonlyArray<TuiAction>): TuiState {
  return actions.reduce((state, action) => reduceTui(state, action).state, initial);
}
