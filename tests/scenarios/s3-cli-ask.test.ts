import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { decodeSessionEnvelope, PROTOCOL_VERSION } from "../../packages/protocol/src/index.ts";
import { runProductionAsk, type CliDaemonSetup } from "../../packages/ziggy/src/cli-client.ts";
import { runCliExecutable, type CliExecutableDependencies } from "../../packages/ziggy/src/cli.ts";
import { DaemonControlError, type DaemonProbeResult } from "../../packages/ziggy/src/daemon.ts";
import { runEffect } from "../testkit/effect.ts";
import { ScriptedProvider, textStep } from "../testkit/provider/scripted.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  observeProviderInputs,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

const temporaryDirectories: string[] = [];
let observations: RuntimeObservations = emptyRuntimeObservations();

test("ask auto-starts once and emits exactly one durable main Turn's accepted text", async () => {
  const profile = await temporaryProfile("success");
  const provider = new ScriptedProvider([textStep("accepted text\n\n", 1)]);
  let daemon: ScenarioDaemon | undefined;
  let startCalls = 0;
  const setup = absentDaemonSetup(profile, () =>
    startDaemonBoundary(profile, provider).pipe(
      Effect.tap((started) =>
        Effect.sync(() => {
          startCalls += 1;
          daemon = started;
        }),
      ),
      Effect.map((started) => readyProbe(profile, started.server.socketPath)),
    ),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];

  await runEffect(
    runCliExecutable(
      ["ask", "one prompt", "--profile", profile],
      executableDependencies(
        profile,
        (profilePath, prompt) =>
          runProductionAsk(profilePath, prompt, setup, (text) =>
            Effect.sync(() => {
              stdout.push(text);
            }),
          ),
        stdout,
        stderr,
        exitCodes,
      ),
    ),
  );

  const durable = await readFile(join(profile, "sessions/main.ndjson"), "utf8");
  const envelopes = durable
    .trimEnd()
    .split("\n")
    .map((line) => decodeSessionEnvelope(`${line}\n`));
  expect(startCalls).toBe(1);
  expect(stdout.join("")).toBe("accepted text\n");
  expect(stderr).toEqual([]);
  expect(exitCodes).toEqual([0]);
  expect(envelopes.filter((envelope) => envelope.event.type === "turn-started")).toHaveLength(1);
  expect(envelopes.filter((envelope) => envelope.event.type === "turn-ended")).toHaveLength(1);
  expect(provider.calls).toHaveLength(1);

  observations = {
    ...observations,
    canonicalEventTrace: observeCanonicalEvents(envelopes),
    providerInputs: observeProviderInputs(provider.calls),
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "cli-daemon-readiness",
        point: "missing-daemon-auto-start",
        occurrence: startCalls,
        outcome: "recovered",
      },
    ],
    filesystemDiffs: [
      {
        path: "sessions/main.ndjson",
        change: "created",
        beforeDigest: null,
        afterDigest: fixtureDigest(durable),
      },
    ],
  };

  await daemon?.close();
});

test("ask reports outcome unknown after production server persists acceptance but drops its response", async () => {
  const profile = await temporaryProfile("outcome-unknown");
  const provider = new ScriptedProvider([textStep("accepted but response dropped", 1)]);
  let acceptedWrites = 0;
  const daemon = await runEffect(
    startDaemonBoundary(profile, provider, () => {
      acceptedWrites += 1;
      return true;
    }),
  );
  const setup: CliDaemonSetup = {
    probe: () => Effect.succeed(readyProbe(profile, daemon.server.socketPath)),
    startAbsent: () =>
      Effect.fail(
        new DaemonControlError({
          operation: "unexpected-start",
          message: "ready fixture must not auto-start",
        }),
      ),
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];

  await runEffect(
    runCliExecutable(
      ["ask", "execute once", "--profile", profile],
      executableDependencies(
        profile,
        (profilePath, prompt) =>
          runProductionAsk(profilePath, prompt, setup, (text) =>
            Effect.sync(() => {
              stdout.push(text);
            }),
          ),
        stdout,
        stderr,
        exitCodes,
      ),
    ),
  );

  await provider.waitForCalls(1);
  const durable = await readFile(join(profile, "sessions/main.ndjson"), "utf8");
  const envelopes = durable
    .trimEnd()
    .split("\n")
    .map((line) => decodeSessionEnvelope(`${line}\n`));
  expect(acceptedWrites).toBe(1);
  expect(envelopes.filter((envelope) => envelope.event.type === "turn-started")).toHaveLength(1);
  expect(provider.calls).toHaveLength(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "Turn outcome unknown; it may have been accepted. Do not retry automatically.\n",
  ]);
  expect(exitCodes).toEqual([3]);
  observations = {
    ...observations,
    faultSchedule: [
      ...observations.faultSchedule,
      {
        boundary: "cli-attach-receive",
        point: "post-turn-write-disconnect-no-resend",
        occurrence: acceptedWrites,
        outcome: "failed",
      },
    ],
  };
  await daemon.close();
});

afterAll(async () => {
  emitVerificationObservation("s3.cli-ask", observations);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface ScenarioDaemon {
  readonly server: AttachServer;
  readonly close: () => Promise<void>;
}

function startDaemonBoundary(
  profilePath: string,
  provider: ScriptedProvider,
  dropTurnStartResponseAfterAcceptance?: () => boolean,
): Effect.Effect<ScenarioDaemon, DaemonControlError> {
  return Effect.tryPromise({
    try: () => createScenarioDaemon(profilePath, provider, dropTurnStartResponseAfterAcceptance),
    catch: (cause) =>
      new DaemonControlError({
        operation: "scenario-daemon-start",
        message: "Failed to start scripted daemon",
        cause,
      }),
  });
}

async function createScenarioDaemon(
  profilePath: string,
  provider: ScriptedProvider,
  dropTurnStartResponseAfterAcceptance?: () => boolean,
): Promise<ScenarioDaemon> {
  let milliseconds = Date.parse("2026-07-21T01:00:00.000Z");
  const kernel = await runEffect(
    createDaemonKernel({
      profilePath,
      createWorld: (canonicalProfilePath) =>
        createFilesystemWorld({
          profilePath: canonicalProfilePath,
          now: () => {
            const value = new Date(milliseconds);
            milliseconds += 1;
            return value;
          },
        }),
      createRuntime: (sessionId, world) =>
        createFilesystemSessionRuntime({
          sessionId,
          world,
          baseSystemPrompt: "You are Ziggy.",
          tools: [],
          model: provider.model,
          streamSimple: provider.streamSimple,
          cacheRetention: "long",
          nextTurnId: () => "accepted-turn",
          nextStepId: () => "accepted-step",
        }),
    }).pipe(Effect.provide(ProfileLockCoordinator.layer)),
  );
  const server = await runEffect(
    createAttachServer({
      kernel,
      nextSessionId: () => "unused-session",
      nextSubscriptionId: () => "ask-subscription",
      ...(dropTurnStartResponseAfterAcceptance === undefined
        ? {}
        : {
            faultInjection: {
              dropTurnStartResponseAfterAcceptance,
            },
          }),
    }),
  );
  return closingDaemon(kernel, server);
}

function closingDaemon(kernel: DaemonKernel<unknown>, server: AttachServer): ScenarioDaemon {
  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => {
      closing ??= runEffect(server.close.pipe(Effect.andThen(kernel.close)));
      return closing;
    },
  };
}

function absentDaemonSetup(
  profilePath: string,
  start: () => Effect.Effect<DaemonProbeResult, DaemonControlError>,
): CliDaemonSetup {
  return {
    probe: () =>
      Effect.succeed({
        status: "unavailable",
        profilePath,
        socketPath: join(profilePath, ".runtime/ziggy.sock"),
        socketState: "absent",
        detail: "fixture daemon is stopped",
      }),
    startAbsent: start,
  };
}

function readyProbe(profilePath: string, socketPath: string): DaemonProbeResult {
  return { status: "ready", profilePath, socketPath, protocolVersion: PROTOCOL_VERSION };
}

function executableDependencies<E, R>(
  profilePath: string,
  ask: (profilePath: string, prompt: string) => Effect.Effect<void, E, R>,
  stdout: string[],
  stderr: string[],
  exitCodes: number[],
): CliExecutableDependencies<E, R> {
  return {
    ask,
    cwd: Effect.succeed(profilePath),
    onSignal: () => Effect.void,
    offSignal: () => Effect.void,
    output: (value) =>
      Effect.sync(() => {
        stdout.push(`${value}\n`);
      }),
    errorOutput: (value) =>
      Effect.sync(() => {
        stderr.push(value);
      }),
    setExitCode: (code) =>
      Effect.sync(() => {
        exitCodes.push(code);
      }),
  };
}

async function temporaryProfile(label: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-s3-cli-ask-${label}-`));
  temporaryDirectories.push(profile);
  return profile;
}
