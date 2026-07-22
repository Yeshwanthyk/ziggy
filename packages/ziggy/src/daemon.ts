import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemWorld,
  createProviderRuntimeComposition,
  ExtensionLifecycle,
  inspectProfileLock,
  type ProfileLockInspection,
  ProviderRuntimeError,
  ZIGGY_VERSION,
} from "@ziggy/core";
import {
  decodeServerFrame,
  encodeClientRequest,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@ziggy/protocol";
import { Clock, Context, Deferred, Effect, Layer, Option, Ref, Result, Schema } from "effect";
import { queryProviderAuthStatus } from "./auth-client.ts";
import { productionRuntimeInvocation, serveArgv } from "./executable.ts";
import { loadProfileConfig } from "./profile-config.ts";

const SOCKET_MODE = 0o600;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const READINESS_REQUEST_ID = "ziggy-readiness";

const ErrorMessageSchema = Schema.Struct({ message: Schema.String });
const ErrorCodeSchema = Schema.Struct({ code: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessageSchema);
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCodeSchema);

export class DaemonControlError extends Schema.TaggedErrorClass<DaemonControlError>()(
  "DaemonControlError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ServeDaemonOptions {
  readonly profilePath: string;
  readonly signal: AbortSignal;
}

export type DaemonProbeResult =
  | {
      readonly status: "ready";
      readonly profilePath: string;
      readonly socketPath: string;
      readonly protocolVersion: typeof PROTOCOL_VERSION;
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
  readonly canonicalize?: (path: string) => Effect.Effect<string, DaemonControlError>;
}

export interface EnsureDaemonReadyOptions {
  readonly profilePath: string;
  readonly start: (canonicalProfilePath: string) => Effect.Effect<void, DaemonControlError>;
  readonly probe?: (
    canonicalProfilePath: string,
  ) => Effect.Effect<DaemonProbeResult, DaemonControlError>;
  readonly canonicalize?: (path: string) => Effect.Effect<string, DaemonControlError>;
  readonly now?: Effect.Effect<number>;
  readonly sleep?: (milliseconds: number) => Effect.Effect<void>;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly requireAbsent?: boolean;
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
  readonly canonicalize?: (path: string) => Effect.Effect<string, DaemonControlError>;
  readonly probe?: (
    canonicalProfilePath: string,
  ) => Effect.Effect<DaemonProbeResult, DaemonControlError>;
  readonly inspectLock?: (
    canonicalProfilePath: string,
  ) => Effect.Effect<ProfileLockInspection, DaemonControlError>;
  readonly providerAuthPresent?: Effect.Effect<boolean, DaemonControlError>;
  readonly providerAuthStatus?: (socketPath: string) => Effect.Effect<boolean, DaemonControlError>;
}

interface ReadinessGate {
  readonly owner: boolean;
  readonly result: Deferred.Deferred<DaemonProbeResult, DaemonControlError>;
}

type ReadinessGates = ReadonlyMap<string, Deferred.Deferred<DaemonProbeResult, DaemonControlError>>;

interface DaemonReadinessShape {
  ensure(options: EnsureDaemonReadyOptions): Effect.Effect<DaemonProbeResult, DaemonControlError>;
}

export class DaemonReadiness extends Context.Service<DaemonReadiness, DaemonReadinessShape>()(
  "@ziggy/ziggy/DaemonReadiness",
  {
    make: Ref.make<ReadinessGates>(new Map()).pipe(
      Effect.map((gates) => ({
        ensure: (options: EnsureDaemonReadyOptions) =>
          Effect.gen(function* () {
            const profilePath = yield* (options.canonicalize ?? canonicalizeProfilePath)(
              options.profilePath,
            );
            const candidate = yield* Deferred.make<DaemonProbeResult, DaemonControlError>();
            const gate = yield* Ref.modify(gates, (current) =>
              selectReadinessGate(current, profilePath, candidate),
            );
            if (!gate.owner) return yield* Deferred.await(gate.result);
            const clear = Ref.update(gates, (current) => {
              if (current.get(profilePath) !== gate.result) return current;
              const next = new Map(current);
              next.delete(profilePath);
              return next;
            });
            return yield* Deferred.complete(
              gate.result,
              ensureCanonicalDaemonReady(profilePath, options),
            ).pipe(Effect.andThen(Deferred.await(gate.result)), Effect.ensuring(clear));
          }),
      })),
    ),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

function selectReadinessGate(
  current: ReadinessGates,
  profilePath: string,
  candidate: Deferred.Deferred<DaemonProbeResult, DaemonControlError>,
): readonly [ReadinessGate, ReadinessGates] {
  const existing = current.get(profilePath);
  if (existing !== undefined) return [{ owner: false, result: existing }, current];
  const next = new Map(current);
  next.set(profilePath, candidate);
  return [{ owner: true, result: candidate }, next];
}

export function serveDaemon(options: ServeDaemonOptions) {
  return Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadProfileConfig(options.profilePath);
      const composition = yield* createProviderRuntimeComposition({
        profilePath: options.profilePath,
        config,
        loadConfig: () =>
          loadProfileConfig(options.profilePath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeError({
                  message: "Failed to reload Profile config",
                  cause,
                }),
            ),
          ),
      });
      return yield* Effect.acquireUseRelease(
        createDaemonKernel({
          profilePath: options.profilePath,
          createWorld: (profilePath) => createFilesystemWorld({ profilePath }),
          createRuntime: composition.createRuntime,
        }),
        (kernel) =>
          Effect.gen(function* () {
            const extensions = yield* ExtensionLifecycle;
            return yield* Effect.acquireUseRelease(
              createAttachServer({ kernel, auth: composition.auth, extensions }),
              () => waitForAbort(options.signal),
              (server) => server.close,
            );
          }).pipe(Effect.provide(ExtensionLifecycle.layer({ profilePath: kernel.profilePath }))),
        (kernel) => kernel.close,
      );
    }),
  );
}

export function probeDaemon(
  options: ProbeDaemonOptions,
): Effect.Effect<DaemonProbeResult, DaemonControlError> {
  return Effect.gen(function* () {
    const profilePath = yield* (options.canonicalize ?? canonicalizeProfilePath)(
      options.profilePath,
    );
    const socketPath = join(profilePath, ".runtime", "ziggy.sock");
    const inspected = yield* Effect.result(inspectPath(socketPath));
    if (Result.isFailure(inspected)) {
      if (errorCode(inspected.failure.cause) === "ENOENT") {
        return {
          status: "unavailable",
          profilePath,
          socketPath,
          socketState: "absent",
          detail: "Attach socket is absent",
        };
      }
      return yield* inspected.failure;
    }
    const socket = inspected.success;
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
    const timeoutMs = yield* positiveMilliseconds(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    return yield* probeSocket(profilePath, socketPath, timeoutMs);
  });
}

export function ensureDaemonReady(
  options: EnsureDaemonReadyOptions,
): Effect.Effect<DaemonProbeResult, DaemonControlError, DaemonReadiness> {
  return DaemonReadiness.use((readiness) => readiness.ensure(options));
}

export function ensureProductionDaemonReady(
  profilePath: string,
): Effect.Effect<DaemonProbeResult, DaemonControlError, DaemonReadiness> {
  return ensureDaemonReady({ profilePath, start: startBackgroundDaemon, requireAbsent: true });
}

export function runDoctor(options: DoctorOptions): Effect.Effect<DoctorReport, DaemonControlError> {
  return Effect.gen(function* () {
    const profilePath = yield* (options.canonicalize ?? canonicalizeProfilePath)(
      options.profilePath,
    );
    const socketPath = join(profilePath, ".runtime", "ziggy.sock");
    const probe = yield* (options.probe ?? ((path) => probeDaemon({ profilePath: path })))(
      profilePath,
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed<DaemonProbeResult>({
          status: "unsafe",
          profilePath,
          socketPath,
          detail: errorDetail(error, "Attach socket inspection failed"),
        }),
      ),
    );
    const lockResult = yield* Effect.result(
      (options.inspectLock ?? productionInspectProfileLock)(profilePath),
    );
    const lock = Result.isSuccess(lockResult) ? lockResult.success : undefined;
    const lockFailure = Result.isFailure(lockResult) ? lockResult.failure : undefined;
    const daemon = daemonCheck(probe);
    const socket = socketCheck(probe);
    const profileLock = lockCheck(probe, lock, lockFailure);
    const providerAuth = yield* doctorProviderAuth(options, probe);
    const checks = { daemon, socket, profileLock, providerAuth };
    return {
      schemaVersion: 1,
      profilePath,
      healthy: Object.values(checks).every((check) => check.status !== "error"),
      checks,
    };
  });
}

function ensureCanonicalDaemonReady(
  profilePath: string,
  options: EnsureDaemonReadyOptions,
): Effect.Effect<DaemonProbeResult, DaemonControlError> {
  return Effect.gen(function* () {
    const probe = options.probe ?? ((path) => probeDaemon({ profilePath: path }));
    const initial = yield* probe(profilePath);
    if (initial.status === "ready") return initial;
    if (
      initial.status !== "unavailable" ||
      (options.requireAbsent === true && initial.socketState !== "absent")
    ) {
      return yield* new DaemonControlError({
        operation: "auto-start",
        message: `Refusing daemon auto-start: ${initial.detail}`,
      });
    }
    yield* options.start(profilePath);

    const timeoutMs = yield* positiveMilliseconds(options.timeoutMs, DEFAULT_START_TIMEOUT_MS);
    const retryIntervalMs = yield* positiveMilliseconds(
      options.retryIntervalMs,
      DEFAULT_RETRY_INTERVAL_MS,
    );
    const now = options.now ?? Clock.currentTimeMillis;
    const sleep = options.sleep ?? ((milliseconds) => Effect.sleep(milliseconds));
    const deadline = (yield* now) + timeoutMs;
    let latest: DaemonProbeResult = initial;
    while ((yield* now) < deadline) {
      latest = yield* probe(profilePath);
      if (latest.status === "ready") return latest;
      if (latest.status === "incompatible") {
        return yield* new DaemonControlError({
          operation: "auto-start",
          message: `Daemon started an incompatible attach server: ${latest.detail}`,
        });
      }
      const remaining = Math.max(1, deadline - (yield* now));
      yield* sleep(Math.min(retryIntervalMs, remaining));
    }
    return yield* new DaemonControlError({
      operation: "auto-start",
      message: `Daemon did not become protocol-ready: ${latest.detail}`,
    });
  });
}

function probeSocket(
  profilePath: string,
  socketPath: string,
  timeoutMs: number,
): Effect.Effect<DaemonProbeResult> {
  return Effect.callback((resume) => {
    const socket = createConnection(socketPath);
    let connected = false;
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (result: DaemonProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resume(Effect.succeed(result));
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
          params: { client: { name: "ziggy-readiness", version: ZIGGY_VERSION }, features: [] },
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
      const decoded = Result.try((): ServerFrame => {
        const encoded = new TextDecoder("utf-8", { fatal: true }).decode(response);
        return decodeServerFrame(encoded);
      });
      if (Result.isFailure(decoded)) {
        incompatible("Attach server returned an invalid initialize frame");
        return;
      }
      const frame = decoded.success;
      if (
        frame.type !== "success" ||
        frame.requestId !== READINESS_REQUEST_ID ||
        frame.method !== "initialize" ||
        frame.result.protocolVersion !== PROTOCOL_VERSION ||
        !frame.result.features.includes("stableMainSession")
      ) {
        incompatible(
          "Attach server did not complete the expected v2 stable-main initialize handshake",
        );
        return;
      }
      finish({
        status: "ready",
        profilePath,
        socketPath,
        protocolVersion: PROTOCOL_VERSION,
      });
    });
    socket.on("error", (error) => {
      const code = errorCode(error);
      if (!connected && (code === "ENOENT" || code === "ECONNREFUSED")) {
        unavailable("stale", "Attach socket is stale or disappeared before accepting connections");
      } else incompatible("Attach socket failed during protocol initialize");
    });
    socket.on("close", () => {
      if (!settled) {
        if (connected) incompatible("Attach server closed before initialize completed");
        else unavailable("stale", "Attach socket closed before accepting a connection");
      }
    });
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
      }
    });
  });
}

function doctorProviderAuth(
  options: DoctorOptions,
  probe: DaemonProbeResult,
): Effect.Effect<DoctorCheck> {
  if (probe.status === "ready") {
    const status =
      options.providerAuthStatus ??
      (options.providerAuthPresent === undefined
        ? productionProviderAuthStatus
        : () => options.providerAuthPresent ?? Effect.succeed(false));
    return status(probe.socketPath).pipe(
      Effect.match({
        onFailure: (): DoctorCheck => ({
          status: "error",
          detail: "Daemon Provider authentication status is unavailable",
        }),
        onSuccess: (present): DoctorCheck =>
          present
            ? { status: "ok", detail: "Provider authentication is present" }
            : { status: "warning", detail: "No configured Provider authentication is present" },
      }),
    );
  }
  return (options.providerAuthPresent ?? productionProviderAuthPresent()).pipe(
    Effect.catch(() => Effect.succeed(false)),
    Effect.map(
      (present): DoctorCheck =>
        present
          ? { status: "ok", detail: "Provider authentication is present" }
          : { status: "warning", detail: "No configured Provider authentication is present" },
    ),
  );
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

function startBackgroundDaemon(profilePath: string): Effect.Effect<void, DaemonControlError> {
  return productionRuntimeInvocation.pipe(
    Effect.mapError(
      (cause) =>
        new DaemonControlError({
          operation: "start-background-daemon",
          message: "Failed to resolve the daemon executable",
          cause,
        }),
    ),
    Effect.flatMap((runtime) =>
      Effect.try({
        try: () => {
          const child = Bun.spawn([...serveArgv(runtime, profilePath)], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          child.unref();
        },
        catch: (cause) =>
          new DaemonControlError({
            operation: "start-background-daemon",
            message: "Failed to start background daemon",
            cause,
          }),
      }),
    ),
  );
}

function productionProviderAuthStatus(
  socketPath: string,
): Effect.Effect<boolean, DaemonControlError> {
  return queryProviderAuthStatus(socketPath).pipe(
    Effect.map((statuses) => statuses.some((status) => status.configured)),
    Effect.mapError(
      (cause) =>
        new DaemonControlError({
          operation: "provider-auth-status",
          message: "Failed to query daemon Provider authentication",
          cause,
        }),
    ),
  );
}

function productionProviderAuthPresent(): Effect.Effect<boolean> {
  return Effect.sync(() =>
    [
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.GEMINI_API_KEY,
      process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    ].some((value) => value !== undefined && value.trim().length > 0),
  );
}

function productionInspectProfileLock(
  profilePath: string,
): Effect.Effect<ProfileLockInspection, DaemonControlError> {
  return inspectProfileLock({ profilePath }).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonControlError({
          operation: "inspect-profile-lock",
          message: "Failed to inspect Profile lock",
          cause,
        }),
    ),
  );
}

function waitForAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = (): void => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function positiveMilliseconds(
  value: number | undefined,
  fallback: number,
): Effect.Effect<number, DaemonControlError> {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved > 0
    ? Effect.succeed(resolved)
    : Effect.fail(
        new DaemonControlError({
          operation: "validate-timeout",
          message: "Timeout and retry values must be positive safe integers",
        }),
      );
}

function canonicalizeProfilePath(path: string): Effect.Effect<string, DaemonControlError> {
  return Effect.tryPromise({
    try: () => realpath(path),
    catch: (cause) =>
      new DaemonControlError({
        operation: "canonicalize-profile",
        message: `Failed to canonicalize Profile ${path}`,
        cause,
      }),
  });
}

function inspectPath(path: string): Effect.Effect<Stats, DaemonControlError> {
  return Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) =>
      new DaemonControlError({
        operation: "inspect-socket",
        message: `Failed to inspect attach socket ${path}`,
        cause,
      }),
  });
}

function errorDetail(error: unknown, fallback: string): string {
  const decoded = decodeErrorMessage(error);
  return Option.isSome(decoded) ? decoded.value.message : fallback;
}

function errorCode(error: unknown): string | undefined {
  const decoded = decodeErrorCode(error);
  return Option.isSome(decoded) ? decoded.value.code : undefined;
}
