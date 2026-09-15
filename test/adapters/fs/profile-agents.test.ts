/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute filesystem Effects */
import { afterEach, expect, test } from "bun:test";
import { Effect, Predicate, Result } from "effect";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProfileAgents,
  readProfileAgent,
  replaceProfileAgentFile,
} from "ziggy/adapters/fs/profile-agents";

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

test("reads and atomically replaces an exact physical agent source", async () => {
  const profilePath = await profile();
  const targetPath = join(profilePath, "agents", "researcher.md");
  const original = agentFile("Researcher", "Research first.");
  const edited = agentFile("Research specialist", "Cite primary sources.");
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(targetPath, original, "utf8");

  expect(await Effect.runPromise(readProfileAgent(profilePath, "researcher"))).toMatchObject({
    path: targetPath,
    source: original,
    agent: { id: "researcher", description: "Researcher", body: "Research first." },
  });
  const saved = await Effect.runPromise(
    replaceProfileAgentFile(profilePath, "researcher", original, edited),
  );

  expect(saved).toMatchObject({
    path: targetPath,
    source: edited,
    agent: { id: "researcher", description: "Research specialist" },
  });
  expect(await readFile(targetPath, "utf8")).toBe(edited);
});

test("rejects a stale source without overwriting the current agent", async () => {
  const profilePath = await profile();
  const targetPath = join(profilePath, "agents", "researcher.md");
  const current = agentFile("Current");
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(targetPath, current, "utf8");

  const result = await Effect.runPromise(
    replaceProfileAgentFile(
      profilePath,
      "researcher",
      agentFile("Stale"),
      agentFile("Replacement"),
    ).pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileAgentEditConflict", id: "researcher", path: targetPath },
  });
  expect(await readFile(targetPath, "utf8")).toBe(current);
});

test("serializes concurrent saves so only one matching source can win", async () => {
  const profilePath = await profile();
  const targetPath = join(profilePath, "agents", "researcher.md");
  const original = agentFile("Original");
  const first = agentFile("First");
  const second = agentFile("Second");
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(targetPath, original, "utf8");

  const outcomes = await Promise.allSettled([
    Effect.runPromise(replaceProfileAgentFile(profilePath, "researcher", original, first)),
    Effect.runPromise(replaceProfileAgentFile(profilePath, "researcher", original, second)),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: { _tag: "ProfileAgentEditConflict", id: "researcher", path: targetPath },
  });
  expect([first, second]).toContain(await readFile(targetPath, "utf8"));
});

test("validates the full submitted source before preserving the current file", async () => {
  const profilePath = await profile();
  const targetPath = join(profilePath, "agents", "researcher.md");
  const current = agentFile("Current");
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(targetPath, current, "utf8");

  const result = await Effect.runPromise(
    replaceProfileAgentFile(profilePath, "researcher", current, "missing frontmatter\n").pipe(
      Effect.result,
    ),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileAgentInvalid", path: targetPath },
  });
  expect(await readFile(targetPath, "utf8")).toBe(current);
});

test("rejects document reads and saves through symlinked agent paths", async () => {
  const profilePath = await profile();
  const externalPath = join(profilePath, "external.md");
  const linkedPath = join(profilePath, "agents", "researcher.md");
  const source = agentFile("External");
  await mkdir(join(profilePath, "agents"), { recursive: true });
  await writeFile(externalPath, source, "utf8");
  await symlink(externalPath, linkedPath, "file");

  for (const operation of [
    readProfileAgent(profilePath, "researcher"),
    replaceProfileAgentFile(profilePath, "researcher", source, agentFile("Edited")),
  ]) {
    const result = await Effect.runPromise(operation.pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProfileAgentInvalid", path: linkedPath },
    });
  }
  expect(await readFile(externalPath, "utf8")).toBe(source);
});
