import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Logger, Match, Runtime } from "effect";
import packageJson from "../package.json" with { type: "json" };
import {
  AgentsCommandsLayer,
  AutomationsCommandsLayer,
  ExtensionsCommandsLayer,
  MemoryCommandsLayer,
  ModelsCommandsLayer,
  ProfileCommandsLayer,
  ResidentCommandsLayer,
  RunCommandsLayer,
  ServeCommandsLayer,
  SessionsCommandsLayer,
  UpdateCommandsLayer,
} from "./composition";
import { exitWith } from "./faces/cli-exit";
import type { CliCommand } from "./faces/cli-command";
import { decodeCliCommand, isForegroundResidentArguments, renderHelp } from "./faces/cli";
import { type AgentsCommand, runAgentsCommand } from "./faces/commands/agents";
import { type AutomationsCommand, runAutomationsCommand } from "./faces/commands/automations";
import { type ExtensionsCommand, runExtensionsCommand } from "./faces/commands/extensions";
import { type MemoryCommand, runMemoryCommand } from "./faces/commands/memory";
import { type ModelsCommand, runModelsCommand } from "./faces/commands/models";
import { type ProfileCommand, runProfileCommand } from "./faces/commands/profile";
import { type ResidentCommand, runResidentCommand } from "./faces/commands/resident";
import { type RunCommand, runRunCommand } from "./faces/commands/run";
import { type ServeCommand, runServeCommand } from "./faces/commands/serve";
import { type SessionsCommand, runSessionsCommand } from "./faces/commands/sessions";
import { type UpdateCommand, runUpdateCommand } from "./faces/commands/update";
import { renderProfileExtensionFailure } from "./faces/extensions-cli";

// Each command area builds only its own layer.
const profileArea = (command: ProfileCommand) =>
  runProfileCommand(command).pipe(Effect.provide(ProfileCommandsLayer));

const updateArea = (command: UpdateCommand) =>
  runUpdateCommand(command).pipe(Effect.provide(UpdateCommandsLayer));

const extensionsArea = (command: ExtensionsCommand) =>
  runExtensionsCommand(command).pipe(Effect.provide(ExtensionsCommandsLayer));

const agentsArea = (command: AgentsCommand) =>
  runAgentsCommand(command).pipe(Effect.provide(AgentsCommandsLayer));

const runArea = (command: RunCommand) =>
  runRunCommand(command).pipe(Effect.provide(RunCommandsLayer));

const automationsArea = (command: AutomationsCommand) =>
  runAutomationsCommand(command).pipe(Effect.provide(AutomationsCommandsLayer));

const residentArea = (command: ResidentCommand) =>
  runResidentCommand(command).pipe(Effect.provide(ResidentCommandsLayer));

const serveArea = (command: ServeCommand) =>
  runServeCommand(command).pipe(Effect.provide(ServeCommandsLayer));

const modelsArea = (command: ModelsCommand) =>
  runModelsCommand(command).pipe(Effect.provide(ModelsCommandsLayer));

const sessionsArea = (command: SessionsCommand) =>
  runSessionsCommand(command).pipe(Effect.provide(SessionsCommandsLayer));

const memoryArea = (command: MemoryCommand) =>
  runMemoryCommand(command).pipe(Effect.provide(MemoryCommandsLayer));

// Every command maps to its area runner.
const dispatch = (command: CliCommand) =>
  Match.valueTags(command, {
    Help: (command) => Console.log(renderHelp(command.topic)),
    Version: () => Console.log(packageJson.version),
    ModelsStatus: modelsArea,
    ModelsList: modelsArea,
    ModelsSet: modelsArea,
    Update: updateArea,
    Init: profileArea,
    Profiles: profileArea,
    ExtensionsList: extensionsArea,
    ExtensionsShow: extensionsArea,
    ExtensionsManage: extensionsArea,
    ExtensionsAdd: extensionsArea,
    ExtensionsRemove: extensionsArea,
    ExtensionsUpdate: extensionsArea,
    AuthStatus: profileArea,
    AuthLogin: profileArea,
    Doctor: profileArea,
    AgentsCreate: agentsArea,
    AgentsList: agentsArea,
    AgentsShow: agentsArea,
    AgentsValidate: agentsArea,
    AgentsRun: agentsArea,
    Run: runArea,
    Acp: runArea,
    AutomationsCreate: automationsArea,
    AutomationsList: automationsArea,
    AutomationsPause: automationsArea,
    AutomationsResume: automationsArea,
    AutomationsValidate: automationsArea,
    AutomationsStatus: automationsArea,
    AutomationsRuns: automationsArea,
    Wake: automationsArea,
    SessionsList: sessionsArea,
    SessionsShow: sessionsArea,
    MemoryList: memoryArea,
    MemoryShow: memoryArea,
    Serve: serveArea,
    ServeInstall: residentArea,
    ServeStart: residentArea,
    ServeStop: residentArea,
    ServeRestart: residentArea,
    ServeStatus: residentArea,
    ServeLogs: residentArea,
    ServeUninstall: residentArea,
    WebConfigure: residentArea,
    WebPair: residentArea,
    WebRevoke: residentArea,
    Gateway: serveArea,
    UnsupportedResidentAlias: residentArea,
    Open: residentArea,
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
    ExtensionLoadFailed: (failure) => reportFailure(renderProfileExtensionFailure(failure)),
    ExtensionLockFailed: (failure) => reportFailure(renderProfileExtensionFailure(failure)),
    ExtensionUpdateError: (failure) => reportFailure(renderProfileExtensionFailure(failure)),
    SessionHeld: (failure) =>
      reportFailure(
        `this session is open in another process${failure.pid === undefined ? "" : ` (pid ${failure.pid})`}; use the UI, or start a new session`,
      ),
  }),
  Effect.catch((failure) => reportFailure(failure.message)),
  Effect.flatMap(exitWith),
  // stdout carries command output and the ACP protocol; logs never share it.
  Effect.provideService(Logger.LogToStderr, true),
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
