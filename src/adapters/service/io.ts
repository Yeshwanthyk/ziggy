import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  AutomationServiceCommandError,
  AutomationServiceFileSystemError,
} from "../../domain/automation-service";
import { fileSystemCauseDetails } from "../fs/cause";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServiceCommandRunner {
  readonly run: (
    command: string,
    arguments_: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, AutomationServiceCommandError>;
}

export interface ServiceFileSystem {
  readonly readOptional: (
    path: string,
  ) => Effect.Effect<string | undefined, AutomationServiceFileSystemError>;
  readonly writeAtomic: (
    path: string,
    content: string,
  ) => Effect.Effect<void, AutomationServiceFileSystemError>;
  readonly remove: (path: string) => Effect.Effect<boolean, AutomationServiceFileSystemError>;
}

export const liveServiceCommandRunner: ServiceCommandRunner = {
  run: (command, arguments_) =>
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () =>
          Bun.spawn([command, ...arguments_], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        catch: (cause) =>
          new AutomationServiceCommandError({
            operation: "spawn",
            command: [command, ...arguments_],
            message: `could not spawn ${command}`,
            cause,
          }),
      });
      return yield* Effect.tryPromise({
        try: async () => {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        },
        catch: (cause) =>
          new AutomationServiceCommandError({
            operation: "wait",
            command: [command, ...arguments_],
            message: `could not collect ${command} output`,
            cause,
          }),
      });
    }),
};

export const liveServiceFileSystem: ServiceFileSystem = {
  readOptional: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        new AutomationServiceFileSystemError({
          operation: "read",
          path,
          message: `could not read ${path}`,
          cause,
        }),
    }).pipe(
      Effect.catchTag("AutomationServiceFileSystemError", (failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(failure),
      ),
    ),
  writeAtomic: (path, content) =>
    Effect.gen(function* () {
      const directory = dirname(path);
      const temporaryPath = join(directory, `.${crypto.randomUUID()}.service.tmp`);
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true }),
        catch: (cause) =>
          new AutomationServiceFileSystemError({
            operation: "mkdir",
            path: directory,
            message: `could not create ${directory}`,
            cause,
          }),
      });
      yield* Effect.tryPromise({
        try: () => writeFile(temporaryPath, content, { mode: 0o600 }),
        catch: (cause) =>
          new AutomationServiceFileSystemError({
            operation: "write",
            path: temporaryPath,
            message: `could not write ${temporaryPath}`,
            cause,
          }),
      });
      yield* Effect.tryPromise({
        try: () => rename(temporaryPath, path),
        catch: (cause) =>
          new AutomationServiceFileSystemError({
            operation: "rename",
            path,
            message: `could not replace ${path}`,
            cause,
          }),
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => rm(temporaryPath, { force: true }),
            catch: (cause) =>
              new AutomationServiceFileSystemError({
                operation: "cleanup",
                path: temporaryPath,
                message: `could not clean up ${temporaryPath}`,
                cause,
              }),
          }).pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                console.error(failure.message);
              }),
            ),
          ),
        ),
      );
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => rm(path).then(() => true),
      catch: (cause) =>
        new AutomationServiceFileSystemError({
          operation: "remove",
          path,
          message: `could not remove ${path}`,
          cause,
        }),
    }).pipe(
      Effect.catchTag("AutomationServiceFileSystemError", (failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed(false)
          : Effect.fail(failure),
      ),
    ),
};

export const requireCommandSuccess = (
  operation: string,
  command: string,
  arguments_: ReadonlyArray<string>,
  result: CommandResult,
): Effect.Effect<void, AutomationServiceCommandError> =>
  result.exitCode === 0
    ? Effect.void
    : Effect.fail(
        new AutomationServiceCommandError({
          operation,
          command: [command, ...arguments_],
          exitCode: result.exitCode,
          message: `${operation} failed with exit code ${result.exitCode}`,
          cause: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
        }),
      );
