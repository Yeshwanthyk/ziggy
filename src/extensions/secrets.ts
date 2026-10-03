import { Context, Effect, Layer, Schema } from "effect";
import { readGenericPassword, writeGenericPassword } from "../platform/keychain";

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

const failure = (operation: "read" | "write", name: string, message: string, cause?: unknown) =>
  new PluginSecretError({ operation, name, message, cause });

const read = (name: string) =>
  readGenericPassword(PLUGIN_SECRET_SERVICE, name).pipe(
    Effect.mapError((cause) => failure("read", name, cause.message, cause)),
  );

const write = (name: string, value: string) =>
  writeGenericPassword(PLUGIN_SECRET_SERVICE, name, value).pipe(
    Effect.mapError((cause) => failure("write", name, cause.message, cause)),
  );

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
