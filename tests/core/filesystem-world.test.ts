import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemWorld } from "../../packages/core/src/index.ts";
import { decodeSessionEnvelope, type SessionEvent } from "../../packages/protocol/src/index.ts";
import {
  defineContractTests,
  type ContractWorld,
  type MemoryCommitCutPoint,
  type MemoryExpectation,
} from "../testkit/world/contract.ts";
import { defineFilesystemWorldScenarios } from "../testkit/world/filesystem-scenarios.ts";

const profiles: string[] = [];
const fixtures: readonly [SessionEvent, SessionEvent, SessionEvent] = [
  {
    type: "session-started",
    sessionId: "session-a",
    snapshot: { systemPrompt: "fixture prompt", tools: [] },
  },
  {
    type: "step-started",
    sessionId: "session-a",
    turnId: "turn-1",
    stepId: "step-1",
    provider: "anthropic",
    model: "claude-test",
  },
  {
    type: "turn-ended",
    sessionId: "session-a",
    turnId: "turn-1",
    status: "completed",
  },
];

defineContractTests("@ziggy/core filesystem specimen", {
  eventValidator: { decode: decodeFixtureEvent },
  supportsTornSessionTail: true,
  validEventFixtures: fixtures,
  expectedEvents: fixtures,
  invalidEvent: { type: "not-a-session-event" },
  create() {
    const profile = mkdtempSync(join(tmpdir(), "ziggy-s1-world-contract-"));
    profiles.push(profile);
    let fault: MemoryCommitCutPoint | undefined;
    const controls = createContractControls((point) => {
      if (point === fault) {
        fault = undefined;
        throw new Error(`injected ${point} fault`);
      }
    });
    return {
      world: openContractWorld(profile, controls),
      failNextMemoryBatch(cutPoint) {
        fault = cutPoint;
      },
      async injectTornSessionTail(sessionId) {
        await appendFile(join(profile, "sessions", `${sessionId}.ndjson`), '{"schemaVersion":1');
      },
      reopen() {
        return openContractWorld(profile, controls);
      },
    };
  },
});

defineFilesystemWorldScenarios(
  "@ziggy/core filesystem World",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "ziggy-s1-world-"));
    profiles.push(profile);
    return profile;
  },
  {
    supportsSymlinks: process.platform !== "win32",
    open(profilePath, controls) {
      return createFilesystemWorld({
        profilePath,
        now: controls.now,
        nextTemporaryId: controls.nextTemporaryId,
        onMemoryCommitPoint: controls.onMemoryCommitPoint,
        onMemoryRecoveryPoint: controls.onMemoryRecoveryPoint,
        onSessionAppendPoint: controls.onSessionAppendPoint,
      });
    },
  },
);

afterAll(async () => {
  await Promise.all(profiles.map((profile) => rm(profile, { force: true, recursive: true })));
});

function openContractWorld(
  profilePath: string,
  controls: ReturnType<typeof createContractControls>,
): ContractWorld<SessionEvent> {
  const world = createFilesystemWorld({
    profilePath,
    now: controls.now,
    nextTemporaryId: controls.nextTemporaryId,
    onMemoryCommitPoint: controls.onMemoryCommitPoint,
    onMemoryRecoveryPoint: controls.onMemoryRecoveryPoint,
    onSessionAppendPoint: controls.onSessionAppendPoint,
  });
  return {
    appendSession(sessionId, event) {
      return world.appendSession(sessionId, withSessionId(decodeFixtureEvent(event), sessionId));
    },
    readSession(sessionId, afterSeq) {
      return world.readSession(sessionId, afterSeq);
    },
    listSessions() {
      return world.listSessions();
    },
    readMemory(document) {
      return world.readMemory(document);
    },
    replaceMemoryBatch(replacements, expected?: ReadonlyArray<MemoryExpectation>) {
      return world.replaceMemoryBatch(replacements, expected);
    },
  };
}

function createContractControls(observer: (point: MemoryCommitCutPoint) => void): {
  readonly now: () => Date;
  readonly nextTemporaryId: () => string;
  readonly onMemoryCommitPoint: (point: MemoryCommitCutPoint) => Promise<void>;
  readonly onMemoryRecoveryPoint: () => Promise<void>;
  readonly onSessionAppendPoint: () => Promise<void>;
} {
  let milliseconds = Date.parse("2026-07-19T00:00:00.000Z");
  let temporaryId = 0;
  return {
    now() {
      const value = new Date(milliseconds);
      milliseconds += 1;
      return value;
    },
    nextTemporaryId() {
      temporaryId += 1;
      return `contract-${temporaryId}`;
    },
    async onMemoryCommitPoint(point) {
      observer(point);
    },
    async onMemoryRecoveryPoint() {},
    async onSessionAppendPoint() {},
  };
}

function decodeFixtureEvent(value: unknown): SessionEvent {
  const frame = `${JSON.stringify({
    schemaVersion: 1,
    seq: 1,
    emittedAt: "2026-07-19T00:00:00.000Z",
    event: value,
  })}\n`;
  return decodeSessionEnvelope(frame).event;
}

function withSessionId(event: SessionEvent, sessionId: string): SessionEvent {
  return { ...event, sessionId };
}
