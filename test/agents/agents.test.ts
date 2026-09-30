/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- fixture cleanup requires finally */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Option, Predicate, Result } from "effect";
import { SpecialistAgentNotFound } from "ziggy/domain/agent";
import type { ProfileAgent } from "ziggy/domain/profile";
import { localSpecialistSessionDirectory, makeZiggyAgent } from "ziggy/agents/index";
import { agentPersona } from "ziggy/agents/policy";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer, text } from "../harness/provider";

let server: ModelServer;

let profile: ScratchProfile;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  server.stop();
  await profile.remove();
});

const target = () => ({ path: profile.path, name: "harness" });

const writeAgent = async (id: string, frontmatter: string): Promise<void> => {
  await mkdir(join(profile.path, "agents"), { recursive: true });
  await writeFile(
    join(profile.path, "agents", `${id}.md`),
    `---\nversion: 1\ndescription: ${id}\n${frontmatter}---\n\nAGENT_BODY_${id}\n`,
    "utf8",
  );
};

const agent = (tools: ReadonlyArray<string>): ProfileAgent => ({
  id: "helper",
  version: 1,
  description: "Helper",
  tools: [...tools],
  body: "Help.",
});

describe("Profile agent tool policy", () => {
  test("refuses a declared tool that belongs to the calling session, even when narrowed away", () => {
    const persona = agentPersona("/profile", agent(["read", "memory_write"]), []);

    expect(Result.isFailure(persona) && persona.failure.message).toBe(
      "tool is unavailable to Profile agent helper: memory_write",
    );
  });

  test("narrowing only removes declared tools", () => {
    const outside = agentPersona("/profile", agent(["read"]), ["bash"]);

    expect(Result.isFailure(outside) && outside.failure.message).toBe(
      "tool is outside the Profile agent allowlist: bash",
    );
    expect(Result.getOrUndefined(agentPersona("/profile", agent(["read", "read"])))?.tools).toEqual(
      ["read"],
    );
    expect(Result.getOrUndefined(agentPersona("/profile", agent(["read"]), []))?.tools).toEqual([]);
  });
});

describe("direct Profile agent runs", () => {
  test("an unknown agent is refused before any session exists", async () => {
    const directory = join(profile.path, "sessions", "direct");

    const exit = await Effect.runPromiseExit(
      makeZiggyAgent({}).runSpecialist(target(), "missing", "task", {
        sessionDirectory: directory,
      }),
    );

    expect(exit).toEqual(
      Exit.fail(
        new SpecialistAgentNotFound({
          profilePath: profile.path,
          agentId: "missing",
          message: "unknown Profile agent: missing",
        }),
      ),
    );
    expect(await readdir(profile.path)).not.toContain("sessions");
  });

  test("an agent without a model runs on the Profile default in one saved root transcript", async () => {
    await writeAgent("fixture", "tools: read\n");
    server.push(text("saved root answer"));
    const directory = join(profile.path, "sessions", "direct");

    const result = await Effect.runPromise(
      makeZiggyAgent({}).runSpecialist(target(), "fixture", "root task", {
        sessionDirectory: directory,
      }),
    );

    expect(result.answer).toBe("saved root answer");
    expect(server.request(0).model).toBe("harness-model");
    expect((server.request(0).tools ?? []).map((tool) => tool.function.name)).toEqual(["read"]);
    expect(server.raw(0)).toContain("AGENT_BODY_fixture");
    expect(server.raw(0)).not.toContain("SOUL_MARKER");

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(result.session.file).toBe(join(directory, files[0] ?? ""));
    expect(SessionManager.open(result.session.file).getHeader()?.parentSession).toBeUndefined();
    expect(await readFile(result.session.file, "utf8")).toContain("root task");
  });
});

describe("Profile agent rails", () => {
  test("a rail continues one transcript under sessions/local/agents/<id>/ and is held while open", async () => {
    await writeAgent("reviewer", "");
    server.push(text("first"), text("second"));
    const ziggy = makeZiggyAgent({});

    const rail = {
      target: target(),
      context: { kind: "local" as const },
      directory: localSpecialistSessionDirectory(profile.path, "reviewer"),
      session: "continue" as const,
      agent: "reviewer",
    };

    const handle = await Effect.runPromise(ziggy.open(rail));

    try {
      await Effect.runPromise(handle.prompt("first rail turn"));
      const competing = await Effect.runPromiseExit(ziggy.open(rail));

      const message = Exit.isFailure(competing)
        ? Option.getOrUndefined(Cause.findErrorOption(competing.cause))?.message
        : undefined;

      expect(message).toContain("this session is open in another Ziggy process (pid ");
      await Effect.runPromise(handle.prompt("second rail turn"));
    } finally {
      await Effect.runPromise(handle.dispose);
    }

    const files = (await readdir(rail.directory)).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const transcript = await readFile(join(rail.directory, files[0] ?? ""), "utf8");
    expect(transcript).toContain("first rail turn");
    expect(transcript).toContain("second rail turn");
  });

  test("an unknown rail agent is refused before any session exists", async () => {
    const exit = await Effect.runPromiseExit(
      makeZiggyAgent({}).open({
        target: target(),
        context: { kind: "local" },
        directory: localSpecialistSessionDirectory(profile.path, "missing"),
        session: "continue",
        agent: "missing",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readdir(profile.path)).not.toContain("sessions");
  });
});

test("an invalid agent file refuses print and gateway chat before Pi is called", async () => {
  await mkdir(join(profile.path, "agents"), { recursive: true });
  await writeFile(
    join(profile.path, "agents", "broken.md"),
    "---\nversion: 1\ndescription: Broken\n---\n",
    "utf8",
  );
  const ziggy = makeZiggyAgent({});

  const results = await Promise.all([
    Effect.runPromise(
      ziggy.runOnce(target(), "prompt", false, { kind: "local" }, undefined).pipe(Effect.result),
    ),
    Effect.runPromise(
      ziggy
        .open({
          target: target(),
          context: { kind: "local" },
          directory: join(profile.path, "sessions", "gateway"),
          session: "continue",
        })
        .pipe(Effect.result),
    ),
  ]);

  for (const result of results) {
    expect(
      result._tag === "Failure" &&
        Predicate.isTagged(result.failure, "ProfileAgentInvalid") &&
        result.failure.path,
    ).toBe(join(profile.path, "agents", "broken.md"));
  }

  expect(server.requests).toHaveLength(0);
});
