import { Duration, Effect, Option } from "effect";
import { AutomationGateFailed } from "../../domain/automation";
import { killProcess } from "./process";

interface GateProcess {
  readonly exited: Promise<number>;
  readonly kill: () => void;
}

export interface AutomationGate {
  readonly run: (
    profilePath: string,
    automationId: string,
    command: string,
  ) => Effect.Effect<
    { readonly kind: "passed" } | { readonly kind: "declined"; readonly exitCode: number },
    AutomationGateFailed
  >;
}

export interface AutomationGateHost {
  readonly spawn: (profilePath: string, command: string) => GateProcess;
}

const liveHost: AutomationGateHost = {
  spawn: (profilePath, command) => {
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: profilePath,
      detached: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return {
      exited: child.exited,
      kill: () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          killProcess(child);
        }
      },
    };
  },
};

export const makeAutomationGate = (
  host: AutomationGateHost = liveHost,
  timeout: Duration.Input = "30 seconds",
): AutomationGate => ({
  run: (profilePath, automationId, command) =>
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () => host.spawn(profilePath, command),
        catch: (cause) =>
          new AutomationGateFailed({
            automationId,
            command,
            reason: "spawn",
            message: `automation ${automationId} gate could not start`,
            cause,
          }),
      });
      const exit = yield* Effect.tryPromise({
        try: (signal) => {
          const kill = () => killProcess(child);
          signal.addEventListener("abort", kill, { once: true });
          return child.exited.finally(() => signal.removeEventListener("abort", kill));
        },
        catch: (cause) => {
          killProcess(child);
          return new AutomationGateFailed({
            automationId,
            command,
            reason: "wait",
            message: `automation ${automationId} gate failed while waiting for exit`,
            cause,
          });
        },
      }).pipe(Effect.timeoutOption(timeout));
      if (Option.isNone(exit)) {
        return yield* new AutomationGateFailed({
          automationId,
          command,
          reason: "timeout",
          message: `automation ${automationId} gate timed out after ${timeout}`,
          cause: `gate timed out after ${timeout}`,
        });
      }
      return exit.value === 0 ? { kind: "passed" } : { kind: "declined", exitCode: exit.value };
    }),
});

export const liveAutomationGate = makeAutomationGate();
