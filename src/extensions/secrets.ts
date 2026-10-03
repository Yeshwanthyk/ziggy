import { spawn } from "node:child_process";
import { Context, Effect, Layer, Schema } from "effect";

/** The Keychain service plugin secrets live under; the account is the variable name. */
export const PLUGIN_SECRET_SERVICE = "ziggy-plugin";

/** A `${NAME}` a plugin's `mcp.json` may reference. */
export const PluginSecretName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  Schema.isMaxLength(128),
);

/**
 * A secret value: printable ASCII (API keys and tokens), so it round-trips through
 * `security -w` unchanged and can never smuggle a header or command line break.
 */
export const PluginSecretValue = Schema.String.check(
  Schema.isPattern(/^[\x20-\x7e]+$/u),
  Schema.isMaxLength(1024),
);

export class PluginSecretError extends Schema.TaggedErrorClass<PluginSecretError>()(
  "PluginSecretError",
  {
    operation: Schema.Literals(["read", "write"]),
    name: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface PluginSecretsApi {
  /** The stored value, or undefined when none is stored. */
  readonly get: (name: string) => Effect.Effect<string | undefined, PluginSecretError>;
  readonly set: (name: string, value: string) => Effect.Effect<void, PluginSecretError>;
}

interface SecurityResult {
  readonly code: number | null;
  readonly stdout: string;
}

// By absolute path, so a PATH entry cannot stand in for the Keychain tool.
const SECURITY = "/usr/bin/security";

/** Run `security`; the value only ever travels through stdin or stdout, never argv. */
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

const failure = (operation: "read" | "write", name: string, message: string, cause?: unknown) =>
  new PluginSecretError({ operation, name, message, cause });

const read = (name: string) =>
  security(["find-generic-password", "-s", PLUGIN_SECRET_SERVICE, "-a", name, "-w"]).pipe(
    Effect.mapError((cause) => failure("read", name, "could not run the Keychain tool", cause)),
    Effect.flatMap(({ code, stdout }) => {
      if (code === NOT_FOUND) return Effect.succeed(undefined);

      if (code !== 0)
        return Effect.fail(failure("read", name, `Keychain lookup failed (exit ${code})`));

      const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;

      return Effect.succeed(value === "" ? undefined : value);
    }),
  );

const write = (name: string, value: string) =>
  Effect.gen(function* () {
    const hex = Buffer.from(value, "utf8").toString("hex");

    // `-X` takes the value as hex, so no quoting is needed and it never appears in argv.
    yield* security(
      ["-i"],
      `add-generic-password -U -a ${name} -s ${PLUGIN_SECRET_SERVICE} -X ${hex}\n`,
    ).pipe(
      Effect.mapError((cause) => failure("write", name, "could not run the Keychain tool", cause)),
    );

    // Interactive `security` can exit successfully after a failed command; verify the write.
    const stored = yield* read(name).pipe(
      Effect.mapError((cause) => failure("write", name, cause.message, cause)),
    );

    if (stored !== value) return yield* failure("write", name, "Keychain did not store the value");
  });

const unsupported = (name: string) =>
  failure("write", name, "plugin secrets need the macOS Keychain");

/**
 * macOS Keychain; elsewhere nothing is stored and writes are refused. Items are created by
 * `security`, so their access list trusts that tool: any process running as the user can read
 * them with `security find-generic-password -s ziggy-plugin -a NAME -w` without a prompt.
 */
const keychain: PluginSecretsApi = {
  get: (name) => (process.platform === "darwin" ? read(name) : Effect.succeed(undefined)),
  set: (name, value) =>
    process.platform === "darwin" ? write(name, value) : Effect.fail(unsupported(name)),
};

/** Where plugin `${NAME}` values are stored: the Keychain, service `ziggy-plugin`. */
export class PluginSecrets extends Context.Service<PluginSecrets>()("ziggy/PluginSecrets", {
  make: Effect.succeed(keychain),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
