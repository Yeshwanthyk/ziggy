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

interface KillableProcess {
  readonly kill: () => void;
}

export const killProcess = (process: KillableProcess): void => {
  try {
    process.kill();
  } catch {
    // The process may have exited between the timeout and interruption.
  }
};
