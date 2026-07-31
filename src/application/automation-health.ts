import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import {
  AutomationServiceFileSystemError,
  type SchedulerHealthStatus,
} from "../domain/automation-service";
import type { ProfileTarget } from "../domain/profile";

const SchedulerHealthSchema = Schema.Struct({
  heartbeatAt: Schema.String,
  lastSuccessAt: Schema.optional(Schema.String),
  lastErrorAt: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  stoppedAt: Schema.optional(Schema.String),
});

export type SchedulerHealth = typeof SchedulerHealthSchema.Type;

const decodeHealth = Schema.decodeUnknownEffect(Schema.fromJsonString(SchedulerHealthSchema));

export const readAutomationSchedulerHealth = (
  target: ProfileTarget,
): Effect.Effect<SchedulerHealth | undefined, AutomationServiceFileSystemError> => {
  const path = join(target.path, ".runtime", "automations", "scheduler-health.json");
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new AutomationServiceFileSystemError({
        operation: "read scheduler health",
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
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed(undefined)
        : decodeHealth(source).pipe(
            Effect.mapError(
              (cause) =>
                new AutomationServiceFileSystemError({
                  operation: "decode scheduler health",
                  path,
                  message: `invalid scheduler health at ${path}`,
                  cause,
                }),
            ),
          ),
    ),
  );
};

export const schedulerHealthStatus = (
  target: ProfileTarget,
  now: Date = new Date(),
): Effect.Effect<SchedulerHealthStatus, AutomationServiceFileSystemError> =>
  readAutomationSchedulerHealth(target).pipe(
    Effect.map((health) => {
      if (health === undefined) return { fresh: false };
      return {
        fresh:
          health.stoppedAt === undefined &&
          now.getTime() - Date.parse(health.heartbeatAt) <= 30_000,
        heartbeatAt: health.heartbeatAt,
      };
    }),
  );
