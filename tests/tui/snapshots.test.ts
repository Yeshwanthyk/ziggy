import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInitialState,
  reduceTui,
  renderedWidth,
  renderTui,
  type TerminalViewport,
  type TuiAction,
  type TuiState,
} from "../../packages/tui/src/index.ts";
import {
  MAIN_SUMMARY,
  RESEARCH_SUMMARY,
  envelope,
  loadedState,
  modelChunk,
  runActions,
  sessionStarted,
  turnStarted,
} from "./fixtures.ts";

interface SnapshotScenario {
  readonly name: string;
  readonly viewport: TerminalViewport;
  readonly state: TuiState;
}

const streaming = runActions(loadedState(4), [
  { type: "envelope-received", generation: 0, envelope: envelope(1, sessionStarted()) },
  {
    type: "envelope-received",
    generation: 0,
    envelope: envelope(2, turnStarted("Check the resident queue.")),
  },
  {
    type: "envelope-received",
    generation: 0,
    envelope: envelope(3, {
      type: "step-started",
      sessionId: "main",
      turnId: "turn-1",
      stepId: "step-1",
      provider: "anthropic",
      model: "claude-sonnet",
    }),
  },
  {
    type: "envelope-received",
    generation: 0,
    envelope: envelope(4, modelChunk("The daemon is healthy; two jobs remain in the queue.")),
  },
  { type: "composer-changed", value: "prioritize the database check" },
]);

const picker = runActions(streaming, [
  { type: "sessions-listed", sessions: [RESEARCH_SUMMARY, MAIN_SUMMARY] },
  { type: "intent", intent: "sessions" },
  { type: "intent", intent: "move-down" },
]);

const approval = runActions(streaming, [
  {
    type: "envelope-received",
    generation: 0,
    envelope: envelope(5, {
      type: "approval-requested",
      sessionId: "main",
      turnId: "turn-1",
      approvalId: "approval-1",
      toolCallId: "call-1",
      prompt: "Run `bun test tests/tui` in the Profile?",
      choices: ["approve", "deny"],
    }),
  },
]);

const reconnect = runActions(streaming, [
  { type: "connection-lost", generation: 0, message: "Daemon connection closed" },
  { type: "retry-started", generation: 0, attempt: 1 },
  {
    type: "replay-started",
    generation: 0,
    session: { ...MAIN_SUMMARY, lastSeq: 6, activeTurnId: "turn-1" },
    replayThroughSeq: 6,
  },
]);

const error = runActions(loadedState(), [
  { type: "failure", message: "Session replay stopped at a non-contiguous sequence." },
]);

const scenarios: ReadonlyArray<SnapshotScenario> = [
  { name: "idle", viewport: { columns: 88, rows: 16 }, state: loadedState() },
  { name: "streaming", viewport: { columns: 88, rows: 18 }, state: streaming },
  { name: "picker", viewport: { columns: 88, rows: 18 }, state: picker },
  { name: "approval", viewport: { columns: 88, rows: 18 }, state: approval },
  { name: "reconnect", viewport: { columns: 88, rows: 18 }, state: reconnect },
  { name: "narrow", viewport: { columns: 36, rows: 16 }, state: streaming },
  { name: "error", viewport: { columns: 72, rows: 14 }, state: error },
  {
    name: "empty",
    viewport: { columns: 72, rows: 12 },
    state: reduceTui(createInitialState(), {
      type: "connection-lost",
      generation: 0,
      message: "Daemon unavailable",
    }).state,
  },
];

const snapshotDirectory = join(import.meta.dir, "snapshots");

describe("scripted resident-console terminal snapshots", () => {
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const lines = renderTui(scenario.state, scenario.viewport);
      const rendered = `${lines.join("\n")}\n`;
      const path = join(snapshotDirectory, `${scenario.name}.txt`);

      expect(lines.length).toBeLessThanOrEqual(scenario.viewport.rows);
      expect(lines.every((line) => renderedWidth(line) <= scenario.viewport.columns)).toBe(true);

      if (Bun.env.UPDATE_TUI_SNAPSHOTS === "1") writeFileSync(path, rendered);
      expect(readFileSync(path, "utf8")).toBe(rendered);
    });
  }
});

const actionVocabulary: ReadonlyArray<TuiAction["type"]> = [
  "main-ensured",
  "sessions-listed",
  "replay-started",
  "envelope-received",
  "composer-changed",
  "intent",
  "connection-lost",
  "retry-started",
  "outcome-unknown",
  "failure",
  "clear-error",
];

expect(actionVocabulary).toHaveLength(11);
