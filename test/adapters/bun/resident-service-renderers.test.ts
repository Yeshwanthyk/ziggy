import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveResidentServiceIdentity,
  type ResidentLaunchVector,
} from "ziggy/domain/resident-service";
import {
  launchdBootoutCommand,
  launchdBootstrapCommand,
  launchdKickstartCommand,
  launchdLogsCommand,
  launchdStatusCommand,
  renderLaunchdService,
} from "ziggy/adapters/bun/launchd-service";
import {
  renderSystemdService,
  systemdCommand,
  systemdLingerCommand,
  systemdLogsCommand,
  systemdMainPidCommand,
} from "ziggy/adapters/bun/systemd-service";

const profilePath = "/Users/Test Person/Profiles/work & fun $100%";
const identity = deriveResidentServiceIdentity(profilePath);
const launchVector: ResidentLaunchVector = [
  "/Applications/Bun & Tools/bun",
  "/opt/ziggy/main $source%.ts",
  "serve",
  profilePath,
];
const launchdEnvironmentValue = (content: string, key: string): string => {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(content);
  if (match?.[1] === undefined) throw new Error(`missing launchd environment key ${key}`);
  return match[1];
};

describe("resident service renderers", () => {
  test("renders deterministic launchd XML with an argument array and no ambient secrets", () => {
    const options = {
      identity,
      profilePath,
      launchVector,
      home: "/Users/Test Person",
      ziggyHome: "/Users/Test Person/.ziggy",
    };
    const first = renderLaunchdService(options);
    const second = renderLaunchdService(options);

    expect(second).toEqual(first);
    expect(first.content).toContain("<key>ProgramArguments</key>");
    expect(first.content).toContain("<key>EnvironmentVariables</key>");
    expect(first.content).toContain("<key>HOME</key>\n    <string>/Users/Test Person</string>");
    expect(first.content).toContain(
      "<key>ZIGGY_HOME</key>\n    <string>/Users/Test Person/.ziggy</string>",
    );
    expect(first.content).toContain(
      "<key>PATH</key>\n    <string>/Users/Test Person/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>",
    );
    expect(first.launchVector[0]).toMatch(/^\//u);
    expect(first.content).toContain("<string>/Applications/Bun &amp; Tools/bun</string>");
    expect(first.content).toContain("<string>/opt/ziggy/main $source%.ts</string>");
    expect(first.content).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(first.content).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(first.content).toContain(`<string>${first.fingerprint}</string>`);
    expect(renderLaunchdService({ ...options, throttleSeconds: 999 }).content).toContain(
      "<key>ThrottleInterval</key>\n  <integer>300</integer>",
    );
    expect(first.content).not.toContain("fixture-secret");
    expect(
      renderLaunchdService({ ...options, pathEnvironment: "/custom/bin" }).fingerprint,
    ).not.toBe(first.fingerprint);
  });

  test("renders systemd arguments without shell interpolation and pins only safe environment", () => {
    const definition = renderSystemdService({
      identity,
      profilePath,
      launchVector,
      home: "/home/test person",
      ziggyHome: "/home/test person/.ziggy",
    });

    expect(definition.content).toContain(
      'ExecStart="/Applications/Bun & Tools/bun" "/opt/ziggy/main $$source%%.ts" "serve" "/Users/Test Person/Profiles/work & fun $$100%%"',
    );
    expect(definition.content).toContain("Restart=always\nRestartSec=10\nTimeoutStopSec=30");
    expect(
      renderSystemdService({
        identity,
        profilePath,
        launchVector,
        home: "/home/test person",
        ziggyHome: "/home/test person/.ziggy",
        restartSeconds: 0,
      }).content,
    ).toContain("RestartSec=1");
    expect(definition.content).toContain("WantedBy=default.target");
    expect(definition.content).toContain('Environment="HOME=/home/test person"');
    expect(definition.content).toContain('Environment="ZIGGY_HOME=/home/test person/.ziggy"');
    expect(definition.content).toContain(
      'Environment="PATH=/home/test person/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
    );
    expect(definition.launchVector[0]).toMatch(/^\//u);
    expect(definition.content).not.toMatch(/TOKEN|PASSWORD|fixture-secret/u);
  });

  test("resolves a managed fixture from the rendered launchd PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "ziggy-resident-service-renderer-"));
    const fixtureName = "ziggy-managed-fixture";
    const fixtureDirectory = join(home, ".local", "bin");
    const fixturePath = join(fixtureDirectory, fixtureName);
    try {
      await mkdir(fixtureDirectory, { recursive: true });
      await writeFile(fixturePath, "#!/bin/sh\nexit 0\n");
      await chmod(fixturePath, 0o755);

      const profile = join(home, "Profile");
      const definition = renderLaunchdService({
        identity: deriveResidentServiceIdentity(profile),
        profilePath: profile,
        launchVector: ["/usr/bin/ziggy", "serve", profile],
        home,
        ziggyHome: join(home, ".ziggy"),
      });
      const environment = {
        HOME: launchdEnvironmentValue(definition.content, "HOME"),
        ZIGGY_HOME: launchdEnvironmentValue(definition.content, "ZIGGY_HOME"),
        PATH: launchdEnvironmentValue(definition.content, "PATH"),
      };
      expect(environment.PATH).toBe(
        `${fixtureDirectory}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      );

      const child = Bun.spawn(["/bin/sh", "-c", `command -v ${fixtureName}`], {
        env: environment,
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(stdout.trim()).toBe(fixturePath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test("builds lifecycle and log commands as argument arrays", () => {
    expect(launchdBootstrapCommand(501, "/tmp/service.plist")).toEqual([
      "launchctl",
      "bootstrap",
      "gui/501",
      "/tmp/service.plist",
    ]);
    expect(launchdBootoutCommand(501, identity)).toEqual([
      "launchctl",
      "bootout",
      `gui/501/${identity.launchdLabel}`,
    ]);
    expect(launchdKickstartCommand(501, identity)).toEqual([
      "launchctl",
      "kickstart",
      "-k",
      `gui/501/${identity.launchdLabel}`,
    ]);
    expect(launchdStatusCommand(501, identity)[1]).toBe("print");
    expect(launchdLogsCommand({ stdout: "/tmp/out", stderr: "/tmp/err" }, true)).toEqual([
      "tail",
      "-f",
      "/tmp/out",
      "/tmp/err",
    ]);
    expect(systemdCommand("daemon-reload")).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(systemdCommand("start", identity.systemdUnit)).toEqual([
      "systemctl",
      "--user",
      "start",
      identity.systemdUnit,
    ]);
    expect(systemdMainPidCommand(identity.systemdUnit)).toContain("--property=MainPID");
    expect(systemdLogsCommand(identity.systemdUnit, true).at(-1)).toBe("-f");
    expect(systemdLingerCommand("person")).toEqual([
      "loginctl",
      "show-user",
      "person",
      "-p",
      "Linger",
    ]);
  });
});
