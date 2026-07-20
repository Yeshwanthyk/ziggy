import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemWorld,
  inspectProfileLock,
  type AttachServer,
  type DaemonKernel,
  type FilesystemWorld,
  type ProfileLockInspection,
  type SessionRuntime,
} from "@ziggy/core";
import {
  decodeServerFrame,
  encodeClientRequest,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@ziggy/protocol";

const SOCKET_MODE = 0o600;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const READINESS_REQUEST_ID = "ziggy-readiness";

export interface ServeDaemonOptions {
  readonly profilePath: string;
  readonly signal: AbortSignal;
  readonly createRuntime?: (sessionId: string, world: FilesystemWorld) => Promise<SessionRuntime>;
}

export type DaemonProbeResult =
  | {
      readonly status: "ready";
      readonly profilePath: string;
      readonly socketPath: string;
      readonly protocolVersion: 1;
    }
  | {
      readonly status: "unavailable";
      readonly profilePath: string;
      readonly socketPath: string;
      readonly socketState: "absent" | "stale";
      readonly detail: string;
    }
  | {
      readonly status: "unsafe";
      readonly profilePath: string;
      readonly socketPath: string;
      readonly detail: string;
    }
  | {
      readonly status: "incompatible";
      readonly profilePath: string;
      readonly socketPath: string;
      readonly detail: string;
    };

export interface ProbeDaemonOptions {
  readonly profilePath: string;
  readonly timeoutMs?: number;
  readonly canonicalize?: (path: string) => Promise<string>;
}

export interface EnsureDaemonReadyOptions {
  readonly profilePath: string;
  readonly start: (canonicalProfilePath: string) => Promise<void>;
  readonly probe?: (canonicalProfilePath: string) => Promise<DaemonProbeResult>;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
}

export interface DoctorCheck {
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
  readonly pid?: number;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly profilePath: string;
  readonly healthy: boolean;
  readonly checks: {
    readonly daemon: DoctorCheck;
    readonly socket: DoctorCheck;
    readonly profileLock: DoctorCheck;
    readonly providerAuth: DoctorCheck;
  };
}

export interface DoctorOptions {
  readonly profilePath: string;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly probe?: (canonicalProfilePath: string) => Promise<DaemonProbeResult>;
  readonly inspectLock?: (canonicalProfilePath: string) => Promise<ProfileLockInspection>;
  readonly providerAuthPresent?: () => boolean;
}

const readinessGates = new Map<string, Promise<DaemonProbeResult>>();

export async function serveDaemon(options: ServeDaemonOptions): Promise<void> {
  let kernel: DaemonKernel | undefined;
  let server: AttachServer | undefined;
  let failed = false;
  let failure: unknown;
  try {
    kernel = await createDaemonKernel({
      profilePath: options.profilePath,
      createWorld: (profilePath) => createFilesystemWorld({ profilePath }),
      createRuntime: options.createRuntime ?? unavailableRuntime,
    });
    server = await createAttachServer({ kernel });
    await waitForAbort(options.signal);
  } catch (error) {
    failed = true;
    failure = error;
  }

  const closeFailures: unknown[] = [];
  if (server !== undefined) {
    try {
      await server.close();
    } catch (error) {
      closeFailures.push(error);
    }
  }
  if (kernel !== undefined) {
    try {
      await kernel.close();
    } catch (error) {
      closeFailures.push(error);
    }
  }
  if (failed && closeFailures.length > 0) {
    throw new AggregateError([failure, ...closeFailures], "Daemon failed and cleanup also failed");
  }
  if (failed) throw failure;
  if (closeFailures.length > 0) throw new AggregateError(closeFailures, "Daemon cleanup failed");
}

export async function probeDaemon(options: ProbeDaemonOptions): Promise<DaemonProbeResult> {
  const canonicalize = options.canonicalize ?? realpath;
  const profilePath = await canonicalize(options.profilePath);
  const socketPath = join(profilePath, ".runtime", "ziggy.sock");
  let socket: Stats;
  try {
    socket = await lstat(socketPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return {
        status: "unavailable",
        profilePath,
        socketPath,
        socketState: "absent",
        detail: "Attach socket is absent",
      };
    }
    throw error;
  }
  if (!socket.isSocket() || socket.isSymbolicLink()) {
    return {
      status: "unsafe",
      profilePath,
      socketPath,
      detail: "Attach socket path is not a Unix socket",
    };
  }
  if ((socket.mode & 0o777) !== SOCKET_MODE) {
    return {
      status: "unsafe",
      profilePath,
      socketPath,
      detail: "Attach socket permissions are not 0600",
    };
  }
  return probeSocket(
    profilePath,
    socketPath,
    positiveMilliseconds(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
  );
}

export async function ensureDaemonReady(
  options: EnsureDaemonReadyOptions,
): Promise<DaemonProbeResult> {
  const profilePath = await (options.canonicalize ?? realpath)(options.profilePath);
  const pending = readinessGates.get(profilePath);
  if (pending !== undefined) return pending;
  const operation = ensureCanonicalDaemonReady(profilePath, options);
  readinessGates.set(profilePath, operation);
  const clear = (): void => {
    if (readinessGates.get(profilePath) === operation) readinessGates.delete(profilePath);
  };
  void operation.then(clear, clear);
  return operation;
}

export function ensureProductionDaemonReady(profilePath: string): Promise<DaemonProbeResult> {
  return ensureDaemonReady({
    profilePath,
    start: startBackgroundDaemon,
  });
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const profilePath = await (options.canonicalize ?? realpath)(options.profilePath);
  let probe: DaemonProbeResult;
  try {
    probe = await (options.probe ?? ((path) => probeDaemon({ profilePath: path })))(profilePath);
  } catch (error) {
    probe = {
      status: "unsafe",
      profilePath,
      socketPath: join(profilePath, ".runtime", "ziggy.sock"),
      detail: errorDetail(error, "Attach socket inspection failed"),
    };
  }
  let lock: ProfileLockInspection | undefined;
  let lockFailure: unknown;
  try {
    lock = await (options.inspectLock ?? ((path) => inspectProfileLock({ profilePath: path })))(
      profilePath,
    );
  } catch (error) {
    lockFailure = error;
  }
  const daemon = daemonCheck(probe);
  const socket = socketCheck(probe);
  const profileLock = lockCheck(probe, lock, lockFailure);
  const providerAuth: DoctorCheck = (options.providerAuthPresent ?? productionProviderAuthPresent)()
    ? { status: "ok", detail: "Provider authentication is present" }
    : {
        status: "warning",
        detail: "No supported Provider API-key environment variable is present",
      };
  const checks = { daemon, socket, profileLock, providerAuth };
  return {
    schemaVersion: 1,
    profilePath,
    healthy: Object.values(checks).every((check) => check.status !== "error"),
    checks,
  };
}

async function ensureCanonicalDaemonReady(
  profilePath: string,
  options: EnsureDaemonReadyOptions,
): Promise<DaemonProbeResult> {
  const probe = options.probe ?? ((path) => probeDaemon({ profilePath: path }));
  const initial = await probe(profilePath);
  if (initial.status === "ready") return initial;
  if (initial.status !== "unavailable") {
    throw new Error(`Refusing daemon auto-start: ${initial.detail}`);
  }
  await options.start(profilePath);

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = positiveMilliseconds(options.timeoutMs, DEFAULT_START_TIMEOUT_MS);
  const retryIntervalMs = positiveMilliseconds(options.retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS);
  const deadline = now() + timeoutMs;
  let latest: DaemonProbeResult = initial;
  while (now() < deadline) {
    latest = await probe(profilePath);
    if (latest.status === "ready") return latest;
    if (latest.status === "incompatible") {
      throw new Error(`Daemon started an incompatible attach server: ${latest.detail}`);
    }
    await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - now())));
  }
  throw new Error(`Daemon did not become protocol-ready: ${latest.detail}`);
}

function probeSocket(
  profilePath: string,
  socketPath: string,
  timeoutMs: number,
): Promise<DaemonProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let connected = false;
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (result: DaemonProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const unavailable = (socketState: "absent" | "stale", detail: string): void =>
      finish({ status: "unavailable", profilePath, socketPath, socketState, detail });
    const incompatible = (detail: string): void =>
      finish({ status: "incompatible", profilePath, socketPath, detail });
    const timer = setTimeout(() => {
      incompatible(
        connected
          ? `Attach protocol initialize timed out after ${timeoutMs}ms`
          : `Attach socket connection timed out after ${timeoutMs}ms`,
      );
    }, timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(
        encodeClientRequest({
          schemaVersion: PROTOCOL_VERSION,
          requestId: READINESS_REQUEST_ID,
          method: "initialize",
          params: { client: { name: "ziggy-readiness", version: "0.0.0" }, features: [] },
        }),
      );
    });
    socket.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      response = Buffer.concat([response, bytes]);
      if (response.byteLength > MAX_PROBE_RESPONSE_BYTES) {
        incompatible("Attach protocol initialize response is too large");
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      if (newline + 1 !== response.byteLength) {
        incompatible("Attach server sent multiple frames during initialize");
        return;
      }
      let frame: ServerFrame;
      try {
        const encoded = new TextDecoder("utf-8", { fatal: true }).decode(response);
        frame = decodeServerFrame(encoded);
      } catch {
        incompatible("Attach server returned an invalid initialize frame");
        return;
      }
      if (
        frame.type !== "success" ||
        frame.requestId !== READINESS_REQUEST_ID ||
        frame.method !== "initialize" ||
        frame.result.protocolVersion !== PROTOCOL_VERSION
      ) {
        incompatible("Attach server did not complete the expected initialize handshake");
        return;
      }
      finish({ status: "ready", profilePath, socketPath, protocolVersion: PROTOCOL_VERSION });
    });
    socket.on("error", (error) => {
      if (!connected && hasCode(error, "ENOENT")) unavailable("absent", "Attach socket is absent");
      else if (!connected && hasCode(error, "ECONNREFUSED"))
        unavailable("stale", "Attach socket is stale or not accepting connections");
      else incompatible("Attach socket failed during protocol initialize");
    });
    socket.on("close", () => {
      if (!settled) {
        if (connected) incompatible("Attach server closed before initialize completed");
        else unavailable("stale", "Attach socket closed before accepting a connection");
      }
    });
  });
}

function daemonCheck(probe: DaemonProbeResult): DoctorCheck {
  return probe.status === "ready"
    ? {
        status: "ok",
        detail: `Daemon completed attach protocol v${probe.protocolVersion} initialize`,
      }
    : { status: "error", detail: probe.detail };
}

function socketCheck(probe: DaemonProbeResult): DoctorCheck {
  switch (probe.status) {
    case "ready":
    case "incompatible":
      return { status: "ok", detail: "Attach path is a mode-0600 Unix socket" };
    case "unavailable":
      return {
        status: "warning",
        detail:
          probe.socketState === "absent"
            ? "Attach socket is absent"
            : "A mode-0600 socket exists but is stale",
      };
    case "unsafe":
      return { status: "error", detail: probe.detail };
  }
}

function lockCheck(
  probe: DaemonProbeResult,
  lock: ProfileLockInspection | undefined,
  failure: unknown,
): DoctorCheck {
  if (failure !== undefined) {
    return { status: "error", detail: errorDetail(failure, "Profile lock metadata is invalid") };
  }
  if (lock === undefined) {
    return { status: "error", detail: "Profile lock inspection did not complete" };
  }
  switch (lock.state) {
    case "stale":
      return { status: "error", detail: `Profile lock is stale (PID ${lock.pid})`, pid: lock.pid };
    case "live":
      return {
        status: probe.status === "ready" ? "ok" : "warning",
        detail:
          probe.status === "ready"
            ? `Profile lock is held by live PID ${lock.pid}`
            : `Profile lock PID ${lock.pid} is live but the daemon is not protocol-ready`,
        pid: lock.pid,
      };
    case "absent":
      return probe.status === "ready"
        ? { status: "error", detail: "Daemon is ready without a Profile ownership lock" }
        : { status: "ok", detail: "No Profile ownership lock is present" };
  }
}

function startBackgroundDaemon(profilePath: string): Promise<void> {
  const child = Bun.spawn([...productionServeArgv(profilePath)], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  return Promise.resolve();
}

function productionServeArgv(profilePath: string): ReadonlyArray<string> {
  if ("isStandaloneExecutable" in Bun && Bun.isStandaloneExecutable === true) {
    return [process.execPath, "serve", "--profile", profilePath];
  }
  if (Bun.main.length === 0) throw new Error("Cannot locate the Ziggy source entry point");
  return [process.execPath, Bun.main, "serve", "--profile", profilePath];
}

function productionProviderAuthPresent(): boolean {
  return [
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  ].some((value) => value !== undefined && value.trim().length > 0);
}

function unavailableRuntime(): Promise<SessionRuntime> {
  return Promise.reject(
    new Error("Session Provider composition is unavailable until Profile configuration lands"),
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("Timeout and retry values must be positive safe integers");
  }
  return resolved;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorDetail(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
