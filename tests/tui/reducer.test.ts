import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../packages/protocol/src/index.ts";
import { createInitialState, initialCommands, reduceTui } from "../../packages/tui/src/index.ts";
import {
  MAIN_SUMMARY,
  RESEARCH_SUMMARY,
  envelope,
  loadedState,
  modelChunk,
  modelResponse,
  runActions,
  sessionStarted,
  turnStarted,
} from "./fixtures.ts";

describe("TUI reducer transitions", () => {
  test("boots by ensuring stable main and resumes its canonical history", () => {
    const initial = createInitialState();
    const ensured = reduceTui(initial, { type: "main-ensured", session: MAIN_SUMMARY });

    expect(initialCommands()).toEqual([{ type: "ensure-main" }]);
    expect(ensured.commands).toEqual([
      { type: "resume-session", generation: 1, sessionId: "main", sinceSeq: 0 },
    ]);
    expect(ensured.state.resumeGeneration).toBe(0);
    expect(ensured.state.sessions).toEqual([MAIN_SUMMARY]);

    const admitted = reduceTui(ensured.state, {
      type: "command-admitted",
      command: ensured.commands[0] ?? { type: "ensure-main" },
    });
    expect(admitted.state.resumeGeneration).toBe(1);
  });

  test("maps idle and active submissions to start, steer, follow-up, and interrupt commands", () => {
    const idle = reduceTui(
      { ...loadedState(), composer: "  start here  " },
      { type: "intent", intent: "enter" },
    );
    expect(idle.commands).toEqual([
      {
        type: "start-turn",
        generation: 0,
        request: { sessionId: "main", message: "start here" },
      },
    ]);
    expect(idle.state.composer).toBe("  start here  ");
    expect(
      reduceTui(idle.state, {
        type: "command-admitted",
        command: idle.commands[0] ?? { type: "ensure-main" },
      }).state.composer,
    ).toBe("");

    const activeState = runActions(loadedState(2), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(2, turnStarted()) },
      { type: "composer-changed", value: "change direction" },
    ]);
    const steered = reduceTui(activeState, { type: "intent", intent: "enter" });
    expect(steered.commands).toEqual([
      {
        type: "steer-turn",
        generation: 0,
        request: {
          sessionId: "main",
          expectedTurnId: "turn-1",
          message: "change direction",
        },
      },
    ]);

    const followUp = reduceTui(activeState, { type: "intent", intent: "follow-up" });
    expect(followUp.commands).toEqual([
      {
        type: "queue-follow-up",
        generation: 0,
        request: { sessionId: "main", message: "change direction" },
      },
    ]);

    const interrupted = reduceTui(activeState, { type: "intent", intent: "interrupt" });
    expect(interrupted.commands).toEqual([
      {
        type: "interrupt-turn",
        generation: 0,
        request: { sessionId: "main", expectedTurnId: "turn-1" },
      },
    ]);
  });

  test("lists every Session and resumes the selected Session from canonical sequence zero", () => {
    const listed = reduceTui(loadedState(), {
      type: "sessions-listed",
      sessions: [RESEARCH_SUMMARY, MAIN_SUMMARY],
    }).state;
    const opened = reduceTui(listed, { type: "intent", intent: "sessions" });
    const moved = reduceTui(opened.state, { type: "intent", intent: "move-down" });
    const selected = reduceTui(moved.state, { type: "intent", intent: "enter" });

    expect(opened.commands).toEqual([{ type: "list-sessions" }]);
    expect(opened.state.sessions.map((session) => session.sessionId)).toEqual([
      "main",
      "research-notes",
    ]);
    expect(selected.commands).toEqual([
      { type: "resume-session", generation: 1, sessionId: "research-notes", sinceSeq: 0 },
    ]);
    expect(selected.state.displayed).toEqual(listed.displayed);
    expect(selected.state.resumeGeneration).toBe(0);
    const admitted = reduceTui(selected.state, {
      type: "command-admitted",
      command: selected.commands[0] ?? { type: "ensure-main" },
    });
    expect(admitted.state.displayed).toEqual({ kind: "empty" });
    expect(admitted.state.resumeGeneration).toBe(1);
  });

  test("opens first-response-wins approvals and emits only protocol resolution intent", () => {
    const approvalState = runActions(loadedState(3), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(2, turnStarted()) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(3, {
          type: "approval-requested",
          sessionId: "main",
          turnId: "turn-1",
          approvalId: "approval-1",
          toolCallId: "tool-1",
          prompt: "Allow the shell command?",
          choices: ["approve", "deny"],
        }),
      },
    ]);

    expect(approvalState.overlay).toEqual({
      kind: "approval",
      approvalId: "approval-1",
      prompt: "Allow the shell command?",
      choices: ["approve", "deny"],
      selected: "deny",
    });

    const denied = reduceTui(approvalState, { type: "intent", intent: "deny" });
    expect(denied.commands).toEqual([
      {
        type: "resolve-approval",
        generation: 0,
        request: { sessionId: "main", approvalId: "approval-1", decision: "deny" },
      },
    ]);
    expect(denied.state.overlay).toEqual({ kind: "none" });
  });

  test("quit and Ctrl+C semantics detach without interrupting the active Turn", () => {
    const state = runActions(loadedState(2), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(2, turnStarted()) },
    ]);
    const detached = reduceTui(state, { type: "intent", intent: "detach" });

    expect(detached.commands).toEqual([{ type: "detach" }]);
    expect(detached.commands).not.toContainEqual({
      type: "interrupt-turn",
      request: { sessionId: "main", expectedTurnId: "turn-1" },
    });
  });
});

describe("TUI deterministic replay and races", () => {
  test("buffers gaps, applies contiguous replay, and deduplicates replay/live overlap", () => {
    const started = loadedState(3);
    const turnEnded: SessionEvent = {
      type: "turn-ended",
      sessionId: "main",
      turnId: "turn-1",
      status: "completed",
    };
    const state = runActions(started, [
      { type: "envelope-received", generation: 0, envelope: envelope(3, turnEnded) },
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(2, turnStarted("one message")),
      },
      { type: "envelope-received", generation: 0, envelope: envelope(3, turnEnded) },
    ]);

    expect(state.connection).toEqual({ kind: "live" });
    const projection = state.displayed.kind === "loaded" ? state.displayed.projection : undefined;
    expect(state.displayed.kind).toBe("loaded");
    expect(projection?.lastAppliedSeq).toBe(3);
    expect(projection?.pendingEnvelopes).toEqual([]);
    expect(projection?.transcript).toEqual([
      { kind: "user", turnId: "turn-1", mode: "message", text: "one message" },
    ]);
  });

  test("replaces token deltas with completed protocol text instead of duplicating it", () => {
    const state = runActions(loadedState(5), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(2, turnStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(3, modelChunk("Queue ")) },
      { type: "envelope-received", generation: 0, envelope: envelope(4, modelChunk("is clear.")) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(5, modelResponse("Queue is clear.")),
      },
    ]);

    const projection = state.displayed.kind === "loaded" ? state.displayed.projection : undefined;
    expect(state.displayed.kind).toBe("loaded");
    expect(projection?.transcript).toEqual([
      {
        kind: "user",
        turnId: "turn-1",
        mode: "message",
        text: "Inspect the queue.",
      },
      {
        kind: "assistant",
        turnId: "turn-1",
        stepId: "step-1",
        text: "Queue is clear.",
        streaming: false,
      },
    ]);
  });

  test("keys assistant output by Turn and Step identity", () => {
    const firstChunk = modelChunk("first");
    const secondChunk = { ...firstChunk, turnId: "turn-2", delta: "second" };
    const state = runActions(loadedState(7), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(2, turnStarted("one", "turn-1")),
      },
      { type: "envelope-received", generation: 0, envelope: envelope(3, firstChunk) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(4, {
          type: "turn-ended",
          sessionId: "main",
          turnId: "turn-1",
          status: "completed",
        }),
      },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(5, turnStarted("two", "turn-2")),
      },
      { type: "envelope-received", generation: 0, envelope: envelope(6, secondChunk) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(7, {
          type: "turn-ended",
          sessionId: "main",
          turnId: "turn-2",
          status: "completed",
        }),
      },
    ]);

    const projection = state.displayed.kind === "loaded" ? state.displayed.projection : undefined;
    expect(projection?.transcript.filter((item) => item.kind === "assistant")).toEqual([
      { kind: "assistant", turnId: "turn-1", stepId: "step-1", text: "first", streaming: true },
      { kind: "assistant", turnId: "turn-2", stepId: "step-1", text: "second", streaming: true },
    ]);
  });

  test("retains pending approval across dismiss, picker, reconnect, and remote resolution", () => {
    const requested = runActions(loadedState(3), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(2, turnStarted()) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(3, {
          type: "approval-requested",
          sessionId: "main",
          turnId: "turn-1",
          approvalId: "approval-1",
          toolCallId: "tool-1",
          prompt: "Allow?",
          choices: ["approve", "deny"],
        }),
      },
    ]);
    const dismissed = reduceTui(requested, { type: "intent", intent: "dismiss" }).state;
    expect(dismissed.overlay).toEqual({ kind: "none" });
    expect(dismissed.displayed).toMatchObject({
      kind: "loaded",
      projection: { pendingApproval: { approvalId: "approval-1" } },
    });
    const picker = reduceTui(dismissed, { type: "intent", intent: "sessions" }).state;
    const reopened = reduceTui(picker, { type: "intent", intent: "dismiss" }).state;
    expect(reopened.overlay).toMatchObject({ kind: "approval", approvalId: "approval-1" });

    const retry = reduceTui(reopened, {
      type: "retry-started",
      generation: 0,
      attempt: 1,
    }).state;
    const replayed = reduceTui(retry, {
      type: "replay-started",
      generation: retry.resumeGeneration,
      session: { ...MAIN_SUMMARY, lastSeq: 4, activeTurnId: "turn-1" },
      replayThroughSeq: 4,
    }).state;
    const resolved = reduceTui(replayed, {
      type: "envelope-received",
      generation: replayed.resumeGeneration,
      envelope: envelope(4, {
        type: "approval-resolved",
        sessionId: "main",
        turnId: "turn-1",
        approvalId: "approval-1",
        decision: "deny",
      }),
    }).state;
    expect(resolved.overlay).toEqual({ kind: "none" });
    expect(resolved.displayed).toMatchObject({
      kind: "loaded",
      projection: { pendingApproval: null },
    });
  });

  test("blocks every mutation intent unless the subscription is live", () => {
    const connections = [
      { kind: "connecting" as const },
      { kind: "replaying" as const, throughSeq: 2 },
      { kind: "disconnected" as const, message: "closed" },
      { kind: "retrying" as const, attempt: 1 },
      { kind: "outcome-unknown" as const, message: "unknown" },
    ];
    const intents = ["enter", "follow-up", "interrupt"] as const;
    for (const connection of connections) {
      for (const intent of intents) {
        const blocked = reduceTui(
          { ...loadedState(), connection, composer: "keep me" },
          { type: "intent", intent },
        );
        expect(blocked.commands).toEqual([]);
        expect(blocked.state.composer).toBe("keep me");
        expect(blocked.state.error).toContain("Mutations are unavailable");
      }
    }
  });

  test("restores composer text when a written Turn has an unknown outcome", () => {
    const submitted = reduceTui(
      { ...loadedState(), composer: "send exactly once" },
      { type: "intent", intent: "enter" },
    );
    expect(submitted.state.composer).toBe("send exactly once");
    const admitted = reduceTui(submitted.state, {
      type: "command-admitted",
      command: submitted.commands[0] ?? { type: "ensure-main" },
    });
    expect(admitted.state.composer).toBe("");

    const unknown = reduceTui(admitted.state, {
      type: "outcome-unknown",
      generation: 0,
      message: "Acceptance was not correlated.",
      composer: "send exactly once",
    });
    expect(unknown.commands).toEqual([]);
    expect(unknown.state.connection.kind).toBe("outcome-unknown");
    expect(unknown.state.composer).toBe("send exactly once");
  });

  test("rejects stale A to B to A resume and event callbacks", () => {
    const firstA = reduceTui(createInitialState(), { type: "main-ensured", session: MAIN_SUMMARY });
    const admittedA = reduceTui(firstA.state, {
      type: "command-admitted",
      command: firstA.commands[0] ?? { type: "ensure-main" },
    }).state;
    const listed = reduceTui(admittedA, {
      type: "sessions-listed",
      sessions: [MAIN_SUMMARY, RESEARCH_SUMMARY],
    }).state;
    const picker = reduceTui(listed, { type: "intent", intent: "sessions" }).state;
    const moved = reduceTui(picker, { type: "intent", intent: "move-down" }).state;
    const selectedB = reduceTui(moved, { type: "intent", intent: "enter" });
    const admittedB = reduceTui(selectedB.state, {
      type: "command-admitted",
      command: selectedB.commands[0] ?? { type: "ensure-main" },
    }).state;
    const generationB = admittedB.resumeGeneration;
    const resumedB = reduceTui(admittedB, {
      type: "replay-started",
      generation: generationB,
      session: RESEARCH_SUMMARY,
      replayThroughSeq: 0,
    }).state;
    const listedAgain = reduceTui(resumedB, { type: "intent", intent: "sessions" }).state;
    const movedToA = reduceTui(listedAgain, { type: "intent", intent: "move-up" }).state;
    const selectedA = reduceTui(movedToA, { type: "intent", intent: "enter" });
    const admittedA2 = reduceTui(selectedA.state, {
      type: "command-admitted",
      command: selectedA.commands[0] ?? { type: "ensure-main" },
    }).state;
    const generationA2 = admittedA2.resumeGeneration;
    const staleResume = reduceTui(admittedA2, {
      type: "replay-started",
      generation: generationB,
      session: RESEARCH_SUMMARY,
      replayThroughSeq: 0,
    }).state;
    const staleEvent = reduceTui(staleResume, {
      type: "envelope-received",
      generation: generationB,
      envelope: envelope(1, sessionStarted("research-notes")),
    }).state;
    const staleDisconnect = reduceTui(staleEvent, {
      type: "connection-lost",
      generation: generationB,
      message: "stale socket callback",
    }).state;
    const staleFailure = reduceTui(staleDisconnect, {
      type: "failure",
      generation: generationB,
      message: "stale command callback",
    }).state;
    expect(generationA2).toBeGreaterThan(generationB);
    expect(staleFailure).toEqual(admittedA2);
  });

  test("preserves displayed history across reconnect and advances only from the last sequence", () => {
    const beforeDisconnect = runActions(loadedState(3), [
      { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
      { type: "envelope-received", generation: 0, envelope: envelope(2, turnStarted()) },
      {
        type: "envelope-received",
        generation: 0,
        envelope: envelope(3, modelChunk("Still working")),
      },
    ]);
    const reconnecting = runActions(beforeDisconnect, [
      { type: "connection-lost", generation: 0, message: "Socket closed" },
      { type: "retry-started", generation: 0, attempt: 1 },
      {
        type: "replay-started",
        generation: 0,
        session: { ...MAIN_SUMMARY, lastSeq: 5, activeTurnId: "turn-1" },
        replayThroughSeq: 5,
      },
      { type: "envelope-received", generation: 0, envelope: envelope(3, modelChunk("duplicate")) },
      { type: "envelope-received", generation: 0, envelope: envelope(5, modelChunk(".")) },
      { type: "envelope-received", generation: 0, envelope: envelope(4, modelChunk(" safely")) },
    ]);

    const projection =
      reconnecting.displayed.kind === "loaded" ? reconnecting.displayed.projection : undefined;
    expect(reconnecting.connection).toEqual({ kind: "live" });
    expect(reconnecting.displayed.kind).toBe("loaded");
    expect(projection?.lastAppliedSeq).toBe(5);
    expect(projection?.transcript.at(-1)).toMatchObject({
      kind: "assistant",
      text: "Still working safely.",
    });

    const staleList = reduceTui(reconnecting, {
      type: "sessions-listed",
      sessions: [MAIN_SUMMARY, RESEARCH_SUMMARY],
    }).state;
    expect(staleList.sessions.find((session) => session.sessionId === "main")).toMatchObject({
      lastSeq: 5,
      activeTurnId: "turn-1",
    });
  });
});
