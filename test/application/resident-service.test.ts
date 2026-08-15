/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- test fixtures own disposable filesystem state */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { makeResidentPlatformCommands } from "ziggy/adapters/bun/resident-service";
import { AutomationProjectionError } from "ziggy/domain/automation";
import { ResidentServiceError, type ResidentLaunchVector } from "ziggy/domain/resident-service";
import type { AutomationSchedulerApi } from "ziggy/application/automation-scheduler";
import type { ResidentGatewayApi } from "ziggy/application/resident-gateway";
import {
  makeResidentService,
  type ResidentServiceRuntime,
} from "ziggy/application/resident-service";

const paths: Array<string> = [];
const profile = async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-service-app-"));
  paths.push(path);
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  return { path, name: "Test" };
};

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

const gateway = (state: "running" | "stopped" = "running"): ResidentGatewayApi => ({
  run: () => Effect.never,
  status: (target) =>
    Effect.succeed(
      state === "running"
        ? {
            _tag: "running" as const,
            path: join(target.path, ".runtime", "gateway-owner.lock"),
            pid: 4242,
            acquiredAt: "2026-01-01T00:00:00.000Z",
          }
        : { _tag: "stopped" as const, path: join(target.path, ".runtime", "gateway-owner.lock") },
    ),
});

const scheduler = (fail = false): AutomationSchedulerApi => ({
  run: () => Effect.never,
  runs: () => Effect.succeed([]),
  status: (target) =>
    fail
      ? Effect.fail(
          new AutomationProjectionError({
            operation: "read status",
            path: target.path,
            message: "scheduler unreadable",
            cause: "fixture",
          }),
        )
      : Effect.succeed({
          profilePath: target.path,
          observedAtMs: 100_000,
          heartbeatAtMs: 99_000,
          lastTickAtMs: 99_000,
          lastTickStatus: "ok",
          lastTickError: null,
          schedules: [],
          activeRunCount: 0,
          latestRun: null,
          latestErrorRun: null,
        }),
});

const runtime = (
  root: string,
  seen: Array<ReadonlyArray<string>>,
  response: (command: ResidentLaunchVector) => { exitCode: number; stdout: string; stderr: string },
  overrides: Partial<ResidentServiceRuntime> = {},
): ResidentServiceRuntime => ({
  platform: "linux",
  executablePath: process.execPath,
  mainPath: Bun.main,
  home: root,
  ziggyHome: join(root, ".ziggy"),
  uid: 501,
  user: "fixture-user",
  commands: makeResidentPlatformCommands(async (command) => {
    seen.push(command);
    return response(command);
  }),
  inspectDefinition: () =>
    Effect.succeed({ _tag: "current", path: "/service", fingerprint: "fingerprint" }),
  writeDefinition: () => Effect.succeed("created"),
  removeDefinition: () => Effect.succeed(true),
  ensureDirectory: () => Effect.void,
  sleep: () => Effect.void,
  ...overrides,
});

describe("resident service orchestration", () => {
  test("installs and enables systemd without starting for --no-start", async () => {
    const target = await profile();
    const seen: Array<ReadonlyArray<string>> = [];
    const service = makeResidentService(
      gateway(),
      scheduler(),
      runtime(target.path, seen, (command) => ({
        exitCode: 0,
        stdout: command[0] === "loginctl" ? "Linger=no\n" : "",
        stderr: "",
      })),
    );

    const result = await Effect.runPromise(service.install(target, { force: false, start: false }));

    expect(seen).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", expect.stringMatching(/^ziggy-serve-/)],
      ["loginctl", "show-user", "fixture-user", "-p", "Linger"],
    ]);
    expect(result.write).toBe("created");
    expect(result.ready).toBeUndefined();
    expect(result.warnings[0]).toContain("loginctl enable-linger fixture-user");
  });

  test("installs launchd without bootstrap for --no-start", async () => {
    const target = await profile();
    const seen: Array<ReadonlyArray<string>> = [];
    const service = makeResidentService(
      gateway(),
      scheduler(),
      runtime(target.path, seen, () => ({ exitCode: 0, stdout: "", stderr: "" }), {
        platform: "darwin",
      }),
    );

    const result = await Effect.runPromise(service.install(target, { force: false, start: false }));

    expect(seen).toEqual([]);
    expect(result.manager).toBe("launchd");
    expect(result.ready).toBeUndefined();
  });

  test("starts through the manager and reports bounded owner readiness", async () => {
    const target = await profile();
    const seen: Array<ReadonlyArray<string>> = [];
    const service = makeResidentService(
      gateway(),
      scheduler(),
      runtime(target.path, seen, (command) => ({
        exitCode: 0,
        stdout: command.includes("is-active")
          ? "active\n"
          : command.includes("--property=MainPID")
            ? "4242\n"
            : "",
        stderr: "",
      })),
    );

    const result = await Effect.runPromise(service.start(target));

    expect(seen).toEqual([
      ["systemctl", "--user", "start", expect.stringMatching(/^ziggy-serve-/)],
      ["systemctl", "--user", "is-active", expect.stringMatching(/^ziggy-serve-/)],
      [
        "systemctl",
        "--user",
        "show",
        "--property=MainPID",
        "--value",
        expect.stringMatching(/^ziggy-serve-/),
      ],
    ]);
    expect(result.ready).toBeTrue();
    expect(result.owner?._tag).toBe("running");
  });

  test("kickstarts an already loaded launchd service", async () => {
    const target = await profile();
    const seen: Array<ReadonlyArray<string>> = [];
    const service = makeResidentService(
      gateway(),
      scheduler(),
      runtime(target.path, seen, () => ({ exitCode: 0, stdout: "state = running\n", stderr: "" }), {
        platform: "darwin",
      }),
    );

    const result = await Effect.runPromise(service.start(target));

    expect(seen.map((command) => command.slice(0, 2))).toEqual([
      ["launchctl", "print"],
      ["launchctl", "kickstart"],
      ["launchctl", "print"],
    ]);
    expect(result.ready).toBeTrue();
  });

  test("treats launchd's missing-service response as a stopped supervisor", async () => {
    const target = await profile();
    const seen: Array<ReadonlyArray<string>> = [];
    const service = makeResidentService(
      gateway("stopped"),
      scheduler(),
      runtime(
        target.path,
        seen,
        (command) =>
          command.includes("bootout")
            ? { exitCode: 0, stdout: "", stderr: "" }
            : {
                exitCode: 113,
                stdout: "",
                stderr:
                  'Bad request. Could not find service "fixture" in domain for user gui: 501\n',
              },
        { platform: "darwin" },
      ),
    );

    const result = await Effect.runPromise(service.stop(target));

    expect(seen.map((command) => command.slice(0, 2))).toEqual([
      ["launchctl", "bootout"],
      ["launchctl", "print"],
    ]);
    expect(result.ready).toBeTrue();
    expect(result.owner?._tag).toBe("stopped");
  });

  test("status preserves process and supervisor results when other projections fail", async () => {
    const target = await profile();
    const seen: Array<ReadonlyArray<string>> = [];
    const definitionFailure = new ResidentServiceError({
      operation: "inspect definition",
      reason: "filesystem",
      path: "/service",
      message: "definition unreadable",
      cause: "fixture",
    });
    const service = makeResidentService(
      gateway(),
      scheduler(true),
      runtime(
        target.path,
        seen,
        (command) => ({
          exitCode: 0,
          stdout: command.includes("is-active") ? "active\n" : "4242\n",
          stderr: "",
        }),
        { inspectDefinition: () => Effect.fail(definitionFailure) },
      ),
    );

    const result = await Effect.runPromise(service.status(target));

    expect(Result.isFailure(result.managed)).toBeTrue();
    expect(Result.isSuccess(result.supervisor) && result.supervisor.success).toEqual({
      state: "running",
      pid: 4242,
    });
    expect(Result.isSuccess(result.process) && result.process.success._tag).toBe("running");
    expect(Result.isFailure(result.scheduler)).toBeTrue();
  });
});
