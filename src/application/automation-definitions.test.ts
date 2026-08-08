/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures own temporary filesystem setup */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { makeAutomationDefinitions } from "./automation-definitions";

const paths: Array<string> = [];
const service = makeAutomationDefinitions();

const profile = async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-automation-definitions-"));
  paths.push(path);
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  return { path, name: "Test" };
};

const tree = async (root: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  const walk = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = join(prefix, entry.name);
      found.push(relative);
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
    }
  };
  await walk(root);
  return found.sort();
};

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("automation definition commands", () => {
  test("creates a valid safe manual-only definition exclusively", async () => {
    const target = await profile();
    const created = await Effect.runPromise(service.create(target, "morning-note"));

    expect(created).toEqual({
      id: "morning-note",
      path: "automations/morning-note.md",
      valid: true,
      schedule: "0 9 * * *",
      timezone: "UTC",
      gateState: "manual-only",
    });
    const definitionPath = join(target.path, created.path);
    const source = await readFile(definitionPath, "utf8");
    expect(source).toContain("broadcast: none");
    expect(source).not.toContain("gate:");
    expect((await Effect.runPromise(service.validate(target, "morning-note")))[0]).toEqual(created);

    const duplicate = await Effect.runPromiseExit(service.create(target, "morning-note"));
    expect(Exit.isFailure(duplicate)).toBeTrue();
    expect(await readFile(definitionPath, "utf8")).toBe(source);
    expect(await tree(target.path)).not.toContain(".runtime");
  });

  test("lists and validates every sibling in stable order without runtime state", async () => {
    const target = await profile();
    await Effect.runPromise(service.create(target, "zeta"));
    await writeFile(join(target.path, "automations", "broken.md"), "invalid\n");
    await Effect.runPromise(service.create(target, "alpha"));
    const before = await tree(target.path);

    const listed = await Effect.runPromise(service.list(target));
    const validated = await Effect.runPromise(service.validate(target));

    expect(listed.map(({ id, valid }) => ({ id, valid }))).toEqual([
      { id: "alpha", valid: true },
      { id: "broken", valid: false },
      { id: "zeta", valid: true },
    ]);
    expect(validated).toEqual(listed);
    expect(validated[1]?.message).toContain("frontmatter must start");
    expect(await tree(target.path)).toEqual(before);
    expect(before).not.toContain(".runtime");
  });
});
