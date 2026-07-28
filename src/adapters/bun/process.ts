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
