import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startChatServer } from "../harness/chat";
import { ziggy, ziggyWith } from "../harness/cli";
import { scratchProfile, sessionFiles, type ScratchProfile } from "../harness/profile";
import { gate, held, type ModelServer, startModelServer, text, tools } from "../harness/provider";
import { eventually } from "../harness/eventually";
import { startResident, stopResidents } from "../harness/resident";
import { onlyTranscript, readTranscript, sessionId } from "../harness/transcript";

let server: ModelServer;

let profile: ScratchProfile;

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  await stopResidents();
  server.stop();
  await profile.remove();
});

const writeAutomation = async (target: string, cron = "0 9 * * *"): Promise<void> => {
  await mkdir(join(profile.path, "automations"), { recursive: true });
  await writeFile(
    join(profile.path, "automations", "digest.md"),
    `---\nversion: 1\ncron: ${cron}\ntimezone: UTC\nbroadcast: conversation:${target}\n---\n\nWrite the digest.\n`,
    "utf8",
  );
};

const receipts = async (file: string): Promise<number> => {
  const transcript = await readTranscript(profile.path, file);

  return transcript.entries.filter((entry) => entry.customType === "ziggy.automation-result")
    .length;
};

/** One conversation made by a plain `run`, so it has a header id to target. */
const conversation = async (): Promise<{ file: string; id: string }> => {
  await ziggy(profile, "run", profile.path, "start");
  const transcript = await onlyTranscript(profile.path);

  return { file: transcript.file, id: sessionId(transcript) };
};

/** A conversation moved into the web session directory, so the UI can resume it. */
const webConversation = async (): Promise<{ file: string; id: string }> => {
  await ziggy(profile, "run", profile.path, "start");
  const [file] = (await sessionFiles(profile.path)).filter((path) => !path.includes("/"));

  if (file === undefined) throw new Error("run left no top-level session file");
  const moved = join("local", "main", file);
  await mkdir(join(profile.path, "sessions", "local", "main"), { recursive: true });
  await rename(join(profile.path, "sessions", file), join(profile.path, "sessions", moved));

  return { file: moved, id: sessionId(await readTranscript(profile.path, moved)) };
};

describe("automation delivery", () => {
  test("with no resident, each wake stores one receipt in the target conversation", async () => {
    const target = await conversation();
    await writeAutomation(target.id);
    server.push(text("DIGEST_ONE"), text("DIGEST_TWO"));

    const first = await ziggy(profile, "wake", profile.path, "digest");
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain(`wake delivered: conversation:${target.id}`);
    expect(await receipts(target.file)).toBe(1);

    await ziggy(profile, "wake", profile.path, "digest");
    expect(await receipts(target.file)).toBe(2);
    const stored = await readFile(join(profile.path, "sessions", target.file), "utf8");
    expect(stored).toContain("DIGEST_ONE");
    expect(stored).toContain("DIGEST_TWO");
  });

  test("with a resident up, wake is forwarded and stores the receipt in an unopened conversation", async () => {
    const target = await conversation();
    await writeAutomation(target.id);
    await startResident(profile);
    server.push(text("DIGEST_STORED"));

    const woke = await ziggy(profile, "wake", profile.path, "digest");
    expect(woke.stderr).toContain(`wake delivered: conversation:${target.id}`);
    expect(await stopResidents()).toEqual([0]);
    expect(await receipts(target.file)).toBe(1);
  });

  test("a live idle conversation gets the result as an event and one receipt", async () => {
    const resident = await startResident(profile);
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.watchSession(ref);
    await client.gateway.submitPrompt(ref, "start");
    await eventually("settled", () => client.events.find((event) => event.event === "settled"));
    const target = await onlyTranscript(profile.path);
    await writeAutomation(sessionId(target));
    server.push(text("DIGEST_LIVE"));

    await client.gateway.runAutomation(client.profileId, "digest");

    const event = await eventually("automation-result", () =>
      client.events.find((candidate) => candidate.event === "automation-result"),
    );

    expect(JSON.stringify(event)).toContain("DIGEST_LIVE");
    expect(await resident.stop()).toBe(0);
    expect(await receipts(target.file)).toBe(1);
  });

  test("a busy conversation is refused as retriable and not written mid-turn", async () => {
    const hold = gate();
    const resident = await startResident(profile);
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.watchSession(ref);
    await client.gateway.submitPrompt(ref, "start");
    await eventually("settled", () => client.events.find((event) => event.event === "settled"));
    const target = await onlyTranscript(profile.path);
    await writeAutomation(sessionId(target));
    server.push(held("partial", "done", hold), text("DIGEST_BUSY"));

    await client.gateway.submitPrompt(ref, "keep going");
    await hold.started;
    const outcome = await client.gateway.runAutomation(client.profileId, "digest");
    expect(JSON.stringify(outcome)).toContain("session-busy");

    hold.release();
    await eventually(
      "second settle",
      () => client.events.filter((event) => event.event === "settled").length >= 2,
    );
    expect(await resident.stop()).toBe(0);
    expect(await receipts(target.file)).toBe(0);
  });

  test("a conversation the UI switched away from gets the stored receipt", async () => {
    const target = await webConversation();
    const other = await webConversation();
    await writeAutomation(target.id);
    const resident = await startResident(profile);
    const client = await resident.connect();
    const ref = await client.gateway.openMain(client.profileId);
    await client.gateway.resumeSession(ref, target.id);
    await client.gateway.resumeSession(ref, other.id);
    server.push(text("DIGEST_SWITCHED"));

    const outcome = await client.gateway.runAutomation(client.profileId, "digest");

    expect(outcome.runOutcome).toEqual({
      kind: "executed",
      delivery: {
        kind: "resolved",
        targets: [{ target: expect.any(String), status: "delivered" }],
      },
    });
    expect(await resident.stop()).toBe(0);
    expect(await receipts(target.file)).toBe(1);
  });

  // Effect's Cron.next throws for a cron that parses but never fires; parsing rejects it instead.
  test("a resident starts even when an automation's cron never fires", async () => {
    const target = await conversation();
    await writeAutomation(target.id, "0 0 31 2 *");

    await startResident(profile, 1_500);
    expect(await stopResidents()).toEqual([0]);
  });
});

test("wake delivers to a Slack thread, a Discord thread and a Telegram chat, chunked per gateway", async () => {
  const chat = startChatServer();

  try {
    const config = (name: string, value: Readonly<Record<string, string | number>>) =>
      writeFile(join(profile.path, name), JSON.stringify(value), "utf8");

    await config("slack.json", { botToken: "xoxb-s", appToken: "xapp-s", ownerUserId: "U1" });
    await config("discord.json", { botToken: "discord-token", ownerUserId: "123" });
    await config("telegram.json", { botToken: "telegram-token", ownerUserId: 123 });
    await mkdir(join(profile.path, "automations"), { recursive: true });
    await writeFile(
      join(profile.path, "automations", "digest.md"),
      "---\nversion: 1\ncron: 0 9 * * *\ntimezone: UTC\nbroadcast: slack:channel:C0123ABCDE:thread:1700000000.000100,discord:channel:111222333,telegram:chat:2\n---\n\nWrite the digest.\n",
      "utf8",
    );
    const reply = "d".repeat(2_500);
    server.push(text(reply));

    const result = await ziggyWith(profile, chat.env, "wake", profile.path, "digest");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "wake delivered: slack:channel:C0123ABCDE:thread:1700000000.000100",
    );

    expect(chat.posts.map((post) => [post.gateway, post.path])).toEqual([
      ["slack", "/chat.postMessage"],
      ["discord", "/channels/111222333/messages"],
      ["discord", "/channels/111222333/messages"],
      ["telegram", "/bottelegram-token/sendMessage"],
    ]);
    expect(chat.posts[0]?.body).toMatchObject({
      channel: "C0123ABCDE",
      thread_ts: "1700000000.000100",
      markdown_text: reply,
    });
    expect(chat.posts[1]?.body).toMatchObject({ content: "d".repeat(2_000) });
    expect(chat.posts[2]?.body).toMatchObject({ content: "d".repeat(500) });
    expect(chat.posts[3]?.body).toMatchObject({ chat_id: 2, text: reply });
  } finally {
    chat.stop();
  }
});

test.each(["codemode", "direct", "deferred"] as const)(
  "untagged automation denies runtime-registered MCP and discovery (%s)",
  async (exposure) => {
    const target = await conversation();
    await writeAutomation(target.id);
    const extension = join(profile.path, "extensions", "mcp-fixture");
    await mkdir(extension, { recursive: true });
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({
        name: "mcp-fixture",
        description: "Local MCP fixture",
        version: "1.0.0",
        type: "module",
        keywords: ["pi-package"],
        pi: { extensions: ["./index.ts"] },
      }),
    );
    const fixture = join(import.meta.dir, "../extensions/fixtures/mcp-server.ts");
    await writeFile(
      join(extension, "index.ts"),
      `export default function(pi) { pi.registerMcpServer("fixture", ${JSON.stringify({ command: process.execPath, args: [fixture], exposure })}); }`,
    );
    await writeFile(
      join(profile.path, "extensions.json"),
      JSON.stringify({ extensions: ["mcp-fixture"] }),
    );
    server.push(
      tools(
        {
          name: "codemode",
          arguments: { code: 'text(await tools.mcp__fixture__echo({value:"forbidden"}));' },
        },
        { name: "mcp__fixture__echo", arguments: { value: "forbidden" } },
        { name: "tool_search", arguments: { query: "fixture" } },
      ),
    );
    const result = await ziggy(profile, "wake", profile.path, "digest");
    expect(result.exitCode).toBe(0);
    const names = server.request(1).tools?.map((tool) => tool.function.name) ?? [];
    expect(names).not.toContain("codemode");
    expect(names).not.toContain("tool_search");
    expect(names.some((name) => name.startsWith("mcp__"))).toBe(false);
    expect(server.toolResults(2)).toContain("not found");
    expect(await Bun.file(join(profile.path, ".runtime", "mcp-calls")).exists()).toBe(false);
  },
  15000,
);
