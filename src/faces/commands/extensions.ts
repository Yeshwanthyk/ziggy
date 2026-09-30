import * as path from "node:path";
import { Console, Effect, Result } from "effect";
import { terminalExtensionManagerInteraction } from "../../adapters/terminal/extension-manager-interaction";
import { manageExtensions } from "../../application/extension-manager";
import { ResidentService, type ResidentServiceApi } from "../../application/resident-service";
import { Extensions } from "../../extensions";
import { ZiggyPaths } from "../../platform/paths";
import { Profiles, resolveProfileTarget, type ProfileTarget } from "../../profile";
import { RESIDENT_SCHEDULE_HINT } from "../automation-cli";
import { CliCommandFailed } from "../cli-exit";
import { CliInputInvalid, type CliCommand } from "../cli-command";
import {
  renderExtension,
  renderExtensionJson,
  renderExtensionManagerResult,
  renderExtensionMutation,
  renderExtensions,
  renderExtensionsJson,
  renderProfileExtensionJson,
  renderProfileExtensions,
} from "../extensions-cli";
import { TerminalStyle } from "../terminal-ui";

/** `extensions update --restart`: stop the managed resident around `update`, then start it again. */
const withResidentStopped = <A, E>(
  residentService: ResidentServiceApi,
  target: ProfileTarget,
  update: Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* residentService.status(target);

    if (Result.isFailure(service.managed) || service.managed.success._tag === "not-installed") {
      return yield* new CliCommandFailed({
        message:
          "--restart requires an installed managed resident; stop the resident and update without --restart",
      });
    }

    const stopped = yield* residentService.stop(target);

    if (stopped.ready !== true) {
      return yield* new CliCommandFailed({
        message: "Resident did not stop cleanly; update not applied.",
      });
    }

    const restart = residentService.start(target).pipe(
      Effect.flatMap((started) =>
        started.ready === true
          ? Effect.void
          : Console.error("resident not running; use ziggy serve start"),
      ),
      Effect.catch((failure) =>
        Console.error(`resident not running; use ziggy serve start: ${failure.message}`),
      ),
    );

    return yield* update.pipe(Effect.ensuring(restart));
  });

export type ExtensionsCommand = Extract<
  CliCommand,
  {
    readonly _tag:
      | "ExtensionsList"
      | "ExtensionsShow"
      | "ExtensionsManage"
      | "ExtensionsAdd"
      | "ExtensionsRemove"
      | "ExtensionsUpdate";
  }
>;

export const runExtensionsCommand = (command: ExtensionsCommand) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles;
    const profileExtensions = yield* Extensions;
    const residentService = yield* ResidentService;
    const paths = yield* ZiggyPaths;
    const style = yield* TerminalStyle;

    switch (command._tag) {
      case "ExtensionsManage": {
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
          return yield* new CliInputInvalid({
            message:
              "interactive extension management requires a terminal; use 'ziggy extensions add' or 'ziggy extensions remove' in scripts",
          });
        }

        const result = yield* manageExtensions(
          profiles,
          profileExtensions,
          terminalExtensionManagerInteraction,
          command.target === undefined
            ? {}
            : { target: resolveProfileTarget(command.target, paths) },
        );

        console.log(renderExtensionManagerResult(result, style));

        return;
      }

      case "ExtensionsList": {
        if (command.target !== undefined) {
          const target = resolveProfileTarget(command.target, paths);
          const listing = yield* profileExtensions.listForProfile(target.path);
          console.log(renderProfileExtensions(listing, target.path, command.json));

          return;
        }

        const extensions = yield* profileExtensions.list();

        if (command.json) {
          console.log(renderExtensionsJson(extensions));

          return;
        }

        console.log(renderExtensions(extensions, style));

        return;
      }

      case "ExtensionsShow": {
        const target =
          command.target === undefined ? undefined : resolveProfileTarget(command.target, paths);

        const extension = yield* profileExtensions.show(command.id, target?.path);

        const profile =
          target === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const listing = yield* profileExtensions.listForProfile(target.path);

                return {
                  path: target.path,
                  selected:
                    listing.required.includes(command.id) || listing.selected.includes(command.id),
                };
              });

        if (command.json) {
          console.log(
            profile === undefined
              ? renderExtensionJson(extension)
              : renderProfileExtensionJson(extension, profile),
          );

          return;
        }

        console.log(
          renderExtension(
            {
              ...extension,
              packagePath:
                extension.packagePath === undefined
                  ? undefined
                  : path.isAbsolute(extension.packagePath)
                    ? path.relative(process.cwd(), extension.packagePath)
                    : extension.packagePath,
              extensionPaths: extension.extensionPaths?.map((extensionPath) =>
                path.isAbsolute(extensionPath)
                  ? path.relative(process.cwd(), extensionPath)
                  : extensionPath,
              ),
            },
            style,
            profile,
          ),
        );

        return;
      }

      case "ExtensionsAdd":
      case "ExtensionsRemove": {
        const target = resolveProfileTarget(command.target, paths);

        const result = yield* command._tag === "ExtensionsAdd"
          ? profileExtensions.add(target, command.id)
          : profileExtensions.remove(target, command.id);

        console.log(renderExtensionMutation(result, style));

        if (command._tag === "ExtensionsAdd" && result.selected && result.changed) {
          if (result.automations.length > 0) {
            const service = yield* residentService.status(target);

            if (
              Result.isSuccess(service.managed) &&
              service.managed.success._tag === "not-installed"
            )
              console.log(
                RESIDENT_SCHEDULE_HINT(
                  target.path,
                  (yield* residentService.owner(target))._tag === "running",
                ),
              );
          }
        }

        return;
      }

      case "ExtensionsUpdate": {
        const target = resolveProfileTarget(command.target, paths);
        const update = profileExtensions.update(target, command.id, { adopt: command.adopt });

        const updated = command.restart
          ? yield* withResidentStopped(residentService, target, update)
          : yield* update;

        console.log(`${updated.status} ${updated.id} in ${updated.profilePath}`);
        console.log(`content ${updated.contentHash}`);

        return;
      }
    }
  });
