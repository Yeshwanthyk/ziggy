import { Effect } from "effect";
import { terminalAuthInteraction } from "../../adapters/terminal/auth-interaction";
import { terminalSetupInteraction } from "../../adapters/terminal/setup-interaction";
import { Doctor } from "../../application/doctor";
import { Setup } from "../../application/setup";
import { ZiggyPaths } from "../../platform/paths";
import { Auth, Profiles, resolveProfileTarget } from "../../profile";
import type { CliCommand } from "../cli-command";
import { renderDoctor, renderSetupRecovery } from "../doctor-cli";
import { renderProfiles, renderProfilesJson } from "../profiles-cli";
import { TerminalStyle } from "../terminal-ui";

export type ProfileCommand = Extract<
  CliCommand,
  { readonly _tag: "Init" | "Profiles" | "Doctor" | "AuthStatus" | "AuthLogin" }
>;

export const runProfileCommand = (command: ProfileCommand) =>
  Effect.gen(function* () {
    const setup = yield* Setup;
    const profiles = yield* Profiles;
    const auth = yield* Auth;
    const doctor = yield* Doctor;
    const paths = yield* ZiggyPaths;
    const style = yield* TerminalStyle;

    switch (command._tag) {
      case "Init": {
        const target = resolveProfileTarget(command.target, paths);

        const initOptions = {
          minimal: command.minimal,
          interactive:
            !command.nonInteractive &&
            process.stdin.isTTY === true &&
            process.stdout.isTTY === true,
          ...Object.fromEntries(
            [
              command.providerId !== undefined
                ? (["providerId", command.providerId] as const)
                : undefined,
              command.modelId !== undefined ? (["modelId", command.modelId] as const) : undefined,
              command.thinking !== undefined
                ? (["thinking", command.thinking] as const)
                : undefined,
            ].flatMap((entry) => (entry === undefined ? [] : [entry])),
          ),
        };

        const result = yield* setup.initialize(
          target,
          initOptions,
          terminalSetupInteraction(target.path),
        );

        console.log(
          result.soulCreated
            ? `created profile at ${result.profilePath}`
            : `profile already initialized at ${result.profilePath}`,
        );

        if (result.createdDirectories.length > 0) {
          console.log(`created folders: ${result.createdDirectories.join(", ")}`);
        }

        if (result.minimal) {
          console.log(
            `next: ziggy serve install ${JSON.stringify(result.profilePath)}\nthen: ziggy web pair ${JSON.stringify(result.profilePath)}`,
          );

          return;
        }

        if (
          result.modelStatus?.providerId !== undefined &&
          result.modelStatus.modelId !== undefined
        ) {
          console.log(
            `model: ${result.modelStatus.providerId}/${result.modelStatus.modelId} (${result.modelStatus.thinking})`,
          );
        }

        if (result.doctor !== undefined) {
          const rendered = renderDoctor(result.doctor);
          console.log(rendered.text);

          if (rendered.exitCode !== 0) {
            console.error(renderSetupRecovery(result.doctor));

            return rendered.exitCode;
          }
        }

        console.log(
          `ready: ziggy serve install ${JSON.stringify(result.profilePath)}\nthen: ziggy web pair ${JSON.stringify(result.profilePath)}`,
        );

        return;
      }

      case "Profiles": {
        const listings = yield* profiles.list();

        if (command.json) {
          console.log(renderProfilesJson(listings));

          return;
        }

        console.log(
          renderProfiles(listings, {
            ...style,
            homeDirectory: paths.homedir,
          }),
        );

        return;
      }

      case "AuthStatus": {
        const statuses = yield* auth.status(resolveProfileTarget(command.target, paths));

        const sorted = [...statuses].sort(
          (left, right) =>
            Number(right.configured !== undefined) - Number(left.configured !== undefined) ||
            left.id.localeCompare(right.id),
        );

        for (const provider of sorted) {
          const configured =
            provider.configured === undefined
              ? "not configured"
              : `configured: ${provider.configured.type}${provider.configured.source === undefined ? "" : ` via ${provider.configured.source}`}`;

          const loginTypes = [
            ...(provider.supportsApiKeyLogin ? ["api_key"] : []),
            ...(provider.supportsOauth ? ["oauth"] : []),
          ];

          const login =
            loginTypes.length === 0 && provider.ambientOnly
              ? "ambient env only"
              : loginTypes.join(", ");

          console.log(`${provider.id}\t${configured}\tlogin: ${login}`);
        }

        return;
      }

      case "AuthLogin": {
        const result = yield* auth.login(
          resolveProfileTarget(command.target, paths),
          command.providerId,
          command.type,
          terminalAuthInteraction(),
        );

        console.log(
          `logged in to ${result.providerId} (${result.type})${result.source === undefined ? "" : ` via ${result.source}`}`,
        );

        return;
      }

      case "Doctor": {
        const report = yield* doctor.check(resolveProfileTarget(command.target, paths));

        const rendered = renderDoctor(report);
        console.log(rendered.text);

        return rendered.exitCode;
      }
    }
  });
