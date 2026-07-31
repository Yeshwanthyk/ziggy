/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun async tests execute Effect programs */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { launchdLabel, renderLaunchdPlist } from "../adapters/service/launchd";
import type {
  CommandResult,
  ServiceCommandRunner,
  ServiceFileSystem,
} from "../adapters/service/io";
import { renderSystemdUnit, systemdUnit } from "../adapters/service/systemd-user";
import type { SchedulerCommand } from "../domain/automation-service";
import type { ProfileTarget } from "../domain/profile";
import { makeAutomationServices } from "./automation-services";

const target: ProfileTarget = {
  path: "/Profiles/Kai & family",
  name: "Kai",
};

const schedulerCommand: SchedulerCommand = {
  executable: "/Applications/Bun & Tools/bun",
  arguments: ["/opt/ziggy/src/main.ts", "scheduler", target.path],
};

interface FakeState {
  readonly files: Map<string, string>;
  readonly calls: Array<readonly [string, ...ReadonlyArray<string>]>;
  active: boolean;
  linger: "yes" | "no";
}

const makeDependencies = (state: FakeState) => {
  const commands: ServiceCommandRunner = {
    run: (command, arguments_) =>
      Effect.sync(() => {
        state.calls.push([command, ...arguments_]);
        let result: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
        if (
          (command === "launchctl" && arguments_[0] === "print") ||
          (command === "systemctl" && arguments_[1] === "is-active")
        ) {
          result = { exitCode: state.active ? 0 : 3, stdout: "", stderr: "" };
        } else if (
          (command === "launchctl" && arguments_[0] === "bootstrap") ||
          (command === "systemctl" && arguments_[1] === "enable")
        ) {
          state.active = true;
        } else if (
          (command === "launchctl" && arguments_[0] === "bootout") ||
          (command === "systemctl" && arguments_[1] === "disable")
        ) {
          state.active = false;
        } else if (command === "loginctl") {
          result = { exitCode: 0, stdout: `${state.linger}\n`, stderr: "" };
        }
        return result;
      }),
  };
  const fileSystem: ServiceFileSystem = {
    readOptional: (path) => Effect.succeed(state.files.get(path)),
    writeAtomic: (path, content) =>
      Effect.sync(() => {
        state.files.set(path, content);
      }),
    remove: (path) =>
      Effect.sync(() => {
        const existed = state.files.has(path);
        state.files.delete(path);
        return existed;
      }),
  };
  return { commands, fileSystem };
};

const makeState = (): FakeState => ({
  files: new Map(),
  calls: [],
  active: false,
  linger: "yes",
});

describe("scheduler service artifacts", () => {
  test("launchd plist keeps every argument structural and XML escaped", () => {
    const plist = renderLaunchdPlist(launchdLabel(target.path), schedulerCommand, target.path);

    expect(plist).toContain("<string>/Applications/Bun &amp; Tools/bun</string>");
    expect(plist).toContain("<string>/opt/ziggy/src/main.ts</string>");
    expect(plist).toContain("<string>scheduler</string>");
    expect(plist).toContain("<string>/Profiles/Kai &amp; family</string>");
    expect(plist).toContain("<string>/dev/null</string>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>5</integer>");
    expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>30</integer>");
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(launchdLabel(target.path)).toBe(launchdLabel(target.path));
    expect(launchdLabel(`${target.path}/other`)).not.toBe(launchdLabel(target.path));
  });

  test("systemd unit quotes exact argv and escapes specifiers", () => {
    const command: SchedulerCommand = {
      executable: "/opt/Bun Tools/bun",
      arguments: ["/opt/ziggy 100%/main.ts", "scheduler", target.path],
    };
    const unit = renderSystemdUnit(command, target.path);

    expect(unit).toContain(
      'ExecStart="/opt/Bun Tools/bun" "/opt/ziggy 100%%/main.ts" "scheduler" "/Profiles/Kai & family"',
    );
    expect(unit).toContain('WorkingDirectory="/Profiles/Kai & family"');
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("StandardOutput=journal");
    expect(systemdUnit(target.path)).toBe(systemdUnit(target.path));
  });
});

describe("scheduler service lifecycle", () => {
  test("launchd install and uninstall are idempotent", async () => {
    const state = makeState();
    const dependencies = makeDependencies(state);
    const service = makeAutomationServices({
      platform: "darwin",
      homedir: "/Users/test",
      uid: 501,
      userName: "test",
      bunPath: schedulerCommand.executable,
      scriptPath: schedulerCommand.arguments[0],
      health: { read: () => Effect.succeed({ fresh: true, heartbeatAt: "2026-07-30T12:00:00Z" }) },
      ...dependencies,
    });

    const first = await Effect.runPromise(service.install(target));
    const second = await Effect.runPromise(service.install(target));
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(state.files.get(first.artifactPath)).toContain("<string>scheduler</string>");

    const status = await Effect.runPromise(service.status(target));
    expect(status).toMatchObject({
      installed: true,
      hostActive: true,
      healthFresh: true,
      heartbeatAt: "2026-07-30T12:00:00Z",
    });

    expect((await Effect.runPromise(service.uninstall(target))).changed).toBe(true);
    expect((await Effect.runPromise(service.uninstall(target))).changed).toBe(false);
  });

  test("systemd status separates installation, host activity, health, and linger", async () => {
    const state = makeState();
    state.linger = "no";
    const dependencies = makeDependencies(state);
    const service = makeAutomationServices({
      platform: "linux",
      homedir: "/home/test",
      uid: 1000,
      userName: "test",
      bunPath: "/usr/bin/bun",
      scriptPath: "/opt/ziggy/src/main.ts",
      health: { read: () => Effect.succeed({ fresh: false }) },
      ...dependencies,
    });

    await Effect.runPromise(service.install(target));
    const status = await Effect.runPromise(service.status(target));

    expect(status).toMatchObject({
      backend: "systemd-user",
      installed: true,
      hostActive: true,
      healthFresh: false,
      linger: "disabled",
    });
    expect(status.diagnostics).toEqual([
      "systemd user lingering is disabled; the scheduler may stop after logout",
    ]);
  });

  test("unsupported platforms fail through a typed error", async () => {
    const service = makeAutomationServices({
      platform: "win32",
      homedir: "C:\\Users\\test",
      uid: 0,
      userName: "test",
      bunPath: "C:\\bun.exe",
      scriptPath: "C:\\ziggy\\main.ts",
      health: { read: () => Effect.succeed({ fresh: false }) },
    });

    const tag = await Effect.runPromise(
      service.install(target).pipe(
        Effect.as("installed"),
        Effect.catchTag("AutomationServiceUnsupportedPlatform", () =>
          Effect.succeed("AutomationServiceUnsupportedPlatform"),
        ),
      ),
    );
    expect(tag).toBe("AutomationServiceUnsupportedPlatform");
  });
});
