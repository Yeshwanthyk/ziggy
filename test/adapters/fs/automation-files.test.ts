/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute adapter Effects */
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import {
  discoverAutomationSources,
  installAutomationDefinition,
  removeAutomationDefinition,
  pauseAutomationDefinition,
  resumeAutomationDefinition,
} from "ziggy/adapters/fs/automation-files";
import { validateAutomationId } from "ziggy/domain/automation";

const paths: Array<string> = [];
const source = Buffer.from(
  "---\r\nversion: 1\r\ncron: 0 9 * * *\r\ntimezone: UTC\r\nbroadcast: none\r\n---\r\n\r\nExact bytes: π\r\n",
);

const profile = async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-automation-files-"));
  paths.push(path);
  await mkdir(join(path, "automations"));
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  return { path, name: "Test" };
};

const id = () => Effect.runPromise(validateAutomationId("daily"));

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("automation filename lifecycle adapter", () => {
  test("installs an extension-owned definition exclusively without rewriting a collision", async () => {
    const target = await profile();
    const owned =
      "---\nversion: 1\nowner: extension:self-improvement\ncron: 0 3 * * *\ntimezone: UTC\ngate: test -f .runtime/self-improvement/curator-ready\nbroadcast: none\n---\n\nCurate durable learnings.\n";

    const installed = await Effect.runPromise(
      installAutomationDefinition(target, await id(), owned),
    );
    expect(installed).toEqual({
      path: join(target.path, "automations", "daily.md"),
      source: owned,
      lifecycle: "active",
    });
    expect(await readFile(installed.path, "utf8")).toBe(owned);

    const duplicate = await Effect.runPromiseExit(
      installAutomationDefinition(target, await id(), "replacement\n"),
    );
    expect(Exit.isFailure(duplicate)).toBeTrue();
    expect(await readFile(installed.path, "utf8")).toBe(owned);
  });

  test("removes an exact active definition and leaves no paused form behind", async () => {
    const target = await profile();
    const installed = await Effect.runPromise(
      installAutomationDefinition(target, await id(), source.toString("utf8")),
    );

    await Effect.runPromise(
      removeAutomationDefinition(target, await id(), source.toString("utf8")),
    );

    await expect(readFile(installed.path)).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      readFile(join(target.path, "automations", "daily.paused.md")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  test("refuses changed or unrelated active bytes without removing them", async () => {
    const target = await profile();
    const active = join(target.path, "automations", "daily.md");
    const changed = Buffer.from("changed after install\n");
    await writeFile(active, changed);

    const changedResult = await Effect.runPromise(
      removeAutomationDefinition(target, await id(), source.toString("utf8")).pipe(Effect.result),
    );
    expect(changedResult).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AutomationEditConflict", id: "daily", path: active },
    });
    expect(await readFile(active)).toEqual(changed);

    const unrelated = Buffer.from("unrelated definition\n");
    await writeFile(active, unrelated);
    const unrelatedResult = await Effect.runPromise(
      removeAutomationDefinition(target, await id(), changed.toString("utf8")).pipe(Effect.result),
    );
    expect(unrelatedResult).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AutomationEditConflict", id: "daily", path: active },
    });
    expect(await readFile(active)).toEqual(unrelated);
  });

  test("refuses symlinked and paused definitions without removing either target", async () => {
    const target = await profile();
    const active = join(target.path, "automations", "daily.md");
    const paused = join(target.path, "automations", "daily.paused.md");
    const outside = await mkdtemp(join(tmpdir(), "ziggy-automation-remove-outside-"));
    paths.push(outside);
    const outsidePath = join(outside, "daily.md");
    await writeFile(outsidePath, source);
    await symlink(outsidePath, active);

    const symlinkResult = await Effect.runPromise(
      removeAutomationDefinition(target, await id(), source.toString("utf8")).pipe(Effect.result),
    );
    expect(symlinkResult).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AutomationFileSystemError", path: active },
    });
    expect((await lstat(active)).isSymbolicLink()).toBeTrue();
    expect(await readFile(outsidePath)).toEqual(source);

    await rm(active);
    await writeFile(paused, source);
    const pausedResult = await Effect.runPromise(
      removeAutomationDefinition(target, await id(), source.toString("utf8")).pipe(Effect.result),
    );
    expect(pausedResult).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AutomationNotFound", id: "daily", path: active },
    });
    expect(await readFile(paused)).toEqual(source);
  });

  test("pause and resume preserve exact Markdown bytes without replacement", async () => {
    const target = await profile();
    const active = join(target.path, "automations", "daily.md");
    const paused = join(target.path, "automations", "daily.paused.md");
    await writeFile(active, source);

    const pausedResult = await Effect.runPromise(pauseAutomationDefinition(target, await id()));
    expect(pausedResult.lifecycle).toBe("paused");
    expect(Buffer.from(await readFile(paused))).toEqual(source);
    await expect(readFile(active)).rejects.toHaveProperty("code", "ENOENT");

    const resumed = await Effect.runPromise(resumeAutomationDefinition(target, await id()));
    expect(resumed.lifecycle).toBe("active");
    expect(Buffer.from(await readFile(active))).toEqual(source);
    await expect(readFile(paused)).rejects.toHaveProperty("code", "ENOENT");
  });

  test("refuses an existing destination and reports one conflict observation", async () => {
    const target = await profile();
    const active = join(target.path, "automations", "daily.md");
    const paused = join(target.path, "automations", "daily.paused.md");
    await writeFile(active, source);
    await writeFile(paused, "different\n");

    const exit = await Effect.runPromiseExit(pauseAutomationDefinition(target, await id()));
    expect(Exit.isFailure(exit)).toBeTrue();
    expect(await readFile(active)).toEqual(source);
    expect(await readFile(paused, "utf8")).toBe("different\n");
    const observations = await Effect.runPromise(discoverAutomationSources(target));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.lifecycle).toBe("conflict");
    expect(observations[0]?.error).toContain("conflicting active and paused");
  });

  test("keeps both names visible when source cleanup fails", async () => {
    const target = await profile();
    const active = join(target.path, "automations", "daily.md");
    const paused = join(target.path, "automations", "daily.paused.md");
    await writeFile(active, source);

    const exit = await Effect.runPromiseExit(
      pauseAutomationDefinition(target, await id(), {
        removeSource: () => Effect.fail("simulated unlink failure"),
      }),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
    expect(Buffer.from(await readFile(active))).toEqual(source);
    expect(Buffer.from(await readFile(paused))).toEqual(source);
    expect((await Effect.runPromise(discoverAutomationSources(target)))[0]?.lifecycle).toBe(
      "conflict",
    );
  });

  test("rejects symlinked roots and definition files", async () => {
    const target = await profile();
    const outside = await mkdtemp(join(tmpdir(), "ziggy-automation-outside-"));
    paths.push(outside);
    await writeFile(join(outside, "daily.md"), source);
    await rm(join(target.path, "automations"), { recursive: true });
    await symlink(outside, join(target.path, "automations"));
    expect(
      Exit.isFailure(await Effect.runPromiseExit(discoverAutomationSources(target))),
    ).toBeTrue();

    await rm(join(target.path, "automations"));
    await mkdir(join(target.path, "automations"));
    await symlink(join(outside, "daily.md"), join(target.path, "automations", "daily.md"));
    const rows = await Effect.runPromise(discoverAutomationSources(target));
    expect(rows[0]?.source).toBeNull();
    expect(rows[0]?.error).toContain("not a physical file");

    const profileLink = `${target.path}-link`;
    paths.push(profileLink);
    await symlink(target.path, profileLink);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          discoverAutomationSources({ path: profileLink, name: "Linked" }),
        ),
      ),
    ).toBeTrue();
  });
});
