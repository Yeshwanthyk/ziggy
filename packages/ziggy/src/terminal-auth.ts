import { createInterface } from "node:readline/promises";
import { Cause, Effect, Exit, Schema } from "effect";
import type { AuthClientInteraction } from "./auth-client.ts";

export class TerminalAuthError extends Schema.TaggedErrorClass<TerminalAuthError>(
  "@ziggy/ziggy/TerminalAuthError",
)("TerminalAuthError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface SecretTerminal {
  readonly isTTY: boolean;
  readonly isRaw: boolean;
  readonly readableEncoding: BufferEncoding | null;
  readonly readableFlowing: boolean | null;
  setEncoding(encoding: BufferEncoding | null): void;
  resume(): void;
  pause(): void;
  setRawMode(enabled: boolean): void;
  onData(listener: (chunk: string | Buffer) => void): void;
  offData(listener: (chunk: string | Buffer) => void): void;
  write(value: string): void;
}

interface TerminalSnapshot {
  readonly raw: boolean;
  readonly encoding: BufferEncoding | null;
}

export function terminalAuthInteraction(
  output: (value: string) => void,
): AuthClientInteraction<TerminalAuthError> {
  const notify = (message: string): Effect.Effect<void, TerminalAuthError> =>
    terminalOperation("write-output", "Failed to write authentication output", () =>
      output(message),
    );

  return {
    notify,
    prompt: (event, signal) => {
      if (event.kind === "secret") return readTerminalSecret(event.message, signal, nodeTerminal);
      return Effect.acquireUseRelease(
        terminalOperation("open-prompt", "Failed to open authentication prompt", () =>
          createInterface({ input: process.stdin, output: process.stdout }),
        ),
        (question) =>
          Effect.gen(function* () {
            if (event.kind === "select") {
              yield* notify(event.message);
              yield* Effect.forEach(event.options, (option) =>
                notify(
                  `${option.id}: ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`,
                ),
              );
            }
            return yield* Effect.tryPromise({
              try: () =>
                question.question(`${event.kind === "select" ? "Selection" : event.message}: `, {
                  signal,
                }),
              catch: (cause) =>
                new TerminalAuthError({
                  operation: "read-prompt",
                  message: signal.aborted
                    ? "Authentication prompt cancelled"
                    : "Failed to read authentication prompt",
                  cause,
                }),
            });
          }),
        (question) =>
          terminalOperation("close-prompt", "Failed to close authentication prompt", () =>
            question.close(),
          ),
      );
    },
  };
}

export function readTerminalSecret(
  message: string,
  signal: AbortSignal,
  terminal: SecretTerminal,
): Effect.Effect<string, TerminalAuthError> {
  if (signal.aborted) {
    return Effect.fail(
      new TerminalAuthError({
        operation: "read-secret",
        message: "Authentication prompt cancelled",
      }),
    );
  }
  if (!terminal.isTTY) {
    return Effect.fail(
      new TerminalAuthError({
        operation: "read-secret",
        message: "Secret authentication prompt requires an interactive terminal",
      }),
    );
  }

  const snapshot: TerminalSnapshot = {
    raw: terminal.isRaw,
    encoding: terminal.readableEncoding,
  };
  const restore = restoreTerminal(terminal, snapshot);
  const setup = Effect.gen(function* () {
    yield* terminalOperation("set-encoding", "Failed to prepare authentication terminal", () =>
      terminal.setEncoding("utf8"),
    );
    yield* terminalOperation("resume", "Failed to prepare authentication terminal", () =>
      terminal.resume(),
    );
    yield* terminalOperation("set-raw-mode", "Failed to prepare authentication terminal", () =>
      terminal.setRawMode(true),
    );
    yield* terminalOperation("write-prompt", "Failed to prepare authentication terminal", () =>
      terminal.write(`${message}: `),
    );
    return snapshot;
  }).pipe(
    Effect.catch((setupError) =>
      restore.pipe(
        Effect.matchEffect({
          onFailure: (restoreError) =>
            Effect.fail(
              new TerminalAuthError({
                operation: "setup-secret",
                message: "Authentication terminal setup and rollback failed",
                cause: [setupError, restoreError],
              }),
            ),
          onSuccess: () => Effect.fail(setupError),
        }),
      ),
    ),
  );

  return Effect.acquireUseRelease(
    setup,
    () => readSecretInput(signal, terminal),
    () => restore,
  );
}

function readSecretInput(
  signal: AbortSignal,
  terminal: SecretTerminal,
): Effect.Effect<string, TerminalAuthError> {
  let listenerInstalled = false;
  let abortInstalled = false;
  let onData: (chunk: string | Buffer) => void = () => {};
  let onAbort: () => void = () => {};

  const cleanup = terminalOperation(
    "remove-secret-listeners",
    "Failed to remove authentication terminal listeners",
    () => {
      if (listenerInstalled) {
        terminal.offData(onData);
        listenerInstalled = false;
      }
      if (abortInstalled) {
        signal.removeEventListener("abort", onAbort);
        abortInstalled = false;
      }
    },
  );

  const read = Effect.callback<string, TerminalAuthError>((resume) => {
    let value = "";
    let settled = false;
    const settle = (effect: Effect.Effect<string, TerminalAuthError>): void => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    onAbort = () =>
      settle(
        Effect.fail(
          new TerminalAuthError({
            operation: "read-secret",
            message: "Authentication prompt cancelled",
          }),
        ),
      );
    onData = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          settle(Effect.succeed(value));
          return;
        }
        if (character === "\u0003") {
          settle(
            Effect.fail(
              new TerminalAuthError({
                operation: "read-secret",
                message: "Authentication cancelled",
              }),
            ),
          );
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };

    // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- boundary: host event registration can throw before Effect owns the listeners
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      abortInstalled = true;
      listenerInstalled = true;
      terminal.onData(onData);
      if (signal.aborted) onAbort();
    } catch (cause) {
      settle(
        Effect.fail(
          new TerminalAuthError({
            operation: "install-secret-listeners",
            message: "Failed to install authentication terminal listeners",
            cause,
          }),
        ),
      );
    }
    return Effect.exit(cleanup).pipe(Effect.asVoid);
  });
  return Effect.acquireUseRelease(
    Effect.void,
    () => read,
    () => cleanup,
  );
}

function restoreTerminal(
  terminal: SecretTerminal,
  snapshot: TerminalSnapshot,
): Effect.Effect<void, TerminalAuthError> {
  const operations: ReadonlyArray<readonly [string, () => void]> = [
    ["restore-raw-mode", () => terminal.setRawMode(snapshot.raw)],
    ["restore-encoding", () => terminal.setEncoding(snapshot.encoding)],
    ["pause", () => terminal.pause()],
    ["write-newline", () => terminal.write("\n")],
  ];
  return Effect.forEach(operations, ([operation, run]) =>
    Effect.exit(terminalOperation(operation, "Failed to restore authentication terminal", run)),
  ).pipe(
    Effect.flatMap((exits) => {
      const failures = exits.flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      );
      return failures.length === 0
        ? Effect.void
        : Effect.fail(
            new TerminalAuthError({
              operation: "restore-terminal",
              message: "Authentication terminal rollback failed",
              cause: failures,
            }),
          );
    }),
  );
}

function terminalOperation<A>(
  operation: string,
  message: string,
  run: () => A,
): Effect.Effect<A, TerminalAuthError> {
  return Effect.try({
    try: run,
    catch: (cause) => new TerminalAuthError({ operation, message, cause }),
  });
}

const nodeTerminal: SecretTerminal = {
  get isTTY() {
    return process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function";
  },
  get isRaw() {
    return process.stdin.isRaw;
  },
  get readableEncoding() {
    return process.stdin.readableEncoding;
  },
  get readableFlowing() {
    return process.stdin.readableFlowing;
  },
  setEncoding: (encoding) => {
    process.stdin.setEncoding(encoding ?? undefined);
  },
  resume: () => {
    process.stdin.resume();
  },
  pause: () => {
    process.stdin.pause();
  },
  setRawMode: (enabled) => {
    process.stdin.setRawMode?.(enabled);
  },
  onData: (listener) => {
    process.stdin.on("data", listener);
  },
  offData: (listener) => {
    process.stdin.off("data", listener);
  },
  write: (value) => {
    process.stdout.write(value);
  },
};
