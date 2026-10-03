import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ziggy } from "../harness/cli";
import { scratchProfile, sessionFiles, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer, text, tools } from "../harness/provider";
import { readTranscript } from "../harness/transcript";

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

const writeAgent = async (id: string, toolList: string): Promise<void> => {
  await mkdir(join(profile.path, "agents"), { recursive: true });
  await writeFile(
    join(profile.path, "agents", `${id}.md`),
    `---\nversion: 1\ndescription: Looks things up.\ntools: ${toolList}\n---\n\nAGENT_BODY_MARKER research carefully.\n`,
    "utf8",
  );
};

const toolNames = (index: number): ReadonlyArray<string> =>
  (server.request(index).tools ?? []).map((tool) => tool.function.name).toSorted();

describe("agent_run", () => {
  test("makes one child file linked to its parent, running only the declared tools", async () => {
    await writeAgent("researcher", "read");
    server.push(
      tools({ name: "agent_run", arguments: { agent: "researcher", prompt: "find the thing" } }),
      text("CHILD_ANSWER"),
      text("parent done"),
    );

    const result = await ziggy(profile, "run", profile.path, "delegate this");

    expect(result).toEqual({ exitCode: 0, stdout: "parent done\n", stderr: "" });
    expect(server.requests).toHaveLength(3);
    expect(toolNames(1)).toEqual(["read"]);
    expect(server.raw(1)).toContain("AGENT_BODY_MARKER");
    expect(server.toolResults(2)).toContain("CHILD_ANSWER");

    const files = await sessionFiles(profile.path);
    const parentFile = files.find((file) => !file.startsWith("agents/"));
    const childFiles = files.filter((file) => file.startsWith("agents/"));
    expect(childFiles).toHaveLength(1);

    const parent = await readTranscript(profile.path, parentFile ?? "");
    const child = await readTranscript(profile.path, childFiles[0] ?? "");
    expect(childFiles[0]).toStartWith(`agents/${parent.header.id}/`);
    expect(child.header.parentSession).toBe(join(profile.path, "sessions", parent.file));
    expect(child.roles).toEqual(["user", "assistant"]);
  });

  test("keeps the parent's tool result bounded", async () => {
    await writeAgent("researcher", "read");
    const long = "x".repeat(20_000);
    server.push(
      tools({ name: "agent_run", arguments: { agent: "researcher", prompt: "go long" } }),
      text(long),
      text("parent done"),
    );

    await ziggy(profile, "run", profile.path, "delegate this");
    expect(server.toolResults(2).length).toBeLessThan(4_000);
    expect(server.toolResults(2)).toContain(
      "[answer truncated; the full answer is in the child session",
    );
  });

  test.each(["reed", "profile_extensions"])(
    "agent_run refuses an agent declaring %s before the child reaches the model",
    async (bad) => {
      await writeAgent("researcher", `read, ${bad}`);
      server.push(
        tools({ name: "agent_run", arguments: { agent: "researcher", prompt: "go" } }),
        text("parent done"),
      );

      const result = await ziggy(profile, "run", profile.path, "delegate this");

      expect(result.exitCode).toBe(0);
      expect(server.requests).toHaveLength(2);
      expect(server.toolResults(1)).toContain(
        `tool is unavailable to Profile agent researcher: ${bad}`,
      );
      expect(
        (await sessionFiles(profile.path)).filter((file) => file.startsWith("agents/")),
      ).toEqual([]);
    },
  );
});

describe("agent_discuss", () => {
  test("runs sorted agents for two rounds, one child file each, with no child tools", async () => {
    await writeAgent("zeta", "read");
    await writeAgent("alpha", "read");
    server.push(
      tools({
        name: "agent_discuss",
        arguments: { topic: "pick one", agents: ["zeta", "alpha"], rounds: 2 },
      }),
      text("ALPHA_ONE"),
      text("ZETA_ONE"),
      text("ALPHA_TWO"),
      text("ZETA_TWO"),
      text("parent done"),
    );

    const result = await ziggy(profile, "run", profile.path, "discuss this");

    expect(result).toEqual({ exitCode: 0, stdout: "parent done\n", stderr: "" });
    expect(server.requests).toHaveLength(6);

    for (const index of [1, 2, 3, 4]) expect(toolNames(index)).toEqual([]);

    expect(server.raw(1)).toContain("the alpha specialist");
    expect(server.raw(2)).toContain("the zeta specialist");
    expect(server.raw(3)).toContain("ZETA_ONE");
    expect(server.toolResults(5)).toContain("ZETA_TWO");

    const files = await sessionFiles(profile.path);
    const parentFile = files.find((file) => !file.startsWith("agents/"));
    const parent = await readTranscript(profile.path, parentFile ?? "");
    const childFiles = files.filter((file) => file.startsWith(`agents/${parent.header.id}/`));
    expect(childFiles).toHaveLength(4);
  });

  test("refuses duplicate agents before any child runs", async () => {
    await writeAgent("alpha", "read");
    server.push(
      tools({ name: "agent_discuss", arguments: { topic: "t", agents: ["alpha", "alpha"] } }),
      text("parent done"),
    );

    await ziggy(profile, "run", profile.path, "discuss this");

    expect(server.requests).toHaveLength(2);
    expect(server.toolResults(1)).toContain("requires unique Profile agent ids");
  });
});
