import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AutomationFileSystemError,
  AutomationInvalid,
  AutomationNotFound,
  AutomationPaused,
  AutomationProjectionError,
  type AutomationId,
} from "../../domain/automation";
import type { ProfileTarget } from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

export type AutomationLifecycle = "active" | "paused";

export interface AutomationSourceObservation {
  readonly idSource: string;
  readonly lifecycle: AutomationLifecycle | "conflict";
  readonly path: string;
  readonly source: string | null;
  readonly error: string | null;
}

export interface AutomationSourceRuntime {
  readonly afterRead: (path: string) => Effect.Effect<void>;
}

const missing = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";
const exists = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "EEXIST";
const liveAutomationSourceRuntime: AutomationSourceRuntime = { afterRead: () => Effect.void };

const physicalDirectory = async (path: string): Promise<void> => {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${path} must be a physical directory`);
  }
};

const readPhysicalFilePromise = async (path: string, signal?: AbortSignal): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile({ encoding: "utf8", signal });
  } finally {
    await handle.close();
  }
};

interface PhysicalReadError {
  readonly _tag: "PhysicalReadError";
  readonly cause: unknown;
}
const physicalReadError = (cause: unknown): PhysicalReadError => ({
  _tag: "PhysicalReadError",
  cause,
});
const readPhysicalFile = (path: string) =>
  Effect.tryPromise({
    try: (signal) => readPhysicalFilePromise(path, signal),
    catch: physicalReadError,
  });

const sourceName = (
  name: string,
): { readonly idSource: string; readonly lifecycle: AutomationLifecycle } | undefined => {
  if (name.endsWith(".paused.md")) {
    return { idSource: name.slice(0, -10), lifecycle: "paused" };
  }
  return name.endsWith(".md") ? { idSource: name.slice(0, -3), lifecycle: "active" } : undefined;
};

export const discoverAutomationSources = (
  target: ProfileTarget,
  runtime: AutomationSourceRuntime = liveAutomationSourceRuntime,
): Effect.Effect<ReadonlyArray<AutomationSourceObservation>, AutomationProjectionError> => {
  const directory = join(target.path, "automations");
  return Effect.tryPromise({
    try: async () => {
      await physicalDirectory(target.path);
      await physicalDirectory(directory);
      return readdir(directory, { withFileTypes: true });
    },
    catch: (cause) =>
      new AutomationProjectionError({
        operation: "list definitions",
        path: directory,
        message: `could not safely list automation definitions at ${directory}`,
        cause,
      }),
  }).pipe(
    Effect.catch((failure) => (missing(failure.cause) ? Effect.succeed([]) : Effect.fail(failure))),
    Effect.map((items) =>
      items
        .flatMap((entry) => {
          const parsed = sourceName(entry.name);
          return parsed === undefined ? [] : [{ entry, ...parsed }];
        })
        .sort((left, right) => left.entry.name.localeCompare(right.entry.name)),
    ),
    Effect.flatMap((items) => {
      const grouped = new Map<string, typeof items>();
      for (const item of items)
        grouped.set(item.idSource, [...(grouped.get(item.idSource) ?? []), item]);
      return Effect.forEach(
        [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ([idSource, forms]) => {
          const active = forms.find((form) => form.lifecycle === "active");
          const paused = forms.find((form) => form.lifecycle === "paused");
          if (active !== undefined && paused !== undefined) {
            const activePath = join(directory, active.entry.name);
            const pausedPath = join(directory, paused.entry.name);
            return Effect.succeed({
              idSource,
              lifecycle: "conflict" as const,
              path: activePath,
              source: null,
              error: `automation ${idSource} has conflicting active and paused definitions at ${activePath} and ${pausedPath}; remove exactly one form after verifying their bytes`,
            });
          }
          const form = forms[0];
          if (form === undefined) {
            return Effect.fail(
              new AutomationProjectionError({
                operation: "list definitions",
                path: directory,
                message: `automation discovery produced an empty group for ${idSource}`,
                cause: "empty-automation-discovery-group",
              }),
            );
          }
          const path = join(directory, form.entry.name);
          if (form.entry.isSymbolicLink() || !form.entry.isFile()) {
            return Effect.succeed({
              idSource,
              lifecycle: form.lifecycle,
              path,
              source: null,
              error: `automation ${idSource} is not a physical file at ${path}`,
            });
          }
          return readPhysicalFile(path).pipe(
            Effect.match({
              onFailure: (): AutomationSourceObservation => ({
                idSource,
                lifecycle: form.lifecycle,
                path,
                source: null,
                error: `could not safely read automation ${idSource} at ${path}`,
              }),
              onSuccess: (source): AutomationSourceObservation => ({
                idSource,
                lifecycle: form.lifecycle,
                path,
                source,
                error: null,
              }),
            }),
            Effect.tap(() => runtime.afterRead(path)),
          );
        },
        { concurrency: 1 },
      );
    }),
  );
};

export const automationDefinitionTemplate = (id: string): string =>
  `---\nversion: 1\ncron: 0 9 * * *\ntimezone: UTC\nbroadcast: none\n---\n\nDescribe the manual ${id} task here.\n`;

export interface AutomationDefinitionSource {
  readonly path: string;
  readonly source: string;
  readonly lifecycle: AutomationLifecycle;
}

export const createAutomationDefinition = (
  target: ProfileTarget,
  id: AutomationId,
): Effect.Effect<AutomationDefinitionSource, AutomationFileSystemError> => {
  const directory = join(target.path, "automations");
  const path = join(directory, `${id}.md`);
  const pausedPath = join(directory, `${id}.paused.md`);
  const source = automationDefinitionTemplate(id);
  return Effect.tryPromise({
    try: async () => {
      await physicalDirectory(target.path);
      await mkdir(directory, { recursive: true });
      await physicalDirectory(directory);
      try {
        await lstat(pausedPath);
        throw new Error(`paused automation ${id} already exists at ${pausedPath}`);
      } catch (cause) {
        if (!missing(cause)) throw cause;
      }
      await writeFile(path, source, { encoding: "utf8", flag: "wx" });
      return { path, source, lifecycle: "active" as const };
    },
    catch: (cause) =>
      new AutomationFileSystemError({
        path,
        message: `could not exclusively create automation ${id} at ${path}; neither active nor paused form may already exist`,
        cause,
      }),
  });
};

export interface AutomationDefinitionTransition {
  readonly path: string;
  readonly lifecycle: AutomationLifecycle;
}

export interface AutomationTransitionRuntime {
  readonly removeSource: (path: string) => Effect.Effect<void, unknown>;
}
const liveAutomationTransitionRuntime: AutomationTransitionRuntime = {
  removeSource: (path) =>
    Effect.tryPromise({
      try: () => unlink(path),
      catch: physicalReadError,
    }),
};

const transition = (
  target: ProfileTarget,
  id: AutomationId,
  from: AutomationLifecycle,
  runtime: AutomationTransitionRuntime,
): Effect.Effect<
  AutomationDefinitionTransition,
  AutomationFileSystemError | AutomationNotFound | AutomationPaused
> => {
  const directory = join(target.path, "automations");
  const activePath = join(directory, `${id}.md`);
  const pausedPath = join(directory, `${id}.paused.md`);
  const sourcePath = from === "active" ? activePath : pausedPath;
  const destinationPath = from === "active" ? pausedPath : activePath;
  const destinationLifecycle = from === "active" ? "paused" : "active";
  const transitionFailure = (cause: unknown) => {
    if (missing(cause)) {
      return from === "active"
        ? new AutomationNotFound({
            id,
            path: sourcePath,
            message: `no active automation ${id} at ${sourcePath}`,
          })
        : new AutomationPaused({
            id,
            path: sourcePath,
            message: `automation ${id} is not paused at ${sourcePath}`,
          });
    }
    return new AutomationFileSystemError({
      path: destinationPath,
      message: exists(cause)
        ? `refused to ${from === "active" ? "pause" : "resume"} automation ${id}: destination already exists at ${destinationPath}`
        : `could not ${from === "active" ? "pause" : "resume"} automation ${id} from ${sourcePath} to ${destinationPath}; if both forms are visible, resolve the conflict manually after verifying their bytes`,
      cause,
    });
  };
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await physicalDirectory(target.path);
        await physicalDirectory(directory);
        const sourceStatus = await lstat(sourcePath);
        if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
          throw new Error(`${sourcePath} must be a physical file`);
        }
        await link(sourcePath, destinationPath);
        const [stillSource, destination] = await Promise.all([
          lstat(sourcePath),
          lstat(destinationPath),
        ]);
        if (
          stillSource.isSymbolicLink() ||
          !stillSource.isFile() ||
          destination.isSymbolicLink() ||
          !destination.isFile() ||
          stillSource.dev !== destination.dev ||
          stillSource.ino !== destination.ino
        ) {
          throw new Error(
            "automation transition did not produce two names for the same physical file",
          );
        }
      },
      catch: transitionFailure,
    });
    yield* runtime.removeSource(sourcePath).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationFileSystemError({
            path: sourcePath,
            message: `could not remove the source name while ${from === "active" ? "pausing" : "resuming"} automation ${id}; both forms remain visible and discovery will reject the conflict`,
            cause,
          }),
      ),
    );
    return { path: destinationPath, lifecycle: destinationLifecycle };
  });
};

export const pauseAutomationDefinition = (
  target: ProfileTarget,
  id: AutomationId,
  runtime: AutomationTransitionRuntime = liveAutomationTransitionRuntime,
) => transition(target, id, "active", runtime);
export const resumeAutomationDefinition = (
  target: ProfileTarget,
  id: AutomationId,
  runtime: AutomationTransitionRuntime = liveAutomationTransitionRuntime,
) => transition(target, id, "paused", runtime);

export interface AutomationFileStore {
  readonly readDefinition: (
    target: ProfileTarget,
    id: AutomationId,
    allowPaused?: boolean,
  ) => Effect.Effect<
    AutomationDefinitionSource,
    AutomationNotFound | AutomationPaused | AutomationInvalid | AutomationFileSystemError
  >;
  readonly readBroadcasts: (
    target: ProfileTarget,
  ) => Effect.Effect<string | undefined, AutomationFileSystemError>;
}

export const automationFileStore: AutomationFileStore = {
  readDefinition: (target, id, allowPaused = false) => {
    const activePath = join(target.path, "automations", `${id}.md`);
    const pausedPath = join(target.path, "automations", `${id}.paused.md`);
    return Effect.tryPromise({
      try: async () => {
        await physicalDirectory(target.path);
        await physicalDirectory(join(target.path, "automations"));
        const inspectOptional = async (path: string) => {
          try {
            return await lstat(path);
          } catch (cause) {
            if (missing(cause)) return undefined;
            throw cause;
          }
        };
        const [active, paused] = await Promise.all([
          inspectOptional(activePath),
          inspectOptional(pausedPath),
        ]);
        if (active !== undefined && paused !== undefined) {
          throw new AutomationInvalid({
            path: activePath,
            message: `automation ${id} has conflicting active and paused definitions; remove exactly one form after verifying their bytes`,
            cause: "active-paused-conflict",
          });
        }
        const selected = active ?? (allowPaused ? paused : undefined);
        const path = active !== undefined ? activePath : pausedPath;
        if (selected === undefined) {
          if (paused !== undefined) {
            throw new AutomationPaused({
              id,
              path: pausedPath,
              message: `automation ${id} is paused at ${pausedPath}`,
            });
          }
          throw new AutomationNotFound({
            id,
            path: activePath,
            message: `no automation ${id} at ${activePath}`,
          });
        }
        if (selected.isSymbolicLink() || !selected.isFile())
          throw new Error(`${path} must be a physical file`);
        const source = await readPhysicalFilePromise(path);
        return {
          path,
          source,
          lifecycle: active !== undefined ? ("active" as const) : ("paused" as const),
        };
      },
      catch: (cause) => {
        if (
          cause instanceof AutomationInvalid ||
          cause instanceof AutomationPaused ||
          cause instanceof AutomationNotFound
        )
          return cause;
        return new AutomationFileSystemError({
          path: activePath,
          message: `could not safely read automation ${id}`,
          cause,
        });
      },
    });
  },
  readBroadcasts: (target) => {
    const path = join(target.path, "broadcasts.json");
    return readPhysicalFile(path).pipe(
      Effect.catch((failure) =>
        missing(failure.cause)
          ? Effect.succeed(undefined)
          : Effect.fail(
              new AutomationFileSystemError({
                path,
                message: `could not safely read automation broadcasts at ${path}`,
                cause: failure.cause,
              }),
            ),
      ),
    );
  },
};
