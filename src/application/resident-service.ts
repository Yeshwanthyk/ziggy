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

/** A restart is ready only after a new owner has published its lease. */
export const residentReady = (
  supervisor: ResidentSupervisorStatus,
  observed: GatewayOwnerStatus | undefined,
  previous: GatewayOwnerStatus | undefined,
  mode: "running" | "stopped",
): boolean => {
  if (supervisor.state !== mode || observed?._tag !== mode) return false;

  if (
    mode === "running" &&
    supervisor.state === "running" &&
    supervisor.pid !== undefined &&
    observed?._tag === "running" &&
    supervisor.pid !== observed.pid
  )
    return false;

  if (mode === "stopped" || previous === undefined) return true;

  return (
    previous._tag !== "running" ||
    (observed._tag === "running" &&
      (observed.pid !== previous.pid || observed.acquiredAt !== previous.acquiredAt))
  );
};
