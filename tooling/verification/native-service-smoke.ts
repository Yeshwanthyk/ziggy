import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { BunProcessRunner } from "./compile-smoke.ts";
import type { ProcessResult, ProcessRunner } from "./process.ts";
import { loadSchemaCatalog } from "./schemas.ts";

const commandTimeoutMs = 20_000;
const compileTimeoutMs = 120_000;
const diagnosticLimit = 2_048;
const schemaName = "native-service-smoke-v1.schema.json";

type NativePlatform = "darwin" | "linux";
type Availability = "available" | "missing" | "not-probed";
type DarwinOverrideDisposition = "absent" | "enabled" | "disabled" | "unknown";

interface Workspace {
  readonly directory: string;
  readonly profilePath: string;
  readonly executable: string;
  readonly definitionPath: string;
  readonly target: string;
  readonly profileHash: string;
}

interface WorkspaceFilesystem {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

interface SmokeStep {
  readonly id: string;
  readonly command: ReadonlyArray<string>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly result: "passed" | "failed";
  readonly diagnostic: Diagnostic;
}

interface Diagnostic {
  readonly text: string;
  readonly digest: string;
  readonly truncated: boolean;
}

interface Capabilities {
  readonly darwin: {
    readonly disposition: "available" | "unavailable-on-host" | "unsupported";
    readonly launchd: Availability;
    readonly plutil: Availability;
  };
  readonly linux: {
    disposition: "available" | "unavailable-on-host" | "unsupported";
    readonly systemctl: Availability;
    readonly systemdAnalyze: Availability;
    readonly loginctl: Availability;
    userManager: "available" | "unavailable" | "not-probed";
    lingering: "enabled" | "disabled" | "unknown" | "not-probed";
  };
}

export interface NativeServiceSmokeOptions {
  readonly platform?: string;
  readonly home?: string;
  readonly uid?: number;
  readonly runner?: ProcessRunner;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly which?: (executable: string) => string | null;
  readonly createWorkspace?: (
    platform: NativePlatform,
    home: string,
    uid: number | undefined,
  ) => Promise<Workspace>;
  readonly workspaceFilesystem?: WorkspaceFilesystem;
  readonly definitionMode?: (path: string) => Promise<number>;
  readonly definitionExists?: (path: string) => Promise<boolean>;
  readonly removeOwnedDefinition?: (path: string, profileHash: string) => Promise<void>;
  readonly removeWorkspace?: (path: string) => Promise<void>;
  readonly workspaceExists?: (path: string) => Promise<boolean>;
  readonly publish?: (root: string, runId: string, text: string) => Promise<string>;
}

export interface NativeServiceSmokeResult {
  readonly directory: string;
  readonly record: unknown;
}

export async function runNativeServiceSmoke(
  root: string,
  options: NativeServiceSmokeOptions = {},
): Promise<NativeServiceSmokeResult> {
  const platform = requirePlatform(options.platform ?? process.platform);
  const home = options.home ?? process.env.HOME ?? "";
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  requireHostIdentity(platform, home, uid);
  const runner = options.runner ?? new BunProcessRunner();
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? Bun.sleep;
  const which = options.which ?? Bun.which;
  const capabilities = inspectCapabilities(platform, which);
  requireNativeCapabilities(platform, capabilities);
  const startedAt = timestamp(now);
  const runId = runIdFrom(startedAt);
  const steps: SmokeStep[] = [];
  const workspace =
    options.createWorkspace === undefined
      ? await createDisposableWorkspace(platform, home, uid, options.workspaceFilesystem)
      : await options.createWorkspace(platform, home, uid);
  const definitionMode = options.definitionMode ?? fileMode;
  const definitionExists = options.definitionExists ?? exists;
  const removeOwnedDefinition = options.removeOwnedDefinition ?? removeGeneratedDefinition;
  const removeWorkspace = options.removeWorkspace ?? removeTree;
  const workspaceExists = options.workspaceExists ?? exists;
  let failure: unknown;
  let gitRevision = "";
  let gitDirty = false;
  let gitVersion = "";
  let lifecycleComplete = false;
  let nativeUnregister: "passed" | "failed" | "not-needed" = "not-needed";
  let darwinOverrideBefore: DarwinOverrideDisposition | undefined;

  try {
    gitRevision = await executeTextStep(
      steps,
      runner,
      now,
      "git-revision",
      ["git", "rev-parse", "HEAD"],
      ["git", "rev-parse", "HEAD"],
      root,
      commandTimeoutMs,
      (output) => {
        const revision = output.trim();
        if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("invalid git revision");
        return { value: revision, diagnostic: "git revision captured" };
      },
    );
    gitDirty = await executeTextStep(
      steps,
      runner,
      now,
      "git-dirty",
      ["git", "status", "--porcelain=v1"],
      ["git", "status", "--porcelain=v1"],
      root,
      commandTimeoutMs,
      (output) => ({ value: output.length > 0, diagnostic: `dirty=${output.length > 0}` }),
    );
    gitVersion = await executeTextStep(
      steps,
      runner,
      now,
      "git-version",
      ["git", "--version"],
      ["git", "--version"],
      root,
      commandTimeoutMs,
      (output) => ({ value: singleLine(output), diagnostic: "git version captured" }),
    );
    await probeLinuxCapabilities(platform, capabilities, steps, runner, now, root, uid);
    if (platform === "darwin") {
      darwinOverrideBefore = await inspectDarwinOverride(
        steps,
        runner,
        now,
        "override-before",
        workspace,
        root,
        uid,
      );
      if (darwinOverrideBefore !== "absent") {
        throw new Error("disposable launchd label already has a persistent override");
      }
    }
    await executeStep(
      steps,
      runner,
      now,
      "compile",
      [
        "bun",
        "build",
        "--compile",
        "packages/ziggy/src/main.ts",
        "--outfile",
        workspace.executable,
      ],
      [
        "bun",
        "build",
        "--compile",
        "packages/ziggy/src/main.ts",
        "--outfile",
        "<disposable-binary>",
      ],
      root,
      compileTimeoutMs,
      () => "compiled standalone Ziggy executable",
    );
    await executeJsonStep(
      steps,
      runner,
      now,
      "init-profile",
      [workspace.executable, "init", workspace.profilePath],
      ["<compiled-ziggy>", "init", "<disposable-profile>"],
      root,
      (value) => summarizeInitialization(value, workspace.profilePath),
    );
    await executeJsonStep(
      steps,
      runner,
      now,
      "status-before-install",
      serviceArgv(workspace, "status"),
      sanitizedServiceArgv("status"),
      root,
      (value) => summarizeStatus(value, "absent", "unregistered", "stopped"),
    );
    const runningAfterInstall = await executeJsonValueStep(
      steps,
      runner,
      now,
      "install",
      serviceArgv(workspace, "install"),
      sanitizedServiceArgv("install"),
      root,
      summarizeRegisteredStatus,
    );
    if (!runningAfterInstall) {
      await waitForRunning(steps, runner, now, sleep, workspace, root, "install-readiness");
    }
    const mode = await definitionMode(workspace.definitionPath);
    if (mode !== 0o600) throw new Error("native service definition mode is not 0600");
    await executeStep(
      steps,
      runner,
      now,
      platform === "darwin" ? "plutil" : "systemd-analyze",
      platform === "darwin"
        ? ["plutil", "-lint", workspace.definitionPath]
        : ["systemd-analyze", "--user", "verify", workspace.definitionPath],
      platform === "darwin"
        ? ["plutil", "-lint", "<service-definition>"]
        : ["systemd-analyze", "--user", "verify", "<service-definition>"],
      root,
      commandTimeoutMs,
      () => `native definition valid mode=${mode.toString(8).padStart(4, "0")}`,
    );
    await executeJsonStep(
      steps,
      runner,
      now,
      "doctor-after-install",
      doctorArgv(workspace),
      sanitizedDoctorArgv(),
      root,
      summarizeDoctor,
    );
    const stoppedAfterStop = await executeJsonValueStep(
      steps,
      runner,
      now,
      "stop",
      serviceArgv(workspace, "stop"),
      sanitizedServiceArgv("stop"),
      root,
      summarizeStoppedStatus,
    );
    if (!stoppedAfterStop) {
      await waitForStopped(steps, runner, now, sleep, workspace, root);
    }
    const runningAfterStart = await executeJsonValueStep(
      steps,
      runner,
      now,
      "start",
      serviceArgv(workspace, "start"),
      sanitizedServiceArgv("start"),
      root,
      summarizeRegisteredStatus,
    );
    if (!runningAfterStart) {
      await waitForRunning(steps, runner, now, sleep, workspace, root, "start-readiness");
    }
    await executeJsonStep(
      steps,
      runner,
      now,
      "doctor-after-start",
      doctorArgv(workspace),
      sanitizedDoctorArgv(),
      root,
      summarizeDoctor,
    );
    await executeJsonStep(
      steps,
      runner,
      now,
      "remove",
      serviceArgv(workspace, "remove"),
      sanitizedServiceArgv("remove"),
      root,
      summarizeRemove,
    );
    lifecycleComplete = true;
  } catch (error) {
    failure = error;
  } finally {
    let cleanupResult = await executeCleanupStep(steps, runner, now, platform, workspace, root);
    if (platform === "darwin") {
      try {
        const after = await inspectDarwinOverride(
          steps,
          runner,
          now,
          "override-after",
          workspace,
          root,
          uid,
        );
        if (darwinOverrideBefore !== undefined && after !== darwinOverrideBefore) {
          failure = combineFailures(failure, new Error("launchd override disposition changed"));
        }
      } catch (error) {
        failure = combineFailures(failure, error);
      }
    }
    try {
      await removeOwnedDefinition(workspace.definitionPath, workspace.profileHash);
    } catch (error) {
      cleanupResult = false;
      failure = combineFailures(failure, error);
    }
    if (platform === "linux") {
      cleanupResult =
        (await executeLinuxPostRemovalCleanup(steps, runner, now, workspace, root)) &&
        cleanupResult;
    }
    nativeUnregister = cleanupResult ? "passed" : "failed";
    try {
      await removeWorkspace(workspace.directory);
    } catch (error) {
      failure = combineFailures(failure, error);
    }
  }

  const definitionRemoved = !(await definitionExists(workspace.definitionPath));
  const disposableWorkspaceRemoved = !(await workspaceExists(workspace.directory));
  if (!definitionRemoved || !disposableWorkspaceRemoved || nativeUnregister !== "passed") {
    failure = combineFailures(failure, new Error("native service smoke cleanup was incomplete"));
  }
  const finishedAt = timestamp(now);
  const record = {
    schemaVersion: 1,
    kind: "native-service-smoke",
    runId,
    platform,
    startedAt,
    finishedAt,
    git: { revision: gitRevision, dirty: gitDirty },
    toolingInputDigest: await toolingInputDigest(root),
    toolVersions: {
      bun: Bun.version,
      git: gitVersion,
      typescript: await typescriptVersion(root),
      host: `${platform} ${release()}`,
    },
    capabilities,
    steps,
    cleanup: {
      attempted: true,
      nativeUnregister,
      definitionRemoved,
      disposableWorkspaceRemoved,
      finishedAt,
    },
    replay: {
      command: ["bun", "run", "native-service:smoke"],
      requirements:
        platform === "darwin"
          ? ["Darwin login session with launchd", "launchctl and plutil on PATH"]
          : [
              "Linux login session with a systemd user manager",
              "systemctl, systemd-analyze, and loginctl on PATH",
              "user lingering enabled",
            ],
      instructions:
        "From the recorded git revision with files matching toolingInputDigest and the declared toolchain, run the command. It compiles Ziggy, creates a disposable Profile, exercises the native service lifecycle, validates the generated definition, and cleans up on every exit path.",
    },
    result: failure === undefined && lifecycleComplete ? "passed" : "failed",
  };
  await validateNativeServiceSmokeRecord(root, record, workspace);
  const text = `${JSON.stringify(record, undefined, 2)}\n`;
  const directory = await (options.publish ?? publishRecord)(root, runId, text);
  if (failure !== undefined || !lifecycleComplete) {
    throw new Error(`native service smoke failed; schema-valid evidence: ${directory}`, {
      cause: failure,
    });
  }
  return { directory, record };
}

export async function validateNativeServiceSmokeRecord(
  root: string,
  value: unknown,
  sensitive?: Workspace,
): Promise<void> {
  const schemas = await loadSchemaCatalog(root);
  schemas.validate(schemaName, value, "native service smoke record");
  const text = JSON.stringify(value);
  const forbidden = [
    root,
    sensitive?.directory,
    sensitive?.profilePath,
    sensitive?.executable,
    sensitive?.definitionPath,
    sensitive?.target,
    sensitive?.profileHash,
  ];
  for (const marker of forbidden) {
    if (marker !== undefined && marker.length > 0 && text.includes(marker)) {
      throw new Error("native service smoke record contains a private runtime identifier");
    }
  }
  if (
    /\/(?:Users|home|private|tmp)\//.test(text) ||
    /dev\.ziggy\.profile\.[a-f0-9]+/.test(text) ||
    /"(?:pid|uid|owner|profileHash|credentials?|secrets?)"\s*:/i.test(text)
  ) {
    throw new Error("native service smoke record failed the redaction scan");
  }
}

function requirePlatform(platform: string): NativePlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(`native service smoke unsupported on ${platform}`);
}

function requireHostIdentity(
  platform: NativePlatform,
  home: string,
  uid: number | undefined,
): void {
  if (home.length === 0 || !home.startsWith("/")) {
    throw new Error("native service smoke requires an absolute home directory");
  }
  if (platform === "darwin" && (uid === undefined || !Number.isInteger(uid) || uid < 1)) {
    throw new Error("native service smoke requires a Darwin login user ID");
  }
}

function inspectCapabilities(
  platform: NativePlatform,
  which: (executable: string) => string | null,
): Capabilities {
  const available = (name: string): Availability =>
    which(name) === null ? "missing" : "available";
  if (platform === "darwin") {
    return {
      darwin: {
        disposition: "available",
        launchd: available("launchctl"),
        plutil: available("plutil"),
      },
      linux: {
        disposition: "unavailable-on-host",
        systemctl: "not-probed",
        systemdAnalyze: "not-probed",
        loginctl: "not-probed",
        userManager: "not-probed",
        lingering: "not-probed",
      },
    };
  }
  return {
    darwin: { disposition: "unavailable-on-host", launchd: "not-probed", plutil: "not-probed" },
    linux: {
      disposition: "available",
      systemctl: available("systemctl"),
      systemdAnalyze: available("systemd-analyze"),
      loginctl: available("loginctl"),
      userManager: "unavailable",
      lingering: "unknown",
    },
  };
}

function requireNativeCapabilities(platform: NativePlatform, capabilities: Capabilities): void {
  if (
    platform === "darwin" &&
    (capabilities.darwin.launchd !== "available" || capabilities.darwin.plutil !== "available")
  ) {
    throw new Error("native service smoke unsupported: launchctl and plutil are required");
  }
  if (
    platform === "linux" &&
    (capabilities.linux.systemctl !== "available" ||
      capabilities.linux.systemdAnalyze !== "available" ||
      capabilities.linux.loginctl !== "available")
  ) {
    throw new Error(
      "native service smoke unsupported: systemctl, systemd-analyze, and loginctl are required",
    );
  }
}

async function probeLinuxCapabilities(
  platform: NativePlatform,
  capabilities: Capabilities,
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  root: string,
  uid: number | undefined,
): Promise<void> {
  if (platform !== "linux") return;
  if (uid === undefined) throw new Error("native service smoke requires a Linux login user ID");
  try {
    await executeStep(
      steps,
      runner,
      now,
      "systemd-user-manager",
      ["systemctl", "--user", "show-environment"],
      ["systemctl", "--user", "show-environment"],
      root,
      commandTimeoutMs,
      () => "systemd user manager available",
    );
  } catch (error) {
    capabilities.linux.disposition = "unsupported";
    throw error;
  }
  capabilities.linux.userManager = "available";
  const lingering = await executeTextStep(
    steps,
    runner,
    now,
    "systemd-lingering",
    ["loginctl", "show-user", String(uid), "--property=Linger", "--value"],
    ["loginctl", "show-user", "<owner>", "--property=Linger", "--value"],
    root,
    commandTimeoutMs,
    (output) => {
      const enabled = output.trim() === "yes";
      return { value: enabled, diagnostic: `lingering=${enabled ? "enabled" : "disabled"}` };
    },
  );
  capabilities.linux.lingering = lingering ? "enabled" : "disabled";
  if (!lingering) {
    capabilities.linux.disposition = "unsupported";
    throw new Error("native service smoke unsupported: Linux user lingering is disabled");
  }
}

async function createDisposableWorkspace(
  platform: NativePlatform,
  home: string,
  uid: number | undefined,
  filesystem: WorkspaceFilesystem = nativeWorkspaceFilesystem,
): Promise<Workspace> {
  const directory = await filesystem.mkdtemp(join(home, ".ziggy-native-smoke-"));
  try {
    const profilePath = join(directory, "Profile");
    await filesystem.mkdir(profilePath);
    const executable = join(directory, "ziggy-smoke");
    const profileHash = createHash("sha256").update(profilePath).digest("hex");
    const label = `dev.ziggy.profile.${profileHash}`;
    if (platform === "darwin") {
      if (uid === undefined) throw new Error("Darwin workspace requires a login user ID");
      return {
        directory,
        profilePath,
        executable,
        profileHash,
        definitionPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
        target: `gui/${uid}/${label}`,
      };
    }
    const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
    return {
      directory,
      profilePath,
      executable,
      profileHash,
      definitionPath: join(configHome, "systemd", "user", `${label}.service`),
      target: `${label}.service`,
    };
  } catch (error) {
    try {
      await filesystem.remove(directory);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "workspace creation and cleanup failed");
    }
    throw error;
  }
}

const nativeWorkspaceFilesystem: WorkspaceFilesystem = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  mkdir: async (path) => {
    await mkdir(path, { mode: 0o700 });
  },
  remove: (path) => rm(path, { recursive: true, force: true }),
};

async function executeJsonStep(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  actual: ReadonlyArray<string>,
  sanitized: ReadonlyArray<string>,
  cwd: string,
  summarize: (value: unknown) => string,
): Promise<void> {
  await executeStep(steps, runner, now, id, actual, sanitized, cwd, commandTimeoutMs, (result) => {
    const value: unknown = JSON.parse(result.stdout);
    return summarize(value);
  });
}

async function executeJsonValueStep<T>(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  actual: ReadonlyArray<string>,
  sanitized: ReadonlyArray<string>,
  cwd: string,
  read: (value: unknown) => { readonly value: T; readonly diagnostic: string },
): Promise<T> {
  return executeTextStep(
    steps,
    runner,
    now,
    id,
    actual,
    sanitized,
    cwd,
    commandTimeoutMs,
    (output) => {
      const value: unknown = JSON.parse(output);
      return read(value);
    },
  );
}

async function waitForRunning(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  sleep: (milliseconds: number) => Promise<void>,
  workspace: Workspace,
  root: string,
  idPrefix: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await sleep(100);
    const running = await executeJsonValueStep(
      steps,
      runner,
      now,
      `${idPrefix}-${attempt}`,
      serviceArgv(workspace, "status"),
      sanitizedServiceArgv("status"),
      root,
      summarizeRegisteredStatus,
    );
    if (running) return;
  }
  throw new Error(`${idPrefix} did not reach running state`);
}

async function waitForStopped(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  sleep: (milliseconds: number) => Promise<void>,
  workspace: Workspace,
  root: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await sleep(100);
    const stopped = await executeJsonValueStep(
      steps,
      runner,
      now,
      `stop-readiness-${attempt}`,
      serviceArgv(workspace, "status"),
      sanitizedServiceArgv("status"),
      root,
      summarizeStoppedStatus,
    );
    if (stopped) return;
  }
  throw new Error("stop-readiness did not reach unregistered stopped state");
}

async function executeTextStep<T>(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  actual: ReadonlyArray<string>,
  sanitized: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
  read: (stdout: string) => { readonly value: T; readonly diagnostic: string },
): Promise<T> {
  let value: T | undefined;
  await executeStep(steps, runner, now, id, actual, sanitized, cwd, timeoutMs, (result) => {
    const parsed = read(result.stdout);
    value = parsed.value;
    return parsed.diagnostic;
  });
  if (value === undefined) throw new Error(`${id} did not produce a value`);
  return value;
}

async function executeStep(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  actual: ReadonlyArray<string>,
  sanitized: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
  summarize: (result: ProcessResult) => string,
): Promise<void> {
  const startedAt = timestamp(now);
  let result: ProcessResult;
  try {
    result = await runner.run({ argv: actual, cwd, timeoutMs });
  } catch (error) {
    const finishedAt = timestamp(now);
    steps.push(
      step(id, sanitized, startedAt, finishedAt, -1, false, "failed", "command spawn failed"),
    );
    throw error;
  }
  const finishedAt = timestamp(now);
  if (result.timedOut || result.exitCode !== 0) {
    steps.push(
      step(
        id,
        sanitized,
        startedAt,
        finishedAt,
        result.exitCode,
        result.timedOut,
        "failed",
        result.timedOut ? "command timed out" : `command failed exit=${result.exitCode}`,
      ),
    );
    throw new Error(`${id} failed`);
  }
  try {
    const diagnostic = summarize(result);
    steps.push(
      step(id, sanitized, startedAt, finishedAt, result.exitCode, false, "passed", diagnostic),
    );
  } catch (error) {
    steps.push(
      step(
        id,
        sanitized,
        startedAt,
        finishedAt,
        result.exitCode,
        false,
        "failed",
        "command output failed semantic validation",
      ),
    );
    throw error;
  }
}

async function inspectDarwinOverride(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  workspace: Workspace,
  cwd: string,
  uid: number | undefined,
): Promise<DarwinOverrideDisposition> {
  if (uid === undefined) throw new Error("Darwin override inspection requires a login user ID");
  const label = workspace.target.slice(workspace.target.lastIndexOf("/") + 1);
  return executeTextStep(
    steps,
    runner,
    now,
    id,
    ["launchctl", "print-disabled", `gui/${uid}`],
    ["launchctl", "print-disabled", "<user-domain>"],
    cwd,
    commandTimeoutMs,
    (output) => {
      const disposition = parseDarwinOverride(output, label);
      return { value: disposition, diagnostic: `override=${disposition}` };
    },
  );
}

function parseDarwinOverride(output: string, label: string): DarwinOverrideDisposition {
  for (const line of output.split("\n")) {
    const match = /^\s*"?([^"\s]+)"?\s*=>\s*(true|false|enabled|disabled)\s*,?\s*$/.exec(line);
    if (match?.[1] !== label) continue;
    const state = match[2];
    return state === "true" || state === "disabled" ? "disabled" : "enabled";
  }
  return output.length <= 65_536 && /disabled services\s*=\s*\{|^\s*\{/m.test(output)
    ? "absent"
    : "unknown";
}

async function executeCleanupStep(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  platform: NativePlatform,
  workspace: Workspace,
  cwd: string,
): Promise<boolean> {
  const unregister = await executeNativeCleanupCommand(
    steps,
    runner,
    now,
    "cleanup-unregister",
    platform === "darwin"
      ? ["launchctl", "bootout", workspace.target]
      : ["systemctl", "--user", "stop", workspace.target],
    platform === "darwin"
      ? ["launchctl", "bootout", "<service-target>"]
      : ["systemctl", "--user", "stop", "<service-target>"],
    cwd,
    platform === "darwin" ? [0, 3, 113] : [0],
    "native service unregistered",
  );
  if (platform === "darwin") return unregister;
  await executeNativeCleanupCommand(
    steps,
    runner,
    now,
    "cleanup-disable",
    ["systemctl", "--user", "disable", "--now", workspace.target],
    ["systemctl", "--user", "disable", "--now", "<service-target>"],
    cwd,
    [0],
    "native service disabled",
  );
  return true;
}

async function executeLinuxPostRemovalCleanup(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  workspace: Workspace,
  cwd: string,
): Promise<boolean> {
  const reloaded = await executeNativeCleanupCommand(
    steps,
    runner,
    now,
    "cleanup-daemon-reload",
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "daemon-reload"],
    cwd,
    [0],
    "systemd user manager reloaded",
  );
  const managerStateRemoved = await executeNativeCleanupManagerStateCheck(
    steps,
    runner,
    now,
    workspace,
    cwd,
  );
  const inactive = await executeNativeCleanupStateCheck(
    steps,
    runner,
    now,
    "cleanup-inactive",
    ["systemctl", "--user", "is-active", workspace.target],
    ["systemctl", "--user", "is-active", "<service-target>"],
    cwd,
    [3],
    new Set(["inactive"]),
    "native service is inactive",
  );
  const enablementRemoved = await executeNativeCleanupStateCheck(
    steps,
    runner,
    now,
    "cleanup-disabled",
    ["systemctl", "--user", "is-enabled", workspace.target],
    ["systemctl", "--user", "is-enabled", "<service-target>"],
    cwd,
    [1],
    new Set(["not-found"]),
    "native service definition and enablement are absent",
  );
  return reloaded && managerStateRemoved && inactive && enablementRemoved;
}

async function executeNativeCleanupManagerStateCheck(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  workspace: Workspace,
  cwd: string,
): Promise<boolean> {
  const actual = [
    "systemctl",
    "--user",
    "show",
    workspace.target,
    "--property=LoadState",
    "--property=ActiveState",
  ];
  const sanitized = [
    "systemctl",
    "--user",
    "show",
    "<service-target>",
    "--property=LoadState",
    "--property=ActiveState",
  ];
  const startedAt = timestamp(now);
  try {
    const result = await runner.run({ argv: actual, cwd, timeoutMs: commandTimeoutMs });
    const states = new Set(result.stdout.trim().split("\n"));
    const passed =
      !result.timedOut &&
      result.exitCode === 0 &&
      result.stderr.trim().length === 0 &&
      states.size === 2 &&
      states.has("LoadState=not-found") &&
      states.has("ActiveState=inactive");
    steps.push(
      step(
        "cleanup-manager-state",
        sanitized,
        startedAt,
        timestamp(now),
        result.exitCode,
        result.timedOut,
        passed ? "passed" : "failed",
        passed
          ? "systemd manager reports definition absent and service inactive"
          : "systemd manager retained stale service state",
      ),
    );
    return passed;
  } catch {
    steps.push(
      step(
        "cleanup-manager-state",
        sanitized,
        startedAt,
        timestamp(now),
        -1,
        false,
        "failed",
        "systemd manager state inspection spawn failed",
      ),
    );
    return false;
  }
}

async function executeNativeCleanupCommand(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  actual: ReadonlyArray<string>,
  sanitized: ReadonlyArray<string>,
  cwd: string,
  allowedExitCodes: ReadonlyArray<number>,
  successDiagnostic: string,
): Promise<boolean> {
  const startedAt = timestamp(now);
  try {
    const result = await runner.run({ argv: actual, cwd, timeoutMs: commandTimeoutMs });
    const passed = !result.timedOut && allowedExitCodes.includes(result.exitCode);
    steps.push(
      step(
        id,
        sanitized,
        startedAt,
        timestamp(now),
        result.exitCode,
        result.timedOut,
        passed ? "passed" : "failed",
        passed ? successDiagnostic : "native cleanup command failed",
      ),
    );
    return passed;
  } catch {
    steps.push(
      step(
        id,
        sanitized,
        startedAt,
        timestamp(now),
        -1,
        false,
        "failed",
        "native cleanup command spawn failed",
      ),
    );
    return false;
  }
}

async function executeNativeCleanupStateCheck(
  steps: SmokeStep[],
  runner: ProcessRunner,
  now: () => Date,
  id: string,
  actual: ReadonlyArray<string>,
  sanitized: ReadonlyArray<string>,
  cwd: string,
  allowedExitCodes: ReadonlyArray<number>,
  allowedStates: ReadonlySet<string>,
  successDiagnostic: string,
): Promise<boolean> {
  const startedAt = timestamp(now);
  try {
    const result = await runner.run({ argv: actual, cwd, timeoutMs: commandTimeoutMs });
    const state = result.stdout.trim();
    const passed =
      !result.timedOut &&
      allowedExitCodes.includes(result.exitCode) &&
      result.stderr.trim().length === 0 &&
      allowedStates.has(state);
    steps.push(
      step(
        id,
        sanitized,
        startedAt,
        timestamp(now),
        result.exitCode,
        result.timedOut,
        passed ? "passed" : "failed",
        passed ? successDiagnostic : "native cleanup state verification failed",
      ),
    );
    return passed;
  } catch {
    steps.push(
      step(
        id,
        sanitized,
        startedAt,
        timestamp(now),
        -1,
        false,
        "failed",
        "native cleanup state inspection spawn failed",
      ),
    );
    return false;
  }
}

function step(
  id: string,
  command: ReadonlyArray<string>,
  startedAt: string,
  finishedAt: string,
  exitCode: number,
  timedOut: boolean,
  result: "passed" | "failed",
  diagnosticText: string,
): SmokeStep {
  return {
    id,
    command: [...command],
    startedAt,
    finishedAt,
    exitCode,
    timedOut,
    result,
    diagnostic: diagnostic(diagnosticText),
  };
}

function diagnostic(value: string): Diagnostic {
  const truncated = value.length > diagnosticLimit;
  const text = truncated ? value.slice(0, diagnosticLimit) : value;
  return { text, digest: createHash("sha256").update(text).digest("hex"), truncated };
}

function summarizeInitialization(value: unknown, profilePath: string): string {
  const record = requireRecord(value, "Profile initialization");
  if (record.schemaVersion !== 1)
    throw new Error("Profile initialization schemaVersion is invalid");
  requireField(record, "profilePath", profilePath);
  requireField(record, "voice", "clear");
  const created = record.created;
  const expected = [
    "ziggy.jsonc",
    "automations/",
    "credentials/",
    "extensions/",
    "memory/",
    "sessions/",
    "SOUL.md",
  ];
  if (
    !Array.isArray(created) ||
    created.length !== expected.length ||
    created.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error("Profile initialization scaffold is invalid");
  }
  return "schemaVersion=1 voice=clear scaffold=complete";
}

function summarizeStatus(
  value: unknown,
  definition: string,
  registration: string,
  processState: string,
): string {
  const record = requireRecord(value, "service status");
  requireField(record, "definition", definition);
  requireField(record, "registration", registration);
  requireField(record, "process", processState);
  return `definition=${definition} registration=${registration} process=${processState}`;
}

function summarizeRegisteredStatus(value: unknown): {
  readonly value: boolean;
  readonly diagnostic: string;
} {
  const record = requireRecord(value, "service status");
  requireField(record, "definition", "current");
  requireField(record, "registration", "registered");
  const processState = record.process;
  if (processState !== "running" && processState !== "stopped") {
    throw new Error("registered service process state is invalid");
  }
  return {
    value: processState === "running",
    diagnostic: `definition=current registration=registered process=${processState}`,
  };
}

function summarizeStoppedStatus(value: unknown): {
  readonly value: boolean;
  readonly diagnostic: string;
} {
  const record = requireRecord(value, "service status");
  requireField(record, "definition", "current");
  const registration = record.registration;
  const processState = record.process;
  if (
    (registration !== "registered" && registration !== "unregistered") ||
    (processState !== "running" && processState !== "stopped")
  ) {
    throw new Error("stopping service state is invalid");
  }
  return {
    value: registration === "unregistered" && processState === "stopped",
    diagnostic: `definition=current registration=${registration} process=${processState}`,
  };
}

function summarizeDoctor(value: unknown): string {
  const record = requireRecord(value, "doctor report");
  if (record.healthy !== true) throw new Error("doctor report is unhealthy");
  const checks = requireRecord(record.checks, "doctor checks");
  const daemon = checkStatus(checks, "daemon");
  const socket = checkStatus(checks, "socket");
  const profileLock = checkStatus(checks, "profileLock");
  const providerAuth = checkStatus(checks, "providerAuth");
  if (daemon !== "ok" || socket !== "ok" || profileLock !== "ok") {
    throw new Error("doctor runtime checks did not pass");
  }
  return `healthy=true daemon=${daemon} socket=${socket} profileLock=${profileLock} providerAuth=${providerAuth}`;
}

function summarizeRemove(value: unknown): string {
  const record = requireRecord(value, "service remove");
  requireField(record, "kind", "removed");
  return "result=removed";
}

function checkStatus(record: Record<string, unknown>, name: string): string {
  const check = requireRecord(record[name], `doctor ${name}`);
  const status = check.status;
  if (status !== "ok" && status !== "warning" && status !== "error") {
    throw new Error(`doctor ${name} has invalid status`);
  }
  return status;
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireField(record: Record<string, unknown>, name: string, expected: string): void {
  if (record[name] !== expected) throw new Error(`${name} did not equal ${expected}`);
}

function serviceArgv(workspace: Workspace, action: string): ReadonlyArray<string> {
  return [workspace.executable, "service", action, "--profile", workspace.profilePath];
}

function sanitizedServiceArgv(action: string): ReadonlyArray<string> {
  return ["<compiled-ziggy>", "service", action, "--profile", "<disposable-profile>"];
}

function doctorArgv(workspace: Workspace): ReadonlyArray<string> {
  return [workspace.executable, "doctor", "--profile", workspace.profilePath];
}

function sanitizedDoctorArgv(): ReadonlyArray<string> {
  return ["<compiled-ziggy>", "doctor", "--profile", "<disposable-profile>"];
}

async function fileMode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeGeneratedDefinition(path: string, profileHash: string): Promise<void> {
  if (!(await exists(path))) return;
  const content = await readFile(path, "utf8");
  if (!content.includes(`"profileHash":"${profileHash}"`)) {
    throw new Error("refusing to remove a service definition without matching ownership");
  }
  await rm(path);
}

async function removeTree(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

async function publishRecord(root: string, runId: string, text: string): Promise<string> {
  const parent = join(root, ".artifacts", "verification");
  const destination = join(parent, runId);
  const temporary = join(parent, `.${runId}.tmp-${crypto.randomUUID()}`);
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(temporary);
    await Bun.write(join(temporary, "record.json"), text);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
  return destination;
}

async function typescriptVersion(root: string): Promise<string> {
  const value: unknown = JSON.parse(await Bun.file(join(root, "package.json")).text());
  const packageJson = requireRecord(value, "package.json");
  const dependencies = requireRecord(packageJson.devDependencies, "package.json devDependencies");
  const version = dependencies.typescript;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json does not declare TypeScript");
  }
  return version;
}

export async function toolingInputDigest(root: string): Promise<string> {
  const roots = [
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "tsconfig.base.json",
    "packages/core/package.json",
    "packages/core/tsconfig.json",
    "packages/core/src",
    "packages/protocol/package.json",
    "packages/protocol/tsconfig.json",
    "packages/protocol/src",
    "packages/ziggy/package.json",
    "packages/ziggy/tsconfig.json",
    "packages/ziggy/src",
    "tooling/verification",
    "verification/schemas",
  ];
  const paths: string[] = [];
  for (const path of roots) paths.push(...(await digestInputPaths(root, path)));
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash.update(`${path}\0`);
    hash.update(new Uint8Array(await Bun.file(join(root, path)).arrayBuffer()));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function digestInputPaths(root: string, path: string): Promise<ReadonlyArray<string>> {
  const absolute = join(root, path);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`tooling input symlink rejected: ${path}`);
  if (metadata.isFile()) return [path];
  if (!metadata.isDirectory()) throw new Error(`tooling input is not a regular file: ${path}`);
  const paths: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`tooling input symlink rejected: ${child}`);
    if (entry.isDirectory()) paths.push(...(await digestInputPaths(root, child)));
    else if (entry.isFile()) paths.push(child);
  }
  return paths;
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function runIdFrom(timestampValue: string): string {
  return `native-service-smoke-${timestampValue.replaceAll("-", "").replaceAll(":", "").slice(0, 15)}Z`;
}

function singleLine(value: string): string {
  const line = value.trim();
  if (line.length === 0 || line.includes("\n") || line.length > 128) {
    throw new Error("tool version must be one bounded line");
  }
  return line;
}

function combineFailures(first: unknown, second: unknown): unknown {
  return first === undefined
    ? second
    : new AggregateError([first, second], "smoke and cleanup failed");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

if (import.meta.main) {
  const root = new URL("../..", import.meta.url).pathname;
  const result = await runNativeServiceSmoke(root);
  console.log(`native service smoke: passed (${result.directory})`);
}
