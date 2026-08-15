/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures own temporary filesystem setup */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { makeChatHandle, type ZiggyAgentApi } from "ziggy/application/agent";
import type { ModelsApi } from "ziggy/application/models";
import { makeProfileAgents } from "ziggy/application/profile-agents";

const paths: Array<string> = [];

const profile = async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-agent-cli-"));
  paths.push(path);
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  return { path, name: "Test" };
};

const agentRuntime = (sessionDirectories: Array<string>): ZiggyAgentApi => ({
  runOnce: () => Effect.succeed(0),
  openTui: () => Effect.succeed(0),
  openSpecialistChat: () =>
    Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
  openChat: () =>
    Effect.succeed(
      makeChatHandle({ prompt: () => Effect.succeed("unused"), dispose: Effect.void }),
    ),
  runSpecialist: (_target, agentId, task, context) =>
    Effect.sync(() => {
      sessionDirectories.push(context.sessionDirectory);
      return {
        answer: `${agentId}: ${task}`,
        session: { id: "root", file: join(context.sessionDirectory, "root.jsonl") },
      };
    }),
});

const models: ModelsApi = {
  status: () =>
    Effect.succeed({
      providerId: "openai",
      modelId: "gpt-test",
      thinking: "medium",
      authConfigured: true,
    }),
  readOnlyStatus: () =>
    Effect.succeed({
      providerId: "openai",
      modelId: "gpt-test",
      thinking: "medium",
      authConfigured: true,
    }),
  list: () =>
    Effect.succeed([
      {
        providerId: "openai",
        modelId: "gpt-test",
        name: "Test",
        thinkingLevels: ["low", "medium"],
      },
    ]),
  set: () => Effect.never,
};

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("Profile agent application commands", () => {
  test("creates exclusively, lists stably, and shows metadata without the body", async () => {
    const target = await profile();
    const service = makeProfileAgents(agentRuntime([]), models);

    expect(await Effect.runPromise(service.create(target, "reviewer"))).toEqual({
      id: "reviewer",
      description: "Describe the reviewer specialist.",
      tools: [],
      path: "agents/reviewer.md",
    });
    await mkdir(join(target.path, "agents"), { recursive: true });
    await writeFile(
      join(target.path, "agents", "alpha.md"),
      "---\nversion: 1\ndescription: First\n---\n\nSecret body instructions.\n",
    );

    expect((await Effect.runPromise(service.list(target))).map((agent) => agent.id)).toEqual([
      "alpha",
      "reviewer",
    ]);
    const shown = await Effect.runPromise(service.show(target, "alpha"));
    expect(shown).toEqual({
      id: "alpha",
      description: "First",
      tools: [],
      path: "agents/alpha.md",
    });
    expect(JSON.stringify(shown)).not.toContain("Secret body instructions");

    const before = await readFile(join(target.path, "agents", "reviewer.md"), "utf8");
    const duplicate = await Effect.runPromiseExit(service.create(target, "reviewer"));
    expect(Exit.isFailure(duplicate)).toBeTrue();
    expect(await readFile(join(target.path, "agents", "reviewer.md"), "utf8")).toBe(before);
  });

  test("validates parse and safely checkable runtime policy per file", async () => {
    const target = await profile();
    await mkdir(join(target.path, "agents"));
    await writeFile(
      join(target.path, "agents", "good.md"),
      "---\nversion: 1\ndescription: Good\n---\n\nWork.\n",
    );
    await writeFile(
      join(target.path, "agents", "blocked.md"),
      "---\nversion: 1\ndescription: Blocked\ntools: agent_run\n---\n\nWork.\n",
    );
    await writeFile(join(target.path, "agents", "broken.md"), "not frontmatter\n");

    const validation = await Effect.runPromise(
      makeProfileAgents(agentRuntime([]), models).validate(target),
    );
    expect(validation.map(({ id, valid }) => ({ id, valid }))).toEqual([
      { id: "blocked", valid: false },
      { id: "broken", valid: false },
      { id: "good", valid: true },
    ]);
    expect(validation[0]?.message).toContain("tool is unavailable");
    expect(validation[1]?.message).toContain("missing frontmatter");
  });

  test("direct run delegates to the persistent root specialist operation", async () => {
    const target = await profile();
    const directories: Array<string> = [];
    const result = await Effect.runPromise(
      makeProfileAgents(agentRuntime(directories), models).run(target, "reviewer", "check this"),
    );

    expect(result.answer).toBe("reviewer: check this");
    expect(directories).toHaveLength(1);
    expect(directories[0]).toStartWith(join(target.path, "sessions", "agents", "reviewer"));
    expect(result.session.file).toStartWith(directories[0] ?? "missing-session-directory");
  });
});
