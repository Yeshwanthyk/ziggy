/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Fiber } from "effect";
import {
  killGateProcessGroup,
  makeAutomationGate,
  type AutomationGateHost,
} from "./automation-gate";

const failure = (host: AutomationGateHost, timeout: Duration.Input = "30 seconds") =>
  Effect.runPromise(
    makeAutomationGate(host, timeout)
      .run("/profile", "daily", "check")
      .pipe(
        Effect.map(() => ({ kind: "success" as const })),
        Effect.catchTag("AutomationGateFailed", (error) =>
          Effect.succeed({
            kind: "failure" as const,
            reason: error.reason,
            automationId: error.automationId,
            command: error.command,
            message: error.message,
          }),
        ),
      ),
  );

describe("automation gate", () => {
  test("returns pass and decline results", async () => {
    const gate = (exitCode: number) =>
      makeAutomationGate({ spawn: () => ({ exited: Promise.resolve(exitCode), kill: () => {} }) });
    expect(await Effect.runPromise(gate(0).run("/p", "daily", "ok"))).toEqual({ kind: "passed" });
    expect(await Effect.runPromise(gate(7).run("/p", "daily", "no"))).toEqual({
      kind: "declined",
      exitCode: 7,
    });
  });

  test("returns typed spawn and wait failures", async () => {
    const spawn = await failure({
      spawn: () => {
        throw new Error("spawn");
      },
    });
    const wait = await failure({
      spawn: () => ({ exited: Promise.reject(new Error("wait")), kill: () => {} }),
    });
    expect(spawn).toEqual({
      kind: "failure",
      reason: "spawn",
      automationId: "daily",
      command: "check",
      message: "automation daily gate could not start",
    });
    expect(wait).toEqual({
      kind: "failure",
      reason: "wait",
      automationId: "daily",
      command: "check",
      message: "automation daily gate failed while waiting for exit",
    });
  });

  test("reports both non-benign group and fallback signal failures", () => {
    const failures: Array<unknown> = [];
    const groupFailure = Object.assign(new Error("group denied"), { code: "EPERM" });
    const childFailure = Object.assign(new Error("child denied"), { code: "EPERM" });

    killGateProcessGroup(
      () => {
        throw groupFailure;
      },
      {
        kill: () => {
          throw childFailure;
        },
      },
      (cause) => failures.push(cause),
    );

    expect(failures).toEqual([groupFailure, childFailure]);
  });

  test("kills the child on timeout", async () => {
    let kills = 0;
    const result = await failure(
      {
        spawn: () => ({
          exited: new Promise(() => {}),
          kill: () => {
            kills += 1;
          },
        }),
      },
      "5 millis",
    );
    expect(result).toEqual({
      kind: "failure",
      reason: "timeout",
      automationId: "daily",
      command: "check",
      message: "automation daily gate timed out after 5 millis",
    });
    expect(kills).toBe(1);
  });

  test("kills the shell process group on timeout", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-gate-"));
    const pidPath = join(profilePath, "pids");
    const isRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitUntilStopped = async (pids: readonly number[]): Promise<boolean> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (pids.every((pid) => !isRunning(pid))) return true;
        await Bun.sleep(10);
      }
      return false;
    };
    let pids: readonly number[] = [];
    try {
      const command = `sleep 30 & child=$!; printf '%s %s' "$$" "$child" > "${pidPath}"; wait`;
      const result = await Effect.runPromise(
        makeAutomationGate(undefined, "100 millis")
          .run(profilePath, "daily", command)
          .pipe(Effect.catchTag("AutomationGateFailed", (error) => Effect.succeed(error.reason))),
      );
      pids = (await readFile(pidPath, "utf8")).split(" ").map(Number);
      expect(result).toBe("timeout");
      expect(pids).toHaveLength(2);
      expect(await waitUntilStopped(pids)).toBe(true);
    } finally {
      for (const pid of pids) {
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
      await rm(profilePath, { recursive: true, force: true });
    }
  });

  test("kills the child on interruption", async () => {
    let kills = 0;
    const effect = makeAutomationGate({
      spawn: () => ({
        exited: new Promise(() => {}),
        kill: () => {
          kills += 1;
        },
      }),
    }).run("/p", "daily", "check");
    const fiber = Effect.runFork(effect);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(kills).toBe(1);
  });
});
