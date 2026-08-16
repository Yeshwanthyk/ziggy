import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { memoryEntries } from "ziggy/domain/memory";
import { createMemoryWriteTool } from "ziggy/adapters/pi/pi-agent";

const temporaryProfiles: Array<string> = [];

const temporaryProfile = async (): Promise<string> => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-memory-"));
  temporaryProfiles.push(profilePath);
  return profilePath;
};

const resultText = (
  result: Awaited<ReturnType<ReturnType<typeof createMemoryWriteTool>["execute"]>>,
): string => {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("expected a text tool result");
  }
  return content.text;
};

const memoryLockPath = (profilePath: string, relativePath: string): string =>
  join(profilePath, ".runtime", "memory-locks", `${encodeURIComponent(relativePath)}.sqlite`);

const expectMemoryLockAvailable = (profilePath: string, relativePath: string): void => {
  const database = new Database(memoryLockPath(profilePath, relativePath), { create: true });
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    expect(database.inTransaction).toBeTrue();
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryProfiles.splice(0).map((profilePath) => rm(profilePath, { recursive: true })),
  );
});

describe("memory_write locking", () => {
  test("two concurrent add batches both survive and release the lock", async () => {
    const profilePath = await temporaryProfile();
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });

    const [first, second] = await Promise.all([
      tool.execute(
        "first",
        { scope: "shared", operations: [{ action: "add", content: "first entry" }] },
        undefined,
        undefined,
        Object.create(null),
      ),
      tool.execute(
        "second",
        { scope: "shared", operations: [{ action: "add", content: "second entry" }] },
        undefined,
        undefined,
        Object.create(null),
      ),
    ]);

    expect(resultText(first)).toContain("applied 1 operation(s)");
    expect(resultText(second)).toContain("applied 1 operation(s)");
    expect(
      [...memoryEntries(await readFile(join(profilePath, "MEMORY.md"), "utf8"))].sort(),
    ).toEqual(["first entry", "second entry"]);
    expectMemoryLockAvailable(profilePath, "MEMORY.md");
    await expect(stat(join(profilePath, "MEMORY.md.lock.sqlite"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  test("interruption while waiting for the lock closes the waiting database", async () => {
    const profilePath = await temporaryProfile();
    const lockPath = memoryLockPath(profilePath, "MEMORY.md");
    await mkdir(join(profilePath, ".runtime", "memory-locks"), { recursive: true });
    const holder = new Database(lockPath, { create: true });
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const controller = new AbortController();
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });
    const pending = tool.execute(
      "interrupted",
      { scope: "shared", operations: [{ action: "add", content: "must not persist" }] },
      controller.signal,
      undefined,
      Object.create(null),
    );
    await Bun.sleep(75);

    controller.abort();
    await expect(pending).rejects.toBeDefined();
    holder.exec("ROLLBACK");
    holder.close();

    expectMemoryLockAvailable(profilePath, "MEMORY.md");
    await expect(readFile(join(profilePath, "MEMORY.md"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  test("overflow leaves the document untouched", async () => {
    const profilePath = await temporaryProfile();
    const memoryPath = join(profilePath, "MEMORY.md");
    const initial = "existing entry\n";
    await writeFile(memoryPath, initial, "utf8");
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });
    const oversized = "x".repeat(2_200);

    const result = await tool.execute(
      "overflow",
      { scope: "shared", operations: [{ action: "add", content: oversized }] },
      undefined,
      undefined,
      Object.create(null),
    );

    expect(resultText(result)).toContain("ERROR: memory full:");
    expect(await readFile(memoryPath, "utf8")).toBe(initial);
    expectMemoryLockAvailable(profilePath, "MEMORY.md");
  });

  test("a connection teardown releases the lock without explicit cleanup", async () => {
    const profilePath = await temporaryProfile();
    const memoryPath = join(profilePath, "MEMORY.md");
    const lockPath = memoryLockPath(profilePath, "MEMORY.md");
    await mkdir(join(profilePath, ".runtime", "memory-locks"), { recursive: true });
    const abandoned = new Database(lockPath, { create: true });
    abandoned.exec("BEGIN IMMEDIATE");
    abandoned.close();
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });

    const result = await tool.execute(
      "after-teardown",
      { scope: "shared", operations: [{ action: "add", content: "recovered entry" }] },
      undefined,
      undefined,
      Object.create(null),
    );

    expect(resultText(result)).toContain("applied 1 operation(s)");
    expect([...memoryEntries(await readFile(memoryPath, "utf8"))]).toEqual(["recovered entry"]);
    expectMemoryLockAvailable(profilePath, "MEMORY.md");
  });

  test("backs up exact prior bytes with private permissions before an existing-file mutation", async () => {
    const profilePath = await temporaryProfile();
    const memoryPath = join(profilePath, "MEMORY.md");
    const initial = Buffer.from("prior 😀\n", "utf8");
    await writeFile(memoryPath, initial);
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });

    const result = await tool.execute(
      "backup",
      { scope: "shared", operations: [{ action: "add", content: "next" }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(result)).toContain("applied 1 operation(s)");

    const backupDirectory = join(profilePath, ".runtime", "memory-backups", "MEMORY.md");
    const backups = await readdir(backupDirectory);
    expect(backups).toHaveLength(1);
    const backupName = backups[0];
    if (backupName === undefined) throw new Error("expected one memory backup");
    const backupPath = join(backupDirectory, backupName);
    expect(await readFile(backupPath)).toEqual(initial);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  });

  test("does not create backups for missing, no-op, rejected, or overflow writes", async () => {
    const profilePath = await temporaryProfile();
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });
    const missing = await tool.execute(
      "missing",
      { scope: "shared", operations: [{ action: "add", content: "first" }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(missing)).toContain("applied 1 operation(s)");
    expect((await stat(join(profilePath, "MEMORY.md"))).mode & 0o777).toBe(0o600);
    await expect(stat(join(profilePath, ".runtime", "memory-backups"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );

    const noOp = await tool.execute(
      "no-op",
      { scope: "shared", operations: [{ action: "add", content: "first" }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(noOp)).toBe("no change");
    const rejected = await tool.execute(
      "rejected",
      { scope: "shared", operations: [{ action: "add", content: "bad\n§\nentry" }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(rejected)).toContain("ERROR:");
    const overflow = await tool.execute(
      "overflow",
      { scope: "shared", operations: [{ action: "add", content: "x".repeat(2_200) }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(overflow)).toContain("ERROR: memory full:");
    await expect(stat(join(profilePath, ".runtime", "memory-backups"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  test("retains only the newest ten backups", async () => {
    const profilePath = await temporaryProfile();
    const memoryPath = join(profilePath, "MEMORY.md");
    await writeFile(memoryPath, "entry 0\n");
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });
    for (let index = 1; index <= 11; index += 1) {
      const result = await tool.execute(
        `write-${index}`,
        { scope: "shared", operations: [{ action: "add", content: `entry ${index}` }] },
        undefined,
        undefined,
        Object.create(null),
      );
      expect(resultText(result)).toContain("applied 1 operation(s)");
    }
    const backups = await readdir(join(profilePath, ".runtime", "memory-backups", "MEMORY.md"));
    expect(backups).toHaveLength(10);
  });

  test("backup failures block publication and memory symlinks are rejected", async () => {
    const profilePath = await temporaryProfile();
    const memoryPath = join(profilePath, "MEMORY.md");
    const initial = "prior\n";
    await writeFile(memoryPath, initial);
    await mkdir(join(profilePath, ".runtime", "memory-backups"), { recursive: true });
    await writeFile(join(profilePath, ".runtime", "memory-backups", "MEMORY.md"), "not a dir\n");
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });
    const blocked = await tool.execute(
      "blocked",
      { scope: "shared", operations: [{ action: "add", content: "must not publish" }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(blocked)).toContain("ERROR: memory backup failed");
    expect(await readFile(memoryPath, "utf8")).toBe(initial);

    const elsewhere = join(profilePath, "elsewhere.md");
    await writeFile(elsewhere, initial);
    await rm(memoryPath);
    await symlink(elsewhere, memoryPath);
    const rejected = await tool.execute(
      "symlink",
      { scope: "shared", operations: [{ action: "add", content: "must reject" }] },
      undefined,
      undefined,
      Object.create(null),
    );
    expect(resultText(rejected)).toContain("ERROR: memory write failed");
    expect(await readFile(elsewhere, "utf8")).toBe(initial);
  });

  test("a failure after the backup temp write leaves no partial final backup", async () => {
    const profilePath = await temporaryProfile();
    const memoryPath = join(profilePath, "MEMORY.md");
    const initial = "prior\n";
    await writeFile(memoryPath, initial);
    const backupDirectory = join(profilePath, ".runtime", "memory-backups", "MEMORY.md");
    await mkdir(backupDirectory, { recursive: true });
    const now = new Date("2026-08-15T12:34:56.789Z");
    const collision = `${now.toISOString()}.md`;
    await mkdir(join(backupDirectory, collision));
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });

    setSystemTime(now);
    try {
      const result = await tool.execute(
        "post-write-failure",
        { scope: "shared", operations: [{ action: "add", content: "must not publish" }] },
        undefined,
        undefined,
        Object.create(null),
      );
      expect(resultText(result)).toContain("ERROR: memory backup failed");
    } finally {
      setSystemTime();
    }

    expect(await readFile(memoryPath, "utf8")).toBe(initial);
    expect(await readdir(backupDirectory)).toEqual([collision]);
  });

  test("rejects a symlinked runtime directory before creating a lock outside the Profile", async () => {
    const profilePath = await temporaryProfile();
    const externalPath = await mkdtemp(join(tmpdir(), "ziggy-memory-lock-external-"));
    await symlink(externalPath, join(profilePath, ".runtime"));
    const tool = createMemoryWriteTool(profilePath, { kind: "local" });

    const result = await tool.execute(
      "unsafe-lock",
      { scope: "shared", operations: [{ action: "add", content: "must reject" }] },
      undefined,
      undefined,
      Object.create(null),
    );

    expect(resultText(result)).toContain("ERROR: memory write failed");
    await expect(stat(join(externalPath, "memory-locks"))).rejects.toHaveProperty("code", "ENOENT");
    await rm(externalPath, { recursive: true, force: true });
  });
});
