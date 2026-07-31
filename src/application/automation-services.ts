import { Context, Effect, Layer } from "effect";
import {
  type AutomationServiceChange,
  type AutomationServiceError,
  type AutomationServicePlatform,
  type AutomationServiceStatus,
  AutomationServiceUnsupportedPlatform,
  type SchedulerCommand,
  type SchedulerHealthStatus,
} from "../domain/automation-service";
import type { ProfileTarget } from "../domain/profile";
import { makeLaunchdBackend } from "../adapters/service/launchd";
import { makeSystemdUserBackend } from "../adapters/service/systemd-user";
import {
  liveServiceCommandRunner,
  liveServiceFileSystem,
  type ServiceCommandRunner,
  type ServiceFileSystem,
} from "../adapters/service/io";

export interface SchedulerHealthReader {
  readonly read: (
    target: ProfileTarget,
  ) => Effect.Effect<SchedulerHealthStatus, AutomationServiceError>;
}

export interface AutomationServicesShape {
  readonly install: (
    target: ProfileTarget,
  ) => Effect.Effect<AutomationServiceChange, AutomationServiceError>;
  readonly status: (
    target: ProfileTarget,
  ) => Effect.Effect<AutomationServiceStatus, AutomationServiceError>;
  readonly uninstall: (
    target: ProfileTarget,
  ) => Effect.Effect<AutomationServiceChange, AutomationServiceError>;
}

export class AutomationServices extends Context.Service<
  AutomationServices,
  AutomationServicesShape
>()("ziggy/AutomationServices") {}

export interface AutomationServicesOptions {
  readonly platform: string;
  readonly homedir: string;
  readonly uid: number;
  readonly userName: string;
  readonly bunPath: string;
  readonly scriptPath: string;
  readonly health: SchedulerHealthReader;
  readonly commands?: ServiceCommandRunner;
  readonly fileSystem?: ServiceFileSystem;
}

const schedulerCommand = (
  options: AutomationServicesOptions,
  target: ProfileTarget,
): SchedulerCommand => ({
  executable: options.bunPath,
  arguments: [options.scriptPath, "scheduler", target.path],
});

export const makeAutomationServices = (
  options: AutomationServicesOptions,
): AutomationServicesShape => {
  const commands = options.commands ?? liveServiceCommandRunner;
  const fileSystem = options.fileSystem ?? liveServiceFileSystem;
  const backend =
    options.platform === "darwin"
      ? makeLaunchdBackend({
          homedir: options.homedir,
          uid: options.uid,
          commands,
          fileSystem,
        })
      : options.platform === "linux"
        ? makeSystemdUserBackend({
            homedir: options.homedir,
            userName: options.userName,
            commands,
            fileSystem,
          })
        : undefined;

  const unsupported = () =>
    Effect.fail(
      new AutomationServiceUnsupportedPlatform({
        platform: options.platform,
        message: `scheduler services are unsupported on ${options.platform}`,
      }),
    );

  return {
    install: (target) =>
      backend === undefined
        ? unsupported()
        : backend.install(target, schedulerCommand(options, target)),
    status: (target) =>
      backend === undefined
        ? unsupported()
        : options.health
            .read(target)
            .pipe(Effect.flatMap((health) => backend.status(target, health))),
    uninstall: (target) => (backend === undefined ? unsupported() : backend.uninstall(target)),
  };
};

export const makeAutomationServicesLive = (
  options: AutomationServicesOptions,
): Layer.Layer<AutomationServices> =>
  Layer.succeed(AutomationServices, makeAutomationServices(options));

export const supportedAutomationServicePlatform = (
  platform: string,
): platform is AutomationServicePlatform => platform === "darwin" || platform === "linux";
