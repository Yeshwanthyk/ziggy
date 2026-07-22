/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Bun scenario drives compiled child processes through the compiled-process test adapter */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: scenario cleanup preserves the primary process assertion */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionEnvelope } from "../../packages/protocol/src/index.ts";
import "../../packages/ziggy/testkit/compiled-cli-entry.ts";
import {
  awaitBarrier,
  cleanupDetachedDaemon,
  collectProcess,
  compileCompiledCliFixture,
  createStaleSocket,
  runProcess,
  spawnProcess,
  startOutcomeUnknownAttachServer,
  waitForFile,
  waitForPathState,
} from "../testkit/compiled-process.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
  observeCanonicalEvents,
  type RuntimeObservations,
} from "../testkit/verification-observations.ts";

const repositoryRoot = join(import.meta.dir, "..", "..");
const stderrLimit = 513;
let suiteRoot = "";
let executable = "";
let observations: RuntimeObservations = emptyRuntimeObservations();

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), "ziggy-compiled-cli-process-"));
  executable = join(suiteRoot, "ziggy");
  await compileCompiledCliFixture(executable, repositoryRoot);
});

afterAll(async () => {
  emitVerificationObservation("s3.compiled-cli-process", observations);
  await rm(suiteRoot, { recursive: true, force: true });
});

describe("compiled CLI process boundary", () => {
  it("starts only an absent daemon, reaches protocol readiness, retries the original ask, and persists one Turn", async () => {
    const profilePath = await initializeProfile("success");
    const tracePath = join(suiteRoot, "success-process.trace");
    const providerRequestedPath = join(suiteRoot, "success-provider.requested");

    try {
      const result = await runProcess(
        [executable, "ask", "compiled success", "--profile", profilePath],
        {
          cwd: repositoryRoot,
          env: fixtureEnvironment({ tracePath, providerRequestedPath }),
        },
      );
      const transcriptPath = join(profilePath, "sessions", "main.ndjson");
      const durable = await readFile(transcriptPath, "utf8");
      const envelopes = decodeTranscript(durable);
      const daemonStatus = await runProcess([executable, "doctor", "--profile", profilePath], {
        cwd: repositoryRoot,
        env: fixtureEnvironment(),
      });

      expect(result).toEqual({ exitCode: 0, stdout: "accepted text\n", stderr: "" });
      expect(result.stderr.length).toBeLessThanOrEqual(stderrLimit);
      expect(await readLines(tracePath)).toEqual([
        "initial-absent",
        "start-absent",
        "protocol-ready",
      ]);
      expect(await readLines(providerRequestedPath)).toEqual(["requested"]);
      expect(daemonStatus.exitCode).toBe(0);
      expect(envelopes.filter((envelope) => envelope.event.type === "turn-started")).toHaveLength(
        1,
      );
      expect(envelopes.filter((envelope) => envelope.event.type === "turn-ended")).toHaveLength(1);
      expect(envelopes.at(-1)?.event).toMatchObject({ type: "turn-ended", status: "completed" });

      observations = {
        ...observations,
        canonicalEventTrace: observeCanonicalEvents(envelopes),
        faultSchedule: [
          ...observations.faultSchedule,
          {
            boundary: "compiled-cli-daemon-readiness",
            point: "absent-detached-start-handshake-original-intent-retry",
            occurrence: 1,
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
    } finally {
      await cleanupAndProveRuntimeRemoved(profilePath);
    }
  }, 30_000);

  it("returns exact usage and refuses an absent-to-stale race before detached start", async () => {
    const usage = await runProcess([executable, "ask"], { cwd: repositoryRoot });
    const profilePath = await initializeProfile("stale-race");
    const socketPath = join(profilePath, ".runtime", "ziggy.sock");
    const observedPath = join(suiteRoot, "stale-initial-absent.observed");
    const releasePath = join(suiteRoot, "stale-initial-absent.release");
    const tracePath = join(suiteRoot, "stale-process.trace");
    const providerRequestedPath = join(suiteRoot, "stale-provider.requested");
    const child = spawnProcess([executable, "ask", "must not start", "--profile", profilePath], {
      cwd: repositoryRoot,
      env: fixtureEnvironment({
        tracePath,
        providerRequestedPath,
        initialAbsentBarrierPath: observedPath,
        initialAbsentReleasePath: releasePath,
      }),
    });

    try {
      await waitForPathState(observedPath, true);
      await createStaleSocket(socketPath, repositoryRoot);
      await writeFile(releasePath, "release\n");
      const known = await collectProcess(child);

      expect(usage).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: "usage: ziggy ask PROMPT [--profile PATH]\n",
      });
      expect(known).toEqual({ exitCode: 1, stdout: "", stderr: "Ziggy command failed.\n" });
      expect(usage.stderr.length).toBeLessThanOrEqual(stderrLimit);
      expect(known.stderr.length).toBeLessThanOrEqual(stderrLimit);
      expect(await readLines(tracePath)).toEqual(["initial-absent", "start-absent"]);
      expect((await lstat(socketPath)).isSocket()).toBeTrue();
      await expect(readFile(providerRequestedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(profilePath, "sessions", "main.ndjson"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      observations = {
        ...observations,
        faultSchedule: [
          ...observations.faultSchedule,
          {
            boundary: "compiled-cli-daemon-readiness",
            point: "absent-to-stale-before-readiness-owner-probe",
            occurrence: 1,
            outcome: "failed",
          },
        ],
      };
    } finally {
      child.kill("SIGKILL");
      try {
        await unlink(socketPath);
      } catch {
        // The controlled stale socket may already be absent after a failed assertion.
      }
    }
  }, 30_000);

  it("returns outcome unknown after one Turn write, never resends, and finalizes transport", async () => {
    const profilePath = await initializeProfile("unknown");
    const socketPath = join(profilePath, ".runtime", "ziggy.sock");
    const server = await startOutcomeUnknownAttachServer(socketPath);

    try {
      const result = await runProcess(
        [executable, "ask", "write exactly once", "--profile", profilePath],
        { cwd: repositoryRoot, env: fixtureEnvironment() },
      );
      const closedConnections = await awaitBarrier(server.closedConnections);

      expect(result).toEqual({
        exitCode: 3,
        stdout: "",
        stderr: "Turn outcome unknown; it may have been accepted. Do not retry automatically.\n",
      });
      expect(result.stderr.length).toBeLessThanOrEqual(stderrLimit);
      expect(server.methods).toEqual([
        "initialize",
        "initialize",
        "session/ensure",
        "session/subscribe",
        "turn/start",
      ]);
      expect(server.turnMessages).toEqual(["write exactly once"]);
      expect(server.methods.filter((method) => method === "turn/interrupt")).toEqual([]);
      expect(closedConnections).toBe(2);
      observations = {
        ...observations,
        faultSchedule: [
          ...observations.faultSchedule,
          {
            boundary: "compiled-cli-attach-receive",
            point: "post-turn-write-disconnect-no-resend",
            occurrence: 1,
            outcome: "failed",
          },
        ],
      };
    } finally {
      await server.close();
      await waitForPathState(socketPath, false);
    }
  }, 30_000);

  it("returns 130 on SIGINT detach while daemon-owned work completes without interruption", async () => {
    const profilePath = await initializeProfile("sigint");
    const requestedPath = join(suiteRoot, "sigint-provider.requested");
    const releasePath = join(suiteRoot, "sigint-provider.release");
    const child = spawnProcess(
      [executable, "ask", "remain daemon owned", "--profile", profilePath],
      {
        cwd: repositoryRoot,
        env: fixtureEnvironment({
          providerRequestedPath: requestedPath,
          providerReleasePath: releasePath,
        }),
      },
    );

    try {
      await waitForPathState(requestedPath, true);
      child.kill("SIGINT");
      const result = await collectProcess(child);
      await writeFile(releasePath, "release\n");
      const durable = await waitForFile(join(profilePath, "sessions", "main.ndjson"), (contents) =>
        contents.includes('"type":"turn-ended"'),
      );
      const envelopes = decodeTranscript(durable);
      const ended = envelopes.filter((envelope) => envelope.event.type === "turn-ended");

      expect(result).toEqual({ exitCode: 130, stdout: "", stderr: "" });
      expect(result.stderr.length).toBeLessThanOrEqual(stderrLimit);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.event).toMatchObject({ type: "turn-ended", status: "completed" });
      expect(
        envelopes.filter(
          (envelope) =>
            envelope.event.type === "turn-ended" && envelope.event.status === "interrupted",
        ),
      ).toEqual([]);
      expect(await readLines(requestedPath)).toEqual(["requested"]);
      observations = {
        ...observations,
        faultSchedule: [
          ...observations.faultSchedule,
          {
            boundary: "compiled-cli-signal",
            point: "sigint-detach-without-daemon-turn-interrupt",
            occurrence: 1,
            outcome: "continued",
          },
        ],
      };
    } finally {
      await writeFile(releasePath, "release\n");
      await cleanupAndProveRuntimeRemoved(profilePath);
    }
  }, 30_000);
});

async function initializeProfile(label: string): Promise<string> {
  const profilePath = join(suiteRoot, `profile-${label}`);
  const result = await runProcess([executable, "init", profilePath, "--voice", "operator"], {
    cwd: repositoryRoot,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  await writeFile(
    join(profilePath, "ziggy.jsonc"),
    '{"schemaVersion":1,"defaultProvider":"faux","defaultModel":"faux-1","thinkingLevel":"medium","cacheRetention":"long"}\n',
  );
  return profilePath;
}

function fixtureEnvironment(
  options: {
    readonly tracePath?: string;
    readonly providerRequestedPath?: string;
    readonly providerReleasePath?: string;
    readonly initialAbsentBarrierPath?: string;
    readonly initialAbsentReleasePath?: string;
  } = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(suiteRoot, "fixture-home"),
    TMPDIR: tmpdir(),
    ...(options.tracePath === undefined ? {} : { ZIGGY_TEST_PROCESS_TRACE: options.tracePath }),
    ...(options.providerRequestedPath === undefined
      ? {}
      : { ZIGGY_TEST_PROVIDER_REQUESTED: options.providerRequestedPath }),
    ...(options.providerReleasePath === undefined
      ? {}
      : { ZIGGY_TEST_PROVIDER_RELEASE: options.providerReleasePath }),
    ...(options.initialAbsentBarrierPath === undefined
      ? {}
      : { ZIGGY_TEST_INITIAL_ABSENT_BARRIER: options.initialAbsentBarrierPath }),
    ...(options.initialAbsentReleasePath === undefined
      ? {}
      : { ZIGGY_TEST_INITIAL_ABSENT_RELEASE: options.initialAbsentReleasePath }),
  };
}

async function cleanupAndProveRuntimeRemoved(profilePath: string): Promise<void> {
  await cleanupDetachedDaemon(profilePath);
  await waitForPathState(join(profilePath, ".runtime", "daemon.lock"), false);
  await waitForPathState(join(profilePath, ".runtime", "ziggy.sock"), false);
}

async function readLines(path: string): Promise<ReadonlyArray<string>> {
  return (await readFile(path, "utf8")).trimEnd().split("\n");
}

function decodeTranscript(contents: string) {
  return contents
    .trimEnd()
    .split("\n")
    .map((line) => decodeSessionEnvelope(`${line}\n`));
}
