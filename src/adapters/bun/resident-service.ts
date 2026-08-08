import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import {
  type ResidentLaunchVector,
  type ResidentServiceDefinition,
  type ResidentServiceDefinitionState,
  ResidentServiceError,
  type ResidentServiceManager,
  type ResidentServiceWriteResult,
} from "../../domain/resident-service";
import { fileSystemCauseDetails } from "../fs/cause";
import { launchdManagedMarker } from "./launchd-service";
import { systemdManagedMarker } from "./systemd-service";

export interface ResidentLaunchRuntime {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (
    path: string,
  ) => Promise<{ readonly isFile: () => boolean; readonly isDirectory: () => boolean }>;
}

const liveLaunchRuntime: ResidentLaunchRuntime = { realpath, stat };

const serviceError = (
  operation: string,
  reason: ConstructorParameters<typeof ResidentServiceError>[0]["reason"],
  path: string | undefined,
  message: string,
  cause?: unknown,
): ResidentServiceError => new ResidentServiceError({ operation, reason, path, message, cause });

const resolveRegularFile = (
  path: string,
  operation: string,
  runtime: ResidentLaunchRuntime,
): Effect.Effect<string, ResidentServiceError> =>
  Effect.tryPromise({
    try: async () => {
      const resolved = await runtime.realpath(path);
      if (!(await runtime.stat(resolved)).isFile())
        throw new Error(`${resolved} is not a regular file`);
      return resolved;
    },
    catch: (cause) =>
      serviceError(
        operation,
        "invalid-path",
        path,
        `could not resolve a stable regular file at ${path}`,
        cause,
      ),
  });

export interface ResidentLaunchInput {
  readonly executablePath: string;
  readonly mainPath: string;
  readonly profilePath: string;
}

export interface ResolvedResidentLaunch {
  readonly profilePath: string;
  readonly launchVector: ResidentLaunchVector;
}

export const resolveResidentLaunch = (
  input: ResidentLaunchInput,
  runtime: ResidentLaunchRuntime = liveLaunchRuntime,
): Effect.Effect<ResolvedResidentLaunch, ResidentServiceError> =>
  Effect.gen(function* () {
    const executable = yield* resolveRegularFile(
      input.executablePath,
      "resolve executable",
      runtime,
    );
    const profilePath = yield* Effect.tryPromise({
      try: async () => {
        const resolved = await runtime.realpath(input.profilePath);
        if (!(await runtime.stat(resolved)).isDirectory())
          throw new Error(`${resolved} is not a directory`);
        return resolved;
      },
      catch: (cause) =>
        serviceError(
          "resolve profile",
          "invalid-path",
          input.profilePath,
          `could not resolve a stable Profile directory at ${input.profilePath}`,
          cause,
        ),
    });
    const main = yield* resolveRegularFile(
      input.mainPath,
      "resolve source entrypoint",
      runtime,
    ).pipe(Effect.option);
    return {
      profilePath,
      launchVector:
        main._tag === "Some"
          ? [executable, main.value, "serve", profilePath]
          : [executable, "serve", profilePath],
    };
  });

export const detectResidentServiceManager = (
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<ResidentServiceManager, ResidentServiceError> => {
  if (platform === "darwin") return Effect.succeed("launchd");
  if (platform === "linux") return Effect.succeed("systemd");
  return Effect.fail(
    serviceError(
      "detect service manager",
      "unsupported-platform",
      undefined,
      `resident services are unsupported on ${platform}`,
    ),
  );
};

interface DefinitionObservation {
  readonly state: ResidentServiceDefinitionState;
  readonly content?: string;
  readonly device?: number;
  readonly inode?: number;
}

const managedMarker = (definition: ResidentServiceDefinition): string =>
  definition.manager === "launchd" ? launchdManagedMarker : systemdManagedMarker;

const installedFingerprint = (content: string): string | undefined => {
  const match =
    /Ziggy(?:DefinitionFingerprint|-(?:Definition-)?Fingerprint)(?:<\/key>\s*<string>|:\s*)([a-f0-9]{64})/u.exec(
      content,
    );
  return match?.[1];
};

const observeDefinition = (
  definition: ResidentServiceDefinition,
): Effect.Effect<DefinitionObservation, ResidentServiceError> =>
  Effect.tryPromise({
    try: async () => {
      let status;
      try {
        status = await lstat(definition.path);
      } catch (cause) {
        if (fileSystemCauseDetails(cause).code === "ENOENT") {
          return { state: { _tag: "not-installed" as const, path: definition.path } };
        }
        throw cause;
      }
      if (status.isSymbolicLink()) {
        return {
          state: { _tag: "refused" as const, path: definition.path, reason: "symlink" as const },
          device: status.dev,
          inode: status.ino,
        };
      }
      if (!status.isFile()) {
        return {
          state: {
            _tag: "refused" as const,
            path: definition.path,
            reason: "non-regular" as const,
          },
          device: status.dev,
          inode: status.ino,
        };
      }
      const handle = await open(definition.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      if (!content.includes(managedMarker(definition))) {
        return {
          state: { _tag: "refused" as const, path: definition.path, reason: "unmanaged" as const },
          content,
          device: status.dev,
          inode: status.ino,
        };
      }
      if (content === definition.content) {
        return {
          state: {
            _tag: "current" as const,
            path: definition.path,
            fingerprint: definition.fingerprint,
          },
          content,
          device: status.dev,
          inode: status.ino,
        };
      }
      return {
        state: {
          _tag: "drifted" as const,
          path: definition.path,
          expectedFingerprint: definition.fingerprint,
          installedFingerprint: installedFingerprint(content),
        },
        content,
        device: status.dev,
        inode: status.ino,
      };
    },
    catch: (cause) =>
      serviceError(
        "inspect definition",
        "filesystem",
        definition.path,
        `could not safely inspect resident service definition at ${definition.path}`,
        cause,
      ),
  });

export const inspectManagedDefinition = (
  definition: ResidentServiceDefinition,
): Effect.Effect<ResidentServiceDefinitionState, ResidentServiceError> =>
  observeDefinition(definition).pipe(Effect.map((observation) => observation.state));

const sameObservation = (left: DefinitionObservation, right: DefinitionObservation): boolean =>
  left.state._tag === right.state._tag &&
  left.content === right.content &&
  left.device === right.device &&
  left.inode === right.inode;

const policyFailure = (state: ResidentServiceDefinitionState): ResidentServiceError => {
  if (state._tag === "drifted") {
    return serviceError(
      "write definition",
      "definition-drift",
      state.path,
      `managed resident service definition has drifted at ${state.path}; use --force to replace it`,
    );
  }
  if (state._tag === "refused" && state.reason === "unmanaged") {
    return serviceError(
      "write definition",
      "unmanaged-definition",
      state.path,
      `refused to overwrite an unmanaged service definition at ${state.path}`,
    );
  }
  return serviceError(
    "write definition",
    "unsafe-definition",
    state.path,
    `refused to overwrite an unsafe service definition at ${state.path}`,
  );
};

export const writeManagedDefinition = (
  definition: ResidentServiceDefinition,
  options: { readonly force: boolean },
): Effect.Effect<ResidentServiceWriteResult, ResidentServiceError> =>
  Effect.gen(function* () {
    const initial = yield* observeDefinition(definition);
    if (initial.state._tag === "current") return "unchanged";
    if (initial.state._tag === "refused" || (initial.state._tag === "drifted" && !options.force)) {
      return yield* policyFailure(initial.state);
    }

    const directory = dirname(definition.path);
    const temporaryPath = `${definition.path}.${randomUUID()}.tmp`;
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) =>
        serviceError(
          "create definition directory",
          "filesystem",
          directory,
          `could not create ${directory}`,
          cause,
        ),
    });

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(temporaryPath, "wx", 0o600),
        catch: (cause) =>
          serviceError(
            "open temporary definition",
            "filesystem",
            temporaryPath,
            `could not create ${temporaryPath}`,
            cause,
          ),
      }),
      (handle) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              await handle.writeFile(definition.content, "utf8");
              await handle.sync();
              await handle.close();
            },
            catch: (cause) =>
              serviceError(
                "write definition",
                "filesystem",
                definition.path,
                `could not write ${definition.path}`,
                cause,
              ),
          });
          const current = yield* observeDefinition(definition);
          if (!sameObservation(initial, current)) {
            return yield* serviceError(
              "write definition",
              "unsafe-definition",
              definition.path,
              `resident service definition changed while preparing replacement at ${definition.path}`,
            );
          }
          yield* Effect.tryPromise({
            try: async () => {
              await rename(temporaryPath, definition.path);
              const directoryHandle = await open(directory, "r");
              try {
                await directoryHandle.sync();
              } finally {
                await directoryHandle.close();
              }
            },
            catch: (cause) =>
              serviceError(
                "replace definition",
                "filesystem",
                definition.path,
                `could not atomically replace ${definition.path}`,
                cause,
              ),
          });
          return initial.state._tag === "not-installed" ? "created" : "replaced";
        }),
      (handle) =>
        Effect.all(
          [
            Effect.tryPromise({ try: () => handle.close(), catch: (cause) => ({ cause }) }).pipe(
              Effect.catch((failure) =>
                Effect.logWarning("Resident service temporary handle cleanup failed", {
                  path: temporaryPath,
                  cause: failure.cause,
                }),
              ),
            ),
            Effect.tryPromise({ try: () => rm(temporaryPath), catch: (cause) => ({ cause }) }).pipe(
              Effect.catch((failure) =>
                fileSystemCauseDetails(failure.cause).code === "ENOENT"
                  ? Effect.void
                  : Effect.logWarning("Resident service temporary file cleanup failed", {
                      path: temporaryPath,
                      cause: failure.cause,
                    }),
              ),
            ),
          ],
          { discard: true },
        ),
    );
  });

export interface ResidentPlatformCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ResidentPlatformCommandRunner = (
  command: ResidentLaunchVector,
  signal: AbortSignal,
) => Promise<ResidentPlatformCommandResult>;

export const liveResidentPlatformCommandRunner: ResidentPlatformCommandRunner = async (
  command,
  signal,
) => {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export const makeResidentPlatformCommands = (runner: ResidentPlatformCommandRunner) => ({
  run: (
    command: ResidentLaunchVector,
  ): Effect.Effect<ResidentPlatformCommandResult, ResidentServiceError> =>
    Effect.tryPromise({
      try: (signal) => runner(command, signal),
      catch: (cause) =>
        serviceError(
          "run platform command",
          "command",
          command[0],
          `could not run resident service platform command ${command[0]}`,
          cause,
        ),
    }),
});

export type ResidentPlatformCommands = ReturnType<typeof makeResidentPlatformCommands>;
export const residentPlatformCommands = makeResidentPlatformCommands(
  liveResidentPlatformCommandRunner,
);
