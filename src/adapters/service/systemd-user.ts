import { join } from "node:path";
import { Effect, Option } from "effect";
import type {
  AutomationServiceBackend,
  AutomationServiceStatus,
  SchedulerCommand,
} from "../../domain/automation-service";
import type { ProfileTarget } from "../../domain/profile";
import { type ServiceCommandRunner, type ServiceFileSystem, requireCommandSuccess } from "./io";
import { serviceIdentitySuffix } from "./identity";

const quoteSystemd = (value: string): string =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("%", "%%")}"`;

export const systemdUnit = (profilePath: string): string =>
  `ziggy-scheduler-${serviceIdentitySuffix(profilePath)}.service`;

export const renderSystemdUnit = (command: SchedulerCommand, profilePath: string): string => `[Unit]
Description=Ziggy scheduler for ${profilePath.replaceAll("\n", " ")}

[Service]
Type=simple
ExecStart=${[command.executable, ...command.arguments].map(quoteSystemd).join(" ")}
WorkingDirectory=${quoteSystemd(profilePath)}
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

export interface SystemdUserOptions {
  readonly homedir: string;
  readonly userName: string;
  readonly commands: ServiceCommandRunner;
  readonly fileSystem: ServiceFileSystem;
}

const coordinates = (target: ProfileTarget, options: SystemdUserOptions) => {
  const id = systemdUnit(target.path);
  return {
    id,
    artifactPath: join(options.homedir, ".config", "systemd", "user", id),
  };
};

const isActive = (commands: ServiceCommandRunner, id: string) =>
  commands
    .run("systemctl", ["--user", "is-active", "--quiet", id])
    .pipe(Effect.map((result) => result.exitCode === 0));

const reload = (commands: ServiceCommandRunner) => {
  const arguments_ = ["--user", "daemon-reload"];
  return commands
    .run("systemctl", arguments_)
    .pipe(
      Effect.flatMap((result) =>
        requireCommandSuccess("systemd daemon-reload", "systemctl", arguments_, result),
      ),
    );
};

export const makeSystemdUserBackend = (options: SystemdUserOptions): AutomationServiceBackend => ({
  install: (target, command) =>
    Effect.gen(function* () {
      const service = coordinates(target, options);
      const desired = renderSystemdUnit(command, target.path);
      const current = yield* options.fileSystem.readOptional(service.artifactPath);
      const active = yield* isActive(options.commands, service.id);
      if (current === desired && active) {
        return { backend: "systemd-user", ...service, changed: false };
      }
      if (current !== desired) {
        yield* options.fileSystem.writeAtomic(service.artifactPath, desired);
        yield* reload(options.commands);
      }
      const arguments_ = ["--user", "enable", "--now", service.id];
      yield* options.commands
        .run("systemctl", arguments_)
        .pipe(
          Effect.flatMap((result) =>
            requireCommandSuccess("systemd enable", "systemctl", arguments_, result),
          ),
        );
      return { backend: "systemd-user", ...service, changed: true };
    }),
  status: (target, health) =>
    Effect.gen(function* () {
      const service = coordinates(target, options);
      const installed =
        (yield* options.fileSystem.readOptional(service.artifactPath)) !== undefined;
      const active = yield* isActive(options.commands, service.id);
      const lingerResult = yield* options.commands
        .run("loginctl", ["show-user", options.userName, "-p", "Linger", "--value"])
        .pipe(Effect.option);
      const lingerCommand = Option.getOrUndefined(lingerResult);
      const linger =
        lingerCommand !== undefined
          ? lingerCommand.exitCode !== 0
            ? ("unknown" as const)
            : lingerCommand.stdout.trim() === "yes"
              ? ("enabled" as const)
              : ("disabled" as const)
          : ("unknown" as const);
      return {
        backend: "systemd-user",
        id: service.id,
        artifactPath: service.artifactPath,
        installed,
        hostActive: active,
        healthFresh: health.fresh,
        ...(health.heartbeatAt === undefined ? {} : { heartbeatAt: health.heartbeatAt }),
        linger,
        diagnostics:
          linger === "disabled"
            ? ["systemd user lingering is disabled; the scheduler may stop after logout"]
            : linger === "unknown"
              ? ["could not determine systemd user lingering status"]
              : [],
      } satisfies AutomationServiceStatus;
    }),
  uninstall: (target) =>
    Effect.gen(function* () {
      const service = coordinates(target, options);
      const active = yield* isActive(options.commands, service.id);
      const installed =
        (yield* options.fileSystem.readOptional(service.artifactPath)) !== undefined;
      if (active || installed) {
        const arguments_ = ["--user", "disable", "--now", service.id];
        yield* options.commands
          .run("systemctl", arguments_)
          .pipe(
            Effect.flatMap((result) =>
              requireCommandSuccess("systemd disable", "systemctl", arguments_, result),
            ),
          );
      }
      const removed = yield* options.fileSystem.remove(service.artifactPath);
      if (removed) {
        yield* reload(options.commands);
      }
      return { backend: "systemd-user", ...service, changed: active || removed };
    }),
});
