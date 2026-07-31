import { Effect, Schema } from "effect";
import type { ProfileTarget } from "./profile";

export type AutomationServicePlatform = "darwin" | "linux";

export interface SchedulerCommand {
  readonly executable: string;
  readonly arguments: readonly [scriptPath: string, command: "scheduler", profilePath: string];
}

export interface SchedulerHealthStatus {
  readonly fresh: boolean;
  readonly heartbeatAt?: string;
}

export interface AutomationServiceStatus {
  readonly backend: "launchd" | "systemd-user";
  readonly id: string;
  readonly artifactPath: string;
  readonly installed: boolean;
  readonly hostActive: boolean;
  readonly healthFresh: boolean;
  readonly heartbeatAt?: string;
  readonly linger?: "enabled" | "disabled" | "unknown";
  readonly diagnostics: ReadonlyArray<string>;
}

export interface AutomationServiceChange {
  readonly backend: AutomationServiceStatus["backend"];
  readonly id: string;
  readonly artifactPath: string;
  readonly changed: boolean;
}

export class AutomationServiceUnsupportedPlatform extends Schema.TaggedErrorClass<AutomationServiceUnsupportedPlatform>()(
  "AutomationServiceUnsupportedPlatform",
  {
    platform: Schema.String,
    message: Schema.String,
  },
) {}

export class AutomationServiceCommandError extends Schema.TaggedErrorClass<AutomationServiceCommandError>()(
  "AutomationServiceCommandError",
  {
    operation: Schema.String,
    command: Schema.Array(Schema.String),
    exitCode: Schema.optional(Schema.Finite),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AutomationServiceFileSystemError extends Schema.TaggedErrorClass<AutomationServiceFileSystemError>()(
  "AutomationServiceFileSystemError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type AutomationServiceError =
  | AutomationServiceUnsupportedPlatform
  | AutomationServiceCommandError
  | AutomationServiceFileSystemError;

export interface AutomationServiceBackend {
  readonly install: (
    target: ProfileTarget,
    command: SchedulerCommand,
  ) => Effect.Effect<AutomationServiceChange, AutomationServiceError>;
  readonly status: (
    target: ProfileTarget,
    health: SchedulerHealthStatus,
  ) => Effect.Effect<AutomationServiceStatus, AutomationServiceError>;
  readonly uninstall: (
    target: ProfileTarget,
  ) => Effect.Effect<AutomationServiceChange, AutomationServiceError>;
}
