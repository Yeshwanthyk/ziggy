import { expect, test } from "bun:test";
import {
  createServiceController,
  type ServiceIdentity,
  type ServicePlatform,
  type ServiceStatus,
} from "../../packages/ziggy/src/service.ts";
import { MemoryServiceFilesystem, ScriptedProcess, missing, ok } from "./service-manager.ts";

const input = {
  profilePath: "/profiles/a & <x> %$ \\\"'",
  executable: "/opt/Ziggy App/ziggy",
};

export function serviceManagerContract(platform: ServicePlatform): void {
  const setup = () => {
    const filesystem = new MemoryServiceFilesystem();
    const process = new ScriptedProcess();
    const controller = createServiceController({
      platform,
      home: "/home/u",
      uid: 501,
      filesystem,
      process,
    });
    return { filesystem, process, controller };
  };

  test(`${platform}: canonical identity, exact paths, and escaped definitions`, async () => {
    const context = setup();
    context.filesystem.canonical.set("/alias", "/profiles/a");
    const one = await context.controller.identity({ ...input, profilePath: "/alias" });
    const same = await context.controller.identity({ ...input, profilePath: "/profiles/a" });
    const other = await context.controller.identity({ ...input, profilePath: "/profiles/b" });
    expect(one).toEqual(same);
    expect(one.label).not.toBe(other.label);
    expect(one.definitionPath).toBe(
      platform === "darwin"
        ? `/home/u/Library/LaunchAgents/${one.label}.plist`
        : `/home/u/.config/systemd/user/${one.label}.service`,
    );
    const special = await context.controller.identity(input);
    const status = await installFresh(platform, context, special);
    expect(status.process).toBe("running");
    const content = context.filesystem.files.get(special.definitionPath) ?? "";
    expect(content).toContain("schemaVersion");
    expect(content).toContain(platform === "darwin" ? "&amp;" : "%%$$");
    expect(content).toContain(platform === "darwin" ? "&lt;x&gt;" : '\\\\\\\"');
  });

  test(`${platform}: fresh install has exact order and healthy install is idempotent`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    await installFresh(platform, context, identity);
    expect(context.filesystem.mutations).toEqual([`create:${identity.definitionPath}`]);
    expect(context.process.timeouts.every((timeout) => timeout === 15_000)).toBeTrue();
    context.filesystem.mutations.length = 0;
    context.process.calls.length = 0;
    expectInspect(platform, context.process, identity, running(platform));
    const status = await context.controller.install(input);
    context.process.verifyComplete();
    expect(status.process).toBe("running");
    expect(context.filesystem.mutations).toEqual([]);
    expect(context.process.calls).toHaveLength(1);
  });

  test(`${platform}: inactive current install starts without replacing`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    await installFresh(platform, context, identity);
    context.filesystem.mutations.length = 0;
    context.process.calls.length = 0;
    expectInspect(platform, context.process, identity, stopped(platform));
    if (platform === "darwin") {
      context.process.expect(["launchctl", "enable", identity.target]);
      context.process.expect(["launchctl", "kickstart", identity.target]);
    } else {
      expectSystemdStart(context.process, identity, "start");
    }
    expectInspect(platform, context.process, identity, running(platform));
    const status = await context.controller.install(input);
    context.process.verifyComplete();
    expect(status.process).toBe("running");
    expect(context.filesystem.mutations).toEqual([]);
  });

  test(`${platform}: owned drift is replaced and restarted in exact order`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    await installFresh(platform, context, identity);
    const content = context.filesystem.files.get(identity.definitionPath) ?? "";
    context.filesystem.files.set(
      identity.definitionPath,
      content.replace(
        platform === "darwin" ? "/opt/Ziggy App/ziggy" : '"/opt/Ziggy App/ziggy"',
        platform === "darwin" ? "/old/ziggy" : '"/old/ziggy"',
      ),
    );
    context.filesystem.mutations.length = 0;
    context.process.calls.length = 0;
    expectInspect(platform, context.process, identity, running(platform));
    if (platform === "darwin") {
      context.process.expect(["launchctl", "bootout", identity.target]);
      context.process.expect(["launchctl", "enable", identity.target]);
      context.process.expect(["launchctl", "bootstrap", "gui/501", identity.definitionPath]);
    } else {
      expectSystemdStart(context.process, identity, "restart");
    }
    expectInspect(platform, context.process, identity, running(platform));
    const status = await context.controller.install(input);
    context.process.verifyComplete();
    expect(status.process).toBe("running");
    expect(context.filesystem.mutations).toEqual([`replace:${identity.definitionPath}`]);
  });

  test(`${platform}: foreign, copied-marker, and unsupported files never mutate`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    context.filesystem.files.set(identity.definitionPath, "foreign");
    expect((await context.controller.status(input)).definition).toBe("foreign");
    expect(await context.controller.remove(input)).toEqual({ kind: "refused", reason: "foreign" });
    const ownership = {
      schemaVersion: 1,
      platform,
      profileHash: identity.hash,
      identity: identity.label,
    };
    const prefix =
      platform === "darwin" ? "<!-- ziggy-service-ownership:" : "# ziggy-service-ownership:";
    const suffix = platform === "darwin" ? " -->" : "";
    context.filesystem.files.set(
      identity.definitionPath,
      `${platform === "darwin" ? '<?xml version="1.0" encoding="UTF-8"?>\n' : ""}${prefix}${JSON.stringify(ownership)}${suffix}\nforeign body\n`,
    );
    expect((await context.controller.status(input)).definition).toBe("foreign");
    context.filesystem.files.set(
      identity.definitionPath,
      `${platform === "darwin" ? '<?xml version="1.0" encoding="UTF-8"?>\n' : ""}${prefix}${JSON.stringify({ ...ownership, schemaVersion: 99 })}${suffix}\n`,
    );
    expect((await context.controller.status(input)).definition).toBe("unsupported");
    expect(await context.controller.remove(input)).toEqual({
      kind: "refused",
      reason: "unsupported",
    });
    expect(context.process.calls).toEqual([]);
    expect(context.filesystem.mutations).toEqual([]);
  });

  test(`${platform}: start, stop, and status preserve separate state dimensions`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    await installFresh(platform, context, identity);
    context.process.calls.length = 0;
    expectInspect(platform, context.process, identity, stopped(platform));
    if (platform === "darwin") {
      context.process.expect(["launchctl", "enable", identity.target]);
      context.process.expect(["launchctl", "kickstart", identity.target]);
    } else {
      context.process.expect(["systemctl", "--user", "reset-failed", identity.target]);
      context.process.expect(["systemctl", "--user", "start", identity.target]);
    }
    expectInspect(platform, context.process, identity, running(platform));
    expect((await context.controller.start(input)).process).toBe("running");
    if (platform === "darwin") context.process.expect(["launchctl", "bootout", identity.target]);
    else context.process.expect(["systemctl", "--user", "stop", identity.target]);
    expectInspect(platform, context.process, identity, stoppedAfterStop(platform));
    const stoppedStatus = await context.controller.stop(input);
    context.process.verifyComplete();
    expect(stoppedStatus.process).toBe("stopped");
    expect(stoppedStatus.definition).toBe("current");
  });

  test(`${platform}: remove is ordered, absent is idempotent, and cached state is refused`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    await installFresh(platform, context, identity);
    context.process.calls.length = 0;
    expectInspect(platform, context.process, identity, running(platform));
    if (platform === "darwin") context.process.expect(["launchctl", "bootout", identity.target]);
    else {
      context.process.expect(["systemctl", "--user", "disable", "--now", identity.target]);
      context.process.expect(["systemctl", "--user", "daemon-reload"]);
    }
    expect(await context.controller.remove(input)).toEqual({ kind: "removed" });
    context.process.verifyComplete();
    expect(context.filesystem.files.has(identity.definitionPath)).toBeFalse();
    expectInspect(platform, context.process, identity, absent(platform));
    expect(await context.controller.remove(input)).toEqual({ kind: "absent" });
    expectInspect(platform, context.process, identity, running(platform));
    expect(await context.controller.remove(input)).toEqual({
      kind: "refused",
      reason: "ambiguous-registration",
    });
    context.process.verifyComplete();
  });

  test(`${platform}: supervisor failure and ownership race retain the definition`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    await installFresh(platform, context, identity);
    expectInspect(platform, context.process, identity, running(platform));
    const removeArgv =
      platform === "darwin"
        ? ["launchctl", "bootout", identity.target]
        : ["systemctl", "--user", "disable", "--now", identity.target];
    context.process.expect(removeArgv, { exitCode: 2, stdout: "", stderr: "failed" });
    await expect(context.controller.remove(input)).rejects.toThrow("failed");
    expect(context.filesystem.files.has(identity.definitionPath)).toBeTrue();
    context.process.verifyComplete();
  });

  test(`${platform}: unknown cached registration fails closed and controls are rejected`, async () => {
    const context = setup();
    const identity = await context.controller.identity(input);
    if (platform === "darwin") context.process.expect(inspectArgv(platform, identity), missing());
    else context.process.expect(inspectArgv(platform, identity), ok("unexpected=true\n"));
    const result = await context.controller.remove(input);
    expect(result.kind).toBe(platform === "darwin" ? "absent" : "refused");
    await expect(
      context.controller.identity({ ...input, profilePath: "/bad\npath" }),
    ).rejects.toThrow("control");
    context.process.verifyComplete();
  });
}

async function installFresh(
  platform: ServicePlatform,
  context: ReturnType<typeof createContextShape>,
  identity: ServiceIdentity,
): Promise<ServiceStatus> {
  expectInspect(platform, context.process, identity, absent(platform));
  if (platform === "darwin") {
    context.process.expect(["launchctl", "enable", identity.target]);
    context.process.expect(["launchctl", "bootstrap", "gui/501", identity.definitionPath]);
  } else {
    expectSystemdStart(context.process, identity, "start");
  }
  expectInspect(platform, context.process, identity, running(platform));
  const status = await context.controller.install(input);
  context.process.verifyComplete();
  return status;
}

function createContextShape() {
  const filesystem = new MemoryServiceFilesystem();
  const process = new ScriptedProcess();
  return {
    filesystem,
    process,
    controller: createServiceController({
      platform: "linux",
      home: "/home/u",
      filesystem,
      process,
    }),
  };
}

function expectSystemdStart(
  process: ScriptedProcess,
  identity: ServiceIdentity,
  action: "start" | "restart",
): void {
  process.expect(["systemctl", "--user", "daemon-reload"]);
  process.expect(["systemctl", "--user", "enable", identity.target]);
  process.expect(["systemctl", "--user", "reset-failed", identity.target]);
  process.expect(["systemctl", "--user", action, identity.target]);
}

function expectInspect(
  platform: ServicePlatform,
  process: ScriptedProcess,
  identity: ServiceIdentity,
  result: ReturnType<typeof ok>,
): void {
  process.expect(inspectArgv(platform, identity), result);
}

function inspectArgv(platform: ServicePlatform, identity: ServiceIdentity): ReadonlyArray<string> {
  if (platform === "darwin") return ["launchctl", "print", identity.target];
  return [
    "systemctl",
    "--user",
    "show",
    identity.target,
    "--no-pager",
    "--property=LoadState",
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "--property=Result",
    "--property=UnitFileState",
  ];
}

function running(platform: ServicePlatform): ReturnType<typeof ok> {
  return platform === "darwin"
    ? ok("state = running")
    : ok(
        "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nResult=success\nUnitFileState=enabled\n",
      );
}

function stopped(platform: ServicePlatform): ReturnType<typeof ok> {
  return platform === "darwin"
    ? ok("state = waiting")
    : ok(
        "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nResult=success\nUnitFileState=enabled\n",
      );
}

function absent(platform: ServicePlatform): ReturnType<typeof ok> {
  return platform === "darwin"
    ? missing()
    : ok("LoadState=not-found\nActiveState=inactive\nMainPID=0\nUnitFileState=disabled\n");
}

function stoppedAfterStop(platform: ServicePlatform): ReturnType<typeof ok> {
  return platform === "darwin" ? missing() : stopped(platform);
}
