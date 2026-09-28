/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- async Bun tests execute Effects at their approved boundary */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Cron, Effect, Result } from "effect";
import {
  type AutomationBroadcastToken,
  automationScheduleFingerprint,
  manualRunId,
  parseAutomationFile,
  parseAutomationTarget,
  scheduledRunId,
  validateAutomationId,
} from "ziggy/domain/automation";

const broadcastTokenSource = (token: AutomationBroadcastToken): string =>
  token === "origin" || token === "all" ? token : token.target;

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
      broadcast: automation.broadcast.map(broadcastTokenSource),
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
    const [five, six, steppedFive, steppedSix, changed, zoned] = await Promise.all([
      parse(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 0 9 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 9 */2 * 1", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 0 9 */2 * 1", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 10 * * *", "timezone: UTC", "broadcast: none"]),
      parse(["cron: 0 9 * * *", "timezone: Europe/London", "broadcast: none"]),
    ]);

    expect(automationScheduleFingerprint(five)).toBe(automationScheduleFingerprint(six));
    expect(automationScheduleFingerprint(steppedFive)).toBe(
      automationScheduleFingerprint(steppedSix),
    );
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
      "conversation:0199aabb-ccdd-7000-8000-001122334455",
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
      "conversation:../escape",
      "conversation:",
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

    expect(duplicate.broadcast.map(broadcastTokenSource)).toEqual([
      "telegram:chat:1",
      "telegram:chat:1",
    ]);
  });

  test("routes a leading Profile agent mention and strips only its tag", async () => {
    const newline = await parse(
      ["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"],
      "@research-helper\nWrite the daily note.",
    );

    const inline = await parse(
      ["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"],
      "@research-helper Write the daily note.",
    );

    expect(newline.specialist).toEqual({
      agentId: "research-helper",
      task: "Write the daily note.",
    });
    expect(inline).toMatchObject({
      prompt: "Write the daily note.",
      specialist: { agentId: "research-helper" },
    });

    const indented = await parse(
      ["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"],
      "  @research-helper\nWrite the daily note.",
    );

    expect(indented.specialist).toBeUndefined();
    expect(indented.prompt).toBe("@research-helper\nWrite the daily note.");
  });

  test("rejects malformed leading Profile agent mentions with the automation source path", async () => {
    const messages = await Promise.all(
      ["@Research-helper do this", "@research-helper", "@research_helper do this"].map((body) =>
        invalidMessage(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"], body),
      ),
    );

    expect(messages).toEqual([
      "invalid automation daily-note: a leading Profile agent mention must use lowercase kebab-case @agent-id",
      "invalid automation daily-note: a leading Profile agent mention must be followed by a non-empty task",
      "invalid automation daily-note: a leading Profile agent mention must use lowercase kebab-case @agent-id",
    ]);
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

  test("parses optional provider, model, and thinking and inherits when omitted", async () => {
    const inherited = await parse(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none"]);
    expect(inherited.provider).toBeUndefined();
    expect(inherited.model).toBeUndefined();
    expect(inherited.thinking).toBeUndefined();

    const overridden = await parse([
      "cron: 0 9 * * *",
      "timezone: UTC",
      "broadcast: none",
      "provider: anthropic",
      "model: claude-sonnet",
      "thinking: high",
    ]);

    expect({
      provider: overridden.provider,
      model: overridden.model,
      thinking: overridden.thinking,
    }).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
      thinking: "high",
    });

    const thinkingOnly = await parse([
      "cron: 0 9 * * *",
      "timezone: UTC",
      "broadcast: none",
      "thinking: off",
    ]);

    expect(thinkingOnly.provider).toBeUndefined();
    expect(thinkingOnly.model).toBeUndefined();
    expect(thinkingOnly.thinking).toBe("off");
  });

  test("rejects unpaired provider/model and unknown thinking", async () => {
    expect(
      await invalidMessage([
        "cron: 0 9 * * *",
        "timezone: UTC",
        "broadcast: none",
        "provider: anthropic",
      ]),
    ).toBe("invalid automation daily-note: provider and model must be provided together");
    expect(
      await invalidMessage([
        "cron: 0 9 * * *",
        "timezone: UTC",
        "broadcast: none",
        "model: claude-sonnet",
      ]),
    ).toBe("invalid automation daily-note: provider and model must be provided together");
    expect(
      await invalidMessage([
        "cron: 0 9 * * *",
        "timezone: UTC",
        "broadcast: none",
        "thinking: loud",
      ]),
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

describe("automation generated invariants", () => {
  test("arbitrary definition bytes and mutated valid frontmatter never defect", async () => {
    const id = await Effect.runPromise(validateAutomationId("daily-note"));

    const text = fc.oneof(
      fc.string({ maxLength: 512 }),
      fc.uint8Array({ maxLength: 512 }).map((bytes) => Buffer.from(bytes).toString("utf8")),
      fc
        .tuple(
          fc.constantFrom(
            "cron",
            "timezone",
            "broadcast",
            "gate",
            "provider",
            "model",
            "thinking",
            "version",
            "origin",
            "unexpected",
          ),
          fc.string({ maxLength: 128 }),
          fc.string({ maxLength: 128 }),
        )
        .map(([key, value, body]) =>
          source(["cron: 0 9 * * *", "timezone: UTC", "broadcast: none", `${key}: ${value}`], body),
        ),
    );

    await fc.assert(
      fc.asyncProperty(text, async (input) => {
        const result = await Effect.runPromise(
          parseAutomationFile(id, "/profile/automations/daily-note.md", input).pipe(Effect.result),
        );

        expect(Result.isSuccess(result) || result.failure._tag === "AutomationInvalid").toBe(true);
      }),
      { numRuns: 500, seed: 20260928 },
    );
  });

  test("UTC cron next occurrence agrees with independent minute stepping", async () => {
    const id = await Effect.runPromise(validateAutomationId("daily-note"));

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 365 * 24 * 60 }),
        async (minute, hour, weekday, offset) => {
          const cron = `${minute} ${hour} * * ${weekday}`;

          const parsed = await Effect.runPromise(
            parseAutomationFile(
              id,
              "/profile/automations/daily-note.md",
              source([`cron: ${cron}`, "timezone: UTC", "broadcast: none"]),
            ),
          );

          const after = Date.parse("2025-01-01T00:00:00.000Z") + offset * 60_000 + 13_000;
          let expected = Math.floor(after / 60_000) * 60_000 + 60_000;

          while (true) {
            const date = new Date(expected);

            if (
              date.getUTCMinutes() === minute &&
              date.getUTCHours() === hour &&
              date.getUTCDay() === weekday
            )
              break;

            expected += 60_000;
          }

          expect(Cron.next(parsed.schedule.cron, new Date(after)).getTime()).toBe(expected);
        },
      ),
      { numRuns: 150, seed: 20260928 },
    );
  });
});
