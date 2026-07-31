/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises the Node filesystem adapter */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TelegramApiError } from "../adapters/telegram/api";
import { ProviderCallError } from "../domain/agent";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentShape } from "./agent";
import { latestAutomationReceipt } from "./automation-receipts";
import type {
  AutomationRunDelivery,
  AutomationRunOutput,
} from "./automation-runner";
import { makeAutomations } from "./automations";

const temporaryPaths: Array<string> = [];

const makeProfile = async (frontmatter: ReadonlyArray<string> = []): Promise<ProfileTarget> => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automations-"));
  temporaryPaths.push(profilePath);
  await mkdir(join(profilePath, "automations"));
  await writeFile(join(profilePath, "SOUL.md"), "# Test profile\n", "utf8");
  await writeFile(
    join(profilePath, "automations", "daily-note.md"),
    [
      "---",
      "version: 1",
      ...frontmatter,
      "---",
      "Write the daily note.",
      "",
    ].join("\n"),
    "utf8",
  );
  return { path: profilePath, name: "Test" };
};

const makeAgent = (
  events: Array<string>,
  reply: Effect.Effect<string, ProviderCallError> = Effect.succeed("local reply"),
): ZiggyAgentShape => ({
  runOnce: () => Effect.succeed(0),
  openTui: () => Effect.succeed(0),
  openChat: (_target, _context, sessionPath) =>
    Effect.sync(() => {
      events.push(`open-chat:${sessionPath}`);
      return {
        prompt: (prompt: string) =>
          Effect.sync(() => events.push(`prompt:${prompt}`)).pipe(Effect.andThen(reply)),
        dispose: Effect.sync(() => {
          events.push("dispose");
        }),
      };
    }),
});

const makeDelivery = (events: Array<string>): AutomationRunDelivery => ({
  loadTelegramConfig: () =>
    Effect.sync(() => {
      events.push("load-telegram");
      return { botToken: "telegram-token", ownerUserId: 7 };
    }),
  sendTelegramMessage: (_token, _chatId, text) =>
    Effect.sync(() => {
      events.push(`send-telegram:${text}`);
    }),
  loadDiscordConfig: () =>
    Effect.sync(() => {
      events.push("load-discord");
      return { botToken: "discord-token", ownerUserId: "7" };
    }),
  sendDiscordMessage: (_token, _channel, text) =>
    Effect.sync(() => {
      events.push(`send-discord:${text}`);
    }),
  loadSlackConfig: () =>
    Effect.sync(() => {
      events.push("load-slack");
      return { botToken: "slack-token", appToken: "app-token", ownerUserId: "U7" };
    }),
  sendSlackMessage: (_token, _channel, text) =>
    Effect.sync(() => {
      events.push(`send-slack:${text}`);
    }),
});

const makeOutput = (events: Array<string>): AutomationRunOutput => ({
  printReply: (reply) =>
    Effect.sync(() => {
      events.push(`reply:${reply}`);
    }),
  info: (message) =>
    Effect.sync(() => {
      events.push(`info:${message}`);
    }),
  warn: (message) =>
    Effect.sync(() => {
      events.push(`warn:${message}`);
    }),
});

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Profile-owned automation definitions", () => {
  test("creates, lists, updates, and removes scheduled Markdown definitions", async () => {
    const target = await makeProfile();
    const service = makeAutomations(makeAgent([]), makeDelivery([]), makeOutput([]));
    const created = await Effect.runPromise(
      service.create(target, {
        id: "kai-weather",
        name: "Kai weather",
        enabled: true,
        prompt: "# Daily weather\n\nDress Kai for today.",
        schedule: {
          kind: "cron",
          expression: "0 8 * * *",
          timezone: "America/Toronto",
        },
        discordChannel: "123",
      }),
    );

    expect(await readFile(join(target.path, "automations", "kai-weather.md"), "utf8")).toBe(
      [
        "---",
        "version: 1",
        "name: Kai weather",
        "enabled: true",
        "discord-channel: 123",
        "schedule: cron:0 8 * * *",
        "timezone: America/Toronto",
        "---",
        "",
        "# Daily weather",
        "",
        "Dress Kai for today.",
        "",
      ].join("\n"),
    );
    expect((await Effect.runPromise(service.list(target))).scheduler.online).toBeFalse();
    await Effect.runPromise(service.update(target, { ...created, enabled: false }));
    await Effect.runPromise(service.remove(target, "kai-weather"));
    expect((await Effect.runPromise(service.list(target))).automations).toHaveLength(1);
  });

  test("isolates invalid definition diagnostics and refuses create clobbering", async () => {
    const target = await makeProfile();
    await writeFile(join(target.path, "automations", "broken.md"), "not frontmatter\n", "utf8");
    const service = makeAutomations(makeAgent([]), makeDelivery([]), makeOutput([]));
    const inventory = await Effect.runPromise(service.list(target));
    expect(inventory.automations.map((automation) => automation.id)).toEqual(["daily-note"]);
    expect(inventory.diagnostics[0]?.id).toBe("broken");

    const outcome = await Effect.runPromise(
      service
        .create(target, {
          id: "daily-note",
          name: "Replacement",
          enabled: true,
          prompt: "Overwrite it.",
        })
        .pipe(
          Effect.as("created" as const),
          Effect.catchTag("AutomationExists", () => Effect.succeed("exists" as const)),
        ),
    );
    expect(outcome).toBe("exists");
  });
});

describe("durable automation runs", () => {
  test("records disabled admission as skipped without constructing Pi", async () => {
    const events: Array<string> = [];
    const target = await makeProfile(["enabled: false"]);
    const receipt = await Effect.runPromise(
      makeAutomations(makeAgent(events), makeDelivery(events), makeOutput(events)).wake(
        target,
        "daily-note",
      ),
    );

    expect(receipt.status).toBe("skipped");
    expect(receipt.error).toBe("Automation is disabled.");
    expect(events).toEqual([
      "info:[automation] daily-note: disabled — skipped",
    ]);
  });

  test("persists local output before all three delivery targets", async () => {
    const events: Array<string> = [];
    const target = await makeProfile([
      "telegram-chat: 42",
      "discord-channel: 123",
      "slack-channel: C123",
    ]);
    const delivery = makeDelivery(events);
    const checkingDelivery: AutomationRunDelivery = {
      ...delivery,
      sendTelegramMessage: (token, chatId, text) =>
        Effect.gen(function* () {
          const persisted = yield* latestAutomationReceipt(target, "daily-note").pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          events.push(`persisted:${persisted?.status}:${persisted?.localOutput}`);
          yield* delivery.sendTelegramMessage(token, chatId, text);
        }),
    };
    const receipt = await Effect.runPromise(
      makeAutomations(makeAgent(events), checkingDelivery, makeOutput(events)).wake(
        target,
        "daily-note",
      ),
    );

    expect(receipt.status).toBe("succeeded");
    expect(receipt.deliveries.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(events).toContain("persisted:succeeded:local reply");
    expect(events.indexOf("reply:local reply")).toBeLessThan(
      events.indexOf("load-telegram"),
    );
  });

  test("keeps execution succeeded when one delivery fails", async () => {
    const events: Array<string> = [];
    const target = await makeProfile(["telegram-chat: 42"]);
    const failure = new TelegramApiError({
      operation: "sendMessage",
      reason: "authentication",
      retriable: false,
      status: 401,
      message: "Telegram sendMessage authentication failed",
      cause: "HTTP 401",
    });
    const receipt = await Effect.runPromise(
      makeAutomations(
        makeAgent(events),
        { ...makeDelivery(events), sendTelegramMessage: () => Effect.fail(failure) },
        makeOutput(events),
      ).wake(target, "daily-note"),
    );

    expect(receipt.status).toBe("succeeded");
    expect(receipt.localOutput).toBe("local reply");
    expect(receipt.deliveries[0]).toMatchObject({
      target: "telegram:42",
      status: "failed",
    });
  });

  test("records model failure without claiming success", async () => {
    const target = await makeProfile();
    const failure = new ProviderCallError({
      profilePath: target.path,
      operation: "prompt",
      message: "model failed",
      cause: "test",
    });
    const receipt = await Effect.runPromise(
      makeAutomations(
        makeAgent([], Effect.fail(failure)),
        makeDelivery([]),
        makeOutput([]),
      ).wake(target, "daily-note"),
    );

    expect(receipt.status).toBe("failed");
    expect(receipt.localOutput).toBeUndefined();
    expect(receipt.error).toContain("model failed");
  });
});
