import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { WebAccessConfig, WebAccessError } from "../../domain/web-access";
import { fileSystemCauseDetails } from "./cause";

const DEFAULT_PORT = 0;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(WebAccessConfig), {
  onExcessProperty: "error",
});

export const webAccessConfigPath = (profilePath: string): string =>
  join(profilePath, ".gateway", "web.json");

const failure = (operation: string, path: string, message: string, cause?: unknown) =>
  cause === undefined
    ? new WebAccessError({ operation, path, message })
    : new WebAccessError({ operation, path, message, cause });

export const validateWebAccessConfig = (
  profilePath: string,
  config: WebAccessConfig,
): Effect.Effect<WebAccessConfig, WebAccessError> => {
  const path = webAccessConfigPath(profilePath);
  const publicUrl = config.publicUrl;

  return publicUrl === undefined
    ? Effect.succeed(config)
    : Effect.try({
        try: () => {
          const url = new URL(publicUrl);

          if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new Error("public URL must use http or https");

          if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0)
            throw new Error("public URL must not contain credentials or a query");

          if (url.pathname !== "/") throw new Error("public URL must use the origin root");

          url.hash = "";
          url.pathname = url.pathname.replace(/\/+$/u, "") || "/";

          return { ...config, publicUrl: url.toString().replace(/\/$/u, "") };
        },
        catch: (cause) => failure("decode config", path, "web access public URL is invalid", cause),
      });
};

export const readWebAccessConfig = (
  profilePath: string,
): Effect.Effect<WebAccessConfig, WebAccessError> => {
  const path = webAccessConfigPath(profilePath);

  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => failure("read config", path, "could not read web access config", cause),
  }).pipe(
    Effect.catchIf(
      (error) => fileSystemCauseDetails(error.cause).code === "ENOENT",
      () => Effect.succeed(`${JSON.stringify({ version: 1, port: DEFAULT_PORT })}\n`),
    ),
    Effect.flatMap((source) =>
      decodeConfig(source).pipe(
        Effect.mapError((cause) =>
          failure("decode config", path, "web access config is invalid", cause),
        ),
      ),
    ),
    Effect.flatMap((config) => validateWebAccessConfig(profilePath, config)),
  );
};

export const writeWebAccessConfig = (
  profilePath: string,
  config: WebAccessConfig,
): Effect.Effect<void, WebAccessError> => {
  const path = webAccessConfigPath(profilePath);
  const directory = dirname(path);
  const temporary = join(directory, `.web-${randomUUID()}.tmp`);

  return validateWebAccessConfig(profilePath, config).pipe(
    Effect.flatMap((validated) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const directoryStatus = await lstat(directory);

          if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink())
            throw new Error("web access config directory must be a physical directory");

          await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
          });
          await rename(temporary, path);
        },
        catch: (cause) => failure("write config", path, "could not write web access config", cause),
      }),
    ),
    Effect.ensuring(
      Effect.tryPromise({ try: () => rm(temporary, { force: true }), catch: () => undefined }).pipe(
        Effect.catch(() => Effect.void),
      ),
    ),
  );
};
