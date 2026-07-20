import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemWorld,
  createMemoryTool,
  MEMORY_DOCUMENT_LIMIT,
  MEMORY_ENTRY_DELIMITER,
  openSession,
  runMemoryTool,
  USER_DOCUMENT_LIMIT,
  type FilesystemWorld,
  type MemoryReplacement,
  type SessionTool,
} from "../../packages/core/src/index.ts";

const ENTRY_DELIMITER = MEMORY_ENTRY_DELIMITER;
const profiles: string[] = [];

interface Operation {
  readonly action: "add" | "replace" | "remove";
  readonly target: "memory" | "user";
  readonly content?: string;
  readonly oldText?: string;
}

const targets: ReadonlyArray<"memory" | "user"> = ["memory", "user"];
const substringActions: ReadonlyArray<"replace" | "remove"> = ["replace", "remove"];
const limits: ReadonlyArray<readonly ["memory" | "user", number]> = [
  ["memory", MEMORY_DOCUMENT_LIMIT],
  ["user", USER_DOCUMENT_LIMIT],
];

interface WorldCalls {
  memoryReads: number;
  memoryWrites: MemoryReplacement[][];
}

describe("@ziggy/core Memory tool", () => {
  for (const target of targets) {
    test(`${target}: add, replace, and remove persist exact delimited entries`, async () => {
      const fixture = await createFixture();

      await expect(run(fixture.world, add(target, "first entry"))).resolves.toMatchObject({
        success: true,
      });
      await expect(run(fixture.world, add(target, "second entry"))).resolves.toMatchObject({
        success: true,
      });
      expect(await readTarget(fixture.profile, target)).toBe(
        `first entry${ENTRY_DELIMITER}second entry`,
      );

      await expect(
        run(fixture.world, {
          action: "replace",
          target,
          oldText: "first",
          content: "updated entry",
        }),
      ).resolves.toMatchObject({ success: true });
      expect(await readTarget(fixture.profile, target)).toBe(
        `updated entry${ENTRY_DELIMITER}second entry`,
      );

      await expect(
        run(fixture.world, { action: "remove", target, oldText: "second" }),
      ).resolves.toMatchObject({ success: true });
      expect(await readTarget(fixture.profile, target)).toBe("updated entry");
    });
  }

  test("a mixed-target batch applies sequentially and commits both documents once", async () => {
    const fixture = await createFixture();
    const calls: WorldCalls = { memoryReads: 0, memoryWrites: [] };
    const world = recordingWorld(fixture.world, calls);

    const operations: readonly Operation[] = [
      add("memory", "alpha"),
      add("user", "prefers terse answers"),
      { action: "replace", target: "memory", oldText: "alpha", content: "beta" },
      { action: "remove", target: "user", oldText: "terse" },
      add("user", "uses TypeScript"),
      add("memory", "beta"),
    ];

    await expect(run(world, ...operations)).resolves.toMatchObject({ success: true });
    expect(await readTarget(fixture.profile, "memory")).toBe("beta");
    expect(await readTarget(fixture.profile, "user")).toBe("uses TypeScript");
    expect(calls.memoryReads).toBe(1);
    expect(calls.memoryWrites).toHaveLength(1);
    expect(calls.memoryWrites[0]?.map((replacement) => replacement.document).sort()).toEqual([
      "MEMORY.md",
      "USER.md",
    ]);
  });

  test("duplicate and sequentially cancelled operations perform no write", async () => {
    const fixture = await createFixture();
    await run(fixture.world, add("memory", "one fact"));
    const before = await readFile(memoryPath(fixture.profile, "memory"));
    const calls: WorldCalls = { memoryReads: 0, memoryWrites: [] };
    const world = recordingWorld(fixture.world, calls);

    await expect(
      run(
        world,
        add("memory", "one fact"),
        { action: "replace", target: "memory", oldText: "one fact", content: "one fact" },
        add("user", "temporary"),
        { action: "remove", target: "user", oldText: "temporary" },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(calls.memoryReads).toBe(1);
    expect(calls.memoryWrites).toHaveLength(0);
    expect(await readFile(memoryPath(fixture.profile, "memory"))).toEqual(before);
  });

  for (const action of substringActions) {
    test(`${action}: zero substring matches reject the whole call without changing bytes`, async () => {
      const fixture = await createFixture();
      await seedEntries(fixture.world, "memory", ["alpha", "beta"]);
      const before = await readFile(memoryPath(fixture.profile, "memory"));
      const operation: Operation =
        action === "replace"
          ? { action, target: "memory", oldText: "missing", content: "replacement" }
          : { action, target: "memory", oldText: "missing" };

      const result = await run(fixture.world, operation);
      expect(result).toMatchObject({ success: false });
      expect(JSON.stringify(result)).toContain("missing");
      expect(await readFile(memoryPath(fixture.profile, "memory"))).toEqual(before);
    });

    test(`${action}: ambiguous substring matches reject the whole call without changing bytes`, async () => {
      const fixture = await createFixture();
      await seedEntries(fixture.world, "user", ["likes dark mode", "likes compact output"]);
      const before = await readFile(memoryPath(fixture.profile, "user"));
      const operation: Operation =
        action === "replace"
          ? { action, target: "user", oldText: "likes", content: "replacement" }
          : { action, target: "user", oldText: "likes" };

      const result = await run(fixture.world, operation);
      expect(result).toMatchObject({ success: false });
      expect(/multiple|ambiguous/i.test(JSON.stringify(result))).toBe(true);
      expect(await readFile(memoryPath(fixture.profile, "user"))).toEqual(before);
    });
  }

  test("entry content containing the exact delimiter rejects the whole call", async () => {
    const fixture = await createFixture();
    await run(fixture.world, add("memory", "existing"));
    const before = await readFile(memoryPath(fixture.profile, "memory"));

    const result = await run(
      fixture.world,
      add("memory", `looks safe${ENTRY_DELIMITER}injected entry`),
    );
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result).toLowerCase()).toContain("delimiter");
    expect(await readFile(memoryPath(fixture.profile, "memory"))).toEqual(before);
  });

  test("manually malformed entry lists fail actionably without a write", async () => {
    for (const malformed of [
      `${ENTRY_DELIMITER}alpha`,
      `alpha${ENTRY_DELIMITER}`,
      `alpha${ENTRY_DELIMITER}   ${ENTRY_DELIMITER}beta`,
    ]) {
      const fixture = await createFixture();
      await fixture.world.replaceMemoryBatch([{ document: "MEMORY.md", content: malformed }]);
      const calls: WorldCalls = { memoryReads: 0, memoryWrites: [] };

      const result = await run(recordingWorld(fixture.world, calls), add("user", "unchanged"));

      expect(result).toMatchObject({ success: false });
      expect(JSON.stringify(result)).toContain("MEMORY.md");
      expect(JSON.stringify(result)).toContain("exact delimiter");
      expect(calls.memoryWrites).toHaveLength(0);
    }
  });

  test("delimiter parsing is exact rather than whitespace-normalized", async () => {
    const fixture = await createFixture();
    const similar = "alpha\n § \nbeta";

    await expect(run(fixture.world, add("memory", similar))).resolves.toMatchObject({
      success: true,
    });
    expect(await readTarget(fixture.profile, "memory")).toBe(similar);
  });

  for (const [target, limit] of limits) {
    test(`${target}: exactly ${limit} Unicode code points passes`, async () => {
      const fixture = await createFixture();
      const exact = "🧠".repeat(limit);

      await expect(run(fixture.world, add(target, exact))).resolves.toMatchObject({
        success: true,
      });
      expect(Array.from(await readTarget(fixture.profile, target))).toHaveLength(limit);
    });

    test(`${target}: ${limit + 1} Unicode code points rejects actionably without truncation`, async () => {
      const fixture = await createFixture();
      await run(fixture.world, add(target, "unchanged"));
      const before = await readFile(memoryPath(fixture.profile, target));

      const result = await run(fixture.world, add(target, "🧠".repeat(limit + 1)));
      const rendered = JSON.stringify(result);
      expect(result).toMatchObject({ success: false });
      expect(rendered).toContain(limit.toString());
      expect(/remove|replace|shorten|consolidat/i.test(rendered)).toBe(true);
      expect(await readFile(memoryPath(fixture.profile, target))).toEqual(before);
    });
  }

  test("the Unicode cap includes exact delimiters between entries", async () => {
    const fixture = await createFixture();
    const delimiterSize = Array.from(ENTRY_DELIMITER).length;
    const secondEntrySize = MEMORY_DOCUMENT_LIMIT - delimiterSize - 1;

    await expect(
      run(fixture.world, add("memory", "a"), add("memory", "🧠".repeat(secondEntrySize))),
    ).resolves.toMatchObject({ success: true });
    expect(Array.from(await readTarget(fixture.profile, "memory"))).toHaveLength(
      MEMORY_DOCUMENT_LIMIT,
    );

    const overflowFixture = await createFixture();
    const result = await run(
      overflowFixture.world,
      add("memory", "a"),
      add("memory", "🧠".repeat(secondEntrySize + 1)),
    );
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain((MEMORY_DOCUMENT_LIMIT + 1).toString());
  });

  test("the cap is checked on final state so one batch can remove then add", async () => {
    const fixture = await createFixture();
    await run(fixture.world, add("memory", "x".repeat(2_200)));

    await expect(
      run(
        fixture.world,
        { action: "remove", target: "memory", oldText: "xxx" },
        add("memory", "y".repeat(2_200)),
      ),
    ).resolves.toMatchObject({ success: true });
    expect(await readTarget(fixture.profile, "memory")).toBe("y".repeat(2_200));
  });
});

describe("@ziggy/core model-visible Memory tool", () => {
  test("defines one typed memory tool and adapts model input to the sole Memory authority", async () => {
    const fixture = await createFixture();
    const tool = createMemoryTool(fixture.world);
    const runtimeTool: SessionTool = tool;

    expect(runtimeTool).toBe(tool);
    expect(tool.name).toBe("memory");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["operations"],
      properties: { operations: { type: "array", minItems: 1 } },
    });
    await expect(
      tool.execute({
        input: {
          operations: [{ action: "add", target: "memory", content: "model-visible fact" }],
        },
      }),
    ).resolves.toMatchObject({ success: true });
    expect(await readTarget(fixture.profile, "memory")).toBe("model-visible fact");
  });
});

describe("@ziggy/core frozen Session Memory snapshot", () => {
  test("one persisted systemPrompt stays stable for the Session and refreshes only for a new Session", async () => {
    const fixture = await createFixture();
    await run(fixture.world, add("memory", "original memory"), add("user", "original user"));

    const current = await openSession({
      world: fixture.world,
      sessionId: "session-current",
      baseSystemPrompt: "You are Ziggy.",
      tools: [],
    });
    expect(current.systemPrompt).toContain("original memory");
    expect(current.systemPrompt).toContain("original user");
    expect(Object.keys(current)).toEqual(["systemPrompt", "tools"]);

    await run(
      fixture.world,
      { action: "replace", target: "memory", oldText: "original", content: "new memory" },
      { action: "replace", target: "user", oldText: "original", content: "new user" },
    );
    expect(current.systemPrompt).toContain("original memory");
    expect(current.systemPrompt).not.toContain("new memory");

    const currentReplay = await fixture.world.readSession("session-current", 0);
    expect(currentReplay).toHaveLength(1);
    expect(currentReplay[0]?.event).toEqual({
      type: "session-started",
      sessionId: "session-current",
      snapshot: current,
    });

    const next = await openSession({
      world: fixture.world,
      sessionId: "session-next",
      baseSystemPrompt: "You are Ziggy.",
      tools: [],
    });
    expect(next.systemPrompt).toContain("new memory");
    expect(next.systemPrompt).toContain("new user");
    expect(next.systemPrompt).not.toBe(current.systemPrompt);

    const reopenedWorld = createFilesystemWorld({ profilePath: fixture.profile });
    const resumed = await openSession({
      world: reopenedWorld,
      sessionId: "session-current",
      baseSystemPrompt: "this changed and must be ignored",
      tools: [],
    });
    expect(resumed).toEqual(current);
    expect(await reopenedWorld.readSession("session-current", 0)).toHaveLength(1);
  });

  test("concurrent opens through separate World instances persist exactly the first snapshot", async () => {
    const fixture = await createFixture();
    await run(fixture.world, add("memory", "frozen memory"));
    const firstWorld = createFilesystemWorld({ profilePath: fixture.profile });
    const secondWorld = createFilesystemWorld({ profilePath: fixture.profile });
    const tool = createMemoryTool(firstWorld);
    const frozenTool = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };

    const firstOpen = openSession({
      world: firstWorld,
      sessionId: "concurrent-session",
      baseSystemPrompt: "first prompt",
      tools: [frozenTool],
    });
    const secondOpen = openSession({
      world: secondWorld,
      sessionId: "concurrent-session",
      baseSystemPrompt: "second prompt",
      tools: [],
    });
    const [first, second] = await Promise.all([firstOpen, secondOpen]);

    expect(second).toEqual(first);
    expect(first.systemPrompt).toContain("first prompt");
    expect(first.systemPrompt).not.toContain("second prompt");
    expect(first.tools).toEqual([frozenTool]);
    const persisted = await secondWorld.readSession("concurrent-session", 0);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.event).toEqual({
      type: "session-started",
      sessionId: "concurrent-session",
      snapshot: first,
    });

    const restarted = await openSession({
      world: createFilesystemWorld({ profilePath: fixture.profile }),
      sessionId: "concurrent-session",
      baseSystemPrompt: "restart must not replace the first snapshot",
      tools: [],
    });
    expect(restarted).toEqual(first);
  });
});

afterAll(async () => {
  await Promise.all(profiles.map((profile) => rm(profile, { force: true, recursive: true })));
});

async function createFixture(): Promise<{
  readonly profile: string;
  readonly world: FilesystemWorld;
}> {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-memory-red-"));
  profiles.push(profile);
  return { profile, world: createFilesystemWorld({ profilePath: profile }) };
}

function add(target: "memory" | "user", content: string): Operation {
  return { action: "add", target, content };
}

function run(world: FilesystemWorld, ...operations: ReadonlyArray<Operation>) {
  return runMemoryTool({ world, operations });
}

async function seedEntries(
  world: FilesystemWorld,
  target: "memory" | "user",
  entries: ReadonlyArray<string>,
): Promise<void> {
  await run(world, ...entries.map((entry) => add(target, entry)));
}

function memoryPath(profile: string, target: "memory" | "user"): string {
  return join(profile, "memory", target === "memory" ? "MEMORY.md" : "USER.md");
}

function readTarget(profile: string, target: "memory" | "user"): Promise<string> {
  return readFile(memoryPath(profile, target), "utf8");
}

function recordingWorld(delegate: FilesystemWorld, calls: WorldCalls): FilesystemWorld {
  return {
    startSession(sessionId, snapshot) {
      return delegate.startSession(sessionId, snapshot);
    },
    appendSession(sessionId, event) {
      return delegate.appendSession(sessionId, event);
    },
    readSession(sessionId, afterSeq) {
      return delegate.readSession(sessionId, afterSeq);
    },
    listSessions() {
      return delegate.listSessions();
    },
    readMemory(document) {
      return delegate.readMemory(document);
    },
    readMemoryBatch(documents) {
      calls.memoryReads += 1;
      return delegate.readMemoryBatch(documents);
    },
    replaceMemoryBatch(replacements) {
      calls.memoryWrites.push(replacements.map((replacement) => ({ ...replacement })));
      return delegate.replaceMemoryBatch(replacements);
    },
  };
}
