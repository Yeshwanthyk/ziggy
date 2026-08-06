/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures exercise the Node filesystem adapter */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TelegramApiError } from "../adapters/telegram/api";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentShape } from "./agent";
import { type AutomationCapabilities, makeAutomations } from "./automations";

const paths: Array<string> = [];
const definition = (broadcast: string, extras: ReadonlyArray<string> = []) => [
  "---", "version: 1", "cron: 0 9 * * *", "timezone: America/New_York", ...extras,
  `broadcast: ${broadcast}`, "---", "Write the daily note.", "",
].join("\n");

const profile = async (broadcast: string, extras: ReadonlyArray<string> = []) => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-automations-"));
  paths.push(path);
  await mkdir(join(path, "automations"));
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  await writeFile(join(path, "automations", "daily-note.md"), definition(broadcast, extras));
  return { path, name: "Test" } satisfies ProfileTarget;
};

const tree = async (root: string): Promise<ReadonlyArray<readonly [string, string]>> => {
  const entries: Array<readonly [string, string]> = [];
  const walk = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = path.slice(root.length + 1);
      const status = await stat(path);
      if (status.isDirectory()) await walk(path);
      else entries.push([relative, await readFile(path, "utf8")]);
    }
  };
  await walk(root);
  return entries;
};

const harness = (events: Array<string>, options: {
  readonly gateExit?: number;
  readonly telegramFailure?: TelegramApiError;
} = {}) => {
  const agent: ZiggyAgentShape = {
    runOnce: () => Effect.succeed(0), openTui: () => Effect.succeed(0),
    openChat: (target, context, sessionPath, mode) => Effect.sync(() => {
      events.push(`open:${target.path}:${context.kind}:${sessionPath}:${mode}`);
      return {
        prompt: (prompt) => Effect.sync(() => { events.push(`prompt:${prompt}`); return "local reply"; }),
        dispose: Effect.sync(() => { events.push("dispose"); }),
      };
    }),
  };
  const capabilities: AutomationCapabilities = {
    gate: { run: (_path, _id, command) => Effect.sync(() => {
      events.push(`gate:${command}`);
      return options.gateExit === undefined || options.gateExit === 0
        ? { kind: "passed" as const }
        : { kind: "declined" as const, exitCode: options.gateExit };
    }) },
    printReply: (reply) => Effect.sync(() => { events.push(`reply:${reply}`); }),
    loadTelegramConfig: () => Effect.sync(() => { events.push("config:telegram"); return { botToken: "t", ownerUserId: 1 }; }),
    loadDiscordConfig: () => Effect.sync(() => { events.push("config:discord"); return { botToken: "d", ownerUserId: "1" }; }),
    loadSlackConfig: () => Effect.sync(() => { events.push("config:slack"); return { botToken: "s", appToken: "a", ownerUserId: "U" }; }),
    sendTelegram: (_token, id, text) => Effect.gen(function* () {
      events.push(`send:telegram:${id}:${text}`);
      if (options.telegramFailure !== undefined) return yield* options.telegramFailure;
    }),
    sendDiscord: (_token, id, text) => Effect.sync(() => { events.push(`send:discord:${id}:${text}`); }),
    sendSlack: (_token, id, text, thread) => Effect.sync(() => { events.push(`send:slack:${id}:${thread ?? "-"}:${text}`); }),
  };
  return makeAutomations(agent, capabilities);
};

const run = (service: ReturnType<typeof harness>, target: ProfileTarget) =>
  Effect.runPromise(service.run(target, "daily-note", { kind: "manual-force" }));

afterEach(async () => Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("automation run", () => {
  test("an absent gate opens one exact fresh session, prompts once, prints once, and writes nothing", async () => {
    const events: Array<string> = [];
    const target = await profile("none");
    const before = await tree(target.path);
    const bytes = await readFile(join(target.path, "automations", "daily-note.md"), "utf8");
    const outcome = await run(harness(events), target);
    expect(outcome).toEqual({ kind: "executed", delivery: { kind: "resolved", targets: [] } });
    expect(events).toEqual([
      `open:${target.path}:local:${join(target.path, "sessions", "automations", "daily-note")}:fresh`,
      "prompt:Write the daily note.", "dispose", "reply:local reply",
    ]);
    expect(await readFile(join(target.path, "automations", "daily-note.md"), "utf8")).toBe(bytes);
    expect(await tree(target.path)).toEqual(before);
    expect((await tree(target.path)).some(([path]) => /cursor|next-occurrence|\.runtime|database|ledger|receipt/i.test(path))).toBe(false);
  });

  test("a nonzero gate declines before Pi", async () => {
    const events: Array<string> = [];
    const target = await profile("none", ["gate: exit 7"]);
    expect(await run(harness(events, { gateExit: 7 }), target)).toEqual({ kind: "declined", reason: "gate-nonzero", exitCode: 7 });
    expect(events).toEqual(["gate:exit 7"]);
  });

  test("prints before resolution and malformed broadcasts sends nothing", async () => {
    const events: Array<string> = [];
    const target = await profile("all");
    await writeFile(join(target.path, "broadcasts.json"), '{"targets":[42]}');
    expect(await run(harness(events), target)).toEqual({ kind: "executed", delivery: { kind: "resolution-failed", category: "broadcasts-invalid" } });
    expect(events).toEqual([
      `open:${target.path}:local:${join(target.path, "sessions", "automations", "daily-note")}:fresh`,
      "prompt:Write the daily note.", "dispose", "reply:local reply",
    ]);
  });

  test("resolves origin, all, explicit targets, and first-seen deduplication", async () => {
    const events: Array<string> = [];
    const target = await profile("origin,all,telegram:chat:2,origin", ["origin: slack:channel:C0123ABCDE"]);
    await writeFile(join(target.path, "broadcasts.json"), JSON.stringify({ targets: ["telegram:chat:2", "discord:channel:3", "telegram:chat:2"] }));
    expect(await run(harness(events), target)).toEqual({ kind: "executed", delivery: { kind: "resolved", targets: [
      { target: "slack:channel:C0123ABCDE", status: "delivered" },
      { target: "telegram:chat:2", status: "delivered" },
      { target: "discord:channel:3", status: "delivered" },
    ] } });
    expect(events.slice(-6)).toEqual([
      "config:slack", "send:slack:C0123ABCDE:-:local reply", "config:telegram",
      "send:telegram:2:local reply", "config:discord", "send:discord:3:local reply",
    ]);
  });

  test("only reads all when requested and reports an empty all after stdout", async () => {
    const explicitEvents: Array<string> = [];
    const explicit = await profile("telegram:chat:2");
    await writeFile(join(explicit.path, "broadcasts.json"), "invalid");
    expect(await run(harness(explicitEvents), explicit)).toEqual({ kind: "executed", delivery: { kind: "resolved", targets: [{ target: "telegram:chat:2", status: "delivered" }] } });
    const allEvents: Array<string> = [];
    const all = await profile("all");
    expect(await run(harness(allEvents), all)).toEqual({ kind: "executed", delivery: { kind: "resolution-failed", category: "all-empty" } });
    expect(allEvents.at(-1)).toBe("reply:local reply");
  });

  test("continues success, failure, success with complete ordered outcomes", async () => {
    const events: Array<string> = [];
    const target = await profile("discord:channel:1,telegram:chat:2,slack:channel:C0123ABCDE");
    const apiFailure = new TelegramApiError({ operation: "sendMessage", reason: "rate-limited", retriable: true, status: 429, message: "failed", cause: "fixture" });
    expect(await run(harness(events, { telegramFailure: apiFailure }), target)).toEqual({ kind: "executed", delivery: { kind: "resolved", targets: [
      { target: "discord:channel:1", status: "delivered" },
      { target: "telegram:chat:2", status: "failed", category: "rate-limited", retriable: true },
      { target: "slack:channel:C0123ABCDE", status: "delivered" },
    ] } });
    expect(events.filter((event) => event.startsWith("send:"))).toEqual([
      "send:discord:1:local reply", "send:telegram:2:local reply", "send:slack:C0123ABCDE:-:local reply",
    ]);
  });
});
