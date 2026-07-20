import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemWorld,
  MEMORY_DOCUMENT_LIMIT,
  MEMORY_ENTRY_DELIMITER,
  openSession,
  runMemoryTool,
  type FilesystemWorld,
} from "../../packages/core/src/index.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  type FaultScheduleObservation,
} from "../testkit/verification-observations.ts";

test("S1 Memory batches persist atomically, reject caps, and refresh only at Session start", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-s1-scenario-memory-"));
  try {
    let temporaryId = 0;
    let millisecond = 0;
    const commitPoints: string[] = [];
    const world = createFilesystemWorld({
      profilePath: profile,
      now: () => new Date(Date.parse("2026-07-19T00:00:00.000Z") + millisecond++),
      nextTemporaryId: () => `fixture-${++temporaryId}`,
      onMemoryCommitPoint: async (point) => {
        commitPoints.push(point);
      },
    });
    const result = await runMemoryTool({
      world,
      operations: [
        { action: "add", target: "memory", content: "fixture fact" },
        { action: "add", target: "user", content: "fixture preference" },
      ],
    });
    expect(result).toMatchObject({ success: true });
    const memoryBefore = await readFile(join(profile, "memory/MEMORY.md"), "utf8");
    const first = await openSession({
      world,
      sessionId: "fixture-current",
      baseSystemPrompt: "fixture base",
      tools: [],
    });
    await expect(
      runMemoryTool({
        world,
        operations: [
          { action: "replace", target: "memory", oldText: "fixture fact", content: "new fact" },
        ],
      }),
    ).resolves.toMatchObject({ success: true });
    const reopened = await openSession({
      world,
      sessionId: "fixture-current",
      baseSystemPrompt: "changed base must not replace authority",
      tools: [],
    });
    const next = await openSession({
      world,
      sessionId: "fixture-next",
      baseSystemPrompt: "fixture base",
      tools: [],
    });
    expect(reopened).toEqual(first);
    expect(first.systemPrompt).toContain("fixture fact");
    expect(first.systemPrompt).not.toContain("new fact");
    expect(next.systemPrompt).toContain("new fact");

    const overCap = await runMemoryTool({
      world,
      operations: [
        {
          action: "replace",
          target: "memory",
          oldText: "new fact",
          content: "x".repeat(MEMORY_DOCUMENT_LIMIT + 1),
        },
      ],
    });
    expect(overCap).toMatchObject({ success: false });
    expect(await world.readMemory("MEMORY.md")).toBe("new fact");

    const readsReached = Promise.withResolvers<void>();
    const releaseReads = Promise.withResolvers<void>();
    let concurrentReads = 0;
    const synchronizeFirstRead = (delegate: FilesystemWorld): FilesystemWorld => ({
      ...delegate,
      async readMemoryBatch(documents) {
        const snapshot = await delegate.readMemoryBatch(documents);
        concurrentReads += 1;
        if (concurrentReads === 2) {
          readsReached.resolve();
        }
        await releaseReads.promise;
        return snapshot;
      },
    });
    const concurrent = ["concurrent alpha", "concurrent beta"].map((content) =>
      runMemoryTool({
        world: synchronizeFirstRead(createFilesystemWorld({ profilePath: profile })),
        operations: [{ action: "add", target: "memory", content }],
      }),
    );
    await readsReached.promise;
    releaseReads.resolve();
    await expect(Promise.all(concurrent)).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    const concurrentEntries = new Set(
      (await world.readMemory("MEMORY.md"))?.split(MEMORY_ENTRY_DELIMITER),
    );
    expect(concurrentEntries).toEqual(new Set(["new fact", "concurrent alpha", "concurrent beta"]));
    const memoryAfter = await readFile(join(profile, "memory/MEMORY.md"), "utf8");
    const trace = [
      ...(await world.readSession("fixture-current", 0)),
      ...(await world.readSession("fixture-next", 0)),
    ];
    const faultSchedule: FaultScheduleObservation[] = commitPoints.map((point, occurrence) => ({
      boundary: "Memory-batch",
      point,
      occurrence: occurrence + 1,
      outcome: "continued",
    }));
    faultSchedule.push({
      boundary: "Memory-batch",
      point: "concurrent-conditional-commit",
      occurrence: 1,
      outcome: "recovered",
    });

    emitVerificationObservation("s1.memory", {
      ...emptyRuntimeObservations(),
      canonicalEventTrace: observeCanonicalEvents(trace),
      faultSchedule,
      filesystemDiffs: [
        {
          path: "memory/MEMORY.md",
          change: "modified",
          beforeDigest: fixtureDigest(memoryBefore),
          afterDigest: fixtureDigest(memoryAfter),
        },
      ],
    });
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
});
