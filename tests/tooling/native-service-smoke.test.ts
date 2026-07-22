import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../testkit/boundaries.ts";
import {
  runNativeServiceSmoke,
  toolingInputDigest,
  validateNativeServiceSmokeRecord,
} from "../../tooling/verification/native-service-smoke.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const fixedTime = "2026-07-20T23:00:13.000Z";
const workspace = {
  directory: "/fixture-private/workspace",
  profilePath: "/fixture-private/workspace/Profile",
  executable: "/fixture-private/workspace/ziggy-smoke",
  definitionPath: "/fixture-owner/Library/LaunchAgents/private.plist",
  target: "gui/987/dev.ziggy.profile.private",
  profileHash: "private-profile-hash",
};

class NativeSmokeRunner implements ProcessRunner {
  readonly commands: ProcessRequest[] = [];
  private installed = false;

  constructor(
    private readonly failCompile = false,
    private readonly delayedInstall = false,
    private readonly failInit = false,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.commands.push({ ...request, argv: [...request.argv] });
    if (request.argv[0] === "git" && request.argv[1] === "rev-parse") {
      return success(`${"a".repeat(40)}\n`);
    }
    if (request.argv[0] === "git" && request.argv[1] === "status") {
      return success(" M private-file.ts\n");
    }
    if (request.argv[0] === "git" && request.argv[1] === "--version") {
      return success("git version 2.51.0\n");
    }
    if (request.argv[0] === "bun") {
      return this.failCompile
        ? { exitCode: 1, stdout: workspace.profilePath, stderr: "secret=private", timedOut: false }
        : success("compiled private output");
    }
    if (request.argv[0] === "plutil") return success(`${workspace.definitionPath}: OK\n`);
    if (request.argv[0] === "launchctl") {
      if (request.argv[1] === "print-disabled") return success("disabled services = {\n}\n");
      return { ...success(""), exitCode: 3 };
    }
    if (request.argv[1] === "init") {
      if (this.failInit) {
        return {
          exitCode: 1,
          stdout: workspace.profilePath,
          stderr: "secret=private",
          timedOut: false,
        };
      }
      return success(
        JSON.stringify({
          schemaVersion: 1,
          profilePath: workspace.profilePath,
          voice: "clear",
          created: [
            "ziggy.jsonc",
            "automations/",
            "credentials/",
            "extensions/",
            "memory/",
            "sessions/",
            "SOUL.md",
          ],
        }),
      );
    }
    const action = request.argv[2];
    if (action === "status") {
      return this.installed
        ? success(status("current", "registered", "running"))
        : success(status("absent", "unregistered", "stopped"));
    }
    if (action === "install") {
      this.installed = true;
      return success(status("current", "registered", this.delayedInstall ? "stopped" : "running"));
    }
    if (action === "start") {
      return success(status("current", "registered", "running"));
    }
    if (action === "stop") return success(status("current", "unregistered", "stopped"));
    if (action === "remove") return success(JSON.stringify({ kind: "removed" }));
    if (request.argv[1] === "doctor") return success(doctor());
    throw new Error(`unexpected fixture command: ${request.argv.join(" ")}`);
  }
}

class LinuxFailureRunner implements ProcessRunner {
  readonly commands: ProcessRequest[] = [];
  private managerDefinitionPresent: boolean;

  constructor(
    private readonly failDisable = false,
    private readonly definitionPresent: () => boolean = () => false,
    private readonly events: string[] = [],
  ) {
    this.managerDefinitionPresent = definitionPresent();
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.commands.push({ ...request, argv: [...request.argv] });
    if (request.argv[0] === "git" && request.argv[1] === "rev-parse")
      return success("a".repeat(40));
    if (request.argv[0] === "git" && request.argv[1] === "status") return success("");
    if (request.argv[0] === "git" && request.argv[1] === "--version") {
      return success("git version 2.51.0");
    }
    if (request.argv[0] === "loginctl") return success("yes\n");
    if (request.argv[0] === "bun") return { ...success(""), exitCode: 1 };
    if (request.argv[0] === "systemctl" && request.argv.includes("show-environment")) {
      return success("");
    }
    if (request.argv[0] === "systemctl" && request.argv.includes("stop")) {
      return { ...success(""), exitCode: 1 };
    }
    if (request.argv[0] === "systemctl" && request.argv.includes("daemon-reload")) {
      this.events.push("daemon-reload");
      this.managerDefinitionPresent = this.definitionPresent();
      return success("");
    }
    if (request.argv[0] === "systemctl" && request.argv.includes("show")) {
      return success(
        this.managerDefinitionPresent
          ? "LoadState=loaded\nActiveState=inactive\n"
          : "LoadState=not-found\nActiveState=inactive\n",
      );
    }
    if (request.argv[0] === "systemctl" && request.argv.includes("is-active")) {
      return { ...success("inactive\n"), exitCode: 3 };
    }
    if (request.argv[0] === "systemctl" && request.argv.includes("is-enabled")) {
      if (this.failDisable) return { ...success("enabled\n"), exitCode: 0 };
      return this.managerDefinitionPresent
        ? { ...success("disabled\n"), exitCode: 1 }
        : { ...success("not-found\n"), exitCode: 1 };
    }
    if (request.argv[0] === "systemctl" && request.argv.includes("disable")) {
      return this.failDisable
        ? { exitCode: 1, stdout: "", stderr: "permission denied", timedOut: false }
        : success("");
    }
    if (request.argv[0] === "systemctl") return success("");
    throw new Error(`unexpected Linux fixture command: ${request.argv.join(" ")}`);
  }
}

describe("native service smoke evidence", () => {
  test("records exact sanitized lifecycle steps and a schema-valid cleanup proof", async () => {
    const runner = new NativeSmokeRunner(false, true);
    let published = "";
    let definitionRemovalAttempted = false;
    let workspaceRemovalAttempted = false;
    const result = await runNativeServiceSmoke(repositoryRoot, {
      platform: "darwin",
      home: "/fixture-owner",
      uid: 987,
      runner,
      now: () => new Date(fixedTime),
      sleep: async () => {},
      which: () => "/fixture-tool",
      createWorkspace: async () => workspace,
      definitionMode: async () => 0o600,
      definitionExists: async () => false,
      removeOwnedDefinition: async () => {
        definitionRemovalAttempted = true;
      },
      removeWorkspace: async () => {
        workspaceRemovalAttempted = true;
      },
      workspaceExists: async () => false,
      publish: async (_root, _runId, text) => {
        published = text;
        return "/fixture-evidence";
      },
    });

    expect(result.directory).toBe("/fixture-evidence");
    expect(definitionRemovalAttempted).toBe(true);
    expect(workspaceRemovalAttempted).toBe(true);
    expect(published).not.toContain(workspace.profilePath);
    expect(published).not.toContain(workspace.definitionPath);
    expect(published).not.toContain(workspace.target);
    expect(published).not.toContain(workspace.profileHash);
    expect(published).not.toContain("private-file.ts");
    expect(published).not.toContain("secret=private");

    const record = parseRecord(published);
    expect(record.result).toBe("passed");
    const capabilities = parseRecord(record.capabilities);
    expect(parseRecord(capabilities.linux).disposition).toBe("unavailable-on-host");
    const cleanup = parseRecord(record.cleanup);
    expect(cleanup.nativeUnregister).toBe("passed");
    expect(cleanup.definitionRemoved).toBe(true);
    expect(cleanup.disposableWorkspaceRemoved).toBe(true);
    const steps = requireArray(record.steps).map((value) => parseRecord(value));
    expect(steps.map((value) => value.id)).toEqual([
      "git-revision",
      "git-dirty",
      "git-version",
      "override-before",
      "compile",
      "init-profile",
      "status-before-install",
      "install",
      "install-readiness-1",
      "plutil",
      "doctor-after-install",
      "stop",
      "start",
      "doctor-after-start",
      "remove",
      "cleanup-unregister",
      "override-after",
    ]);
    expect(requireArray(steps[4]?.command)).toContain("<disposable-binary>");
    expect(requireArray(steps[5]?.command)).toEqual([
      "<compiled-ziggy>",
      "init",
      "<disposable-profile>",
    ]);
    expect(requireArray(steps[7]?.command)).toContain("<disposable-profile>");
    for (const smokeStep of steps) {
      const diagnostic = parseRecord(smokeStep.diagnostic);
      const text = requireString(diagnostic.text);
      expect(diagnostic.digest).toBe(createHash("sha256").update(text).digest("hex"));
    }
    await expect(validateNativeServiceSmokeRecord(repositoryRoot, record)).resolves.toBeUndefined();
  });

  test("runs native unregister and removal cleanup after lifecycle failure without retaining output", async () => {
    const runner = new NativeSmokeRunner(true);
    let published = "";
    let definitionRemovalAttempted = false;
    let workspaceRemovalAttempted = false;
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "darwin",
        home: "/fixture-owner",
        uid: 987,
        runner,
        now: () => new Date(fixedTime),
        which: () => "/fixture-tool",
        createWorkspace: async () => workspace,
        definitionMode: async () => 0o600,
        definitionExists: async () => false,
        removeOwnedDefinition: async () => {
          definitionRemovalAttempted = true;
        },
        removeWorkspace: async () => {
          workspaceRemovalAttempted = true;
        },
        workspaceExists: async () => false,
        publish: async (_root, _runId, text) => {
          published = text;
          return "/fixture-failed-evidence";
        },
      }),
    ).rejects.toThrow("schema-valid evidence");

    expect(definitionRemovalAttempted).toBe(true);
    expect(workspaceRemovalAttempted).toBe(true);
    expect(runner.commands.some((command) => command.argv[0] === "launchctl")).toBe(true);
    expect(published).not.toContain(workspace.profilePath);
    expect(published).not.toContain("secret=private");
    const record = parseRecord(published);
    expect(record.result).toBe("failed");
    const steps = requireArray(record.steps).map((value) => parseRecord(value));
    expect(steps.map((value) => value.id)).toEqual([
      "git-revision",
      "git-dirty",
      "git-version",
      "override-before",
      "compile",
      "cleanup-unregister",
      "override-after",
    ]);
  });

  test("runs native unregister and removal cleanup after Profile initialization failure", async () => {
    const runner = new NativeSmokeRunner(false, false, true);
    let published = "";
    let definitionRemovalAttempted = false;
    let workspaceRemovalAttempted = false;
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "darwin",
        home: "/fixture-owner",
        uid: 987,
        runner,
        now: () => new Date(fixedTime),
        which: () => "/fixture-tool",
        createWorkspace: async () => workspace,
        definitionExists: async () => false,
        removeOwnedDefinition: async () => {
          definitionRemovalAttempted = true;
        },
        removeWorkspace: async () => {
          workspaceRemovalAttempted = true;
        },
        workspaceExists: async () => false,
        publish: async (_root, _runId, text) => {
          published = text;
          return "/fixture-failed-evidence";
        },
      }),
    ).rejects.toThrow("schema-valid evidence");

    expect(definitionRemovalAttempted).toBe(true);
    expect(workspaceRemovalAttempted).toBe(true);
    expect(runner.commands.some((command) => command.argv[0] === "launchctl")).toBe(true);
    expect(published).not.toContain(workspace.profilePath);
    expect(published).not.toContain("secret=private");
    const record = parseRecord(published);
    const steps = requireArray(record.steps).map((value) => parseRecord(value));
    expect(steps.map((value) => value.id)).toEqual([
      "git-revision",
      "git-dirty",
      "git-version",
      "override-before",
      "compile",
      "init-profile",
      "cleanup-unregister",
      "override-after",
    ]);
  });

  test("removes a partially created disposable workspace when Profile creation fails", async () => {
    const removed: string[] = [];
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "darwin",
        home: "/fixture-owner",
        uid: 987,
        which: () => "/fixture-tool",
        workspaceFilesystem: {
          mkdtemp: async () => "/fixture-owner/.ziggy-native-smoke-partial",
          mkdir: async () => {
            throw new Error("fixture Profile creation failed");
          },
          remove: async (path) => {
            removed.push(path);
          },
        },
      }),
    ).rejects.toThrow("fixture Profile creation failed");
    expect(removed).toEqual(["/fixture-owner/.ziggy-native-smoke-partial"]);
  });

  test("refuses unsupported hosts before creating disposable state", async () => {
    let created = false;
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "win32",
        home: "/fixture-owner",
        createWorkspace: async () => {
          created = true;
          return workspace;
        },
      }),
    ).rejects.toThrow("unsupported on win32");
    expect(created).toBe(false);
  });

  test("refuses Linux hosts missing a required native tool before creating disposable state", async () => {
    let created = false;
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "linux",
        home: "/fixture-owner",
        uid: 987,
        which: (name) => (name === "loginctl" ? null : "/fixture-tool"),
        createWorkspace: async () => {
          created = true;
          return workspace;
        },
      }),
    ).rejects.toThrow("loginctl are required");
    expect(created).toBe(false);
  });

  test("Linux cleanup reloads after owned definition removal and proves deterministic manager absence", async () => {
    let definitionPresent = true;
    const events: string[] = [];
    const runner = new LinuxFailureRunner(false, () => definitionPresent, events);
    let published = "";
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "linux",
        home: "/fixture-owner",
        uid: 987,
        runner,
        now: () => new Date(fixedTime),
        which: () => "/fixture-tool",
        createWorkspace: async () => ({
          ...workspace,
          definitionPath: "/fixture-owner/.config/systemd/user/private.service",
          target: "private.service",
        }),
        definitionExists: async () => definitionPresent,
        removeOwnedDefinition: async () => {
          events.push("definition-removed");
          definitionPresent = false;
        },
        removeWorkspace: async () => {},
        workspaceExists: async () => false,
        publish: async (_root, _runId, text) => {
          published = text;
          return "/fixture-linux-evidence";
        },
      }),
    ).rejects.toThrow("schema-valid evidence");
    expect(events).toEqual(["definition-removed", "daemon-reload"]);
    const systemctl = runner.commands
      .filter((command) => command.argv[0] === "systemctl")
      .map((command) => command.argv.slice(1));
    expect(systemctl.slice(-6)).toEqual([
      ["--user", "stop", "private.service"],
      ["--user", "disable", "--now", "private.service"],
      ["--user", "daemon-reload"],
      ["--user", "show", "private.service", "--property=LoadState", "--property=ActiveState"],
      ["--user", "is-active", "private.service"],
      ["--user", "is-enabled", "private.service"],
    ]);
    const steps = requireArray(parseRecord(published).steps).map((value) => parseRecord(value));
    for (const id of ["cleanup-manager-state", "cleanup-inactive", "cleanup-disabled"]) {
      expect(steps.find((step) => step.id === id)?.result).toBe("passed");
    }
  });

  test("Linux cleanup rejects stale loaded manager state after definition removal", async () => {
    const runner = new LinuxFailureRunner(false, () => true);
    let published = "";
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "linux",
        home: "/fixture-owner",
        uid: 987,
        runner,
        now: () => new Date(fixedTime),
        which: () => "/fixture-tool",
        createWorkspace: async () => ({
          ...workspace,
          definitionPath: "/fixture-owner/.config/systemd/user/private.service",
          target: "private.service",
        }),
        definitionExists: async () => false,
        removeOwnedDefinition: async () => {},
        removeWorkspace: async () => {},
        workspaceExists: async () => false,
        publish: async (_root, _runId, text) => {
          published = text;
          return "/fixture-linux-evidence";
        },
      }),
    ).rejects.toThrow("schema-valid evidence");

    const steps = requireArray(parseRecord(published).steps).map((value) => parseRecord(value));
    expect(steps.find((step) => step.id === "cleanup-manager-state")?.result).toBe("failed");
    expect(steps.find((step) => step.id === "cleanup-disabled")?.result).toBe("failed");
  });

  test("Linux cleanup does not accept a generic disable failure while enablement remains", async () => {
    const runner = new LinuxFailureRunner(true);
    let published = "";
    await expect(
      runNativeServiceSmoke(repositoryRoot, {
        platform: "linux",
        home: "/fixture-owner",
        uid: 987,
        runner,
        now: () => new Date(fixedTime),
        which: () => "/fixture-tool",
        createWorkspace: async () => ({
          ...workspace,
          definitionPath: "/fixture-owner/.config/systemd/user/private.service",
          target: "private.service",
        }),
        definitionExists: async () => false,
        removeOwnedDefinition: async () => {},
        removeWorkspace: async () => {},
        workspaceExists: async () => false,
        publish: async (_root, _runId, text) => {
          published = text;
          return "/fixture-linux-evidence";
        },
      }),
    ).rejects.toThrow("schema-valid evidence");

    const record = parseRecord(published);
    expect(parseRecord(record.cleanup).nativeUnregister).toBe("failed");
    const steps = requireArray(record.steps).map((value) => parseRecord(value));
    const disable = steps.find((value) => value.id === "cleanup-disable");
    const state = steps.find((value) => value.id === "cleanup-disabled");
    expect(disable?.result).toBe("failed");
    expect(state?.result).toBe("failed");
  });

  test("tooling digest binds recursively discovered Provider and auth inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ziggy-native-digest-"));
    try {
      for (const path of [
        "package.json",
        "bun.lock",
        "tsconfig.json",
        "tsconfig.base.json",
        "packages",
        "tooling",
        "verification",
      ]) {
        await cp(join(repositoryRoot, path), join(root, path), { recursive: true });
      }
      const baseline = await toolingInputDigest(root);
      for (const path of [
        "packages/ziggy/src/auth-client.ts",
        "packages/ziggy/src/terminal-auth.ts",
        "packages/core/src/provider-runtime.ts",
        "packages/core/src/credentials/filesystem-store.ts",
        "packages/core/src/oauth.ts",
        "tsconfig.json",
        "tsconfig.base.json",
      ]) {
        const original = await Bun.file(join(root, path)).text();
        await Bun.write(join(root, path), `${original}\n// digest fixture`);
        expect(await toolingInputDigest(root)).not.toBe(baseline);
        await Bun.write(join(root, path), original);
      }
      await Bun.write(
        join(root, "packages/ziggy/src/untracked-production-input.ts"),
        "export {};\n",
      );
      expect(await toolingInputDigest(root)).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects schema additions and private runtime identifiers", async () => {
    await expect(
      validateNativeServiceSmokeRecord(repositoryRoot, {
        schemaVersion: 1,
        kind: "native-service-smoke",
        pid: 123,
      }),
    ).rejects.toThrow("schema validation");
  });
});

function success(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function status(definition: string, registration: string, processState: string): string {
  return JSON.stringify({
    definition,
    registration,
    process: processState,
    enablement: "unknown",
    pid: 4321,
    detail: { output: workspace.profilePath },
  });
}

function doctor(): string {
  return JSON.stringify({
    schemaVersion: 1,
    profilePath: workspace.profilePath,
    healthy: true,
    checks: {
      daemon: { status: "ok", detail: "ready", pid: 4321 },
      socket: { status: "ok", detail: workspace.profilePath },
      profileLock: { status: "ok", detail: "live", pid: 4321 },
      providerAuth: { status: "warning", detail: "secret=private" },
    },
  });
}

function parseRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected record");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function requireArray(value: unknown): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
