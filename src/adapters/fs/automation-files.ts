import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AutomationFileSystemError,
  AutomationNotFound,
  AutomationProjectionError,
  type AutomationId,
} from "../../domain/automation";
import type { ProfileTarget } from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

export interface AutomationSourceObservation {
  readonly idSource: string;
  readonly path: string;
  readonly source: string | null;
  readonly error: string | null;
}

export interface AutomationSourceRuntime {
  readonly afterRead: (path: string) => Effect.Effect<void>;
}

const missing = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";
const liveAutomationSourceRuntime: AutomationSourceRuntime = { afterRead: () => Effect.void };

export const discoverAutomationSources = (
  target: ProfileTarget,
  runtime: AutomationSourceRuntime = liveAutomationSourceRuntime,
): Effect.Effect<ReadonlyArray<AutomationSourceObservation>, AutomationProjectionError> => {
  const directory = join(target.path, "automations");
  return Effect.tryPromise({
    try: () => readdir(directory, { withFileTypes: true }),
    catch: (cause) =>
      new AutomationProjectionError({
        operation: "list definitions",
        path: directory,
        message: `could not list automation definitions at ${directory}`,
        cause,
      }),
  }).pipe(
    Effect.catch((failure) => (missing(failure.cause) ? Effect.succeed([]) : Effect.fail(failure))),
    Effect.map((items) =>
      items
        .filter((item) => item.name.endsWith(".md"))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
    Effect.flatMap((items) =>
      Effect.forEach(items, (entry) => {
        const path = join(directory, entry.name);
        const idSource = entry.name.slice(0, -3);
        if (entry.isSymbolicLink() || !entry.isFile()) {
          return Effect.succeed({
            idSource,
            path,
            source: null,
            error: `automation ${idSource} is not a physical file at ${path}`,
          });
        }
        return Effect.tryPromise({
          try: (signal) => readFile(path, { encoding: "utf8", signal }),
          catch: () => undefined,
        }).pipe(
          Effect.match({
            onFailure: (): AutomationSourceObservation => ({
              idSource,
              path,
              source: null,
              error: `could not read automation ${idSource} at ${path}`,
            }),
            onSuccess: (source): AutomationSourceObservation => ({
              idSource,
              path,
              source,
              error: null,
            }),
          }),
          Effect.tap(() => runtime.afterRead(path)),
        );
      }),
    ),
  );
};

export const automationDefinitionTemplate = (id: string): string =>
  `---\nversion: 1\ncron: 0 9 * * *\ntimezone: UTC\nbroadcast: none\n---\n\nDescribe the manual ${id} task here.\n`;

export const createAutomationDefinition = (
  target: ProfileTarget,
  id: AutomationId,
): Effect.Effect<AutomationDefinitionSource, AutomationFileSystemError> => {
  const directory = join(target.path, "automations");
  const path = join(directory, `${id}.md`);
  const source = automationDefinitionTemplate(id);
  return Effect.tryPromise({
    try: async () => {
      const profileStatus = await lstat(target.path);
      if (profileStatus.isSymbolicLink() || !profileStatus.isDirectory()) {
        throw new Error("Profile root must be a physical directory");
      }
      await mkdir(directory, { recursive: true });
      const status = await lstat(directory);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error("Profile automations root must be a physical directory");
      }
      await writeFile(path, source, { encoding: "utf8", flag: "wx" });
      return { path, source };
    },
    catch: (cause) =>
      new AutomationFileSystemError({
        path,
        message: `could not exclusively create automation ${id} at ${path}`,
        cause,
      }),
  });
};

export interface AutomationDefinitionSource {
  readonly path: string;
  readonly source: string;
}

export interface AutomationFileStore {
  readonly readDefinition: (
    target: ProfileTarget,
    id: AutomationId,
  ) => Effect.Effect<AutomationDefinitionSource, AutomationNotFound | AutomationFileSystemError>;
  readonly readBroadcasts: (
    target: ProfileTarget,
  ) => Effect.Effect<string | undefined, AutomationFileSystemError>;
}

export const automationFileStore: AutomationFileStore = {
  readDefinition: (target, id) => {
    const path = join(target.path, "automations", `${id}.md`);
    return Effect.tryPromise({
      try: (signal) => readFile(path, { encoding: "utf8", signal }),
      catch: (cause) =>
        fileSystemCauseDetails(cause).code === "ENOENT"
          ? new AutomationNotFound({
              id,
              path,
              message: `no automation ${id} at ${path}`,
            })
          : new AutomationFileSystemError({
              path,
              message: `could not read automation ${id} at ${path}`,
              cause,
            }),
    }).pipe(Effect.map((source) => ({ path, source })));
  },
  readBroadcasts: (target) => {
    const path = join(target.path, "broadcasts.json");
    return Effect.tryPromise({
      try: (signal) => readFile(path, { encoding: "utf8", signal }),
      catch: (cause) =>
        new AutomationFileSystemError({
          path,
          message: `could not read automation broadcasts at ${path}`,
          cause,
        }),
    }).pipe(
      Effect.catch((failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(failure),
      ),
    );
  },
};
