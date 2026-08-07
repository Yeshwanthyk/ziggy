import { Option, Schema } from "effect";

const ProcessSignalError = Schema.Struct({ code: Schema.String });
const decodeProcessSignalError = Schema.decodeUnknownOption(ProcessSignalError);

type SignalProcess = (pid: number, signal: 0) => boolean;

export const makeLocalProcessAlive =
  (signal: SignalProcess): ((pid: number) => boolean) =>
  (pid) => {
    try {
      signal(pid, 0);
      return true;
    } catch (cause) {
      return Option.match(decodeProcessSignalError(cause), {
        onNone: () => true,
        onSome: ({ code }) => code !== "ESRCH",
      });
    }
  };

export const isLocalProcessAlive = makeLocalProcessAlive((pid, signal) =>
  process.kill(pid, signal),
);

export interface KillableProcess {
  readonly kill: () => void;
}

export type ReportSignalFailure = (cause: unknown) => void;

const reportLiveSignalFailure: ReportSignalFailure = (cause) =>
  console.error("process cleanup signal failed", cause);

export const killProcess = (
  process: KillableProcess,
  report: ReportSignalFailure = reportLiveSignalFailure,
): void => {
  try {
    process.kill();
  } catch (cause) {
    if (Option.getOrUndefined(decodeProcessSignalError(cause))?.code !== "ESRCH") report(cause);
  }
};
