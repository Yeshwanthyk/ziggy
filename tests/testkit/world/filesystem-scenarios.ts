import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { SessionEnvelope, SessionEvent } from "../../../packages/protocol/src/index.ts";
import type { MemoryCommitCutPoint, MemoryReplacement, SessionSummary } from "./contract.ts";

interface FilesystemScenarioWorld {
  appendSession(sessionId: string, event: SessionEvent): Promise<SessionEnvelope>;
  readSession(sessionId: string, afterSeq: number): Promise<ReadonlyArray<SessionEnvelope>>;
  listSessions(): Promise<ReadonlyArray<SessionSummary>>;
  readMemory(document: string): Promise<string | undefined>;
  readMemoryBatch(
    documents: ReadonlyArray<string>,
  ): Promise<Readonly<Record<string, string | undefined>>>;
  replaceMemoryBatch(replacements: ReadonlyArray<MemoryReplacement>): Promise<void>;
}

interface FilesystemScenarioControls {
  readonly now: () => Date;
  readonly nextTemporaryId: () => string;
  readonly onMemoryCommitPoint: (point: MemoryCommitCutPoint) => Promise<void>;
  readonly onMemoryRecoveryPoint: (point: "duringRecovery") => Promise<void>;
  readonly onSessionAppendPoint: (point: "afterAppend") => Promise<void>;
}

export interface FilesystemWorldScenarioFactory {
  readonly supportsSymlinks: boolean;
  open(profilePath: string, controls: FilesystemScenarioControls): FilesystemScenarioWorld;
}

const events: readonly [SessionEvent, SessionEvent, SessionEvent] = [
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

const commitCutPoints: ReadonlyArray<MemoryCommitCutPoint> = [
  "beforePrepare",
  "afterPrepare",
  "duringCommit",
  "afterCommit",
];

export function defineFilesystemWorldScenarios(
  label: string,
  profilePath: () => Promise<string>,
  factory: FilesystemWorldScenarioFactory,
): void {
  test(`${label}: writes one exact canonical NDJSON line and replays exclusively`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    const envelope = await world.appendSession("session-a", events[0]);
    const sessionFile = await onlySessionFile(profile);

    expect(await readFile(sessionFile, "utf8")).toBe(`${JSON.stringify(envelope)}\n`);
    expect(await world.readSession("session-a", 0)).toEqual([envelope]);
    expect(await world.readSession("session-a", envelope.seq)).toEqual([]);
    expect(Object.keys(envelope)).toEqual(["schemaVersion", "seq", "emittedAt", "event"]);
    expect(envelope.schemaVersion).toBe(1);
  });

  test(`${label}: reopens a Session and continues its sequence`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const firstWorld = factory.open(profile, controls);
    const first = await firstWorld.appendSession("session-a", events[0]);
    const second = await firstWorld.appendSession("session-a", events[1]);

    const reopened = factory.open(profile, controls);
    expect(await reopened.readSession("session-a", 0)).toEqual([first, second]);
    const third = await reopened.appendSession("session-a", events[2]);
    expect(third.seq).toBe(3);
    expect((await reopened.readSession("session-a", 2)).map((item) => item.seq)).toEqual([3]);
  });

  test(`${label}: rejects negative, fractional, and unsafe afterSeq without filesystem changes`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);

    for (const afterSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(world.readSession("session-a", afterSeq)).rejects.toThrow();
    }
    expect(await filesBelow(profile)).toEqual([]);
  });

  test(`${label}: rejects missing and duplicate session-started authority without changing bytes`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);

    await expect(world.appendSession("session-a", events[1])).rejects.toThrow(/session-started/);
    expect(await filesBelow(profile)).toEqual([]);

    await world.appendSession("session-a", events[0]);
    const sessionFile = await onlySessionFile(profile);
    const before = await readFile(sessionFile);
    await expect(world.appendSession("session-a", events[0])).rejects.toThrow(/session-started/);
    expect(await readFile(sessionFile)).toEqual(before);
  });

  test(`${label}: rejects an event for another Session without touching bytes or consuming seq`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    const mismatched = withSessionId(events[0], "session-b");

    await expect(world.appendSession("session-a", mismatched)).rejects.toThrow();
    expect(await filesBelow(profile)).toEqual([]);

    const first = await world.appendSession("session-a", events[0]);
    const sessionFile = await onlySessionFile(profile);
    const before = await readFile(sessionFile);
    await expect(world.appendSession("session-a", mismatched)).rejects.toThrow();
    expect(await readFile(sessionFile)).toEqual(before);

    const second = await world.appendSession("session-a", events[1]);
    expect([first.seq, second.seq]).toEqual([1, 2]);
  });

  const corruptEnvelopes: ReadonlyArray<readonly [string, unknown]> = [
    ["schemaVersion 2", { ...firstEnvelope(), schemaVersion: 2 }],
    ["an extra envelope key", { ...firstEnvelope(), unexpected: true }],
    ["a missing envelope key", firstEnvelopeWithoutEvent()],
    ["a noncontiguous sequence", { ...firstEnvelope(), seq: 2 }],
    ["an invalid timestamp", { ...firstEnvelope(), emittedAt: "not-a-timestamp" }],
    ["an invalid event", { ...firstEnvelope(), event: { type: "not-a-session-event" } }],
    [
      "an event whose Session id differs from its path",
      { ...firstEnvelope(), event: withSessionId(events[0], "session-b") },
    ],
    ["a missing session-started first event", { ...firstEnvelope(), event: events[1] }],
    [
      "a duplicate session-started event",
      [firstEnvelope(), { ...firstEnvelope(), seq: 2, event: events[0] }],
    ],
  ];
  for (const [description, corruptEnvelope] of corruptEnvelopes) {
    test(`${label}: ${description} in an existing Session fails read/list/append without byte changes`, async () => {
      const profile = await profilePath();
      const controls = createControls();
      const world = factory.open(profile, controls);
      await world.appendSession("session-a", events[0]);
      const sessionFile = await onlySessionFile(profile);
      const corrupted = `${Array.isArray(corruptEnvelope) ? corruptEnvelope.map((envelope) => JSON.stringify(envelope)).join("\n") : JSON.stringify(corruptEnvelope)}\n`;
      await writeFile(sessionFile, corrupted);

      await expect(world.readSession("session-a", 0)).rejects.toThrow();
      expect(await readFile(sessionFile, "utf8")).toBe(corrupted);
      await expect(world.listSessions()).rejects.toThrow();
      expect(await readFile(sessionFile, "utf8")).toBe(corrupted);
      await expect(world.appendSession("session-a", events[1])).rejects.toThrow();
      expect(await readFile(sessionFile, "utf8")).toBe(corrupted);
    });
  }

  for (const suffix of ['{"schemaVersion":1', `${JSON.stringify(canonicalEnvelope())}`]) {
    const description = suffix.endsWith("}") ? "valid JSON missing its final LF" : "a torn line";
    test(`${label}: ${description} fails loud, remains unchanged, and blocks append`, async () => {
      const profile = await profilePath();
      const controls = createControls();
      const world = factory.open(profile, controls);
      await world.appendSession("session-a", events[0]);
      const sessionFile = await onlySessionFile(profile);
      const corrupted = `${await readFile(sessionFile, "utf8")}${suffix}`;
      await writeFile(sessionFile, corrupted);

      await expect(world.readSession("session-a", 0)).rejects.toThrow();
      expect(await readFile(sessionFile, "utf8")).toBe(corrupted);
      await expect(world.listSessions()).rejects.toThrow();
      expect(await readFile(sessionFile, "utf8")).toBe(corrupted);
      await expect(world.appendSession("session-a", events[1])).rejects.toThrow();
      expect(await readFile(sessionFile, "utf8")).toBe(corrupted);
    });
  }

  test(`${label}: invalid UTF-8 in Session NDJSON fails read/list/append without replacement or repair`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    await world.appendSession("session-a", events[0]);
    const sessionFile = await onlySessionFile(profile);
    const corrupted = invalidUtf8JsonLine(firstEnvelope(), "fixture prompt");
    await writeFile(sessionFile, corrupted);

    await expect(world.readSession("session-a", 0)).rejects.toThrow("valid UTF-8");
    expect(await readFile(sessionFile)).toEqual(corrupted);
    await expect(world.listSessions()).rejects.toThrow("valid UTF-8");
    expect(await readFile(sessionFile)).toEqual(corrupted);
    await expect(world.appendSession("session-a", events[1])).rejects.toThrow("valid UTF-8");
    expect(await readFile(sessionFile)).toEqual(corrupted);
  });

  test(`${label}: serializes concurrent appends into contiguous whole lines`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    const started = await world.appendSession("session-a", events[0]);
    const appended = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        world.appendSession("session-a", {
          type: "step-started",
          sessionId: "session-a",
          turnId: "turn-1",
          stepId: `step-${index}`,
          provider: "anthropic",
          model: "claude-test",
        }),
      ),
    );
    const replay = await world.readSession("session-a", 0);
    const rawLines = (await readFile(await onlySessionFile(profile), "utf8")).split("\n");

    expect(
      appended
        .map((item: SessionEnvelope) => item.seq)
        .sort((left: number, right: number) => left - right),
    ).toEqual(Array.from({ length: 24 }, (_, index) => index + 2));
    expect(replay.map((item) => item.seq)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(replay[0]).toEqual(started);
    expect(rawLines.at(-1)).toBe("");
    expect(rawLines.slice(0, -1).map(parseJson)).toEqual([...replay]);
  });

  test(`${label}: cross-instance append/read/list races observe one durable contiguous authority`, async () => {
    const profile = await profilePath();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdFirstAppend = true;
    const controls = createControls(undefined, {
      async onSessionAppendPoint() {
        if (holdFirstAppend) {
          holdFirstAppend = false;
          reached.resolve();
          await release.promise;
        }
      },
    });
    const writer = factory.open(profile, controls);
    const observer = factory.open(profile, controls);
    const firstWrite = writer.appendSession("session-a", events[0]);
    await reached.promise;

    const secondWrite = observer.appendSession("session-a", events[1]);
    const read = observer.readSession("session-a", 0);
    const list = observer.listSessions();
    release.resolve();

    const [first, second, replay, summaries] = await Promise.all([
      firstWrite,
      secondWrite,
      read,
      list,
    ]);
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(replay.map((envelope) => envelope.seq)).toEqual([1, 2]);
    expect(summaries).toEqual([{ sessionId: "session-a", lastSeq: 2 }]);
  });

  test(`${label}: rejects path-unsafe Session IDs without touching outside the Session store`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    const unsafeIds = [
      "",
      ".",
      "..",
      "../escape",
      "nested/session",
      "nested\\session",
      "/tmp/escape",
    ];

    for (const sessionId of unsafeIds) {
      await expect(
        world.appendSession(sessionId, withSessionId(events[0], sessionId)),
      ).rejects.toThrow();
      await expect(world.readSession(sessionId, 0)).rejects.toThrow();
    }
    expect(await filesBelow(profile)).toEqual([]);
  });

  test(`${label}: lists Sessions deterministically in creation order across reopen`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    await world.appendSession("session-z", withSessionId(events[0], "session-z"));
    await world.appendSession("session-a", events[0]);
    await world.appendSession("session-m", withSessionId(events[0], "session-m"));
    await world.appendSession("session-z", withSessionId(events[1], "session-z"));

    const expected = [
      { sessionId: "session-z", lastSeq: 2 },
      { sessionId: "session-a", lastSeq: 1 },
      { sessionId: "session-m", lastSeq: 1 },
    ];
    expect(await world.listSessions()).toEqual(expected);
    const files = await filesBelow(join(profile, "sessions"));
    await Promise.all(
      files.map((file, index) =>
        utimes(file, new Date(0), new Date((files.length - index) * 1000)),
      ),
    );
    expect(await factory.open(profile, controls).listSessions()).toEqual(expected);
  });

  if (factory.supportsSymlinks) {
    test(`${label}: fails closed when the Sessions directory is a symlink`, async () => {
      const profile = await profilePath();
      const controls = createControls();
      const world = factory.open(profile, controls);
      await world.appendSession("session-a", events[0]);
      const sessionFile = await onlySessionFile(profile);
      const sessionsDirectory = dirname(sessionFile);
      const original = await readFile(sessionFile);
      const outside = join(profile, "outside-sessions");
      await mkdir(outside);
      await writeFile(join(outside, basename(sessionFile)), original);
      await rm(sessionsDirectory, { recursive: true });
      await symlink(outside, sessionsDirectory, "dir");
      const before = await snapshotFiles(outside);

      await expect(world.readSession("session-a", 0)).rejects.toThrow();
      await expect(world.listSessions()).rejects.toThrow();
      await expect(world.appendSession("session-a", events[1])).rejects.toThrow();
      expect(await snapshotFiles(outside)).toEqual(before);
    });

    test(`${label}: fails closed when a Session file is a symlink`, async () => {
      const profile = await profilePath();
      const controls = createControls();
      const world = factory.open(profile, controls);
      await world.appendSession("session-a", events[0]);
      const sessionFile = await onlySessionFile(profile);
      const outside = join(profile, "outside-session.ndjson");
      await writeFile(outside, `${JSON.stringify(firstEnvelope())}\n`);
      await rm(sessionFile);
      await symlink(outside, sessionFile, "file");
      const before = await readFile(outside);

      await expect(world.readSession("session-a", 0)).rejects.toThrow();
      await expect(world.listSessions()).rejects.toThrow();
      await expect(world.appendSession("session-a", events[1])).rejects.toThrow();
      expect(await readFile(outside)).toEqual(before);
    });
  }

  if (factory.supportsSymlinks) {
    test(`${label}: Memory directory, documents, and journal fail closed on symlinks`, async () => {
      const profile = await profilePath();
      const controls = createControls();
      const world = factory.open(profile, controls);
      await seedMemory(world);
      const memoryDirectory = join(profile, "memory");
      const outside = join(profile, "outside-memory");
      await mkdir(outside);
      await writeFile(join(outside, "MEMORY.md"), "outside");

      await rm(join(memoryDirectory, "MEMORY.md"));
      await symlink(join(outside, "MEMORY.md"), join(memoryDirectory, "MEMORY.md"), "file");
      await expect(world.readMemory("MEMORY.md")).rejects.toThrow();
      await expect(
        world.replaceMemoryBatch([{ document: "MEMORY.md", content: "changed" }]),
      ).rejects.toThrow();
      expect(await readFile(join(outside, "MEMORY.md"), "utf8")).toBe("outside");

      await rm(join(memoryDirectory, "MEMORY.md"));
      await writeFile(join(memoryDirectory, ".batch-journal.json"), "journal-target");
      await rm(join(memoryDirectory, ".batch-journal.json"));
      await symlink(
        join(outside, "MEMORY.md"),
        join(memoryDirectory, ".batch-journal.json"),
        "file",
      );
      await expect(world.readMemory("USER.md")).rejects.toThrow();

      await rm(join(memoryDirectory, ".batch-journal.json"));
      await rm(memoryDirectory, { recursive: true });
      await symlink(outside, memoryDirectory, "dir");
      await expect(world.readMemory("MEMORY.md")).rejects.toThrow();
      await expect(
        world.replaceMemoryBatch([{ document: "MEMORY.md", content: "changed" }]),
      ).rejects.toThrow();
      expect(await readFile(join(outside, "MEMORY.md"), "utf8")).toBe("outside");
    });
  }

  test(`${label}: allows only MEMORY.md and USER.md Memory documents`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    await world.replaceMemoryBatch([
      { document: "MEMORY.md", content: "memory" },
      { document: "USER.md", content: "user" },
    ]);

    expect(await world.readMemory("MEMORY.md")).toBe("memory");
    expect(await world.readMemory("USER.md")).toBe("user");
    for (const document of ["SOUL.md", "../SOUL.md", "people/alice.md", "memory.md"]) {
      await expect(world.readMemory(document)).rejects.toThrow();
      await expect(
        world.replaceMemoryBatch([{ document, content: "not allowed" }]),
      ).rejects.toThrow();
    }
    expect(await readFile(join(profile, "memory", "MEMORY.md"), "utf8")).toBe("memory");
    expect(await readFile(join(profile, "memory", "USER.md"), "utf8")).toBe("user");
  });

  test(`${label}: rejects duplicate Memory replacements and an empty replacement batch`, async () => {
    const profile = await profilePath();
    const controls = createControls();
    const world = factory.open(profile, controls);
    await seedMemory(world);
    const before = await snapshotFiles(profile);

    await expect(
      world.replaceMemoryBatch([
        { document: "MEMORY.md", content: "first" },
        { document: "MEMORY.md", content: "second" },
      ]),
    ).rejects.toThrow();
    expect(await snapshotFiles(profile)).toEqual(before);
    await expect(world.replaceMemoryBatch([])).rejects.toThrow();
    expect(await snapshotFiles(profile)).toEqual(before);
  });

  test(`${label}: duringCommit cut is reachable when every old Memory document is missing`, async () => {
    const profile = await profilePath();
    const controls = createControls((point) => {
      if (point === "duringCommit") {
        throw new Error("injected duringCommit fault");
      }
    });
    const world = factory.open(profile, controls);

    await expect(replaceBoth(world)).rejects.toThrow("injected duringCommit fault");
    const recovered = factory.open(profile, createControls());
    expect(await recovered.readMemoryBatch(["MEMORY.md", "USER.md"])).toEqual({
      "MEMORY.md": undefined,
      "USER.md": undefined,
    });
  });

  test(`${label}: rejects unsafe deterministic temporary IDs before creating files`, async () => {
    const profile = await profilePath();
    const controls = { ...createControls(), nextTemporaryId: () => "../escape" };
    const world = factory.open(profile, controls);

    await expect(
      world.replaceMemoryBatch([{ document: "MEMORY.md", content: "memory" }]),
    ).rejects.toThrow("Unsafe temporary file id");
    expect(await filesBelow(profile)).toEqual([]);
  });

  test(`${label}: readMemoryBatch returns one atomic Memory snapshot`, async () => {
    const profile = await profilePath();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let observeCommit = false;
    const controls = createControls(async (point) => {
      if (observeCommit && point === "duringCommit") {
        reached.resolve();
        await release.promise;
      }
    });
    const world = factory.open(profile, controls);
    const reader = factory.open(profile, controls);
    await seedMemory(world);
    observeCommit = true;

    const write = replaceBoth(world);
    await reached.promise;
    const read = reader.readMemoryBatch(["MEMORY.md", "USER.md"]);
    const memoryRead = reader.readMemory("MEMORY.md");
    const userRead = reader.readMemory("USER.md");
    release.resolve();
    const [snapshot, memory, user] = await Promise.all([read, memoryRead, userRead]);
    await write;

    expect(isOldPair(snapshot) || isNewPair(snapshot)).toBe(true);
    expect({ "MEMORY.md": memory, "USER.md": user }).toEqual({
      "MEMORY.md": "new-memory",
      "USER.md": "new-user",
    });
  });

  test(`${label}: recovery preserves a missing old Memory document`, async () => {
    const profile = await profilePath();
    let fail = false;
    const controls = createControls((point) => {
      if (fail && point === "duringCommit") {
        throw new Error("injected duringCommit fault");
      }
    });
    const world = factory.open(profile, controls);
    await world.replaceMemoryBatch([{ document: "MEMORY.md", content: "old-memory" }]);
    fail = true;
    await expect(replaceBoth(world)).rejects.toThrow("injected duringCommit fault");
    fail = false;

    const recovered = factory.open(profile, controls);
    const snapshot = await recovered.readMemoryBatch(["MEMORY.md", "USER.md"]);
    const allOld = snapshot["MEMORY.md"] === "old-memory" && snapshot["USER.md"] === undefined;
    expect(allOld || isNewPair(snapshot)).toBe(true);
  });

  for (const [commitPoint, expected] of [
    ["afterPrepare", { "MEMORY.md": "old-memory", "USER.md": "old-user" }],
    ["afterCommit", { "MEMORY.md": "new-memory", "USER.md": "new-user" }],
  ] as const) {
    test(`${label}: ${commitPoint} Memory recovery remains retryable when recovery itself faults`, async () => {
      const profile = await profilePath();
      let failCommit = false;
      let failRecovery = true;
      const controls = createControls(
        (point) => {
          if (failCommit && point === commitPoint) {
            throw new Error(`injected ${commitPoint} fault`);
          }
        },
        {
          onMemoryRecoveryPoint() {
            if (failRecovery) {
              failRecovery = false;
              throw new Error("injected recovery fault");
            }
          },
        },
      );
      const world = factory.open(profile, controls);
      await seedMemory(world);
      failCommit = true;
      await expect(replaceBoth(world)).rejects.toThrow(`injected ${commitPoint} fault`);
      failCommit = false;

      const recovering = factory.open(profile, controls);
      await expect(recovering.readMemoryBatch(["MEMORY.md", "USER.md"])).rejects.toThrow(
        "injected recovery fault",
      );
      expect((await machineOwnedStructuredFiles(profile)).length).toBe(1);
      expect(await recovering.readMemoryBatch(["MEMORY.md", "USER.md"])).toEqual(expected);
      expect(await machineOwnedStructuredFiles(profile)).toEqual([]);
    });
  }

  test(`${label}: repeated Memory recovery is idempotent`, async () => {
    const profile = await profilePath();
    let fail = false;
    const controls = createControls((point) => {
      if (fail && point === "duringCommit") {
        throw new Error("injected duringCommit fault");
      }
    });
    const world = factory.open(profile, controls);
    await seedMemory(world);
    fail = true;
    await expect(replaceBoth(world)).rejects.toThrow("injected duringCommit fault");
    fail = false;

    const first = factory.open(profile, controls);
    const firstSnapshot = await first.readMemoryBatch(["MEMORY.md", "USER.md"]);
    const firstFiles = await snapshotFiles(profile);
    const second = factory.open(profile, controls);
    expect(await second.readMemoryBatch(["MEMORY.md", "USER.md"])).toEqual(firstSnapshot);
    expect(await snapshotFiles(profile)).toEqual(firstFiles);
  });

  for (const cutPoint of commitCutPoints) {
    test(`${label}: version-stamped Memory journal recovers all-old or all-new at ${cutPoint}`, async () => {
      const profile = await profilePath();
      let fail = false;
      let evidence: Readonly<Record<string, Uint8Array>> | undefined;
      const controls = createControls(async (point) => {
        if (fail && point === cutPoint) {
          evidence = await snapshotFiles(join(profile, "memory"));
          throw new Error(`injected ${cutPoint} fault`);
        }
      });
      const world = factory.open(profile, controls);
      await seedMemory(world);
      fail = true;
      await expect(replaceBoth(world)).rejects.toThrow(`injected ${cutPoint} fault`);
      fail = false;

      expect(decodeSnapshot(evidence)).toEqual(expectedCutEvidence(cutPoint));
      const structuredFiles = await machineOwnedStructuredFiles(profile);
      for (const file of structuredFiles) {
        const record = requireRecord(parseJson(await readFile(file, "utf8")), "Memory journal");
        expect(record.schemaVersion).toBe(1);
      }
      const recovered = factory.open(profile, controls);
      const snapshot = await recovered.readMemoryBatch(["MEMORY.md", "USER.md"]);
      expect(isOldPair(snapshot) || isNewPair(snapshot)).toBe(true);
    });
  }

  for (const malformed of [
    '{"schemaVersion":',
    '{"schemaVersion":2,"phase":"prepared"}\n',
    '{"schemaVersion":1,"phase":"prepared","replacements":[],"extra":true}\n',
    '{"schemaVersion":1,"phase":"prepared","replacements":[],"__proto__":{}}\n',
  ]) {
    test(`${label}: malformed Memory journal fails loud without changing Memory`, async () => {
      const profile = await profilePath();
      let fail = false;
      const controls = createControls((point) => {
        if (fail && point === "afterPrepare") {
          throw new Error("injected afterPrepare fault");
        }
      });
      const world = factory.open(profile, controls);
      await seedMemory(world);
      fail = true;
      await expect(replaceBoth(world)).rejects.toThrow("injected afterPrepare fault");
      fail = false;
      const journal = await onlyMachineOwnedStructuredFile(profile);
      await writeFile(journal, malformed);

      const reopened = factory.open(profile, controls);
      await expect(reopened.readMemoryBatch(["MEMORY.md", "USER.md"])).rejects.toThrow();
      expect(await readFile(join(profile, "memory", "MEMORY.md"), "utf8")).toBe("old-memory");
      expect(await readFile(join(profile, "memory", "USER.md"), "utf8")).toBe("old-user");
      expect(await readFile(journal, "utf8")).toBe(malformed);
    });
  }

  test(`${label}: invalid UTF-8 in the Memory journal fails exact decode without mutation`, async () => {
    const profile = await profilePath();
    let fail = false;
    const controls = createControls((point) => {
      if (fail && point === "afterPrepare") {
        throw new Error("injected afterPrepare fault");
      }
    });
    const world = factory.open(profile, controls);
    await seedMemory(world);
    fail = true;
    await expect(replaceBoth(world)).rejects.toThrow("injected afterPrepare fault");
    fail = false;
    const journal = await onlyMachineOwnedStructuredFile(profile);
    const corrupted = invalidUtf8JsonLine(
      {
        schemaVersion: 1,
        phase: "prepared",
        replacements: [
          {
            document: "MEMORY.md",
            old: { exists: true, content: "old-memory" },
            new: { exists: true, content: "new-memory" },
          },
        ],
      },
      "old-memory",
    );
    await writeFile(journal, corrupted);
    const before = await snapshotFiles(profile);

    await expect(world.readMemory("MEMORY.md")).rejects.toThrow("valid UTF-8");
    expect(await snapshotFiles(profile)).toEqual(before);
  });
}

function createControls(
  observer: (point: MemoryCommitCutPoint) => Promise<void> | void = () => {},
  options: {
    readonly onMemoryRecoveryPoint?: (point: "duringRecovery") => Promise<void> | void;
    readonly onSessionAppendPoint?: (point: "afterAppend") => Promise<void> | void;
  } = {},
): FilesystemScenarioControls {
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
      return `fixture-${temporaryId}`;
    },
    async onMemoryCommitPoint(point) {
      await observer(point);
    },
    async onMemoryRecoveryPoint(point) {
      await options.onMemoryRecoveryPoint?.(point);
    },
    async onSessionAppendPoint(point) {
      await options.onSessionAppendPoint?.(point);
    },
  };
}

function withSessionId(event: SessionEvent, sessionId: string): SessionEvent {
  return { ...event, sessionId };
}

function firstEnvelope(): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq: 1,
    emittedAt: "2026-07-19T00:00:00.000Z",
    event: events[0],
  };
}

function canonicalEnvelope(): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq: 2,
    emittedAt: "2026-07-19T00:00:00.001Z",
    event: events[1],
  };
}

function firstEnvelopeWithoutEvent(): Record<string, unknown> {
  const envelope = firstEnvelope();
  return {
    schemaVersion: envelope.schemaVersion,
    seq: envelope.seq,
    emittedAt: envelope.emittedAt,
  };
}

async function seedMemory(world: FilesystemScenarioWorld): Promise<void> {
  await world.replaceMemoryBatch([
    { document: "MEMORY.md", content: "old-memory" },
    { document: "USER.md", content: "old-user" },
  ]);
}

async function replaceBoth(world: FilesystemScenarioWorld): Promise<void> {
  await world.replaceMemoryBatch([
    { document: "MEMORY.md", content: "new-memory" },
    { document: "USER.md", content: "new-user" },
  ]);
}

function isOldPair(values: Readonly<Record<string, string | undefined>>): boolean {
  return values["MEMORY.md"] === "old-memory" && values["USER.md"] === "old-user";
}

function isNewPair(values: Readonly<Record<string, string | undefined>>): boolean {
  return values["MEMORY.md"] === "new-memory" && values["USER.md"] === "new-user";
}

async function onlySessionFile(profile: string): Promise<string> {
  const files = (await filesBelow(profile)).filter((file) => file.endsWith(".ndjson"));
  if (files.length !== 1 || files[0] === undefined) {
    throw new Error(`expected one Session NDJSON file, found ${files.length}`);
  }
  return files[0];
}

async function machineOwnedStructuredFiles(profile: string): Promise<ReadonlyArray<string>> {
  const files = (await filesBelow(join(profile, "memory"))).filter((file) => !file.endsWith(".md"));
  const candidates = await Promise.all(
    files.map(async (file): Promise<string | undefined> => {
      try {
        const record = requireRecord(parseJson(await readFile(file, "utf8")), "Memory journal");
        return record.schemaVersion === 1 ? file : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return candidates.filter((file): file is string => file !== undefined);
}

async function onlyMachineOwnedStructuredFile(profile: string): Promise<string> {
  const files = await machineOwnedStructuredFiles(profile);
  if (files.length !== 1 || files[0] === undefined) {
    throw new Error(`expected one Memory journal, found ${files.length}`);
  }
  return files[0];
}

async function snapshotFiles(root: string): Promise<Readonly<Record<string, Uint8Array>>> {
  const files = await filesBelow(root);
  const entries = await Promise.all(
    files.map(
      async (file): Promise<readonly [string, Uint8Array]> => [
        relative(root, file),
        await readFile(file),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

async function filesBelow(root: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
          return filesBelow(path);
        }
        if (entry.isFile()) {
          return [path];
        }
        return [];
      }),
    );
    return nested
      .flat()
      .sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function invalidUtf8JsonLine(value: unknown, text: string) {
  const marker = `"${text}"`;
  const json = JSON.stringify(value);
  const markerIndex = json.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`fixture JSON does not contain ${marker}`);
  }
  const invalidByteIndex = markerIndex + 1;
  return Buffer.concat([
    Buffer.from(json.slice(0, invalidByteIndex)),
    Buffer.from([0xff]),
    Buffer.from(`${json.slice(invalidByteIndex + text.length)}\n`),
  ]);
}

function decodeSnapshot(
  snapshot: Readonly<Record<string, Uint8Array>> | undefined,
): Readonly<Record<string, string>> {
  if (snapshot === undefined) {
    throw new Error("Memory cut point produced no evidence");
  }
  return Object.fromEntries(
    Object.entries(snapshot).map(([path, contents]) => [path, new TextDecoder().decode(contents)]),
  );
}

function expectedCutEvidence(cutPoint: MemoryCommitCutPoint): Readonly<Record<string, string>> {
  const prepared = `${JSON.stringify(memoryJournal("prepared"))}\n`;
  const committed = `${JSON.stringify(memoryJournal("committed"))}\n`;
  if (cutPoint === "beforePrepare") {
    return { "MEMORY.md": "old-memory", "USER.md": "old-user" };
  }
  if (cutPoint === "afterPrepare") {
    return {
      ".batch-journal.json": prepared,
      "MEMORY.md": "old-memory",
      "USER.md": "old-user",
    };
  }
  if (cutPoint === "duringCommit") {
    return {
      ".batch-journal.json": prepared,
      "MEMORY.md": "new-memory",
      "USER.md": "old-user",
    };
  }
  return {
    ".batch-journal.json": committed,
    "MEMORY.md": "new-memory",
    "USER.md": "new-user",
  };
}

function memoryJournal(phase: "prepared" | "committed"): unknown {
  return {
    schemaVersion: 1,
    phase,
    replacements: [
      {
        document: "MEMORY.md",
        old: { exists: true, content: "old-memory" },
        new: { exists: true, content: "new-memory" },
      },
      {
        document: "USER.md",
        old: { exists: true, content: "old-user" },
        new: { exists: true, content: "new-user" },
      },
    ],
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return Object.fromEntries(Object.entries(value));
}
