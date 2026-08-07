import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ProfileNotInitialized } from "../../domain/agent";
import { decodeDiscordGatewayConfigJson, type DiscordGatewayConfig } from "../../domain/discord";
import { GatewayConfigError } from "../../domain/gateway";
import { decodeSlackGatewayConfigJson, type SlackGatewayConfig } from "../../domain/slack";
import { decodeTelegramGatewayConfigJson, type TelegramGatewayConfig } from "../../domain/telegram";
import type { ProfileTarget } from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

export const validateGatewayProfile = (
  target: ProfileTarget,
): Effect.Effect<void, ProfileNotInitialized | GatewayConfigError> => {
  const soulPath = join(target.path, "SOUL.md");
  return Effect.tryPromise({
    try: () => stat(soulPath),
    catch: (cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? new ProfileNotInitialized({
            profilePath: target.path,
            message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
          })
        : new GatewayConfigError({
            path: soulPath,
            message: `could not inspect ${soulPath}`,
            cause,
          }),
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.void
        : Effect.fail(
            new ProfileNotInitialized({
              profilePath: target.path,
              message: `profile is not initialized at ${target.path}; run 'ziggy init <name|path>'`,
            }),
          ),
    ),
  );
};

export const gatewayConfigPresent = (path: string): Effect.Effect<boolean, GatewayConfigError> =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => fileSystemCauseDetails(cause),
  }).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      cause.code === "ENOENT"
        ? Effect.succeed(false)
        : Effect.fail(
            new GatewayConfigError({ path, message: `could not inspect ${path}`, cause }),
          ),
    ),
  );

const loadConfig = <A, E>(
  path: string,
  guidance: string,
  decode: (source: string) => Effect.Effect<A, E>,
): Effect.Effect<A, GatewayConfigError> =>
  Effect.tryPromise({
    try: (signal) => readFile(path, { encoding: "utf8", signal }),
    catch: (cause) => new GatewayConfigError({ path, message: guidance, cause }),
  }).pipe(
    Effect.flatMap((source) =>
      decode(source).pipe(
        Effect.mapError((cause) => new GatewayConfigError({ path, message: guidance, cause })),
      ),
    ),
  );

export const loadTelegramConfigFile = (
  target: ProfileTarget,
): Effect.Effect<TelegramGatewayConfig, ProfileNotInitialized | GatewayConfigError> => {
  const path = join(target.path, "telegram.json");
  return validateGatewayProfile(target).pipe(
    Effect.andThen(
      loadConfig(
        path,
        `create ${path} with {"botToken":"...","ownerUserId":123}`,
        decodeTelegramGatewayConfigJson,
      ),
    ),
  );
};

export const loadDiscordConfigFile = (
  target: ProfileTarget,
): Effect.Effect<DiscordGatewayConfig, GatewayConfigError> => {
  const path = join(target.path, "discord.json");
  return validateGatewayProfile(target).pipe(
    Effect.mapError((failure) =>
      failure._tag === "GatewayConfigError"
        ? failure
        : new GatewayConfigError({
            path: join(target.path, "SOUL.md"),
            message: failure.message,
            cause: failure,
          }),
    ),
    Effect.andThen(
      loadConfig(
        path,
        `create ${path} with {"botToken":"...","ownerUserId":"123"}`,
        decodeDiscordGatewayConfigJson,
      ),
    ),
  );
};

export const loadSlackConfigFile = (
  target: ProfileTarget,
): Effect.Effect<SlackGatewayConfig, GatewayConfigError> => {
  const path = join(target.path, "slack.json");
  return validateGatewayProfile(target).pipe(
    Effect.mapError((failure) =>
      failure._tag === "GatewayConfigError"
        ? failure
        : new GatewayConfigError({
            path: join(target.path, "SOUL.md"),
            message: failure.message,
            cause: failure,
          }),
    ),
    Effect.andThen(
      loadConfig(
        path,
        `create ${path} with {"botToken":"xoxb-...","appToken":"xapp-...","ownerUserId":"U0123ABC"}`,
        decodeSlackGatewayConfigJson,
      ),
    ),
  );
};
