/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- async Bun tests execute Effects at their approved boundary */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  automationScheduleFingerprint,
  manualRunId,
  parseAutomationFile,
  parseAutomationTarget,
  scheduledRunId,
  validateAutomationId,
} from "./automation";

const source = (fields: ReadonlyArray<string>, body = "Do the work.") =>
  ["---", "version: 1", ...fields, "---", body, ""].join("\n");

const parse = async (fields: ReadonlyArray<string>, body?: string) => {
  const id = await Effect.runPromise(validateAutomationId("daily-note"));
  return Effect.runPromise(
    parseAutomationFile(id, "/profile/automations/daily-note.md", source(fields, body)),
  );
};

const invalidMessage = async (fields: ReadonlyArray<string>, body?: string) => {
  const id = await Effect.runPromise(validateAutomationId("daily-note"));
  return Effect.runPromise(
    parseAutomationFile(id, "/profile/automations/daily-note.md", source(fields, body)).pipe(
      Effect.map(() => "success"),
      Effect.catchTag("AutomationInvalid", (failure) => Effect.succeed(failure.message)),
    ),
  );
};

describe("automation definition", () => {
  test("parses the exact contract independent of field order", async () => {
    const automation = await parse(
      [
        "broadcast: origin,all,telegram:chat:-1001234567890",
        "timezone: America/New_York",
        "origin: slack:channel:C0123ABCDE:thread:1712345678.123456",
        "gate: test -f READY",
        "cron: 0 9 * * *",
      ],
      "Write the daily note.",
    );

    expect({
      id: automation.id,
      version: automation.version,
      cronSource: automation.schedule.cronSource,
      timezone: automation.schedule.timezone,
      gate: automation.gate,
      broadcast: automation.broadcast.map((token) =>
        typeof token === "string" ? token : token.target,
      ),
      origin: automation.origin?.target,
      prompt: automation.prompt,
    }).toEqual({
      id: "daily-note",
      version: 1,
      cronSource: "0 9 * * *",
      timezone: "America/New_York",
      gate: "test -f READY",
      broadcast: ["origin", "all", "telegram:chat:-1001234567890"],
      origin: "slack:channel:C0123ABCDE:thread:1712345678.123456",
      prompt: "Write the daily note.",
    });
  });

  test("accepts five and six field cron expressions", async () => {
    const values = await Promise.all([
      parse(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 0 9 * * *", "timezone: Europe/London", "broadcast: none"]),
    ]);
    expect(values.map((value) => [value.schedule.cronSource, value.schedule.timezone])).toEqual([
      ["0 9 * * *", "UTC"],
      ["0 0 9 * * *", "Europe/London"],
    ]);
  });

  test("fingerprints parsed schedule semantics and UTC occurrence identities", async () => {
    const [five, six, changed, zoned] = await Promise.all([
      parse(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 0 9 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 10 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 9 * * *", "timezone: Europe/London", "broadcast: none"]),
    ]);
    expect(automationScheduleFingerprint(five)).toBe(automationScheduleFingerprint(six));
    expect(automationScheduleFingerprint(changed)).not.toBe(automationScheduleFingerprint(five));
    expect(automationScheduleFingerprint(zoned)).not.toBe(automationScheduleFingerprint(five));
    expect(scheduledRunId("daily-note", Date.parse("2026-11-01T05:30:00.000Z"))).not.toBe(
      scheduledRunId("daily-note", Date.parse("2026-11-01T06:30:00.000Z")),
    );
    expect(manualRunId("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "manual:550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("rejects invalid schedules and noncanonical timezone values", async () => {
    const cases = [
      ["cron: nope", "timezone: UTC"],
      ["cron: 0 9 * * *", "timezone: +02:00"],
      ["cron: 0 9 * * *", "timezone: Mars/Olympus"],
      ["cron: 0 9 * * *", "timezone:  UTC"],
      ["cron: 0 9 * * *", "timezone: UTC "],
      ["cron: 0 9 * * *", "timezone:"],
    ];
    const messages = await Promise.all(
      cases.map((fields) => invalidMessage([...fields, "broadcast: none"])),
    );
    expect(messages.every((message) => message.startsWith("invalid automation daily-note:"))).toBe(
      true,
    );
  });

  test("accepts every canonical target form and rejects other spellings", async () => {
    const valid = [
      "telegram:chat:42",
      "telegram:chat:-1001234567890",
      "discord:channel:1234567890",
      "slack:channel:C0123ABCDE",
      "slack:channel:G0123ABCDE:thread:1712345678.123456",
    ];
    const parsed = await Promise.all(
      valid.map((value) => Effect.runPromise(parseAutomationTarget("x", "/x", value))),
    );
    expect(parsed.map((value) => value.target)).toEqual(valid);
    const invalid = [
      "telegram:chat:0",
      "telegram:chat:+42",
      "telegram:chat:042",
      "telegram:chat:9007199254740992",
      "discord:channel:0",
      "discord:channel:01",
      "slack:channel:c0123ABCDE",
      "slack:channel:C0123ABCDE:thread:1.2",
      "telegram:42",
    ];
    const results = await Promise.all(
      invalid.map((value) =>
        Effect.runPromise(
          parseAutomationTarget("x", "/x", value).pipe(
            Effect.as("valid"),
            Effect.catchTag("AutomationInvalid", () => Effect.succeed("invalid")),
          ),
        ),
      ),
    );
    expect(results).toEqual(invalid.map(() => "invalid"));
  });

  test("enforces policy grammar and a persisted origin", async () => {
    const invalid = [
      "",
      "origin",
      "none,all",
      "all,",
      ",all",
      "all, telegram:chat:1",
      "all,,origin",
    ];
    const messages = await Promise.all(
      invalid.map((broadcast) =>
        invalidMessage(["cron: 0 9 * * *", "timezone: UTC", `broadcast: ${broadcast}`]),
      ),
    );
    expect(messages.every((message) => message !== "success")).toBe(true);
    const duplicate = await parse([
      "cron: 0 9 * * *",
      "timezone: UTC",
      "broadcast: telegram:chat:1,telegram:chat:1",
    ]);
    expect(
      duplicate.broadcast.map((token) => (typeof token === "string" ? token : token.target)),
    ).toEqual(["telegram:chat:1", "telegram:chat:1"]);
  });

  test("rejects strict frontmatter violations and prompt shadowing", async () => {
    const cases = [
      ["cron: 0 9 * * *", "timezone: UTC", "broadcast: none", "unknown: x"],
      ["cron: 0 9 * * *", "cron: 0 10 * * *", "timezone: UTC", "broadcast: none"],
      ["cron: 0 9 * * *", "timezone: UTC", "broadcast: none", "prompt: shadow"],
      ["cron: 0 9 * * *", "timezone: UTC", "broadcast: none", " continued"],
    ];
    const messages = await Promise.all(cases.map((fields) => invalidMessage(fields)));
    expect(messages.every((message) => message !== "success")).toBe(true);
    expect(
      await invalidMessage(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"], " "),
    ).not.toBe("success");
  });

  test("returns the direct telegram-chat replacement error", async () => {
    expect(
      await invalidMessage([
        "cron: 0 9 * * *",
        "timezone: UTC",
        "broadcast: none",
        "telegram-chat: 42",
      ]),
    ).toBe(
      "invalid automation daily-note: telegram-chat is no longer supported; use broadcast: telegram:chat:<chat-id>",
    );
  });
});
