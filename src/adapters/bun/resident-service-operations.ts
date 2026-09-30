import { userInfo } from "node:os";
import { dirname } from "node:path";
import { Duration, Effect, Layer, Result } from "effect";
import {
  ensureResidentServiceDirectory,
  inspectManagedDefinition,
  removeManagedDefinition,
  residentPlatformCommands,
  resolveResidentLaunch,
  writeManagedDefinition,
  type ResidentPlatformCommands,
} from "./resident-service";
import {
  launchdBootoutCommand,
  launchdBootstrapCommand,
  launchdKickstartCommand,
  launchdLogPaths,
  launchdLogsCommand,
  launchdStatusCommand,
  renderLaunchdService,
} from "./launchd-service";
import {
  renderSystemdService,
  systemdCommand,
  systemdLingerCommand,
  systemdLogsCommand,
  systemdMainPidCommand,
} from "./systemd-service";
import { ZiggyPaths, type ZiggyPathsApi } from "../../platform/paths";
import { validateGatewayProfile } from "../fs/gateway-config";
import { readDiscordHealth } from "../fs/discord-health";
import { readSlackHealth } from "../fs/slack-health";
import {
  deriveResidentServiceIdentity,
  type ResidentServiceDefinition,
  ResidentServiceError,
} from "../../domain/resident-service";
import {
  AutomationScheduler,
  type AutomationSchedulerApi,
} from "../../application/automation-scheduler";
import type { ResidentGatewayApi } from "../../application/resident-gateway";
import { inspectGatewayOwner } from "./gateway-owner";

import {
  ResidentServiceOperations,
  type ResidentServiceApi,
  residentReady,
} from "../../application/resident-service";
import type { ResidentSupervisorStatus } from "../../application/resident-service";
import type { GatewayOwnerStatus } from "../../domain/gateway";
import { type ProfileTarget } from "../../profile";

export const managerFor = (
  platform: NodeJS.Platform,
): Effect.Effect<ResidentServiceDefinition["manager"], ResidentServiceError> =>
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

export interface ResidentServiceRuntime {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  readonly mainPath: string;
  readonly home: string;
  readonly ziggyHome: string;
  readonly uid: number;
  readonly user: string;
  readonly commands: ResidentPlatformCommands;
  readonly inspectDefinition: typeof inspectManagedDefinition;
  readonly writeDefinition: typeof writeManagedDefinition;
  readonly removeDefinition: typeof removeManagedDefinition;
  readonly ensureDirectory: typeof ensureResidentServiceDirectory;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}

const liveRuntime = (paths: ZiggyPathsApi): ResidentServiceRuntime => ({
  platform: process.platform,
  executablePath: process.execPath,
  mainPath: Bun.main,
  home: paths.homedir,
  ziggyHome: paths.ziggyHome,
  uid: process.getuid?.() ?? userInfo().uid,
  user: process.env.USER ?? userInfo().username,
  commands: residentPlatformCommands,
  inspectDefinition: inspectManagedDefinition,
  writeDefinition: writeManagedDefinition,
  removeDefinition: removeManagedDefinition,
  ensureDirectory: ensureResidentServiceDirectory,
  sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)),
});

const definitionFor = (
  target: ProfileTarget,
  runtime: ResidentServiceRuntime,
  stableLaunch: boolean,
): Effect.Effect<ResidentServiceDefinition, ResidentServiceError> =>
  Effect.gen(function* () {
    const manager = yield* managerFor(runtime.platform);

    const launchInput = {
      executablePath: runtime.executablePath,
      mainPath: runtime.mainPath,
      profilePath: target.path,
    };

    const launch = stableLaunch
      ? yield* resolveResidentLaunch(launchInput)
      : yield* resolveResidentLaunch(launchInput).pipe(
          Effect.orElseSucceed(() => ({
            profilePath: target.path,
            launchVector: [runtime.executablePath, "serve", target.path] as const,
          })),
        );

    const identity = deriveResidentServiceIdentity(launch.profilePath);

    return manager === "launchd"
      ? renderLaunchdService({
          identity,
          profilePath: launch.profilePath,
          launchVector: launch.launchVector,
          home: runtime.home,
          ziggyHome: runtime.ziggyHome,
        })
      : renderSystemdService({
          identity,
          profilePath: launch.profilePath,
          launchVector: launch.launchVector,
          home: runtime.home,
          ziggyHome: runtime.ziggyHome,
        });
  });

const runRequired = (
  runtime: ResidentServiceRuntime,
  definition: ResidentServiceDefinition,
  operation: string,
  command: Parameters<ResidentPlatformCommands["run"]>[0],
) =>
  runtime.commands
    .run(command)
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(commandFailure(operation, definition, result)),
      ),
    );

const inspectSupervisor = (
  definition: ResidentServiceDefinition,
  runtime: ResidentServiceRuntime,
): Effect.Effect<ResidentSupervisorStatus, ResidentServiceError> =>
  Effect.gen(function* () {
    if (definition.manager === "launchd") {
      const result = yield* runtime.commands.run(
        launchdStatusCommand(runtime.uid, definition.identity),
      );

      return launchdSupervisorStatus(result);
    }

    const active = yield* runtime.commands.run(
      systemdCommand("is-active", definition.identity.systemdUnit),
    );

    if (active.stdout.trim() !== "active") return systemdSupervisorStatus(active);

    const pidResult = yield* runtime.commands.run(
      systemdMainPidCommand(definition.identity.systemdUnit),
    );

    return systemdSupervisorStatus(active, pidResult);
  });

const startDefinition = (
  definition: ResidentServiceDefinition,
  runtime: ResidentServiceRuntime,
  mode: "start" | "restart",
) =>
  Effect.gen(function* () {
    if (definition.manager === "systemd") {
      yield* runRequired(
        runtime,
        definition,
        mode,
        systemdCommand(mode, definition.identity.systemdUnit),
      );

      return;
    }

    const loaded = yield* runtime.commands.run(
      launchdStatusCommand(runtime.uid, definition.identity),
    );

    if (loaded.exitCode === 0) {
      yield* runRequired(
        runtime,
        definition,
        mode,
        launchdKickstartCommand(runtime.uid, definition.identity),
      );
    } else {
      yield* runRequired(
        runtime,
        definition,
        mode,
        launchdBootstrapCommand(runtime.uid, definition.path),
      );
    }
  });

const waitForReady = (
  target: ProfileTarget,
  definition: ResidentServiceDefinition,
  gateway: Pick<ResidentGatewayApi, "status">,
  runtime: ResidentServiceRuntime,
  previous?: GatewayOwnerStatus,
) =>
  Effect.gen(function* () {
    let observed: GatewayOwnerStatus | undefined;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [supervisor, owner] = yield* Effect.all([
        inspectSupervisor(definition, runtime).pipe(Effect.result),
        gateway.status(target).pipe(Effect.result),
      ]);

      if (Result.isSuccess(owner)) observed = owner.success;

      if (
        Result.isSuccess(supervisor) &&
        observed?._tag === "running" &&
        residentReady(supervisor.success, observed, previous, "running")
      ) {
        return { ready: true, owner: observed } as const;
      }

      if (attempt < 19) yield* runtime.sleep(250);
    }

    if (observed === undefined) return { ready: false } as const;

    return { ready: false, owner: observed } as const;
  });

const waitForStopped = (
  target: ProfileTarget,
  definition: ResidentServiceDefinition,
  gateway: Pick<ResidentGatewayApi, "status">,
  runtime: ResidentServiceRuntime,
) =>
  Effect.gen(function* () {
    let observed: GatewayOwnerStatus | undefined;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [supervisor, owner] = yield* Effect.all([
        inspectSupervisor(definition, runtime).pipe(Effect.result),
        gateway.status(target).pipe(Effect.result),
      ]);

      if (Result.isSuccess(owner)) observed = owner.success;

      if (
        Result.isSuccess(supervisor) &&
        observed?._tag === "stopped" &&
        residentReady(supervisor.success, observed, undefined, "stopped")
      ) {
        return { ready: true, owner: observed } as const;
      }

      if (attempt < 19) yield* runtime.sleep(250);
    }

    if (observed === undefined) return { ready: false } as const;

    return { ready: false, owner: observed } as const;
  });

export const makeResidentService = (
  gateway: Pick<ResidentGatewayApi, "status">,
  scheduler: AutomationSchedulerApi,
  runtime: ResidentServiceRuntime,
): ResidentServiceApi => {
  const lifecycleBase = (definition: ResidentServiceDefinition) => ({
    manager: definition.manager,
    identity:
      definition.manager === "launchd"
        ? definition.identity.launchdLabel
        : definition.identity.systemdUnit,
    definitionPath: definition.path,
  });

  const start = (target: ProfileTarget) =>
    Effect.gen(function* () {
      yield* validateGatewayProfile(target);
      const definition = yield* definitionFor(target, runtime, true);
      yield* startDefinition(definition, runtime, "start");
      const readiness = yield* waitForReady(target, definition, gateway, runtime);

      return {
        action: "start" as const,
        ...lifecycleBase(definition),
        ...readiness,
        warnings: [],
      };
    });

  return {
    install: (target, options) =>
      Effect.gen(function* () {
        yield* validateGatewayProfile(target);
        const definition = yield* definitionFor(target, runtime, true);

        if (definition.manager === "launchd") {
          yield* runtime.ensureDirectory(
            dirname(launchdLogPaths(runtime.ziggyHome, definition.identity).stdout),
          );
        }

        const write = yield* runtime.writeDefinition(definition, { force: options.force });
        const warnings: Array<string> = [];

        if (definition.manager === "systemd") {
          yield* runRequired(runtime, definition, "daemon-reload", systemdCommand("daemon-reload"));
          yield* runRequired(
            runtime,
            definition,
            "enable",
            systemdCommand("enable", definition.identity.systemdUnit),
          );
          const linger = yield* runtime.commands.run(systemdLingerCommand(runtime.user));

          if (linger.exitCode !== 0 || !/^Linger=yes$/mu.test(linger.stdout)) {
            warnings.push(
              `user lingering is not enabled; ask an administrator to run: loginctl enable-linger ${runtime.user}`,
            );
          }
        }

        if (!options.start) {
          return {
            action: "install" as const,
            ...lifecycleBase(definition),
            write,
            warnings,
          };
        }

        if (definition.manager === "launchd" && write === "replaced") {
          yield* runtime.commands.run(launchdBootoutCommand(runtime.uid, definition.identity));
        }

        yield* startDefinition(definition, runtime, "start");
        const readiness = yield* waitForReady(target, definition, gateway, runtime);

        return {
          action: "install" as const,
          ...lifecycleBase(definition),
          write,
          ...readiness,
          warnings,
        };
      }),
    start,
    stop: (target) =>
      Effect.gen(function* () {
        const definition = yield* definitionFor(target, runtime, false);

        const command =
          definition.manager === "launchd"
            ? launchdBootoutCommand(runtime.uid, definition.identity)
            : systemdCommand("stop", definition.identity.systemdUnit);

        const result = yield* runtime.commands.run(command);

        if (result.exitCode !== 0) {
          const installed = yield* runtime.inspectDefinition(definition);

          if (installed._tag !== "not-installed" && definition.manager !== "launchd") {
            return yield* commandFailure("stop", definition, result);
          }
        }

        const readiness = yield* waitForStopped(target, definition, gateway, runtime);

        return {
          action: "stop" as const,
          ...lifecycleBase(definition),
          ...readiness,
          warnings: [],
        };
      }),
    restart: (target) =>
      Effect.gen(function* () {
        yield* validateGatewayProfile(target);
        const definition = yield* definitionFor(target, runtime, true);

        const previous = yield* gateway
          .status(target)
          .pipe(Effect.orElseSucceed(() => ({ _tag: "stopped" as const, path: definition.path })));

        yield* startDefinition(definition, runtime, "restart");
        const readiness = yield* waitForReady(target, definition, gateway, runtime, previous);

        return {
          action: "restart" as const,
          ...lifecycleBase(definition),
          ...readiness,
          warnings: [],
        };
      }),
    uninstall: (target) =>
      Effect.gen(function* () {
        const definition = yield* definitionFor(target, runtime, false);
        const installed = yield* runtime.inspectDefinition(definition);

        if (installed._tag === "refused") yield* runtime.removeDefinition(definition);

        if (installed._tag !== "not-installed") {
          if (definition.manager === "launchd") {
            yield* runtime.commands.run(launchdBootoutCommand(runtime.uid, definition.identity));
          } else {
            yield* runtime.commands.run(systemdCommand("stop", definition.identity.systemdUnit));
            yield* runRequired(
              runtime,
              definition,
              "disable",
              systemdCommand("disable", definition.identity.systemdUnit),
            );
          }
        }

        const removed = yield* runtime.removeDefinition(definition);

        if (definition.manager === "systemd" && removed) {
          yield* runRequired(runtime, definition, "daemon-reload", systemdCommand("daemon-reload"));
        }

        return {
          action: "uninstall" as const,
          ...lifecycleBase(definition),
          removed,
          warnings: [],
        };
      }),
    logs: (target, follow) =>
      Effect.gen(function* () {
        const definition = yield* definitionFor(target, runtime, false);

        const command =
          definition.manager === "launchd"
            ? launchdLogsCommand(launchdLogPaths(runtime.ziggyHome, definition.identity), follow)
            : systemdLogsCommand(definition.identity.systemdUnit, follow);

        const result = yield* runtime.commands.run(command);

        return { manager: definition.manager, ...result };
      }),
    owner: gateway.status,
    status: (target) =>
      Effect.gen(function* () {
        const definitionResult = yield* definitionFor(target, runtime, false).pipe(Effect.result);

        if (Result.isFailure(definitionResult)) {
          const failure = definitionResult.failure;

          return {
            profilePath: target.path,
            manager:
              runtime.platform === "darwin"
                ? "launchd"
                : runtime.platform === "linux"
                  ? "systemd"
                  : "unsupported",
            managed: Result.fail(failure),
            supervisor: Result.fail(failure),
            process: yield* gateway.status(target).pipe(Effect.result),
            scheduler: yield* scheduler.status(target).pipe(Effect.result),
            discord: yield* readDiscordHealth(target.path, Date.now()).pipe(Effect.result),
            slack: yield* readSlackHealth(target.path, Date.now()).pipe(Effect.result),
          };
        }

        const definition = definitionResult.success;

        const [managed, supervisor, process, schedulerStatus, discord, slack] = yield* Effect.all(
          [
            runtime.inspectDefinition(definition).pipe(Effect.result),
            inspectSupervisor(definition, runtime).pipe(Effect.result),
            gateway.status(target).pipe(Effect.result),
            scheduler.status(target).pipe(Effect.result),
            readDiscordHealth(target.path, Date.now()).pipe(Effect.result),
            readSlackHealth(target.path, Date.now()).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );

        return {
          profilePath: target.path,
          manager: definition.manager,
          managed,
          supervisor,
          process,
          scheduler: schedulerStatus,
          discord,
          slack,
        };
      }),
  };
};

export const ResidentServiceOperationsLive = Layer.effect(
  ResidentServiceOperations,
  Effect.gen(function* () {
    const paths = yield* ZiggyPaths;
    const runtime = yield* Effect.sync(() => liveRuntime(paths));

    return makeResidentService(
      { status: (target) => inspectGatewayOwner(target) },
      yield* AutomationScheduler,
      runtime,
    );
  }),
);
