import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProfileLock, ProfileLockCoordinator } from "../../packages/core/src/index.ts";
import { Effect, Layer } from "effect";
import {
  DaemonControlError,
  DaemonReadiness,
  ensureDaemonReady,
  probeDaemon,
  runDoctor,
  serveDaemon,
  type DaemonProbeResult,
} from "../../packages/ziggy/src/daemon.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

const profiles: string[] = [];

test("foreground daemon owns the Profile, serves protocol readiness, and cleans up", async () => {
  const profile = await createProfile("serve");
  const abort = new AbortController();
  const running = runProductionEffect(serveDaemon({ profilePath: profile, signal: abort.signal }));
  const ready = await waitUntilReady(profile);
  expect(ready.status).toBe("ready");
  expect(await runEffect(inspectProfileLock({ profilePath: profile }))).toEqual({
    state: "live",
    pid: process.pid,
  });

  await expect(
    runProductionEffect(
      serveDaemon({ profilePath: profile, signal: new AbortController().signal }),
    ),
  ).rejects.toThrow(`Profile is already owned by live daemon PID ${process.pid}`);

  abort.abort();
  await running;
  expect(await runEffect(probeDaemon({ profilePath: profile }))).toMatchObject({
    status: "unavailable",
    socketState: "absent",
  });
  expect(await runEffect(inspectProfileLock({ profilePath: profile }))).toEqual({
    state: "absent",
  });
});

test("production daemon fails before readiness for unknown configured Provider and model", async () => {
  for (const [provider, model, expected] of [
    ["missing-provider", "model", "Unknown configured Provider"],
    ["anthropic", "missing-model", "Unknown configured model"],
  ]) {
    const profile = await createProfile(`invalid-${provider}`);
    await writeFile(
      join(profile, "ziggy.jsonc"),
      `${JSON.stringify({ schemaVersion: 1, defaultProvider: provider, defaultModel: model, thinkingLevel: "medium", cacheRetention: "long" })}\n`,
    );
    await expect(
      runProductionEffect(
        serveDaemon({ profilePath: profile, signal: new AbortController().signal }),
      ),
    ).rejects.toThrow(expected);
    expect(await runEffect(probeDaemon({ profilePath: profile }))).toMatchObject({
      status: "unavailable",
    });
    expect(await runEffect(inspectProfileLock({ profilePath: profile }))).toEqual({
      state: "absent",
    });
  }
});

test("protocol probe refuses unsafe and incompatible socket occupants", async () => {
  const unsafeProfile = await createProfile("unsafe");
  await mkdir(join(unsafeProfile, ".runtime"), { recursive: true });
  await writeFile(join(unsafeProfile, ".runtime", "ziggy.sock"), "not a socket");
  expect(await runEffect(probeDaemon({ profilePath: unsafeProfile }))).toMatchObject({
    status: "unsafe",
  });

  const incompatibleProfile = await createProfile("incompatible");
  await mkdir(join(incompatibleProfile, ".runtime"), { recursive: true });
  const socketPath = join(incompatibleProfile, ".runtime", "ziggy.sock");
  const server = createServer((socket) => socket.end("not-ziggy\n"));
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  try {
    expect(
      await runEffect(probeDaemon({ profilePath: incompatibleProfile, timeoutMs: 200 })),
    ).toMatchObject({ status: "incompatible" });
  } finally {
    await closeServer(server);
  }

  const missingFeatureProfile = await createProfile("missing-stable-main");
  await mkdir(join(missingFeatureProfile, ".runtime"), { recursive: true });
  const missingFeatureSocketPath = join(missingFeatureProfile, ".runtime", "ziggy.sock");
  const missingFeatureServer = createServer((socket) => {
    socket.once("data", () =>
      socket.end(
        '{"schemaVersion":2,"requestId":"ziggy-readiness","method":"initialize","type":"success","result":{"protocolVersion":2,"features":["sessionReplay"]}}\n',
      ),
    );
  });
  await listen(missingFeatureServer, missingFeatureSocketPath);
  await chmod(missingFeatureSocketPath, 0o600);
  try {
    expect(
      await runEffect(probeDaemon({ profilePath: missingFeatureProfile, timeoutMs: 200 })),
    ).toMatchObject({ status: "incompatible" });
  } finally {
    await closeServer(missingFeatureServer);
  }
});

test("protocol readiness auto-start deduplicates concurrent callers and refuses unsafe sockets", async () => {
  const profile = "/fixture/profile";
  let starts = 0;
  let ready = false;
  const probe = (): Effect.Effect<DaemonProbeResult> =>
    Effect.succeed(
      ready
        ? readyProbe(profile)
        : {
            status: "unavailable",
            profilePath: profile,
            socketPath: `${profile}/.runtime/ziggy.sock`,
            socketState: "absent",
            detail: "absent",
          },
    );
  const options = {
    profilePath: profile,
    canonicalize: () => Effect.succeed(profile),
    probe,
    start: () =>
      Effect.sync(() => {
        starts += 1;
        ready = true;
      }),
  };
  const [first, second] = await runEffect(
    Effect.all([ensureDaemonReady(options), ensureDaemonReady(options)], {
      concurrency: "unbounded",
    }).pipe(Effect.provide(DaemonReadiness.layer)),
  );
  expect(first.status).toBe("ready");
  expect(second.status).toBe("ready");
  expect(starts).toBe(1);

  let unsafeStarts = 0;
  await expect(
    runEffect(
      ensureDaemonReady({
        profilePath: "/fixture/unsafe",
        canonicalize: (path) => Effect.succeed(path),
        probe: (path) =>
          Effect.succeed({
            status: "unsafe",
            profilePath: path,
            socketPath: `${path}/.runtime/ziggy.sock`,
            detail: "wrong permissions",
          }),
        start: () => Effect.sync(() => (unsafeStarts += 1)),
      }).pipe(Effect.provide(DaemonReadiness.layer)),
    ),
  ).rejects.toThrow("Refusing daemon auto-start: wrong permissions");
  expect(unsafeStarts).toBe(0);

  let raceStarts = 0;
  await expect(
    runEffect(
      ensureDaemonReady({
        profilePath: "/fixture/absent-to-stale",
        canonicalize: (path) => Effect.succeed(path),
        requireAbsent: true,
        probe: (path) =>
          Effect.succeed({
            status: "unavailable",
            profilePath: path,
            socketPath: `${path}/.runtime/ziggy.sock`,
            socketState: "stale",
            detail: "socket became stale between Client and readiness-owner probes",
          }),
        start: () => Effect.sync(() => (raceStarts += 1)),
      }).pipe(Effect.provide(DaemonReadiness.layer)),
    ),
  ).rejects.toThrow("Refusing daemon auto-start");
  expect(raceStarts).toBe(0);
});

test("doctor reports protocol, permissions, lock liveness, stale schemas, and auth presence", async () => {
  const profile = "/fixture/doctor";
  const healthy = await runEffect(
    runDoctor({
      profilePath: profile,
      canonicalize: () => Effect.succeed(profile),
      probe: () => Effect.succeed(readyProbe(profile)),
      inspectLock: () => Effect.succeed({ state: "live", pid: 41 }),
      providerAuthPresent: Effect.succeed(true),
    }),
  );
  expect(healthy).toEqual({
    schemaVersion: 1,
    profilePath: profile,
    healthy: true,
    checks: {
      daemon: { status: "ok", detail: "Daemon completed attach protocol v2 initialize" },
      socket: { status: "ok", detail: "Attach path is a mode-0600 Unix socket" },
      profileLock: {
        status: "ok",
        detail: "Profile lock is held by live PID 41",
        pid: 41,
      },
      providerAuth: { status: "ok", detail: "Provider authentication is present" },
    },
  });

  const stale = await runEffect(
    runDoctor({
      profilePath: profile,
      canonicalize: () => Effect.succeed(profile),
      probe: (path) =>
        Effect.succeed({
          status: "unavailable",
          profilePath: path,
          socketPath: `${path}/.runtime/ziggy.sock`,
          socketState: "absent",
          detail: "Attach socket is absent",
        }),
      inspectLock: () => Effect.succeed({ state: "stale", pid: 42 }),
      providerAuthPresent: Effect.succeed(false),
    }),
  );
  expect(stale.healthy).toBeFalse();
  expect(stale.checks.profileLock).toEqual({
    status: "error",
    detail: "Profile lock is stale (PID 42)",
    pid: 42,
  });
  expect(stale.checks.providerAuth.status).toBe("warning");

  const authoritativeStatusFailure = await runEffect(
    runDoctor({
      profilePath: profile,
      canonicalize: () => Effect.succeed(profile),
      probe: () => Effect.succeed(readyProbe(profile)),
      inspectLock: () => Effect.succeed({ state: "live", pid: 43 }),
      providerAuthPresent: Effect.succeed(true),
      providerAuthStatus: () =>
        Effect.fail(
          new DaemonControlError({
            operation: "provider-auth-status",
            message: "status unavailable",
          }),
        ),
    }),
  );
  expect(authoritativeStatusFailure.healthy).toBeFalse();
  expect(authoritativeStatusFailure.checks.providerAuth).toEqual({
    status: "error",
    detail: "Daemon Provider authentication status is unavailable",
  });

  const unsupported = await runEffect(
    runDoctor({
      profilePath: profile,
      canonicalize: () => Effect.succeed(profile),
      probe: () => Effect.succeed(readyProbe(profile)),
      inspectLock: () =>
        Effect.fail(
          new DaemonControlError({
            operation: "inspect-profile-lock",
            message: "Unsupported Profile lock schemaVersion",
          }),
        ),
      providerAuthPresent: Effect.succeed(true),
    }),
  );
  expect(unsupported.healthy).toBeFalse();
  expect(unsupported.checks.profileLock).toEqual({
    status: "error",
    detail: "Unsupported Profile lock schemaVersion",
  });

  const socketFailure = await runEffect(
    runDoctor({
      profilePath: profile,
      canonicalize: () => Effect.succeed(profile),
      probe: () =>
        Effect.fail(
          new DaemonControlError({
            operation: "probe-socket",
            message: "socket inspection failed",
          }),
        ),
      inspectLock: () => Effect.succeed({ state: "absent" }),
      providerAuthPresent: Effect.succeed(true),
    }),
  );
  expect(socketFailure.healthy).toBeFalse();
  expect(socketFailure.checks.socket).toEqual({
    status: "error",
    detail: "socket inspection failed",
  });
});

afterAll(async () => {
  await Promise.all(profiles.map((profile) => rm(profile, { recursive: true, force: true })));
  emitVerificationObservation("s2.operator-readiness", emptyRuntimeObservations());
});

function readyProbe(profilePath: string): DaemonProbeResult {
  return {
    status: "ready",
    profilePath,
    socketPath: `${profilePath}/.runtime/ziggy.sock`,
    protocolVersion: 2,
  };
}

async function createProfile(name: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-daemon-${name}-`));
  profiles.push(profile);
  await writeFile(
    join(profile, "ziggy.jsonc"),
    '{"schemaVersion":1,"defaultProvider":"anthropic","defaultModel":"claude-fable-5","thinkingLevel":"medium","cacheRetention":"long"}\n',
  );
  await writeFile(join(profile, "SOUL.md"), "fixture soul\n");
  await mkdir(join(profile, "credentials"), { mode: 0o700 });
  await chmod(join(profile, "credentials"), 0o700);
  return profile;
}

async function waitUntilReady(profilePath: string): Promise<DaemonProbeResult> {
  let latest = await runEffect(probeDaemon({ profilePath }));
  for (let attempt = 0; attempt < 100 && latest.status !== "ready"; attempt += 1) {
    await Bun.sleep(5);
    latest = await runEffect(probeDaemon({ profilePath }));
  }
  if (latest.status !== "ready") throw new Error("Fixture daemon did not become ready");
  return latest;
}

const ProductionDaemonLayer = Layer.merge(DaemonReadiness.layer, ProfileLockCoordinator.layer);

function runProductionEffect<A, E>(
  program: Effect.Effect<A, E, DaemonReadiness | ProfileLockCoordinator>,
): Promise<A> {
  return runEffect(program.pipe(Effect.provide(ProductionDaemonLayer)));
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
