/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures own temporary filesystem setup */
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { makeAutomationDefinitions } from "ziggy/application/automation-definitions";

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

const snapshot = async (root: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  const walk = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = join(prefix, entry.name);
      const path = join(directory, entry.name);
      const status = await lstat(path);
      found.push(
        entry.isDirectory()
          ? `${relative}\tdirectory\t${status.mtimeMs}`
          : `${relative}\tfile\t${status.size}\t${status.mtimeMs}\t${(await readFile(path)).toString("base64")}`,
      );
      if (entry.isDirectory()) await walk(path, relative);
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
      lifecycle: "active",
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

  test("shows and atomically saves only validated Markdown without losing concurrent edits", async () => {
    const target = await profile();
    const created = await Effect.runPromise(service.create(target, "daily"));
    const definitionPath = join(target.path, created.path);
    const original = await readFile(definitionPath, "utf8");
    const next = original.replace("Describe the manual daily task here.", "Send the daily digest.");

    expect(await Effect.runPromise(service.show(target, "daily"))).toEqual({
      id: "daily",
      path: "automations/daily.md",
      lifecycle: "active",
      source: original,
    });
    expect(await Effect.runPromise(service.save(target, "daily", original, next))).toEqual({
      id: "daily",
      path: "automations/daily.md",
      lifecycle: "active",
      source: next,
    });
    expect(await readFile(definitionPath, "utf8")).toBe(next);
    expect((await readdir(join(target.path, "automations"))).sort()).toEqual(["daily.md"]);

    const invalid = next.replace("version: 1", "version: 2");
    expect(
      await Effect.runPromise(service.save(target, "daily", next, invalid).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "AutomationInvalid" } });
    expect(await readFile(definitionPath, "utf8")).toBe(next);

    const external = next.replace("Send the daily digest.", "Externally changed.");
    await writeFile(definitionPath, external);
    expect(
      await Effect.runPromise(service.save(target, "daily", next, original).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "AutomationEditConflict" } });
    expect(await readFile(definitionPath, "utf8")).toBe(external);
  });

  test("pauses and resumes through explicit lifecycle projections without changing bytes", async () => {
    const target = await profile();
    const created = await Effect.runPromise(service.create(target, "daily"));
    const activePath = join(target.path, created.path);
    const bytes = await readFile(activePath);

    const paused = await Effect.runPromise(service.pause(target, "daily"));
    expect(paused.lifecycle).toBe("paused");
    expect(paused.path).toBe("automations/daily.paused.md");
    expect(await readFile(join(target.path, paused.path))).toEqual(bytes);
    expect((await Effect.runPromise(service.list(target)))[0]?.lifecycle).toBe("paused");

    const resumed = await Effect.runPromise(service.resume(target, "daily"));
    expect(resumed.lifecycle).toBe("active");
    expect(await readFile(join(target.path, resumed.path))).toEqual(bytes);
  });

  test("can pause an invalid definition without rewriting or requiring it to parse", async () => {
    const target = await profile();
    await mkdir(join(target.path, "automations"));
    const activePath = join(target.path, "automations", "broken.md");
    await writeFile(activePath, "not valid markdown\n");
    const bytes = await readFile(activePath);

    const paused = await Effect.runPromise(service.pause(target, "broken"));
    expect(paused).toEqual({
      id: "broken",
      path: "automations/broken.paused.md",
      lifecycle: "paused",
    });
    expect(await readFile(join(target.path, paused.path))).toEqual(bytes);
    expect((await Effect.runPromise(service.validate(target, "broken")))[0]).toMatchObject({
      lifecycle: "paused",
      valid: false,
    });
  });

  test("create refuses collision with an existing paused form", async () => {
    const target = await profile();
    await mkdir(join(target.path, "automations"));
    const pausedPath = join(target.path, "automations", "daily.paused.md");
    await writeFile(pausedPath, "human bytes\n");
    expect(Exit.isFailure(await Effect.runPromiseExit(service.create(target, "daily")))).toBeTrue();
    expect(await readFile(pausedPath, "utf8")).toBe("human bytes\n");
  });

  test("list and validate report one explicit conflict and do not mutate files", async () => {
    const target = await profile();
    await Effect.runPromise(service.create(target, "daily"));
    const activePath = join(target.path, "automations", "daily.md");
    const pausedPath = join(target.path, "automations", "daily.paused.md");
    await writeFile(pausedPath, await readFile(activePath));
    const before = await Promise.all([stat(activePath), stat(pausedPath)]);

    const listed = await Effect.runPromise(service.list(target));
    const validated = await Effect.runPromise(service.validate(target));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lifecycle).toBe("conflict");
    expect(listed[0]?.message).toContain("conflicting active and paused");
    expect(validated).toEqual(listed);
    expect(
      (await Promise.all([stat(activePath), stat(pausedPath)])).map((item) => item.mtimeMs),
    ).toEqual(before.map((item) => item.mtimeMs));
  });

  test("lists and validates every sibling in stable order without runtime state", async () => {
    const target = await profile();
    await Effect.runPromise(service.create(target, "zeta"));
    await writeFile(join(target.path, "automations", "broken.md"), "invalid\n");
    await Effect.runPromise(service.create(target, "alpha"));
    const before = await snapshot(target.path);

    const listed = await Effect.runPromise(service.list(target));
    const validated = await Effect.runPromise(service.validate(target));

    expect(listed.map(({ id, valid }) => ({ id, valid }))).toEqual([
      { id: "alpha", valid: true },
      { id: "broken", valid: false },
      { id: "zeta", valid: true },
    ]);
    expect(validated).toEqual(listed);
    expect(validated[1]?.message).toContain("frontmatter must start");
    expect(await snapshot(target.path)).toEqual(before);
    expect(before.some((item) => item.startsWith(".runtime"))).toBeFalse();
  });
});
