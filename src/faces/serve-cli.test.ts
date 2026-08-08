import { describe, expect, test } from "bun:test";
import type { AutomationStatusProjection } from "../domain/automation";
import { renderAutomationStatus } from "./automation-cli";
import { renderServeStatus } from "./serve-cli";

const ownerPath = "/profiles/pal/.runtime/gateway-owner.lock";

describe("serve status CLI projection", () => {
  test("renders stable stopped, running, and stale process facts", () => {
    expect(renderServeStatus({ _tag: "stopped", path: ownerPath })).toBe(
      ["process: stopped", "pid: -", "acquired at: -", `owner path: ${ownerPath}`].join("\n"),
    );
    for (const state of ["running", "stale"] as const) {
      expect(
        renderServeStatus({
          _tag: state,
          path: ownerPath,
          pid: 4242,
          acquiredAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toBe(
        [
          `process: ${state}`,
          "pid: 4242",
          "acquired at: 2026-01-01T00:00:00.000Z",
          `owner path: ${ownerPath}`,
        ].join("\n"),
      );
    }
  });

  test("keeps stopped process truth distinct from a fresh scheduler heartbeat", () => {
    const scheduler: AutomationStatusProjection = {
      profilePath: "/profiles/pal",
      observedAtMs: 100_000,
      heartbeatAtMs: 99_000,
      lastTickAtMs: 99_000,
      lastTickStatus: "ok",
      lastTickError: null,
      schedules: [],
      activeRunCount: 0,
      latestRun: null,
      latestErrorRun: null,
    };

    expect(renderServeStatus({ _tag: "stopped", path: ownerPath })).toContain("process: stopped");
    expect(renderAutomationStatus(scheduler)).toContain("scheduler: active");
  });
});
