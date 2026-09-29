import { Context, Effect, Layer, Result } from "effect";
import type { ProfileNotInitialized } from "../domain/agent";
import type { AutomationProjectionError, AutomationStatusProjection } from "../domain/automation";
import type { GatewayConfigError, GatewayOwnerError, GatewayOwnerStatus } from "../domain/gateway";
import type {
  DiscordHealthProjection,
  DiscordHealthProjectionError,
} from "../domain/discord-health";
import type { SlackHealthProjection, SlackHealthProjectionError } from "../domain/slack-health";
import type { ProfileTarget } from "../domain/profile";
import {
  type ResidentServiceDefinition,
  type ResidentServiceDefinitionState,
  ResidentServiceError,
  type ResidentServiceManager,
  type ResidentServiceWriteResult,
} from "../domain/resident-service";

export type ResidentSupervisorStatus =
  | { readonly state: "running"; readonly pid?: number }
  | { readonly state: "stopped" | "failed" | "unknown"; readonly reason?: string };

export interface ResidentServiceStatus {
  readonly profilePath: string;
  readonly manager: ResidentServiceManager | "unsupported";
  readonly managed: Result.Result<ResidentServiceDefinitionState, ResidentServiceError>;
  readonly supervisor: Result.Result<ResidentSupervisorStatus, ResidentServiceError>;
  readonly process: Result.Result<GatewayOwnerStatus, GatewayOwnerError>;
  readonly scheduler: Result.Result<AutomationStatusProjection, AutomationProjectionError>;
  readonly discord: Result.Result<DiscordHealthProjection, DiscordHealthProjectionError>;
  readonly slack: Result.Result<SlackHealthProjection, SlackHealthProjectionError>;
}

export interface ResidentLifecycleResult {
  readonly action: "install" | "start" | "stop" | "restart" | "uninstall";
  readonly manager: ResidentServiceManager;
  readonly identity: string;
  readonly definitionPath: string;
  readonly write?: ResidentServiceWriteResult;
  readonly removed?: boolean;
  readonly ready?: boolean;
  readonly owner?: GatewayOwnerStatus;
  readonly warnings: ReadonlyArray<string>;
}

export interface ResidentLogsResult {
  readonly manager: ResidentServiceManager;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ResidentServiceApi {
  readonly install: (
    target: ProfileTarget,
    options: { readonly force: boolean; readonly start: boolean },
  ) => Effect.Effect<
    ResidentLifecycleResult,
    ResidentServiceError | ProfileNotInitialized | GatewayConfigError
  >;
  readonly start: (
    target: ProfileTarget,
  ) => Effect.Effect<
    ResidentLifecycleResult,
    ResidentServiceError | ProfileNotInitialized | GatewayConfigError
  >;
  readonly stop: (
    target: ProfileTarget,
  ) => Effect.Effect<ResidentLifecycleResult, ResidentServiceError>;
  readonly restart: (
    target: ProfileTarget,
  ) => Effect.Effect<
    ResidentLifecycleResult,
    ResidentServiceError | ProfileNotInitialized | GatewayConfigError
  >;
  readonly uninstall: (
    target: ProfileTarget,
  ) => Effect.Effect<ResidentLifecycleResult, ResidentServiceError>;
  readonly logs: (
    target: ProfileTarget,
    follow: boolean,
  ) => Effect.Effect<ResidentLogsResult, ResidentServiceError>;
  readonly status: (target: ProfileTarget) => Effect.Effect<ResidentServiceStatus>;
}

export class ResidentService extends Context.Service<ResidentService, ResidentServiceApi>()(
  "ziggy/ResidentService",
) {}

export class ResidentServiceOperations extends Context.Service<
  ResidentServiceOperations,
  ResidentServiceApi
>()("ziggy/ResidentServiceOperations") {}

export const ResidentServiceLive = Layer.effect(ResidentService, ResidentServiceOperations);

export const managerFor = (
  platform: NodeJS.Platform,
): Effect.Effect<ResidentServiceManager, ResidentServiceError> =>
  platform === "darwin"
    ? Effect.succeed("launchd")
    : platform === "linux"
      ? Effect.succeed("systemd")
      : Effect.fail(
          new ResidentServiceError({
            operation: "detect service manager",
            reason: "unsupported-platform",
            path: undefined,
            message: `resident services are unsupported on ${platform}`,
            cause: undefined,
          }),
        );

export const commandFailure = (
  operation: string,
  definition: ResidentServiceDefinition,
  result: { readonly exitCode: number; readonly stderr: string },
): ResidentServiceError =>
  new ResidentServiceError({
    operation,
    reason: "command",
    path: definition.path,
    message: `${operation} failed for ${definition.identity.key} (exit ${result.exitCode})${result.stderr.trim().length === 0 ? "" : `: ${result.stderr.trim().slice(0, 160)}`}`,
    cause: undefined,
  });

export const launchdSupervisorStatus = (result: {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}): ResidentSupervisorStatus => {
  if (result.exitCode !== 0)
    return /Could not find service\b/u.test(result.stderr)
      ? { state: "stopped" }
      : { state: "unknown", reason: `launchctl print exited ${result.exitCode}` };

  return /\bstate\s*=\s*running\b/u.test(result.stdout)
    ? { state: "running" }
    : { state: "stopped" };
};

export const systemdSupervisorStatus = (
  active: { readonly exitCode: number; readonly stdout: string },
  pidResult?: { readonly exitCode: number; readonly stdout: string },
): ResidentSupervisorStatus => {
  const state = active.stdout.trim();

  if (state === "failed") return { state: "failed" };

  if (state !== "active")
    return state === "inactive" || state === "deactivating"
      ? { state: "stopped" }
      : {
          state: "unknown",
          reason: `systemctl is-active reported ${state || `exit ${active.exitCode}`}`,
        };

  const pid = Number(pidResult?.stdout.trim());

  return pidResult?.exitCode === 0 && Number.isSafeInteger(pid) && pid > 0
    ? { state: "running", pid }
    : { state: "running" };
};

/** A restart is ready only after a new owner has published its lease. */
export const residentReady = (
  supervisor: ResidentSupervisorStatus,
  observed: GatewayOwnerStatus | undefined,
  previous: GatewayOwnerStatus | undefined,
  mode: "running" | "stopped",
): boolean => {
  if (supervisor.state !== mode || observed?._tag !== mode) return false;

  if (mode === "stopped" || previous === undefined) return true;

  return (
    previous._tag !== "running" ||
    (observed._tag === "running" &&
      (observed.pid !== previous.pid || observed.acquiredAt !== previous.acquiredAt))
  );
};
