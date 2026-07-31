/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test callbacks are native Promise boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  canonicalAutomationFiringId,
  decideAutomationDue,
  nextAutomationScheduleInstant,
  parseAutomationScheduleFields,
  renderAutomationScheduleFields,
} from "./automation-schedule";

describe("automation schedules", () => {
  test("parses and renders all frontmatter schedule shapes", async () => {
    const cron = await Effect.runPromise(
      parseAutomationScheduleFields({
        schedule: "cron:0 30 9 * * *",
        timezone: "America/Toronto",
      }),
    );
    const at = await Effect.runPromise(
      parseAutomationScheduleFields({ schedule: "at:2026-08-01T12:00:00.000Z" }),
    );
    const every = await Effect.runPromise(parseAutomationScheduleFields({ schedule: "every:300" }));

    expect(cron === undefined ? [] : renderAutomationScheduleFields(cron)).toEqual([
      "schedule: cron:0 30 9 * * *",
      "timezone: America/Toronto",
    ]);
    expect(at === undefined ? [] : renderAutomationScheduleFields(at)).toEqual([
      "schedule: at:2026-08-01T12:00:00.000Z",
    ]);
    expect(every === undefined ? [] : renderAutomationScheduleFields(every)).toEqual([
      "schedule: every:300",
    ]);
  });

  test("uses Effect Cron timezone rules across the fall DST transition", () => {
    const schedule = {
      kind: "cron" as const,
      expression: "0 30 1 * * *",
      timezone: "America/Toronto",
    };
    const first = nextAutomationScheduleInstant(schedule, new Date("2026-11-01T04:00:00.000Z"));
    const second = first === undefined ? undefined : nextAutomationScheduleInstant(schedule, first);

    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(second?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("admits at most one catch-up inside grace and skips stale firings", () => {
    const schedule = { kind: "every" as const, seconds: 60 };
    const previous = new Date("2026-07-30T12:00:00.000Z");
    const due = decideAutomationDue(
      "digest",
      schedule,
      previous,
      new Date("2026-07-30T12:01:20.000Z"),
      30,
    );
    const missed = decideAutomationDue(
      "digest",
      schedule,
      previous,
      new Date("2026-07-30T12:03:00.000Z"),
      30,
    );

    expect(due).toEqual({
      kind: "due",
      instant: new Date("2026-07-30T12:01:00.000Z"),
      firingId: canonicalAutomationFiringId("digest", new Date("2026-07-30T12:01:00.000Z")),
    });
    expect(missed).toEqual({
      kind: "missed",
      instant: new Date("2026-07-30T12:03:00.000Z"),
    });
  });

  test("finds the latest first firing even when polling is off the boundary", () => {
    const decision = decideAutomationDue(
      "digest",
      { kind: "every", seconds: 60 },
      undefined,
      new Date("2026-07-30T12:01:07.000Z"),
      30,
    );

    expect(decision).toEqual({
      kind: "due",
      instant: new Date("2026-07-30T12:01:00.000Z"),
      firingId: "digest@2026-07-30T12:01:00.000Z",
    });
  });
});
