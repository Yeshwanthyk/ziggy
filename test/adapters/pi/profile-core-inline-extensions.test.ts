import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshProfileMemory } from "ziggy/adapters/pi/profile-core-inline-extensions";
import type { MemoryDocument } from "ziggy/domain/memory";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("Profile memory is reread for each Pi turn rather than pinned at runtime creation", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-memory-refresh-"));

  roots.push(profilePath);

  const absolutePath = join(profilePath, "MEMORY.md");

  const documents: ReadonlyArray<MemoryDocument> = [
    {
      scope: "shared",
      relativePath: "MEMORY.md",
      absolutePath,
      cap: 12_000,
      heading: "Shared memory",
    },
  ];

  await writeFile(absolutePath, "First durable fact");
  const first = await refreshProfileMemory(profilePath, documents, { systemPrompt: "base" });

  await writeFile(absolutePath, "Second durable fact");
  const second = await refreshProfileMemory(profilePath, documents, { systemPrompt: "base" });

  expect(first.systemPrompt).toContain("First durable fact");
  expect(second.systemPrompt).toContain("Second durable fact");
  expect(second.systemPrompt).not.toContain("First durable fact");
});

test("a replaced memory symlink is refused instead of read on a later Pi turn", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-memory-symlink-"));

  roots.push(profilePath);

  const absolutePath = join(profilePath, "MEMORY.md");
  const privatePath = join(profilePath, "private.md");

  const documents: ReadonlyArray<MemoryDocument> = [
    {
      scope: "shared",
      relativePath: "MEMORY.md",
      absolutePath,
      cap: 12_000,
      heading: "Shared memory",
    },
  ];

  await writeFile(absolutePath, "Safe fact");
  await writeFile(privatePath, "Do not expose this private text");
  await refreshProfileMemory(profilePath, documents, { systemPrompt: "base" });
  await rm(absolutePath);
  await symlink(privatePath, absolutePath);

  const refreshed = await refreshProfileMemory(profilePath, documents, { systemPrompt: "base" });

  expect(refreshed.systemPrompt).toContain("PROFILE MEMORY UNAVAILABLE FOR THIS TURN");
  expect(refreshed.systemPrompt).not.toContain("Do not expose this private text");
});
