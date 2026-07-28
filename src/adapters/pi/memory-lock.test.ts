import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { memoryEntries } from "../../domain/memory";
import { createMemoryWriteTool } from "./pi-agent";

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
});
