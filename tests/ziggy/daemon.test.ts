import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProfileLock } from "../../packages/core/src/index.ts";
import {
  ensureDaemonReady,
  probeDaemon,
  runDoctor,
  serveDaemon,
  type DaemonProbeResult,
} from "../../packages/ziggy/src/daemon.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

const profiles: string[] = [];

test("foreground daemon owns the Profile, serves protocol readiness, and cleans up", async () => {
  const profile = await createProfile("serve");
  const abort = new AbortController();
  const running = serveDaemon({ profilePath: profile, signal: abort.signal });
  const ready = await waitUntilReady(profile);
  expect(ready.status).toBe("ready");
  expect(await inspectProfileLock({ profilePath: profile })).toEqual({
    state: "live",
    pid: process.pid,
  });

  await expect(
    serveDaemon({ profilePath: profile, signal: new AbortController().signal }),
  ).rejects.toThrow(`Profile is already owned by live daemon PID ${process.pid}`);

  abort.abort();
  await running;
  expect(await probeDaemon({ profilePath: profile })).toMatchObject({
    status: "unavailable",
    socketState: "absent",
  });
  expect(await inspectProfileLock({ profilePath: profile })).toEqual({ state: "absent" });
});

test("protocol probe refuses unsafe and incompatible socket occupants", async () => {
  const unsafeProfile = await createProfile("unsafe");
  await mkdir(join(unsafeProfile, ".runtime"), { recursive: true });
  await writeFile(join(unsafeProfile, ".runtime", "ziggy.sock"), "not a socket");
  expect(await probeDaemon({ profilePath: unsafeProfile })).toMatchObject({ status: "unsafe" });

  const incompatibleProfile = await createProfile("incompatible");
  await mkdir(join(incompatibleProfile, ".runtime"), { recursive: true });
  const socketPath = join(incompatibleProfile, ".runtime", "ziggy.sock");
  const server = createServer((socket) => socket.end("not-ziggy\n"));
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  try {
    expect(await probeDaemon({ profilePath: incompatibleProfile, timeoutMs: 200 })).toMatchObject({
      status: "incompatible",
    });
  } finally {
    await closeServer(server);
  }
});

test("protocol readiness auto-start deduplicates concurrent callers and refuses unsafe sockets", async () => {
  const profile = "/fixture/profile";
  let starts = 0;
  let ready = false;
  const probe = async (): Promise<DaemonProbeResult> =>
    ready
      ? readyProbe(profile)
      : {
          status: "unavailable",
          profilePath: profile,
          socketPath: `${profile}/.runtime/ziggy.sock`,
          socketState: "absent",
          detail: "absent",
        };
  const options = {
    profilePath: profile,
    canonicalize: async () => profile,
    probe,
    start: async () => {
      starts += 1;
      ready = true;
    },
  };
  const [first, second] = await Promise.all([
    ensureDaemonReady(options),
    ensureDaemonReady(options),
  ]);
  expect(first.status).toBe("ready");
  expect(second.status).toBe("ready");
  expect(starts).toBe(1);

  let unsafeStarts = 0;
  await expect(
    ensureDaemonReady({
      profilePath: "/fixture/unsafe",
      canonicalize: async (path) => path,
      probe: async (path) => ({
        status: "unsafe",
        profilePath: path,
        socketPath: `${path}/.runtime/ziggy.sock`,
        detail: "wrong permissions",
      }),
      start: async () => {
        unsafeStarts += 1;
      },
    }),
  ).rejects.toThrow("Refusing daemon auto-start: wrong permissions");
  expect(unsafeStarts).toBe(0);
});

test("doctor reports protocol, permissions, lock liveness, stale schemas, and auth presence", async () => {
  const profile = "/fixture/doctor";
  const healthy = await runDoctor({
    profilePath: profile,
    canonicalize: async () => profile,
    probe: async () => readyProbe(profile),
    inspectLock: async () => ({ state: "live", pid: 41 }),
    providerAuthPresent: () => true,
  });
  expect(healthy).toEqual({
    schemaVersion: 1,
    profilePath: profile,
    healthy: true,
    checks: {
      daemon: { status: "ok", detail: "Daemon completed attach protocol v1 initialize" },
      socket: { status: "ok", detail: "Attach path is a mode-0600 Unix socket" },
      profileLock: {
        status: "ok",
        detail: "Profile lock is held by live PID 41",
        pid: 41,
      },
      providerAuth: { status: "ok", detail: "Provider authentication is present" },
    },
  });

  const stale = await runDoctor({
    profilePath: profile,
    canonicalize: async () => profile,
    probe: async (path) => ({
      status: "unavailable",
      profilePath: path,
      socketPath: `${path}/.runtime/ziggy.sock`,
      socketState: "absent",
      detail: "Attach socket is absent",
    }),
    inspectLock: async () => ({ state: "stale", pid: 42 }),
    providerAuthPresent: () => false,
  });
  expect(stale.healthy).toBeFalse();
  expect(stale.checks.profileLock).toEqual({
    status: "error",
    detail: "Profile lock is stale (PID 42)",
    pid: 42,
  });
  expect(stale.checks.providerAuth.status).toBe("warning");

  const unsupported = await runDoctor({
    profilePath: profile,
    canonicalize: async () => profile,
    probe: async () => readyProbe(profile),
    inspectLock: async () => {
      throw new Error("Unsupported Profile lock schemaVersion");
    },
    providerAuthPresent: () => true,
  });
  expect(unsupported.healthy).toBeFalse();
  expect(unsupported.checks.profileLock).toEqual({
    status: "error",
    detail: "Unsupported Profile lock schemaVersion",
  });

  const socketFailure = await runDoctor({
    profilePath: profile,
    canonicalize: async () => profile,
    probe: async () => {
      throw new Error("socket inspection failed");
    },
    inspectLock: async () => ({ state: "absent" }),
    providerAuthPresent: () => true,
  });
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
    protocolVersion: 1,
  };
}

async function createProfile(name: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-daemon-${name}-`));
  profiles.push(profile);
  return profile;
}

async function waitUntilReady(profilePath: string): Promise<DaemonProbeResult> {
  let latest = await probeDaemon({ profilePath });
  for (let attempt = 0; attempt < 100 && latest.status !== "ready"; attempt += 1) {
    await Bun.sleep(5);
    latest = await probeDaemon({ profilePath });
  }
  if (latest.status !== "ready") throw new Error("Fixture daemon did not become ready");
  return latest;
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
