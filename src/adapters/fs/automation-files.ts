import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AutomationFileSystemError,
  AutomationNotFound,
  type AutomationId,
} from "../../domain/automation";
import type { ProfileTarget } from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

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
