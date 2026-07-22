import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  createAttachServer,
  createDaemonKernel,
  createFilesystemSessionRuntime,
  createFilesystemWorld,
  ProfileLockCoordinator,
  type AttachServer,
  type DaemonKernel,
} from "../../packages/core/src/index.ts";
import { PROTOCOL_VERSION, type SessionSummary } from "../../packages/protocol/src/index.ts";
import {
  runProductionSessionsList,
  type CliDaemonSetup,
} from "../../packages/ziggy/src/cli-client.ts";
import { runCli } from "../../packages/ziggy/src/cli.ts";
import type { DaemonProbeResult } from "../../packages/ziggy/src/daemon.ts";
import { runEffect } from "../testkit/effect.ts";
import { ScriptedProvider } from "../testkit/provider/scripted.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

const temporaryDirectories: string[] = [];
let observations: RuntimeObservations = emptyRuntimeObservations();

test("sessions list returns daemon-created Sessions without mutation or pin authority", async () => {
  const profile = await temporaryProfile("populated");
  const daemon = await startScenarioDaemon(profile);
  await runEffect(daemon.kernel.createSession("beta"));
  await runEffect(daemon.kernel.createSession("zeta"));
  await runEffect(daemon.kernel.ensureMainSession());
  await runEffect(daemon.kernel.createSession("alpha"));
  const created: ReadonlyArray<SessionSummary> = await runEffect(daemon.kernel.listSessions);

  const filesBefore = await sessionFiles(profile);
  const bytesBefore = await sessionBytes(profile, filesBefore);
  const { output, startCalls } = await listThroughRealSocket(profile, daemon.server);
  const filesAfter = await sessionFiles(profile);
  const bytesAfter = await sessionBytes(profile, filesAfter);
  const decoded: unknown = JSON.parse(output);
  const expected = [...created]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.sessionId.localeCompare(right.sessionId),
    )
    .map((session) => ({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      status: "idle",
    }));

  expect(decoded).toEqual(expected);
  expect(startCalls).toBe(0);
  expect(filesAfter).toEqual(filesBefore);
  expect(bytesAfter).toEqual(bytesBefore);
  expect(output).not.toContain("pin");
  expect(daemon.provider.calls).toEqual([]);

  observations = {
    ...observations,
    filesystemDiffs: filesBefore.map((file, index) => ({
      path: `sessions/${file}`,
      change: "unchanged" as const,
      beforeDigest: fixtureDigest(bytesBefore[index] ?? "missing-before"),
      afterDigest: fixtureDigest(bytesAfter[index] ?? "missing-after"),
    })),
  };
  await daemon.close();
});

test("sessions list on an empty Profile returns [] and does not materialize main", async () => {
  const profile = await temporaryProfile("empty");
  const daemon = await startScenarioDaemon(profile);
  const { output, startCalls } = await listThroughRealSocket(profile, daemon.server);

  expect(JSON.parse(output)).toEqual([]);
  expect(startCalls).toBe(0);
  expect(await sessionFilesIfPresent(profile)).toEqual([]);
  expect(await Bun.file(join(profile, "sessions/main.ndjson")).exists()).toBeFalse();
  expect(daemon.provider.calls).toEqual([]);
  observations = {
    ...observations,
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "cli-session-query",
        point: "empty-profile-real-socket-no-main-write",
        occurrence: 1,
        outcome: "continued",
      },
    ],
  };
  await daemon.close();
});

afterAll(async () => {
  emitVerificationObservation("s3.cli-sessions-list", observations);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface ScenarioDaemon {
  readonly kernel: DaemonKernel<unknown>;
  readonly server: AttachServer;
  readonly provider: ScriptedProvider;
  readonly close: () => Promise<void>;
}

async function startScenarioDaemon(profile: string): Promise<ScenarioDaemon> {
  let milliseconds = Date.parse("2026-07-21T01:00:00.000Z");
  const provider = new ScriptedProvider([]);
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath: profile,
      createWorld: (canonicalProfilePath) =>
        createFilesystemWorld({
          profilePath: canonicalProfilePath,
          now: () => new Date(milliseconds++),
        }),
      createRuntime: (sessionId, world) =>
        createFilesystemSessionRuntime({
          sessionId,
          world,
          baseSystemPrompt: "unused",
          tools: [],
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => "unused-turn",
          nextStepId: () => "unused-step",
        }),
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  const server = await runEffect(
    createAttachServer({
      kernel,
      nextSessionId: () => "unused-session",
      nextSubscriptionId: () => "unused-subscription",
    }),
  );
  return {
    kernel,
    server,
    provider,
    close: () => runEffect(server.close.pipe(Effect.andThen(kernel.close))),
  };
}

async function listThroughRealSocket(
  profile: string,
  server: AttachServer,
): Promise<{ readonly output: string; readonly startCalls: number }> {
  let startCalls = 0;
  const setup: CliDaemonSetup = {
    probe: () => Effect.succeed(readyProbe(profile, server.socketPath)),
    startAbsent: () =>
      Effect.sync((): DaemonProbeResult => {
        startCalls += 1;
        return readyProbe(profile, server.socketPath);
      }),
  };
  const output: string[] = [];
  await runEffect(
    runCli(["sessions", "list", "--profile", profile], {
      sessionsList: (profilePath) => runProductionSessionsList(profilePath, setup),
      cwd: Effect.succeed(profile),
      onSignal: () => Effect.void,
      offSignal: () => Effect.void,
      output: (value) => Effect.sync(() => output.push(value)),
    }),
  );
  return { output: output.join(""), startCalls };
}

function readyProbe(profilePath: string, socketPath: string): DaemonProbeResult {
  return { status: "ready", profilePath, socketPath, protocolVersion: PROTOCOL_VERSION };
}

async function temporaryProfile(label: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-s3-cli-sessions-${label}-`));
  temporaryDirectories.push(profile);
  return profile;
}

async function sessionFiles(profile: string): Promise<ReadonlyArray<string>> {
  return (await readdir(join(profile, "sessions"))).sort();
}

async function sessionFilesIfPresent(profile: string): Promise<ReadonlyArray<string>> {
  return (await Bun.file(join(profile, "sessions/.sentinel")).exists())
    ? sessionFiles(profile)
    : readdir(join(profile, "sessions")).then(
        (files) => files.sort(),
        () => [],
      );
}

function sessionBytes(
  profile: string,
  files: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  return Promise.all(files.map((file) => readFile(join(profile, "sessions", file), "utf8")));
}
