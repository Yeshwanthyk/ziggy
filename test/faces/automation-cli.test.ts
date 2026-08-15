import { describe, expect, test } from "bun:test";
import type { AutomationRunProjection, AutomationStatusProjection } from "ziggy/domain/automation";
import {
  renderAutomationCreated,
  renderAutomationDefinitions,
  renderAutomationOutcome,
  renderAutomationRuns,
  renderAutomationStatus,
  renderAutomationTransition,
  renderAutomationValidation,
} from "ziggy/faces/automation-cli";

describe("automation definition CLI", () => {
  const validDefinition = {
    id: "alpha",
    path: "automations/alpha.md",
    valid: true,
    lifecycle: "active" as const,
    schedule: "0 9 * * *",
    timezone: "UTC",
    gateState: "manual-only" as const,
  };
  const definitions = [
    validDefinition,
    {
      id: "broken",
      path: "automations/broken.md",
      valid: false,
      lifecycle: "active" as const,
      message: "bad frontmatter",
    },
  ];

  test("renders valid and invalid siblings without hiding either", () => {
    expect(renderAutomationDefinitions(definitions)).toBe(
      "alpha\tactive\tvalid\t0 9 * * *\tUTC\tmanual-only\tautomations/alpha.md\nbroken\tactive\tinvalid\t-\t-\t-\tautomations/broken.md",
    );
    expect(renderAutomationValidation(definitions)).toBe(
      "automations/alpha.md\tactive\tvalid\tmanual-only\nautomations/broken.md\tactive\tinvalid\tbad frontmatter",
    );
  });

  test("renders lifecycle transitions explicitly", () => {
    expect(
      renderAutomationTransition("paused", {
        ...validDefinition,
        lifecycle: "paused",
        path: "automations/alpha.paused.md",
      }),
    ).toBe("paused automation alpha at automations/alpha.paused.md");
  });

  test("explains why the safe starter cannot make scheduled model calls", () => {
    expect(renderAutomationCreated(validDefinition)).toContain(
      "scheduled model calls remain blocked until you add a gate",
    );
    expect(renderAutomationCreated(validDefinition)).toContain("broadcast is none");
  });
});

describe("automation CLI outcome", () => {
  test("renders busy, decline, and no-target success", () => {
    expect(renderAutomationOutcome({ kind: "skipped-busy" })).toEqual({
      exitCode: 1,
      stderr: ["wake skipped: automation is already running"],
    });
    expect(
      renderAutomationOutcome({ kind: "declined", reason: "gate-nonzero", exitCode: 4 }),
    ).toEqual({
      exitCode: 0,
      stderr: ["wake declined: gate exited 4"],
    });
    expect(
      renderAutomationOutcome({ kind: "executed", delivery: { kind: "resolved", targets: [] } }),
    ).toEqual({ exitCode: 0, stderr: ["wake delivery resolved: 0 targets"] });
  });

  test("renders full delivery success", () => {
    expect(
      renderAutomationOutcome({
        kind: "executed",
        delivery: {
          kind: "resolved",
          targets: [
            { target: "telegram:chat:1", status: "delivered" },
            { target: "discord:channel:2", status: "delivered" },
          ],
        },
      }),
    ).toEqual({
      exitCode: 0,
      stderr: [
        "wake delivery resolved: 2 targets",
        "wake delivered: telegram:chat:1",
        "wake delivered: discord:channel:2",
      ],
    });
  });

  test("renders resolution and partial target failures safely", () => {
    expect(
      renderAutomationOutcome({
        kind: "executed",
        delivery: { kind: "resolution-failed", category: "all-empty" },
      }),
    ).toEqual({
      exitCode: 1,
      stderr: ["wake delivery resolution failed: all-empty"],
    });
    expect(
      renderAutomationOutcome({
        kind: "executed",
        delivery: {
          kind: "resolved",
          targets: [
            {
              target: "slack:channel:C0123ABCDE",
              status: "failed",
              category: "authentication",
              retriable: false,
            },
            { target: "telegram:chat:1", status: "delivered" },
          ],
        },
      }),
    ).toEqual({
      exitCode: 1,
      stderr: [
        "wake delivery resolved: 2 targets",
        "wake delivery failed: slack:channel:C0123ABCDE (authentication, not retriable)",
        "wake delivered: telegram:chat:1",
      ],
    });
  });
});

describe("automation CLI projections", () => {
  const status = (
    heartbeatAtMs: number | null,
    observedAtMs = 100_000,
  ): AutomationStatusProjection => ({
    profilePath: "/profiles/pal",
    observedAtMs,
    heartbeatAtMs,
    lastTickAtMs: null,
    lastTickStatus: null,
    lastTickError: null,
    schedules: [],
    activeRunCount: 0,
    latestRun: null,
    latestErrorRun: null,
  });

  test("renders freshness boundaries and the absent-state field order", () => {
    expect(renderAutomationStatus(status(10_000)).split("\n").slice(0, 4)).toEqual([
      "profile: /profiles/pal",
      "scheduler: active",
      "heartbeat: fresh (1970-01-01T00:00:10.000Z)",
      "tick: unknown",
    ]);
    expect(renderAutomationStatus(status(9_999)).split("\n")[1]).toBe("scheduler: stale");
    expect(renderAutomationStatus(status(null)).split("\n")).toEqual([
      "profile: /profiles/pal",
      "scheduler: unknown",
      "heartbeat: unknown",
      "tick: unknown",
      "definitions: 0 valid, 0 invalid, 0 deleted",
      "definition error: none",
      "next due: none",
      "active runs: 0",
      "latest run: none",
      "latest error: none",
    ]);
    expect(renderAutomationStatus(status(100_001)).split("\n")[2]).toBe("heartbeat: unknown");
  });

  test("renders persisted target order", () => {
    const run: AutomationRunProjection = {
      runId: "scheduled:daily:1970-01-01T00:00:01.000Z",
      automationId: "daily",
      trigger: "scheduled",
      state: "failed",
      scheduleFingerprint: "a".repeat(64),
      scheduledForMs: 1_000,
      missedThroughMs: null,
      recordedAtMs: 1_000,
      startedAtMs: 1_100,
      finishedAtMs: 1_250,
      localCompleted: true,
      failureCategory: "rate-limited",
      gateExitCode: null,
      targets: [
        {
          ordinal: 0,
          target: "discord:channel:1",
          status: "delivered",
          failureCategory: null,
          retriable: null,
        },
        {
          ordinal: 1,
          target: "telegram:chat:2",
          status: "failed",
          failureCategory: "rate-limited",
          retriable: true,
        },
      ],
    };
    expect(renderAutomationRuns([run], 2_000)).toBe(
      [
        "scheduled:daily:1970-01-01T00:00:01.000Z daily failed scheduled scheduled 1970-01-01T00:00:01.000Z through - recorded 1970-01-01T00:00:01.000Z started 1970-01-01T00:00:01.100Z duration 150 reason rate-limited local completed",
        "  delivery discord:channel:1 delivered reason - retriable -",
        "  delivery telegram:chat:2 failed reason rate-limited retriable true",
      ].join("\n"),
    );
    expect(renderAutomationRuns([], 0)).toBe("no automation runs");
  });
});
