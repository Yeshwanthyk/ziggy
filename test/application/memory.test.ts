/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- fixture cleanup requires finally */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { memoryFiles } from "ziggy/adapters/fs/memory-files";
import { makeMemory } from "ziggy/application/memory";
import {
  MEMORY_ENTRY_DELIMITER,
  codePointLength,
  parseMemoryScopeReference,
} from "ziggy/domain/memory";
import { decodeCliCommand } from "ziggy/faces/cli";

test("memory inventory excludes README, counts Unicode code points, and distinguishes empty", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-memory-application-"));
  try {
    await mkdir(join(profilePath, "memory", "users"), { recursive: true });
    await mkdir(join(profilePath, "memory", "groups"), { recursive: true });
    await writeFile(join(profilePath, "MEMORY.md"), "");
    await writeFile(join(profilePath, "memory", "README.md"), "not admitted\n".repeat(2_000));
    const content = `emoji 😀${MEMORY_ENTRY_DELIMITER}second`;
    await writeFile(join(profilePath, "memory", "users", "alice.md"), content);
    await writeFile(join(profilePath, "memory", "groups", "team.md"), "group fact\n");

    const listed = await Effect.runPromise(
      makeMemory(memoryFiles).list({ path: profilePath, name: "Profile" }),
    );
    expect(listed.map((item) => item.document.relativePath)).toEqual([
      "MEMORY.md",
      "memory/groups/team.md",
      "memory/users/alice.md",
    ]);
    expect(listed[0]?.state).toBe("empty");
    const person = listed[2];
    expect(person?.state).toBe("present");
    expect(person?.entries).toEqual(["emoji 😀", "second"]);
    expect(person?.codePoints).toBe(codePointLength(content));
    expect(person?.codePoints).toBeLessThan(content.length);

    const missing = await Effect.runPromise(
      makeMemory(memoryFiles).show(
        { path: profilePath, name: "Profile" },
        parseMemoryScopeReference("user:bob"),
      ),
    );
    expect(missing.state).toBe("missing");
    expect(missing.entries).toEqual([]);
    expect(await readFile(join(profilePath, "memory", "README.md"), "utf8")).toContain(
      "not admitted",
    );
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("memory CLI decodes scope syntax once at the boundary", async () => {
  await expect(
    Effect.runPromise(decodeCliCommand(["memory", "show", "profile", "user:Alice"])),
  ).resolves.toEqual({
    _tag: "MemoryShow",
    target: "profile",
    scope: "user:Alice",
    json: false,
  });
  await expect(
    Effect.runPromise(decodeCliCommand(["memory", "show", "profile", "user:bad/id"])),
  ).rejects.toMatchObject({ _tag: "CliInputInvalid" });
  await expect(
    Effect.runPromise(decodeCliCommand(["memory", "show", "profile", "USER:alice"])),
  ).rejects.toMatchObject({ _tag: "CliInputInvalid" });
  expect(parseMemoryScopeReference("group:Team")).toEqual({ scope: "group", id: "team" });
});

test("memory inventory rejects symlinked documents and wrong-kind roots", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-memory-unsafe-"));
  const externalPath = await mkdtemp(join(tmpdir(), "ziggy-memory-external-"));
  try {
    await symlink(externalPath, join(profilePath, "memory"));
    await expect(
      Effect.runPromise(makeMemory(memoryFiles).list({ path: profilePath, name: "Profile" })),
    ).rejects.toMatchObject({ _tag: "MemoryDocumentInvalid" });

    await rm(join(profilePath, "memory"));
    await mkdir(join(profilePath, "memory", "users"), { recursive: true });
    await mkdir(join(profilePath, "memory", "groups"));
    await writeFile(join(externalPath, "outside.md"), "outside\n");
    await symlink(
      join(externalPath, "outside.md"),
      join(profilePath, "memory", "users", "unsafe.md"),
    );
    await expect(
      Effect.runPromise(makeMemory(memoryFiles).list({ path: profilePath, name: "Profile" })),
    ).rejects.toMatchObject({ _tag: "MemoryDocumentInvalid" });
  } finally {
    await rm(profilePath, { recursive: true, force: true });
    await rm(externalPath, { recursive: true, force: true });
  }
});
