/**
 * macOS Keychain generic passwords through `/usr/bin/security`. Values only ever travel through
 * stdin or stdout, never argv. Items are created by `security`, so their access list trusts that
 * tool: any process running as the user can read them without a prompt.
 */
import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";

export class KeychainFailed extends Schema.TaggedErrorClass<KeychainFailed>()("KeychainFailed", {
  operation: Schema.Literals(["read", "write"]),
  service: Schema.String,
  account: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Services and accounts go on an interactive `security` command line, so they are plain words. */
const WORD = /^[A-Za-z0-9_.-]{1,128}$/u;

interface SecurityResult {
  readonly code: number | null;
  readonly stdout: string;
}

// By absolute path, so a PATH entry cannot stand in for the Keychain tool.
const SECURITY = "/usr/bin/security";

const security = (args: ReadonlyArray<string>, input?: string) =>
  Effect.callback<SecurityResult, unknown>((resume) => {
    const child = spawn(SECURITY, [...args], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10_000,
    });

    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (cause) => resume(Effect.fail(cause)));
    child.on("close", (code) => resume(Effect.succeed({ code, stdout })));
    child.stdin.on("error", () => {
      /* Process failure is reported by close. */
    });
    child.stdin.end(input);

    // Interrupted: stop the child so it never outlives the caller.
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
  });

// `security find-generic-password` exits 44 when the item does not exist.
const NOT_FOUND = 44;

const failure = (
  operation: "read" | "write",
  service: string,
  account: string,
  message: string,
  cause?: unknown,
) => new KeychainFailed({ operation, service, account, message, cause });

const checkWords = (operation: "read" | "write", service: string, account: string) =>
  WORD.test(service) && WORD.test(account)
    ? Effect.void
    : Effect.fail(failure(operation, service, account, "not a Keychain service and account"));

/** The stored value, or undefined when none is stored. */
export const readGenericPassword = (
  service: string,
  account: string,
): Effect.Effect<string | undefined, KeychainFailed> =>
  checkWords("read", service, account).pipe(
    Effect.andThen(
      security(["find-generic-password", "-s", service, "-a", account, "-w"]).pipe(
        Effect.mapError((cause) =>
          failure("read", service, account, "could not run the Keychain tool", cause),
        ),
      ),
    ),
    Effect.flatMap(({ code, stdout }) => {
      if (code === NOT_FOUND) return Effect.succeed(undefined);

      if (code !== 0)
        return Effect.fail(
          failure("read", service, account, `Keychain lookup failed (exit ${code})`),
        );

      const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;

      return Effect.succeed(value === "" ? undefined : value);
    }),
  );

/** Stores `value` (printable ASCII), replacing any earlier one, and reads it back. */
export const writeGenericPassword = (
  service: string,
  account: string,
  value: string,
): Effect.Effect<void, KeychainFailed> =>
  Effect.gen(function* () {
    yield* checkWords("write", service, account);

    const hex = Buffer.from(value, "utf8").toString("hex");

    // `-X` takes the value as hex, so no quoting is needed and it never appears in argv.
    yield* security(["-i"], `add-generic-password -U -a ${account} -s ${service} -X ${hex}\n`).pipe(
      Effect.mapError((cause) =>
        failure("write", service, account, "could not run the Keychain tool", cause),
      ),
    );

    // Interactive `security` can exit successfully after a failed command; verify the write.
    const stored = yield* readGenericPassword(service, account).pipe(
      Effect.mapError((cause) => failure("write", service, account, cause.message, cause)),
    );

    if (stored !== value)
      return yield* failure("write", service, account, "Keychain did not store the value");
  });
