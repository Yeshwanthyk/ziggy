/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute filesystem Effects */
import { afterEach, expect, test } from "bun:test";
import { Effect, Predicate, Result } from "effect";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProfileAgents } from "./profile-agents";

const temporaryPaths: Array<string> = [];

const profile = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-profile-agents-"));
  temporaryPaths.push(root);
  return join(root, "profile");
};

const agentFile = (description: string, body = "Instructions") =>
  `---\nversion: 1\ndescription: ${description}\n---\n\n${body}\n`;

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

test("missing agents directory is an empty successful discovery", async () => {
  const profilePath = await profile();
  await mkdir(profilePath, { recursive: true });

  expect(await Effect.runPromise(discoverProfileAgents(profilePath))).toEqual([]);
});

test("discovers sorted physical Markdown agents with strict metadata", async () => {
  const profilePath = await profile();
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(
    join(profilePath, "agents", "zeta.md"),
    agentFile("Zeta", "Answer directly."),
    "utf8",
  );
  await writeFile(
    join(profilePath, "agents", "alpha.md"),
    `---\nversion: 1\ndescription: Alpha\nprovider: openai\nmodel: gpt-5\nthinking: medium\ntools: read, bash\n---\n\nResearch first.\n`,
    "utf8",
  );

  expect(await Effect.runPromise(discoverProfileAgents(profilePath))).toEqual([
    {
      id: "alpha",
      version: 1,
      description: "Alpha",
      provider: "openai",
      model: "gpt-5",
      thinking: "medium",
      tools: ["read", "bash"],
      body: "Research first.",
    },
    { id: "zeta", version: 1, description: "Zeta", body: "Answer directly." },
  ]);
});

test("invalid files fail clearly and preserve the schema cause", async () => {
  const profilePath = await profile();
  const agentPath = join(profilePath, "agents", "broken.md");
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(
    agentPath,
    `---\nversion: 1\ndescription: Broken\nprovider: openai\n---\n\nMissing model.\n`,
    "utf8",
  );

  const result = await Effect.runPromise(discoverProfileAgents(profilePath).pipe(Effect.result));

  expect(
    Result.match(result, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileAgentInvalid") &&
        error.path === agentPath &&
        error.message.includes("invalid contract") &&
        error.cause !== undefined,
      onSuccess: () => false,
    }),
  ).toBe(true);
});

test("rejects symlinked agents roots and files", async () => {
  const profilePath = await profile();
  const external = join(profilePath, "external");
  await mkdir(profilePath, { recursive: true });
  await mkdir(external, { recursive: true });
  await symlink(external, join(profilePath, "agents"), "dir");

  const rootResult = await Effect.runPromise(
    discoverProfileAgents(profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(rootResult, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileAgentInvalid") &&
        error.path === join(profilePath, "agents"),
      onSuccess: () => false,
    }),
  ).toBe(true);

  await rm(join(profilePath, "agents"));
  await mkdir(join(profilePath, "agents"), { recursive: true });
  const externalFile = join(external, "agent.md");
  const linkedFile = join(profilePath, "agents", "agent.md");
  await writeFile(externalFile, agentFile("External"), "utf8");
  await symlink(externalFile, linkedFile, "file");

  const fileResult = await Effect.runPromise(
    discoverProfileAgents(profilePath).pipe(Effect.result),
  );
  expect(
    Result.match(fileResult, {
      onFailure: (error) =>
        Predicate.isTagged(error, "ProfileAgentInvalid") && error.path === linkedFile,
      onSuccess: () => false,
    }),
  ).toBe(true);
});
