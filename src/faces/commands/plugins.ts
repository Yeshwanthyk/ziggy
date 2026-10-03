import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { readSecretInput } from "../../adapters/terminal/secret-input";
import { PluginSecretName, PluginSecrets, PluginSecretValue } from "../../extensions";
import { ZiggyPaths } from "../../platform/paths";
import { resolveProfileTarget } from "../../profile";
import { CliInputInvalid, type CliCommand } from "../cli-command";

const isSecretName = Schema.is(PluginSecretName);

const isSecretValue = Schema.is(PluginSecretValue);

export type PluginsCommand = Extract<CliCommand, { readonly _tag: "PluginSecretSet" }>;

const isProfile = (profilePath: string) =>
  Effect.tryPromise(() => lstat(path.join(profilePath, "SOUL.md"))).pipe(
    Effect.map((status) => status.isFile() && !status.isSymbolicLink()),
    Effect.orElseSucceed(() => false),
  );

/** `ziggy plugin secret set`: store one `${NAME}` in the Keychain without echoing it. */
export const runPluginsCommand = (command: PluginsCommand) =>
  Effect.gen(function* () {
    const paths = yield* ZiggyPaths;
    const secrets = yield* PluginSecrets;
    const target = resolveProfileTarget(command.target, paths);

    if (!(yield* isProfile(target.path)))
      return yield* new CliInputInvalid({ message: `not a Ziggy Profile: ${target.path}` });

    if (!isSecretName(command.name))
      return yield* new CliInputInvalid({
        message: "secret name must match [A-Za-z_][A-Za-z0-9_]* (at most 128 characters)",
      });

    const value = yield* readSecretInput(`value for ${command.name}`);

    if (value === undefined) return yield* new CliInputInvalid({ message: "cancelled" });

    if (!isSecretValue(value))
      return yield* new CliInputInvalid({
        message: "secret value must be 1-1024 printable ASCII characters",
      });

    yield* secrets.set(command.name, value);
    console.log(`stored ${command.name} (Keychain service ziggy-plugin; applies to new sessions)`);
  });
