import { describe, expect, it } from "bun:test";
import type { SessionEnvelope, SessionSummary } from "../../packages/protocol/src/index.ts";
import {
  AttachOutcomeUnknownError,
  type AttachClient,
  type AttachSubscription,
} from "../../packages/ziggy/src/attach.ts";
import {
  CliClientSetupError,
  CliOutcomeUnknownError,
  formatSessionList,
  prepareClientDaemon,
  runAskWithClient,
  runSessionsListWithClient,
} from "../../packages/ziggy/src/cli-client.ts";
import {
  DaemonControlError,
  DaemonReadiness,
  ensureDaemonReady,
  type DaemonProbeResult,
} from "../../packages/ziggy/src/daemon.ts";
import { Effect, Queue } from "effect";
import { runEffect } from "../testkit/effect.ts";

const main: SessionSummary = {
  sessionId: "main",
  createdAt: "2026-07-21T00:00:00.000Z",
  lastSeq: 10,
};

const other: SessionSummary = {
  sessionId: "work",
  createdAt: "2026-07-21T00:00:01.000Z",
  lastSeq: 4,
  activeTurnId: "turn-active",
};

function ready(profilePath = "/profile"): Extract<DaemonProbeResult, { readonly status: "ready" }> {
  return {
    status: "ready",
    profilePath,
    socketPath: `${profilePath}/.runtime/ziggy.sock`,
    protocolVersion: 2,
  };
}

function event(seq: number, value: SessionEnvelope["event"]): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq,
    emittedAt: `2026-07-21T00:00:0${seq}.000Z`,
    event: value,
  };
}

function clientWith(
  startMainTurn: AttachClient["startMainTurn"],
  sessions: ReadonlyArray<SessionSummary> = [],
): AttachClient {
  return {
    ensureMain: Effect.succeed(main),
    listSessions: Effect.succeed(sessions),
    subscribe: () => Effect.never,
    startMainTurn,
    startTurn: () => Effect.never,
    steerTurn: () => Effect.never,
    interruptTurn: () => Effect.never,
    resolveApproval: () => Effect.never,
  };
}

function acceptedTurn(events: ReadonlyArray<SessionEnvelope>): Effect.Effect<{
  readonly acceptance: { readonly turnId: string; readonly disposition: "started" };
  readonly subscription: AttachSubscription;
}> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<SessionEnvelope>();
    yield* Effect.forEach(events, (envelope) => Queue.offer(queue, envelope), { discard: true });
    return {
      acceptance: { turnId: "accepted", disposition: "started" },
      subscription: {
        sessionId: "main",
        next: Queue.take(queue),
        lastAppliedSeq: Effect.succeed(0),
        replayThroughSeq: Effect.succeed(0),
        close: Queue.shutdown(queue),
      },
    };
  });
}

describe("CLI Attach Client lane", () => {
  it("streams only accepted Turn text with one normalized final newline", async () => {
    const output: string[] = [];
    const client = clientWith(() =>
      acceptedTurn([
        event(1, {
          type: "model-chunk",
          sessionId: "main",
          turnId: "other",
          stepId: "step-other",
          contentIndex: 0,
          kind: "text",
          delta: "hidden",
        }),
        event(2, {
          type: "model-chunk",
          sessionId: "main",
          turnId: "accepted",
          stepId: "step-1",
          contentIndex: 0,
          kind: "thinking",
          delta: "private",
        }),
        event(3, {
          type: "model-chunk",
          sessionId: "main",
          turnId: "accepted",
          stepId: "step-1",
          contentIndex: 1,
          kind: "text",
          delta: "hello\n",
        }),
        event(4, {
          type: "model-chunk",
          sessionId: "main",
          turnId: "accepted",
          stepId: "step-1",
          contentIndex: 2,
          kind: "text",
          delta: "world\n\n",
        }),
        event(5, {
          type: "turn-ended",
          sessionId: "main",
          turnId: "accepted",
          status: "completed",
        }),
      ]),
    );

    await runEffect(
      runAskWithClient(client, "hello", (text) => Effect.sync(() => output.push(text))),
    );

    expect(output.join("")).toBe("hello\nworld\n");
  });

  it("maps an uncorrelated Turn write to outcome unknown without retrying", async () => {
    let starts = 0;
    const client = clientWith(() => {
      starts += 1;
      return Effect.fail(new AttachOutcomeUnknownError({ sessionId: "main" }));
    });

    const failure = await runEffect(
      Effect.flip(runAskWithClient(client, "execute once", () => Effect.void)),
    );

    expect(failure).toEqual(new CliOutcomeUnknownError());
    expect(starts).toBe(1);
  });

  it("formats empty and all-Session output without pin or protocol state", async () => {
    expect(formatSessionList([])).toBe("[]");
    expect(formatSessionList([other, main])).toBe(
      '[{"sessionId":"main","createdAt":"2026-07-21T00:00:00.000Z","status":"idle"},{"sessionId":"work","createdAt":"2026-07-21T00:00:01.000Z","status":"active"}]',
    );
    expect(
      await runEffect(runSessionsListWithClient(clientWith(() => Effect.never, [other, main]))),
    ).toBe(formatSessionList([other, main]));
  });

  it("auto-starts only after an absent-daemon probe", async () => {
    let starts = 0;
    const absent: DaemonProbeResult = {
      status: "unavailable",
      profilePath: "/canonical",
      socketPath: "/canonical/.runtime/ziggy.sock",
      socketState: "absent",
      detail: "absent",
    };
    const result = await runEffect(
      prepareClientDaemon("/profile", {
        probe: () => Effect.succeed(absent),
        startAbsent: (profilePath) =>
          Effect.sync(() => {
            starts += 1;
            return ready(profilePath);
          }),
      }),
    );
    expect(result).toEqual(ready("/canonical"));
    expect(starts).toBe(1);

    const staleFailure = await runEffect(
      Effect.flip(
        prepareClientDaemon("/profile", {
          probe: () => Effect.succeed({ ...absent, socketState: "stale" }),
          startAbsent: () =>
            Effect.sync(() => {
              starts += 1;
              return ready();
            }),
        }),
      ),
    );
    expect(staleFailure).toEqual(
      new CliClientSetupError({ message: "Profile daemon is not available for safe auto-start" }),
    );
    expect(starts).toBe(1);

    let raceStarts = 0;
    const raceFailure = await runEffect(
      Effect.flip(
        prepareClientDaemon("/profile", {
          probe: () => Effect.succeed(absent),
          startAbsent: (profilePath) =>
            ensureDaemonReady({
              profilePath,
              canonicalize: (path) => Effect.succeed(path),
              requireAbsent: true,
              probe: (path) =>
                Effect.succeed({
                  status: "unavailable",
                  profilePath: path,
                  socketPath: `${path}/.runtime/ziggy.sock`,
                  socketState: "stale",
                  detail: "socket appeared after the Client's absent probe",
                }),
              start: () => Effect.sync(() => (raceStarts += 1)),
            }),
        }),
      ).pipe(Effect.provide(DaemonReadiness.layer)),
    );
    expect(raceFailure).toEqual(
      new DaemonControlError({
        operation: "auto-start",
        message: "Refusing daemon auto-start: socket appeared after the Client's absent probe",
      }),
    );
    expect(raceStarts).toBe(0);

    const startFailure = new DaemonControlError({
      operation: "start-background-daemon",
      message: "fixture start failure",
    });
    expect(
      await runEffect(
        Effect.flip(
          prepareClientDaemon("/profile", {
            probe: () => Effect.succeed(absent),
            startAbsent: () => Effect.fail(startFailure),
          }),
        ),
      ),
    ).toEqual(startFailure);
  });
});
