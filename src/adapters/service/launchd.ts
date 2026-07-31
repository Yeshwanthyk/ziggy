import { join } from "node:path";
import { Effect } from "effect";
import type {
  AutomationServiceBackend,
  AutomationServiceStatus,
  SchedulerCommand,
} from "../../domain/automation-service";
import type { ProfileTarget } from "../../domain/profile";
import { type ServiceCommandRunner, type ServiceFileSystem, requireCommandSuccess } from "./io";
import { serviceIdentitySuffix } from "./identity";

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const launchdLabel = (profilePath: string): string =>
  `works.earendil.ziggy.scheduler.${serviceIdentitySuffix(profilePath)}`;

export const renderLaunchdPlist = (
  label: string,
  command: SchedulerCommand,
  profilePath: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(command.executable)}</string>
    ${command.arguments.map((argument) => `<string>${escapeXml(argument)}</string>`).join("\n    ")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(profilePath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;

export interface LaunchdOptions {
  readonly homedir: string;
  readonly uid: number;
  readonly commands: ServiceCommandRunner;
  readonly fileSystem: ServiceFileSystem;
}

const coordinates = (target: ProfileTarget, options: LaunchdOptions) => {
  const id = launchdLabel(target.path);
  return {
    id,
    artifactPath: join(options.homedir, "Library", "LaunchAgents", `${id}.plist`),
    domain: `gui/${options.uid}`,
    service: `gui/${options.uid}/${id}`,
  };
};

const hostActive = (
  commands: ServiceCommandRunner,
  service: string,
): Effect.Effect<
  boolean,
  import("../../domain/automation-service").AutomationServiceCommandError
> =>
  commands.run("launchctl", ["print", service]).pipe(Effect.map((result) => result.exitCode === 0));

export const makeLaunchdBackend = (options: LaunchdOptions): AutomationServiceBackend => ({
  install: (target, command) =>
    Effect.gen(function* () {
      const service = coordinates(target, options);
      const desired = renderLaunchdPlist(service.id, command, target.path);
      const current = yield* options.fileSystem.readOptional(service.artifactPath);
      const active = yield* hostActive(options.commands, service.service);
      if (current === desired && active) {
        return {
          backend: "launchd",
          id: service.id,
          artifactPath: service.artifactPath,
          changed: false,
        };
      }
      if (active) {
        const arguments_ = ["bootout", service.service];
        yield* options.commands
          .run("launchctl", arguments_)
          .pipe(
            Effect.flatMap((result) =>
              requireCommandSuccess("launchd bootout", "launchctl", arguments_, result),
            ),
          );
      }
      if (current !== desired) {
        yield* options.fileSystem.writeAtomic(service.artifactPath, desired);
      }
      const arguments_ = ["bootstrap", service.domain, service.artifactPath];
      yield* options.commands
        .run("launchctl", arguments_)
        .pipe(
          Effect.flatMap((result) =>
            requireCommandSuccess("launchd bootstrap", "launchctl", arguments_, result),
          ),
        );
      return {
        backend: "launchd",
        id: service.id,
        artifactPath: service.artifactPath,
        changed: true,
      };
    }),
  status: (target, health) =>
    Effect.gen(function* () {
      const service = coordinates(target, options);
      const installed =
        (yield* options.fileSystem.readOptional(service.artifactPath)) !== undefined;
      const active = yield* hostActive(options.commands, service.service);
      return {
        backend: "launchd",
        id: service.id,
        artifactPath: service.artifactPath,
        installed,
        hostActive: active,
        healthFresh: health.fresh,
        ...(health.heartbeatAt === undefined ? {} : { heartbeatAt: health.heartbeatAt }),
        diagnostics: [],
      } satisfies AutomationServiceStatus;
    }),
  uninstall: (target) =>
    Effect.gen(function* () {
      const service = coordinates(target, options);
      const active = yield* hostActive(options.commands, service.service);
      if (active) {
        const arguments_ = ["bootout", service.service];
        yield* options.commands
          .run("launchctl", arguments_)
          .pipe(
            Effect.flatMap((result) =>
              requireCommandSuccess("launchd bootout", "launchctl", arguments_, result),
            ),
          );
      }
      const removed = yield* options.fileSystem.remove(service.artifactPath);
      return {
        backend: "launchd",
        id: service.id,
        artifactPath: service.artifactPath,
        changed: active || removed,
      };
    }),
});
