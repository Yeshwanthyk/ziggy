import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { ResidentServiceStatus } from "../application/resident-service";
import { ResidentServiceError } from "../domain/resident-service";
import { renderServeStatus } from "./serve-cli";

const profilePath = "/profiles/pal";
const ownerPath = `${profilePath}/.runtime/gateway-owner.lock`;
const scheduler = {
  profilePath,
  observedAtMs: 100_000,
  heartbeatAtMs: 99_000,
  lastTickAtMs: 99_000,
  lastTickStatus: "ok" as const,
  lastTickError: null,
  schedules: [],
  activeRunCount: 0,
  latestRun: null,
  latestErrorRun: null,
};

const status = (overrides: Partial<ResidentServiceStatus> = {}): ResidentServiceStatus => ({
  profilePath,
  manager: "systemd",
  managed: Result.succeed({ _tag: "current", path: "/service", fingerprint: "abc" }),
  supervisor: Result.succeed({ state: "running", pid: 4242 }),
  process: Result.succeed({
    _tag: "running",
    path: ownerPath,
    pid: 4242,
    acquiredAt: "2026-01-01T00:00:00.000Z",
  }),
  scheduler: Result.succeed(scheduler),
  ...overrides,
});

describe("serve status CLI projection", () => {
  test("renders stable independent healthy facts", () => {
    expect(renderServeStatus(status())).toEqual({
      text: [
        `profile: ${profilePath}`,
        "managed service: installed",
        "service manager: systemd",
        "supervisor: running",
        "process: running",
        "pid: 4242",
        "acquired at: 2026-01-01T00:00:00.000Z",
        "scheduler: active",
        "tick: ok (1970-01-01T00:01:39.000Z)",
        "next due: none",
        "active runs: 0",
        "latest run: none",
      ].join("\n"),
      exitCode: 0,
    });
  });

  test("keeps supervisor, process, and scheduler disagreements separate", () => {
    const rendered = renderServeStatus(
      status({
        supervisor: Result.succeed({ state: "running" }),
        process: Result.succeed({ _tag: "stopped", path: ownerPath }),
        scheduler: Result.succeed({ ...scheduler, heartbeatAtMs: 1_000 }),
      }),
    );

    expect(rendered.text).toContain("supervisor: running");
    expect(rendered.text).toContain("process: stopped");
    expect(rendered.text).toContain("scheduler: stale");
    expect(rendered.exitCode).toBe(1);
  });

  test("preserves healthy sections when one independent projection fails", () => {
    const failure = new ResidentServiceError({
      operation: "inspect definition",
      reason: "filesystem",
      path: "/service",
      message: "definition unreadable\nwith details",
      cause: undefined,
    });
    const rendered = renderServeStatus(status({ managed: Result.fail(failure) }));

    expect(rendered.text).toContain(
      "managed service: unknown (definition unreadable with details)",
    );
    expect(rendered.text).toContain("supervisor: running");
    expect(rendered.text).toContain("process: running");
    expect(rendered.text).toContain("scheduler: active");
    expect(rendered.exitCode).toBe(1);
  });
});
