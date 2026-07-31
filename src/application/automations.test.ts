/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises the Node filesystem adapter */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TelegramApiError } from "../adapters/telegram/api";
import type { ProfileTarget } from "../domain/profile";
import type { ZiggyAgentShape } from "./agent";
import {
  type AutomationDelivery,
  type AutomationOutput,
  makeAutomations,
} from "./automations";
import { loadGatewayConfig } from "./gateway";

const temporaryPaths: Array<string> = [];

const makeProfile = async (telegramChat = true): Promise<ProfileTarget> => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automations-"));
  temporaryPaths.push(profilePath);
  await mkdir(join(profilePath, "automations"));
  await writeFile(join(profilePath, "SOUL.md"), "# Test profile\n", "utf8");
  await writeFile(
    join(profilePath, "automations", "daily-note.md"),
    [
      "---",
      "version: 1",
      ...(telegramChat ? ["telegram-chat: 42"] : []),
      "---",
      "Write the daily note.",
      "",
    ].join("\n"),
    "utf8",
  );
  return { path: profilePath, name: "Test" };
};

const makeAgent = (events: Array<string>): ZiggyAgentShape => ({
  runOnce: () => Effect.succeed(0),
  openTui: () => Effect.succeed(0),
  openChat: () =>
    Effect.sync(() => {
      events.push("open-chat");
      return {
        prompt: (prompt: string) =>
          Effect.sync(() => {
            events.push(`prompt:${prompt}`);
            return "local reply";
          }),
        dispose: Effect.sync(() => {
          events.push("dispose");
        }),
      };
    }),
});

const makeDelivery = (events: Array<string>): AutomationDelivery => ({
  loadTelegramConfig: (target) =>
    Effect.gen(function* () {
      events.push("load-config");
      return yield* loadGatewayConfig(target);
    }),
  sendTelegramMessage: (_token, _chatId, text) =>
    Effect.sync(() => {
      events.push(`send:${text}`);
    }),
});

const makeOutput = (events: Array<string>): AutomationOutput => ({
  printReply: (reply) =>
    Effect.sync(() => {
      events.push(`reply:${reply}`);
    }),
});

const runCapturingDeliveryUnavailable = (
  target: ProfileTarget,
  events: Array<string>,
): Promise<
  | { readonly kind: "success" }
  | {
      readonly kind: "delivery-unavailable";
      readonly automationId: string;
      readonly channel: "telegram";
      readonly path: string;
    }
> =>
  Effect.runPromise(
    makeAutomations(makeAgent(events), makeDelivery(events), makeOutput(events))
      .wake(target, "daily-note")
      .pipe(
        Effect.as({ kind: "success" as const }),
        Effect.catchTag("AutomationDeliveryUnavailable", (failure) =>
          Effect.succeed({
            kind: "delivery-unavailable" as const,
            automationId: failure.automationId,
            channel: failure.channel,
            path: failure.path,
          }),
        ),
      ),
  );

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Profile-owned automation definitions", () => {
  test("creates, lists, updates, and removes deterministic Markdown", async () => {
    const events: Array<string> = [];
    const target = await makeProfile(false);
    const service = makeAutomations(makeAgent(events), makeDelivery(events), makeOutput(events));

    const created = await Effect.runPromise(
      service.create(target, {
        id: "kai-weather",
        name: "Kai weather",
        enabled: true,
        prompt: "# Daily weather\n\nDress Kai for today.",
      }),
    );
    expect(created.version).toBe(1);
    expect(await readFile(join(target.path, "automations", "kai-weather.md"), "utf8")).toBe(
      [
        "---",
        "version: 1",
        "name: Kai weather",
        "enabled: true",
        "---",
        "",
        "# Daily weather",
        "",
        "Dress Kai for today.",
        "",
      ].join("\n"),
    );

    const listed = await Effect.runPromise(service.list(target));
    expect(listed.automations.map((automation) => automation.id)).toEqual([
      "daily-note",
      "kai-weather",
    ]);
    expect(listed.automations[0]).toMatchObject({
      id: "daily-note",
      name: "Daily note",
      enabled: true,
    });

    await Effect.runPromise(service.update(target, { ...created, enabled: false }));
    expect(await readFile(join(target.path, "automations", "kai-weather.md"), "utf8")).toContain(
      "enabled: false",
    );
    await Effect.runPromise(service.remove(target, "kai-weather"));
    expect((await Effect.runPromise(service.list(target))).automations).toHaveLength(1);
  });

  test("reports invalid Markdown without hiding valid definitions", async () => {
    const target = await makeProfile(false);
    await writeFile(join(target.path, "automations", "broken.md"), "not frontmatter\n", "utf8");
    const inventory = await Effect.runPromise(
      makeAutomations(makeAgent([]), makeDelivery([]), makeOutput([])).list(target),
    );

    expect(inventory.automations.map((automation) => automation.id)).toEqual(["daily-note"]);
    expect(inventory.diagnostics).toHaveLength(1);
    expect(inventory.diagnostics[0]?.id).toBe("broken");
  });

  test("create refuses to clobber an existing definition", async () => {
    const target = await makeProfile(false);
    const service = makeAutomations(makeAgent([]), makeDelivery([]), makeOutput([]));
    const original = await readFile(
      join(target.path, "automations", "daily-note.md"),
      "utf8",
    );
    const outcome = await Effect.runPromise(
      service
        .create(target, {
          id: "daily-note",
          name: "Replacement",
          enabled: true,
          prompt: "Overwrite the original.",
        })
        .pipe(
          Effect.as("created" as const),
          Effect.catchTag("AutomationExists", () => Effect.succeed("exists" as const)),
        ),
    );

    expect(outcome).toBe("exists");
    expect(await readFile(join(target.path, "automations", "daily-note.md"), "utf8")).toBe(
      original,
    );
  });

  test("does not run a disabled automation", async () => {
    const events: Array<string> = [];
    const target = await makeProfile(false);
    const service = makeAutomations(makeAgent(events), makeDelivery(events), makeOutput(events));
    const existing = (await Effect.runPromise(service.list(target))).automations[0];
    expect(existing).toBeDefined();
    if (existing === undefined) return;
    await Effect.runPromise(service.update(target, { ...existing, enabled: false }));

    await Effect.runPromise(service.wake(target, "daily-note"));

    expect(events).toEqual([]);
  });
});

describe("automation Telegram delivery", () => {
  test("prints one model reply before missing Telegram config fails the wake", async () => {
    const events: Array<string> = [];
    const target = await makeProfile();

    const outcome = await runCapturingDeliveryUnavailable(target, events);

    expect(outcome).toEqual({
      kind: "delivery-unavailable",
      automationId: "daily-note",
      channel: "telegram",
      path: join(target.path, "telegram.json"),
    });
    expect(events).toEqual([
      "open-chat",
      "prompt:Write the daily note.",
      "dispose",
      "reply:local reply",
      "load-config",
    ]);
  });

  test("fails the wake when Telegram config is invalid", async () => {
    const events: Array<string> = [];
    const target = await makeProfile();
    await writeFile(join(target.path, "telegram.json"), '{"botToken":42}', "utf8");

    const outcome = await runCapturingDeliveryUnavailable(target, events);

    expect(outcome).toEqual({
      kind: "delivery-unavailable",
      automationId: "daily-note",
      channel: "telegram",
      path: join(target.path, "telegram.json"),
    });
    expect(events).toEqual([
      "open-chat",
      "prompt:Write the daily note.",
      "dispose",
      "reply:local reply",
      "load-config",
    ]);
  });

  test("succeeds without loading delivery config when telegram-chat is absent", async () => {
    const events: Array<string> = [];
    const target = await makeProfile(false);

    await Effect.runPromise(
      makeAutomations(makeAgent(events), makeDelivery(events), makeOutput(events)).wake(
        target,
        "daily-note",
      ),
    );

    expect(events).toEqual([
      "open-chat",
      "prompt:Write the daily note.",
      "dispose",
      "reply:local reply",
    ]);
  });

  test("preserves a Telegram API failure in the typed error channel", async () => {
    const events: Array<string> = [];
    const target = await makeProfile();
    await writeFile(
      join(target.path, "telegram.json"),
      '{"botToken":"token","ownerUserId":7}',
      "utf8",
    );
    const apiFailure = new TelegramApiError({
      operation: "sendMessage",
      reason: "authentication",
      retriable: false,
      status: 401,
      message: "Telegram sendMessage authentication failed",
      cause: "HTTP 401",
    });
    const delivery: AutomationDelivery = {
      ...makeDelivery(events),
      sendTelegramMessage: (_token, _chatId, text) =>
        Effect.gen(function* () {
          events.push(`send:${text}`);
          return yield* apiFailure;
        }),
    };

    const outcome = await Effect.runPromise(
      makeAutomations(makeAgent(events), delivery, makeOutput(events))
        .wake(target, "daily-note")
        .pipe(
          Effect.as({ kind: "success" as const }),
          Effect.catchTag("TelegramApiError", (failure) =>
            Effect.succeed({
              kind: "telegram-api-error" as const,
              operation: failure.operation,
              reason: failure.reason,
              status: failure.status,
            }),
          ),
        ),
    );

    expect(outcome).toEqual({
      kind: "telegram-api-error",
      operation: "sendMessage",
      reason: "authentication",
      status: 401,
    });
    expect(events).toEqual([
      "open-chat",
      "prompt:Write the daily note.",
      "dispose",
      "reply:local reply",
      "load-config",
      "send:local reply",
    ]);
  });
});
