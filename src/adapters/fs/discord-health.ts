import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import {
  type DiscordHealthProjection,
  DiscordHealthProjectionError,
  type DiscordHealthSnapshot,
  DiscordHealthSnapshot as DiscordHealthSnapshotSchema,
} from "../../domain/discord-health";
import { fileSystemCauseDetails } from "./cause";

const decodeSnapshotJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DiscordHealthSnapshotSchema),
  { onExcessProperty: "error" },
);

export const discordHealthPath = (profilePath: string): string =>
  join(profilePath, ".runtime", "discord-health.json");

const projectionError = (
  operation: "read" | "write",
  path: string,
  cause: unknown,
): DiscordHealthProjectionError =>
  new DiscordHealthProjectionError({
    operation,
    path,
    message: `could not ${operation} Discord runtime health projection`,
    cause,
  });

const missing = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";

const inspect = (path: string) =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => cause,
  });

export const writeDiscordHealth = (
  profilePath: string,
  snapshot: DiscordHealthSnapshot,
): Effect.Effect<void, DiscordHealthProjectionError> => {
  const runtimePath = join(profilePath, ".runtime");
  const destination = discordHealthPath(profilePath);
  const temporary = join(runtimePath, `.discord-health-${randomUUID()}.tmp`);
  return Effect.tryPromise({
    try: async (signal) => {
      await mkdir(runtimePath, { recursive: true, mode: 0o700 });
      const runtime = await lstat(runtimePath);
      if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
        throw new Error("unsafe Discord runtime path");
      }
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        signal,
      });
      await rename(temporary, destination);
    },
    catch: (cause) => projectionError("write", destination, cause),
  }).pipe(
    Effect.tapError(() =>
      Effect.tryPromise({
        try: () => rm(temporary, { force: true }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
};

export const readDiscordHealth = (
  profilePath: string,
  observedAtMs: number,
): Effect.Effect<DiscordHealthProjection, DiscordHealthProjectionError> =>
  Effect.gen(function* () {
    const configPath = join(profilePath, "discord.json");
    const config = yield* inspect(configPath).pipe(Effect.result);
    if (Result.isFailure(config)) {
      if (missing(config.failure)) return { _tag: "not-configured" } as const;
      return yield* projectionError("read", configPath, config.failure);
    }
    if (!config.success.isFile() || config.success.isSymbolicLink()) {
      return yield* projectionError("read", configPath, new Error("unsafe Discord config path"));
    }

    const path = discordHealthPath(profilePath);
    const status = yield* inspect(path).pipe(Effect.result);
    if (Result.isFailure(status)) {
      if (missing(status.failure)) return { _tag: "not-observed" } as const;
      return yield* projectionError("read", path, status.failure);
    }
    if (!status.success.isFile() || status.success.isSymbolicLink()) {
      return yield* projectionError("read", path, new Error("unsafe Discord health path"));
    }
    const content = yield* Effect.tryPromise({
      try: (signal) => readFile(path, { encoding: "utf8", signal }),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (Result.isFailure(content)) return yield* projectionError("read", path, content.failure);
    const snapshot = yield* decodeSnapshotJson(content.success).pipe(
      Effect.mapError((cause) => projectionError("read", path, cause)),
    );
    return { _tag: "observed", observedAtMs, snapshot } as const;
  });
