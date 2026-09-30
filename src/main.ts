import * as path from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Clock, Console, Effect, Exit, Match, Result, Runtime, Schedule } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { readUiServerProjection } from "./adapters/bun/ui-server";
import { fileSystemCauseDetails } from "./adapters/fs/cause";
import { readSelectedExtensionPackage } from "./adapters/fs/profile-extensions";
import { terminalAuthInteraction } from "./adapters/terminal/auth-interaction";
import { terminalExtensionManagerInteraction } from "./adapters/terminal/extension-manager-interaction";
import { terminalSetupInteraction } from "./adapters/terminal/setup-interaction";
import { ZiggyAgent } from "./application/agent";
import { Auth } from "./application/auth";
import { AutomationDefinitions } from "./application/automation-definitions";
import { AutomationScheduler } from "./application/automation-scheduler";
import { Automations } from "./application/automations";
import { ProfileExtensions } from "./application/profile-extensions";
import { manageExtensions } from "./application/extension-manager";
import { Doctor } from "./application/doctor";
import { Models } from "./application/models";
import { configureWebAccess, issueWebPairing, revokeWebSessions } from "./application/web-access";
import { ProfileAgents } from "./application/profile-agents";
import { Profiles } from "./application/profiles";
import { ResidentGateway } from "./application/resident-gateway";
import { ResidentService } from "./application/resident-service";
import { Sessions } from "./application/sessions";
import { SelfUpdate } from "./application/self-update";
import { ExtensionUpdate, refreshRequiredExtensions } from "./application/extension-update";
import { Setup } from "./application/setup";
import {
  CliLayer,
  MemoryCommandsLayer,
  ModelsCommandsLayer,
  SessionsCommandsLayer,
} from "./composition";
import { CliCommandFailed, exitWith } from "./faces/cli-exit";
import { TerminalStyle } from "./faces/terminal-ui";
import { ZiggyPaths } from "./application/ziggy-paths";
import { validateAutomationId, type AutomationRunOutcome } from "./domain/automation";
import { type CliCommand, CliInputInvalid } from "./faces/cli-command";
import {
  renderProfileAgent,
  renderProfileAgents,
  renderProfileAgentValidation,
  renderProfileAgentJson,
  renderProfileAgentsJson,
} from "./faces/agents-cli";
import {
  renderAutomationCreated,
  renderAutomationDefinitions,
  renderAutomationDefinitionsJson,
  renderAutomationOutcome,
  renderAutomationRuns,
  renderAutomationRunsJson,
  renderAutomationStatus,
  renderAutomationStatusJson,
  RESIDENT_SCHEDULE_HINT,
  renderAutomationTransition,
  renderAutomationValidation,
} from "./faces/automation-cli";
import { decodeCliCommand, isForegroundResidentArguments, renderHelp } from "./faces/cli";
import { renderDoctor, renderSetupRecovery } from "./faces/doctor-cli";
import {
  renderExtension,
  renderExtensionManagerResult,
  renderExtensionMutation,
  renderExtensions,
  renderExtensionJson,
  renderProfileExtensionJson,
  renderExtensionsJson,
  renderProfileExtensionFailure,
  renderProfileExtensions,
} from "./faces/extensions-cli";
import { type ModelsCommand, runModelsCommand } from "./faces/commands/models";
import { type SessionsCommand, runSessionsCommand } from "./faces/commands/sessions";
import { type MemoryCommand, runMemoryCommand } from "./faces/commands/memory";
import { renderProfiles, renderProfilesJson } from "./faces/profiles-cli";
import { runAcp } from "./faces/acp";
import { wakeInResident } from "./faces/wake-resident";
import { renderResidentLifecycle, renderResidentLogs, renderServeStatus } from "./faces/serve-cli";

type LegacyCommand = Exclude<
  CliCommand,
  { readonly _tag: "Help" | "Version" } | ModelsCommand | SessionsCommand | MemoryCommand
>;

const runCommand = (command: LegacyCommand) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles;
    const agent = yield* ZiggyAgent;
    const auth = yield* Auth;
    const models = yield* Models;
    const doctor = yield* Doctor;
    const profileAgents = yield* ProfileAgents;
    const automationDefinitions = yield* AutomationDefinitions;
    const setup = yield* Setup;
    const automations = yield* Automations;
    const automationScheduler = yield* AutomationScheduler;
    const residentGateway = yield* ResidentGateway;
    const residentService = yield* ResidentService;
    const sessions = yield* Sessions;
    const profileExtensions = yield* ProfileExtensions;
    const selfUpdate = yield* SelfUpdate;
    const extensionUpdate = yield* ExtensionUpdate;
    const paths = yield* ZiggyPaths;
    const style = yield* TerminalStyle;

    switch (command._tag) {
      case "Init": {
        const target = paths.resolveTarget(command.target);

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
          paths.profilesRegistry,
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
        const listings = yield* profiles.listProfiles(
          paths.profilesDirectory,
          paths.profilesRegistry,
        );

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

      case "ExtensionsManage": {
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
          return yield* new CliInputInvalid({
            message:
              "interactive extension management requires a terminal; use 'ziggy extensions add' or 'ziggy extensions remove' in scripts",
          });
        }

        const managerOptions = {
          profilesDirectory: paths.profilesDirectory,
          registryPath: paths.profilesRegistry,
        };

        const result = yield* manageExtensions(
          profiles,
          profileExtensions,
          terminalExtensionManagerInteraction,
          command.target === undefined
            ? managerOptions
            : {
                ...managerOptions,
                target: paths.resolveTarget(command.target),
              },
        );

        console.log(renderExtensionManagerResult(result, style));

        return;
      }

      case "ExtensionsList": {
        if (command.target !== undefined) {
          const target = paths.resolveTarget(command.target);
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
          command.target === undefined ? undefined : paths.resolveTarget(command.target);

        const extension = yield* profileExtensions.show(command.id, target?.path);

        const profile =
          target === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const listing = yield* profileExtensions.listForProfile(target.path);

                return {
                  path: target.path,
                  selected:
                    listing.required?.includes(command.id) === true ||
                    listing.selected.includes(command.id),
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
        const target = paths.resolveTarget(command.target);

        const result = yield* command._tag === "ExtensionsAdd"
          ? profileExtensions.add(target, command.id)
          : profileExtensions.remove(target, command.id);

        console.log(renderExtensionMutation(result, style));

        if (command._tag === "ExtensionsAdd" && result.selected && result.changed) {
          const extension = yield* readSelectedExtensionPackage(target.path, result.id).pipe(
            Effect.result,
          );

          if (Result.isFailure(extension)) {
            console.warn("extension added; could not inspect its schedules for a resident hint");
          } else if (extension.success.automations.length > 0) {
            const service = yield* residentService.status(target);

            if (
              Result.isSuccess(service.managed) &&
              service.managed.success._tag === "not-installed"
            )
              console.log(
                RESIDENT_SCHEDULE_HINT(
                  target.path,
                  (yield* residentGateway.status(target))._tag === "running",
                ),
              );
          }
        }

        return;
      }

      case "ExtensionsUpdate": {
        const target = paths.resolveTarget(command.target);

        const updated = yield* extensionUpdate.update(target, command.id, {
          adopt: command.adopt,
          restart: command.restart,
        });

        console.log(`${updated.status} ${updated.id} in ${updated.profilePath}`);

        if (updated.adoptedUnknownOrigin) console.log("adopted previously untracked package");
        console.log(`content ${updated.contentHash}`);

        if (updated.backupPath !== undefined) console.log(`backup ${updated.backupPath}`);

        if (updated.residentStopped)
          console.log(
            `resident stopped; run ziggy serve start ${JSON.stringify(target.path)} (or install the service first)`,
          );

        return;
      }

      case "Update": {
        const updated = yield* selfUpdate.update();
        console.log(`updated Ziggy at ${updated.path} (${updated.version})`);

        return;
      }

      case "AuthStatus": {
        const statuses = yield* auth.status(paths.resolveTarget(command.target));

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
          paths.resolveTarget(command.target),
          command.providerId,
          command.type,
          terminalAuthInteraction(),
        );

        console.log(
          `logged in to ${result.providerId} (${result.type})${result.source === undefined ? "" : ` via ${result.source}`}`,
        );

        return;
      }

      case "AgentsCreate": {
        const created = yield* profileAgents.create(
          paths.resolveTarget(command.target),
          command.agentId,
        );

        console.log(`created Profile agent ${created.id} at ${created.path}`);

        return;
      }

      case "AgentsList": {
        const listed = yield* profileAgents.list(paths.resolveTarget(command.target));

        console.log(command.json ? renderProfileAgentsJson(listed) : renderProfileAgents(listed));

        return;
      }

      case "AgentsShow": {
        const shown = yield* profileAgents.show(
          paths.resolveTarget(command.target),
          command.agentId,
        );

        console.log(command.json ? renderProfileAgentJson(shown) : renderProfileAgent(shown));

        return;
      }

      case "AgentsValidate": {
        const validation = yield* profileAgents.validate(
          paths.resolveTarget(command.target),
          command.agentId,
        );

        console.log(renderProfileAgentValidation(validation));

        return validation.some((item) => !item.valid) ? 1 : 0;
      }

      case "AgentsRun": {
        const result = yield* profileAgents.run(
          paths.resolveTarget(command.target),
          command.agentId,
          command.prompt,
        );

        console.log(result.answer);

        return;
      }

      case "Run": {
        const target = paths.resolveTarget(command.target);

        const sessionPath =
          command.sessionId === undefined
            ? undefined
            : path.resolve(
                target.path,
                "sessions",
                (yield* sessions.resolve(target, command.sessionId)).path,
              );

        const exitCode = yield* agent.runOnce(
          target,
          command.prompt,
          command.continueSession,
          { kind: "local" },
          sessionPath === undefined
            ? { mode: command.json ? "json" : "text" }
            : { mode: command.json ? "json" : "text", sessionPath },
        );

        return exitCode;
      }

      case "Acp":
        return yield* runAcp(
          paths.resolveTarget(command.target),
          command.shared,
          agent,
          models,
          command.agent,
        );
      case "AutomationsCreate": {
        const created = yield* automationDefinitions.create(
          paths.resolveTarget(command.target),
          command.automationId,
        );

        console.log(renderAutomationCreated(created));

        return;
      }

      case "AutomationsList": {
        const listed = yield* automationDefinitions.list(paths.resolveTarget(command.target));

        console.log(
          command.json
            ? renderAutomationDefinitionsJson(listed)
            : renderAutomationDefinitions(listed),
        );

        return;
      }

      case "AutomationsPause":
      case "AutomationsResume": {
        const definition = yield* command._tag === "AutomationsPause"
          ? automationDefinitions.pause(paths.resolveTarget(command.target), command.automationId)
          : automationDefinitions.resume(paths.resolveTarget(command.target), command.automationId);

        console.log(
          renderAutomationTransition(
            command._tag === "AutomationsPause" ? "paused" : "resumed",
            definition,
          ),
        );

        return;
      }

      case "AutomationsValidate": {
        const validation = yield* automationDefinitions.validate(
          paths.resolveTarget(command.target),
          command.automationId,
        );

        console.log(renderAutomationValidation(validation));

        return validation.some((item) => !item.valid) ? 1 : 0;
      }

      case "AutomationsStatus": {
        const target = paths.resolveTarget(command.target);
        const status = yield* automationScheduler.status(target);

        console.log(
          command.json ? renderAutomationStatusJson(status) : renderAutomationStatus(status),
        );

        if (!command.json) {
          const service = yield* residentService.status(target);

          if (Result.isSuccess(service.managed) && service.managed.success._tag === "not-installed")
            console.log(
              RESIDENT_SCHEDULE_HINT(
                target.path,
                (yield* residentGateway.status(target))._tag === "running",
              ),
            );
        }

        return;
      }

      case "AutomationsRuns": {
        const automationId =
          command.automationId === undefined
            ? undefined
            : yield* validateAutomationId(command.automationId);

        const runs = yield* automationScheduler.runs(
          paths.resolveTarget(command.target),
          automationId,
        );

        console.log(
          command.json
            ? renderAutomationRunsJson(runs)
            : renderAutomationRuns(runs, yield* Clock.currentTimeMillis),
        );

        return;
      }

      case "Wake": {
        const target = paths.resolveTarget(command.target);
        const owner = yield* residentGateway.status(target);
        let outcome: AutomationRunOutcome;

        if (owner._tag === "running") {
          const projection = yield* readUiServerProjection(target.path).pipe(
            Effect.mapError((failure) =>
              fileSystemCauseDetails(failure.cause).code === "ENOENT"
                ? new CliCommandFailed({ message: "resident is starting; retry" })
                : failure,
            ),
          );

          const result = yield* wakeInResident(target, command.automationId, projection);
          outcome = result.runOutcome;
        } else {
          outcome = yield* automations.run(target, command.automationId, {
            kind: "manual-force",
          });
        }

        const rendered = renderAutomationOutcome(outcome);

        for (const line of rendered.stderr) console.error(line);

        return rendered.exitCode;
      }

      case "ServeInstall": {
        const result = yield* residentService.install(paths.resolveTarget(command.target), {
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
        const target = paths.resolveTarget(command.target);

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
        const status = yield* residentService.status(paths.resolveTarget(command.target));

        const rendered = renderServeStatus(status);
        console.log(rendered.text);

        return rendered.exitCode;
      }

      case "ServeLogs": {
        const logs = yield* residentService.logs(
          paths.resolveTarget(command.target),
          command.follow,
        );

        const rendered = renderResidentLogs(logs);

        if (rendered.length > 0) console.log(rendered);

        return logs.exitCode;
      }

      case "Serve":
      case "Gateway": {
        const target = paths.resolveTarget(command.target);
        yield* refreshRequiredExtensions(target, (profile, id) =>
          extensionUpdate.update(profile, id),
        );

        return yield* residentGateway.run(target);
      }

      case "UnsupportedResidentAlias":
        return yield* new CliCommandFailed({
          message: `ziggy ${command.name} is no longer a resident command; use: ziggy serve <name|path>`,
        });
      case "WebConfigure": {
        const target = paths.resolveTarget(command.target);
        yield* configureWebAccess(target, command.port, command.publicUrl);
        console.log(
          `web configured: http://127.0.0.1:${command.port}${command.publicUrl === undefined ? "" : ` (public ${command.publicUrl})`}\nrestart the resident to apply it`,
        );

        return;
      }

      case "WebPair": {
        const pairing = yield* issueWebPairing(paths.resolveTarget(command.target));

        console.log(`${pairing.url}\nexpires: ${pairing.expiresAt}`);

        return;
      }

      case "WebRevoke": {
        const count = yield* revokeWebSessions(paths.resolveTarget(command.target));

        console.log(`revoked browser sessions: ${count}`);

        return;
      }

      case "Open": {
        const target = paths.resolveTarget(command.target);
        const owner = yield* residentGateway.status(target);

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
            const current = yield* residentGateway.status(target);

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

      case "Doctor": {
        const report = yield* doctor.check(paths.resolveTarget(command.target));

        const rendered = renderDoctor(report);
        console.log(rendered.text);

        return rendered.exitCode;
      }
    }
  });

const modelsArea = (command: ModelsCommand) =>
  runModelsCommand(command).pipe(Effect.provide(ModelsCommandsLayer));

const sessionsArea = (command: SessionsCommand) =>
  runSessionsCommand(command).pipe(Effect.provide(SessionsCommandsLayer));

const memoryArea = (command: MemoryCommand) =>
  runMemoryCommand(command).pipe(Effect.provide(MemoryCommandsLayer));

// Commands not yet moved into an area module still run through `runCommand` with every service.
const legacy = (command: LegacyCommand) => runCommand(command).pipe(Effect.provide(CliLayer));

// Every command maps to its area runner; each area builds only its own layer.
const dispatch = (command: CliCommand) =>
  Match.valueTags(command, {
    Help: (command) => Console.log(renderHelp(command.topic)),
    Version: () => Console.log(packageJson.version),
    ModelsStatus: modelsArea,
    ModelsList: modelsArea,
    ModelsSet: modelsArea,
    Update: legacy,
    Init: legacy,
    Profiles: legacy,
    ExtensionsList: legacy,
    ExtensionsShow: legacy,
    ExtensionsManage: legacy,
    ExtensionsAdd: legacy,
    ExtensionsRemove: legacy,
    ExtensionsUpdate: legacy,
    AuthStatus: legacy,
    AuthLogin: legacy,
    Doctor: legacy,
    AgentsCreate: legacy,
    AgentsList: legacy,
    AgentsShow: legacy,
    AgentsValidate: legacy,
    AgentsRun: legacy,
    Run: legacy,
    Acp: legacy,
    AutomationsCreate: legacy,
    AutomationsList: legacy,
    AutomationsPause: legacy,
    AutomationsResume: legacy,
    AutomationsValidate: legacy,
    AutomationsStatus: legacy,
    AutomationsRuns: legacy,
    Wake: legacy,
    SessionsList: sessionsArea,
    SessionsShow: sessionsArea,
    MemoryList: memoryArea,
    MemoryShow: memoryArea,
    Serve: legacy,
    ServeInstall: legacy,
    ServeStart: legacy,
    ServeStop: legacy,
    ServeRestart: legacy,
    ServeStatus: legacy,
    ServeLogs: legacy,
    ServeUninstall: legacy,
    WebConfigure: legacy,
    WebPair: legacy,
    WebRevoke: legacy,
    Gateway: legacy,
    UnsupportedResidentAlias: legacy,
    Open: legacy,
  });

const reportFailure = (message: string) => Console.error(message).pipe(Effect.as(1));

const program = Effect.gen(function* () {
  const command = yield* decodeCliCommand(process.argv.slice(2));

  return yield* dispatch(command);
}).pipe(
  // Typed failures print one line and exit 1; a few tags carry detail beyond their message.
  Effect.catchTags({
    TerminalInteractionFailed: (failure) =>
      reportFailure(`terminal interaction failed during ${failure.operation}`),
    ProfileTargetNotDirectory: (failure) =>
      reportFailure(`profile target is not a directory: ${failure.path}`),
    ProfileFileSystemError: (failure) =>
      reportFailure(`failed to ${failure.operation} ${failure.path}: ${failure.message}`),
    ProfileExtensionPreflightFailed: (failure) =>
      reportFailure(renderProfileExtensionFailure(failure)),
    ProfileExtensionLockFailed: (failure) => reportFailure(renderProfileExtensionFailure(failure)),
    ProfileExtensionRollbackFailed: (failure) =>
      reportFailure(renderProfileExtensionFailure(failure)),
    SessionHeld: (failure) =>
      reportFailure(
        `this session is open in another process${failure.pid === undefined ? "" : ` (pid ${failure.pid})`}; use the UI, or start a new session`,
      ),
  }),
  Effect.catch((failure) => reportFailure(failure.message)),
  Effect.flatMap(exitWith),
);

BunRuntime.runMain(
  program,
  isForegroundResidentArguments(process.argv.slice(2))
    ? {
        teardown: (exit, onExit) => {
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) onExit(0);
          else Runtime.defaultTeardown(exit, onExit);
        },
      }
    : undefined,
);
