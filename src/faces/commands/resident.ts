import { Effect, Result, Schedule } from "effect";
import { readUiServerProjection } from "../../adapters/bun/ui-server";
import { ResidentService } from "../../application/resident-service";
import {
  configureWebAccess,
  issueWebPairing,
  revokeWebSessions,
} from "../../application/web-access";
import { fileSystemCauseDetails } from "../../platform/cause";
import { ZiggyPaths } from "../../platform/paths";
import { resolveProfileTarget } from "../../profile";
import type { CliCommand } from "../cli-command";
import { CliCommandFailed } from "../cli-exit";
import { renderResidentLifecycle, renderResidentLogs, renderServeStatus } from "../serve-cli";

export type ResidentCommand = Extract<
  CliCommand,
  {
    readonly _tag:
      | "ServeInstall"
      | "ServeStart"
      | "ServeStop"
      | "ServeRestart"
      | "ServeUninstall"
      | "ServeStatus"
      | "ServeLogs"
      | "UnsupportedResidentAlias"
      | "WebConfigure"
      | "WebPair"
      | "WebRevoke"
      | "Open";
  }
>;

export const runResidentCommand = (command: ResidentCommand) =>
  Effect.gen(function* () {
    const residentService = yield* ResidentService;
    const paths = yield* ZiggyPaths;

    switch (command._tag) {
      case "ServeInstall": {
        const result = yield* residentService.install(resolveProfileTarget(command.target, paths), {
          force: command.force,
          start: !command.noStart,
        });

        console.log(renderResidentLifecycle(result));

        return result.ready === false ? 1 : 0;
      }

      case "ServeStart":
      case "ServeStop":
      case "ServeRestart":
      case "ServeUninstall": {
        const target = resolveProfileTarget(command.target, paths);

        const result =
          command._tag === "ServeStart"
            ? yield* residentService.start(target)
            : command._tag === "ServeStop"
              ? yield* residentService.stop(target)
              : command._tag === "ServeRestart"
                ? yield* residentService.restart(target)
                : yield* residentService.uninstall(target);

        console.log(renderResidentLifecycle(result));

        return result.ready === false ? 1 : 0;
      }

      case "ServeStatus": {
        const status = yield* residentService.status(resolveProfileTarget(command.target, paths));

        const rendered = renderServeStatus(status);
        console.log(rendered.text);

        return rendered.exitCode;
      }

      case "ServeLogs": {
        const logs = yield* residentService.logs(
          resolveProfileTarget(command.target, paths),
          command.follow,
        );

        const rendered = renderResidentLogs(logs);

        if (rendered.length > 0) console.log(rendered);

        return logs.exitCode;
      }

      case "UnsupportedResidentAlias":
        return yield* new CliCommandFailed({
          message: `ziggy ${command.name} is no longer a resident command; use: ziggy serve <name|path>`,
        });

      case "WebConfigure": {
        const target = resolveProfileTarget(command.target, paths);
        yield* configureWebAccess(target, command.port, command.publicUrl);
        console.log(
          `web configured: http://127.0.0.1:${command.port}${command.publicUrl === undefined ? "" : ` (public ${command.publicUrl})`}\nrestart the resident to apply it`,
        );

        return;
      }

      case "WebPair": {
        const pairing = yield* issueWebPairing(resolveProfileTarget(command.target, paths));

        console.log(`${pairing.url}\nexpires: ${pairing.expiresAt}`);

        return;
      }

      case "WebRevoke": {
        const count = yield* revokeWebSessions(resolveProfileTarget(command.target, paths));

        console.log(`revoked browser sessions: ${count}`);

        return;
      }

      case "Open": {
        const target = resolveProfileTarget(command.target, paths);
        const owner = yield* residentService.owner(target);

        if (owner._tag !== "running") {
          const status = yield* residentService.status(target);

          if (Result.isFailure(status.managed)) return yield* status.managed.failure;

          if (status.managed.success._tag === "not-installed") {
            const profile = JSON.stringify(command.target);

            return yield* new CliCommandFailed({
              message: `resident not running; start it with: ziggy serve ${profile}  (or install: ziggy serve install ${profile})`,
            });
          }

          const started = yield* residentService.start(target).pipe(Effect.result);

          if (Result.isFailure(started) || started.success.ready !== true) {
            const current = yield* residentService.owner(target);

            if (current._tag !== "running") {
              if (Result.isFailure(started)) return yield* started.failure;

              return yield* new CliCommandFailed({
                message: "resident did not become ready; inspect ziggy serve status and logs",
              });
            }
          }
        }

        const ui = yield* readUiServerProjection(target.path).pipe(
          Effect.retry({
            while: (failure) => fileSystemCauseDetails(failure.cause).code === "ENOENT",
            times: 10,
            schedule: Schedule.spaced("100 millis"),
          }),
        );

        console.log(
          `http://127.0.0.1:${ui.port}\nNew browser? Run: ziggy web pair ${JSON.stringify(target.path)}`,
        );

        return;
      }
    }
  });
