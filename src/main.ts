import { homedir } from "node:os";
import * as path from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Clock, Effect, Exit, Layer, Runtime } from "effect";
import packageJson from "../package.json" with { type: "json" };
import type {
  AutomationTuiFailureCategory,
  AutomationTuiHandler,
  AutomationTuiResponse,
} from "./adapters/pi/automation-tui";
import { makePiAgent, PiAgent } from "./adapters/pi/pi-agent";
import { ProfileExtensionPreflightLive } from "./adapters/pi/profile-extension-preflight";
import { ProfileExtensionMutationLockLive } from "./adapters/bun/profile-extension-lock";
import { bootstrapPiStandaloneRuntime } from "./adapters/pi/standalone-runtime";
import { terminalAuthInteraction } from "./adapters/terminal/auth-interaction";
import { terminalSetupInteraction } from "./adapters/terminal/setup-interaction";
import { ZiggyAgent, ZiggyAgentLive } from "./application/agent";
import { Auth, AuthLive } from "./application/auth";
import {
  AutomationDefinitions,
  AutomationDefinitionsLive,
} from "./application/automation-definitions";
import { AutomationScheduler, AutomationSchedulerLive } from "./application/automation-scheduler";
import { Automations, AutomationsLive } from "./application/automations";
import { ProfileExtensions, ProfileExtensionsLive } from "./application/profile-extensions";
import { DiscordGatewayLive } from "./application/discord-gateway";
import { Doctor, DoctorLive } from "./application/doctor";
import { GatewayLive } from "./application/gateway";
import { Models, ModelsLive } from "./application/models";
import { Memory, MemoryLive } from "./application/memory";
import { ProfileAgents, ProfileAgentsLive } from "./application/profile-agents";
import { Profiles, ProfilesLive } from "./application/profiles";
import { ResidentGateway, makeResidentGatewayLive } from "./application/resident-gateway";
import { ResidentService, ResidentServiceLive } from "./application/resident-service";
import { Sessions, SessionsLive } from "./application/sessions";
import { SelfUpdate, SelfUpdateLive } from "./application/self-update";
import { SlackGatewayLive } from "./application/slack-gateway";
import { Setup, SetupLive } from "./application/setup";
import { validateAutomationId } from "./domain/automation";
import { parseMemoryScopeReference } from "./domain/memory";
import {
  resolveProfileTarget,
  resolveProfilesDirectory,
  resolveProfilesRegistry,
} from "./domain/profile";
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
  renderAutomationTransition,
  renderAutomationValidation,
} from "./faces/automation-cli";
import { decodeCliCommand, isForegroundResidentArguments, renderHelp } from "./faces/cli";
import { renderDoctor } from "./faces/doctor-cli";
import {
  renderExtensionJson,
  renderExtensionsJson,
  renderProfileExtensionFailure,
} from "./faces/extensions-cli";
import { renderModelSelection, renderModels, renderModelStatus } from "./faces/models-cli";
import {
  renderMemoryList,
  renderMemoryListJson,
  renderMemoryShow,
  renderMemoryShowJson,
} from "./faces/memory-cli";
import { renderProfilesJson } from "./faces/profiles-cli";
import { runAcp } from "./faces/acp";
import {
  renderSession,
  renderSessionJson,
  renderSessionList,
  renderSessionListJson,
} from "./faces/sessions-cli";
import { renderResidentLifecycle, renderResidentLogs, renderServeStatus } from "./faces/serve-cli";
import { ExtensionArchiveClientLive } from "./adapters/github/extension-catalog";
import { ZiggyReleaseClientLive } from "./adapters/github/self-update";
import { MemoryFilesLive } from "./adapters/fs/memory-files";

const resolutionOptions = {
  cwd: process.cwd(),
  homedir: homedir(),
  ziggyHome: process.env.ZIGGY_HOME,
};

bootstrapPiStandaloneRuntime();

const repositoryRoot = path.resolve(import.meta.dir, "..");
const ProfileExtensionsProvided = ProfileExtensionsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ExtensionArchiveClientLive,
      ProfileExtensionPreflightLive,
      ProfileExtensionMutationLockLive,
    ),
  ),
);
const PiAgentLive = Layer.effect(
  PiAgent,
  Effect.gen(function* () {
    return makePiAgent(repositoryRoot, yield* ProfileExtensions);
  }),
).pipe(Layer.provide(ProfileExtensionsProvided));
const AgentLive = ZiggyAgentLive.pipe(Layer.provide(PiAgentLive));
const AutomationsProvided = AutomationsLive.pipe(Layer.provide(AgentLive));
const ProfileAgentsProvided = ProfileAgentsLive.pipe(
  Layer.provide(Layer.merge(AgentLive, ModelsLive)),
);
const SchedulerProvided = AutomationSchedulerLive.pipe(Layer.provide(AutomationsProvided));
const ResidentProvided = makeResidentGatewayLive(
  repositoryRoot,
  resolveProfilesRegistry(resolutionOptions),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      SchedulerProvided,
      GatewayLive.pipe(Layer.provide(AgentLive)),
      DiscordGatewayLive.pipe(Layer.provide(AgentLive)),
      SlackGatewayLive.pipe(Layer.provide(AgentLive)),
      AgentLive,
      SessionsLive,
      ProfileExtensionsProvided,
    ),
  ),
);
const ResidentServiceProvided = ResidentServiceLive.pipe(
  Layer.provide(Layer.merge(ResidentProvided, SchedulerProvided)),
);
const SelfUpdateProvided = SelfUpdateLive.pipe(Layer.provide(ZiggyReleaseClientLive));

const fail = (message: string) =>
  Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });

interface AutomationTuiOperationFailure {
  readonly _tag: string;
  readonly message: string;
}

const automationTuiFailure = (failure: AutomationTuiOperationFailure): AutomationTuiResponse => {
  const category: AutomationTuiFailureCategory =
    failure._tag === "AutomationInvalid"
      ? "invalid"
      : failure._tag === "AutomationEditConflict"
        ? "changed"
        : failure._tag === "AutomationNotFound" || failure._tag === "AutomationPaused"
          ? "not-found"
          : "unavailable";
  return { kind: "failure", category, message: failure.message };
};

const program = Effect.gen(function* () {
  const command = yield* decodeCliCommand(process.argv.slice(2));

  if (command._tag === "Help") {
    console.log(renderHelp(command.topic));
    return;
  }
  if (command._tag === "Version") {
    console.log(packageJson.version);
    return;
  }

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
  const memory = yield* Memory;

  switch (command._tag) {
    case "Init": {
      const target = resolveProfileTarget(command.target, resolutionOptions);
      const initOptions = {
        minimal: command.minimal,
        interactive:
          !command.nonInteractive && process.stdin.isTTY === true && process.stdout.isTTY === true,
        ...Object.fromEntries(
          [
            command.providerId !== undefined
              ? (["providerId", command.providerId] as const)
              : undefined,
            command.modelId !== undefined ? (["modelId", command.modelId] as const) : undefined,
            command.thinking !== undefined ? (["thinking", command.thinking] as const) : undefined,
          ].flatMap((entry) => (entry === undefined ? [] : [entry])),
        ),
      };
      const result = yield* setup.initialize(
        target,
        resolveProfilesRegistry(resolutionOptions),
        repositoryRoot,
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
        console.log(`next: ziggy tui ${JSON.stringify(result.profilePath)}`);
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
          process.exitCode = rendered.exitCode;
          console.error(
            `setup incomplete; resume with: ziggy init ${JSON.stringify(result.profilePath)}`,
          );
          return;
        }
      }
      console.log(`ready: ziggy tui ${JSON.stringify(result.profilePath)}`);
      return;
    }
    case "Profiles": {
      const listings = yield* profiles.listProfiles(
        resolveProfilesDirectory(resolutionOptions),
        resolveProfilesRegistry(resolutionOptions),
      );
      if (command.json) {
        console.log(renderProfilesJson(listings));
        return;
      }
      if (listings.length === 0) {
        console.log("no profiles yet — try: ziggy init <name>");
        return;
      }
      for (const profile of listings) console.log(`${profile.name}\t${profile.path}`);
      return;
    }
    case "ExtensionsList": {
      const extensions = yield* profileExtensions.list(repositoryRoot);
      if (command.json) {
        console.log(renderExtensionsJson(extensions));
        return;
      }
      for (const extension of extensions) {
        console.log(
          `${extension.id}\t${extension.kind}\t${extension.required ? "required" : "optional"}\t${extension.source}\t${extension.description}`,
        );
      }
      return;
    }
    case "ExtensionsShow": {
      const extension = yield* profileExtensions.show(repositoryRoot, command.id);
      if (command.json) {
        console.log(renderExtensionJson(extension));
        return;
      }
      console.log(`id\t${extension.id}`);
      console.log(`kind\t${extension.kind}`);
      console.log(`status\t${extension.required ? "required" : "optional"}`);
      console.log(`description\t${extension.description}`);
      console.log(`source\t${extension.source}`);
      console.log(`version\t${extension.version}`);
      console.log(`installed\t${extension.installed ? "yes" : "no"}`);
      if (extension.packagePath !== undefined) {
        console.log(
          `path\t${path.isAbsolute(extension.packagePath) ? path.relative(repositoryRoot, extension.packagePath) : extension.packagePath}`,
        );
      }
      for (const skill of extension.skills ?? []) {
        console.log(`skill\t${skill.name} — ${skill.description}`);
      }
      for (const extensionPath of extension.extensionPaths ?? []) {
        console.log(
          `executable\t${path.isAbsolute(extensionPath) ? path.relative(repositoryRoot, extensionPath) : extensionPath}`,
        );
      }
      return;
    }
    case "ExtensionsAdd":
    case "ExtensionsRemove": {
      const target = resolveProfileTarget(command.target, resolutionOptions);
      const result = yield* command._tag === "ExtensionsAdd"
        ? profileExtensions.add(target, repositoryRoot, command.id)
        : profileExtensions.remove(target, repositoryRoot, command.id);
      if (!result.changed) {
        console.log(
          `${result.id} is ${result.selected ? "already selected" : "not selected"} for ${result.profilePath}`,
        );
        return;
      }
      console.log(
        `${result.selected ? "selected" : "unselected"} ${result.id} for ${result.profilePath}`,
      );
      console.log("reopen the Profile or restart its Ziggy process to apply the change");
      return;
    }
    case "Update": {
      const updated = yield* selfUpdate.update();
      console.log(`updated Ziggy at ${updated.path} (${updated.version})`);
      return;
    }
    case "AuthStatus": {
      const statuses = yield* auth.status(resolveProfileTarget(command.target, resolutionOptions));
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
        resolveProfileTarget(command.target, resolutionOptions),
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
        resolveProfileTarget(command.target, resolutionOptions),
        command.agentId,
      );
      console.log(`created Profile agent ${created.id} at ${created.path}`);
      return;
    }
    case "AgentsList": {
      const listed = yield* profileAgents.list(
        resolveProfileTarget(command.target, resolutionOptions),
      );
      console.log(command.json ? renderProfileAgentsJson(listed) : renderProfileAgents(listed));
      return;
    }
    case "AgentsShow": {
      const shown = yield* profileAgents.show(
        resolveProfileTarget(command.target, resolutionOptions),
        command.agentId,
      );
      console.log(command.json ? renderProfileAgentJson(shown) : renderProfileAgent(shown));
      return;
    }
    case "AgentsValidate": {
      const validation = yield* profileAgents.validate(
        resolveProfileTarget(command.target, resolutionOptions),
        command.agentId,
      );
      console.log(renderProfileAgentValidation(validation));
      if (validation.some((item) => !item.valid)) process.exitCode = 1;
      return;
    }
    case "AgentsRun": {
      const result = yield* profileAgents.run(
        resolveProfileTarget(command.target, resolutionOptions),
        command.agentId,
        command.prompt,
      );
      console.log(result.answer);
      return;
    }
    case "Run": {
      const target = resolveProfileTarget(command.target, resolutionOptions);
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
      process.exitCode = exitCode;
      return;
    }
    case "Acp":
      return yield* runAcp(
        resolveProfileTarget(command.target, resolutionOptions),
        command.shared,
        agent,
        models,
        command.agent,
      );
    case "AutomationsCreate": {
      const created = yield* automationDefinitions.create(
        resolveProfileTarget(command.target, resolutionOptions),
        command.automationId,
      );
      console.log(renderAutomationCreated(created));
      return;
    }
    case "AutomationsList": {
      const listed = yield* automationDefinitions.list(
        resolveProfileTarget(command.target, resolutionOptions),
      );
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
        ? automationDefinitions.pause(
            resolveProfileTarget(command.target, resolutionOptions),
            command.automationId,
          )
        : automationDefinitions.resume(
            resolveProfileTarget(command.target, resolutionOptions),
            command.automationId,
          );
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
        resolveProfileTarget(command.target, resolutionOptions),
        command.automationId,
      );
      console.log(renderAutomationValidation(validation));
      if (validation.some((item) => !item.valid)) process.exitCode = 1;
      return;
    }
    case "AutomationsStatus": {
      const status = yield* automationScheduler.status(
        resolveProfileTarget(command.target, resolutionOptions),
      );
      console.log(
        command.json ? renderAutomationStatusJson(status) : renderAutomationStatus(status),
      );
      return;
    }
    case "AutomationsRuns": {
      const automationId =
        command.automationId === undefined
          ? undefined
          : yield* validateAutomationId(command.automationId);
      const runs = yield* automationScheduler.runs(
        resolveProfileTarget(command.target, resolutionOptions),
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
      const outcome = yield* automations.run(
        resolveProfileTarget(command.target, resolutionOptions),
        command.automationId,
        { kind: "manual-force" },
      );
      const rendered = renderAutomationOutcome(outcome);
      for (const line of rendered.stderr) console.error(line);
      process.exitCode = rendered.exitCode;
      return;
    }
    case "SessionsList": {
      const listed = yield* sessions.list(resolveProfileTarget(command.target, resolutionOptions));
      console.log(command.json ? renderSessionListJson(listed) : renderSessionList(listed));
      return;
    }
    case "SessionsShow": {
      const shown = yield* sessions.show(
        resolveProfileTarget(command.target, resolutionOptions),
        command.reference,
      );
      console.log(command.json ? renderSessionJson(shown) : renderSession(shown));
      return;
    }
    case "MemoryList": {
      const listed = yield* memory.list(
        resolveProfileTarget(command.target ?? ".", resolutionOptions),
      );
      console.log(command.json ? renderMemoryListJson(listed) : renderMemoryList(listed));
      return;
    }
    case "MemoryShow": {
      const shown = yield* memory.show(
        resolveProfileTarget(command.target, resolutionOptions),
        parseMemoryScopeReference(command.scope),
      );
      console.log(command.json ? renderMemoryShowJson(shown) : renderMemoryShow(shown));
      return;
    }
    case "ServeInstall": {
      const result = yield* residentService.install(
        resolveProfileTarget(command.target, resolutionOptions),
        { force: command.force, start: !command.noStart },
      );
      console.log(renderResidentLifecycle(result));
      if (result.ready === false) process.exitCode = 1;
      return;
    }
    case "ServeStart":
    case "ServeStop":
    case "ServeRestart":
    case "ServeUninstall": {
      const target = resolveProfileTarget(command.target, resolutionOptions);
      const result =
        command._tag === "ServeStart"
          ? yield* residentService.start(target)
          : command._tag === "ServeStop"
            ? yield* residentService.stop(target)
            : command._tag === "ServeRestart"
              ? yield* residentService.restart(target)
              : yield* residentService.uninstall(target);
      console.log(renderResidentLifecycle(result));
      if (result.ready === false) process.exitCode = 1;
      return;
    }
    case "ServeStatus": {
      const status = yield* residentService.status(
        resolveProfileTarget(command.target, resolutionOptions),
      );
      const rendered = renderServeStatus(status);
      console.log(rendered.text);
      process.exitCode = rendered.exitCode;
      return;
    }
    case "ServeLogs": {
      const logs = yield* residentService.logs(
        resolveProfileTarget(command.target, resolutionOptions),
        command.follow,
      );
      const rendered = renderResidentLogs(logs);
      if (rendered.length > 0) console.log(rendered);
      process.exitCode = logs.exitCode;
      return;
    }
    case "Serve":
    case "Gateway":
      return yield* residentGateway.run(resolveProfileTarget(command.target, resolutionOptions));
    case "UnsupportedResidentAlias":
      return yield* fail(
        `ziggy ${command.name} is no longer a resident command; use: ziggy serve <name|path>`,
      );
    case "Tui": {
      const target = resolveProfileTarget(command.target, resolutionOptions);
      const automationHandler: AutomationTuiHandler = (request) =>
        Effect.gen(function* () {
          switch (request.kind) {
            case "overview": {
              const [definitions, status] = yield* Effect.all(
                [automationDefinitions.list(target), automationScheduler.status(target)],
                { concurrency: 2 },
              );
              return {
                kind: "overview",
                definitions,
                statusText: renderAutomationStatus(status),
              } satisfies AutomationTuiResponse;
            }
            case "document": {
              const document = yield* automationDefinitions.show(target, request.id);
              return { kind: "document", ...document } satisfies AutomationTuiResponse;
            }
            case "save": {
              const document = yield* automationDefinitions.save(
                target,
                request.id,
                request.expectedSource,
                request.source,
              );
              return { kind: "saved", ...document } satisfies AutomationTuiResponse;
            }
            case "runs": {
              const automationId =
                request.id === undefined ? undefined : yield* validateAutomationId(request.id);
              const runs = yield* automationScheduler.runs(target, automationId);
              return {
                kind: "runs",
                text: renderAutomationRuns(runs, yield* Clock.currentTimeMillis),
                ...Object.fromEntries(
                  request.id === undefined ? [] : ([["automationId", request.id]] as const),
                ),
              } satisfies AutomationTuiResponse;
            }
            case "pause":
            case "resume": {
              const transitioned = yield* request.kind === "pause"
                ? automationDefinitions.pause(target, request.id)
                : automationDefinitions.resume(target, request.id);
              return {
                kind: "transitioned",
                ...transitioned,
              } satisfies AutomationTuiResponse;
            }
          }
        }).pipe(Effect.catch((failure) => Effect.succeed(automationTuiFailure(failure))));
      process.exitCode = yield* agent.openTui(target, { kind: "local" }, automationHandler);
      return;
    }
    case "Doctor": {
      const report = yield* doctor.check(
        resolveProfileTarget(command.target, resolutionOptions),
        repositoryRoot,
      );
      const rendered = renderDoctor(report);
      console.log(rendered.text);
      process.exitCode = rendered.exitCode;
      return;
    }
    case "ModelsStatus": {
      const status = yield* models.status(resolveProfileTarget(command.target, resolutionOptions));
      console.log(renderModelStatus(status));
      return;
    }
    case "ModelsList": {
      const listed = yield* models.list(
        resolveProfileTarget(command.target, resolutionOptions),
        command.providerId,
      );
      console.log(renderModels(listed));
      return;
    }
    case "ModelsSet": {
      const selection = yield* models.set(
        resolveProfileTarget(command.target, resolutionOptions),
        command.providerId,
        command.modelId,
        command.thinking,
      );
      console.log(renderModelSelection(selection));
      return;
    }
  }
}).pipe(
  Effect.catchTags({
    CliInputInvalid: (failure) => fail(failure.message),
    ProfileTargetNotDirectory: (failure) =>
      fail(`profile target is not a directory: ${failure.path}`),
    ProfileFileSystemError: (failure) =>
      fail(`failed to ${failure.operation} ${failure.path}: ${failure.message}`),
    ProfileExtensionInvalid: (failure) => fail(failure.message),
    ProfileExtensionPreflightFailed: (failure) => fail(renderProfileExtensionFailure(failure)),
    ProfileExtensionLockFailed: (failure) => fail(renderProfileExtensionFailure(failure)),
    ProfileExtensionRollbackFailed: (failure) => fail(renderProfileExtensionFailure(failure)),
    ProfileAgentInvalid: (failure) => fail(failure.message),
    SpecialistAgentNotFound: (failure) => fail(failure.message),
    SpecialistProviderUnsupported: (failure) => fail(failure.message),
    SpecialistModelUnsupported: (failure) => fail(failure.message),
    SpecialistAuthUnavailable: (failure) => fail(failure.message),
    SpecialistThinkingUnsupported: (failure) => fail(failure.message),
    SpecialistToolUnsupported: (failure) => fail(failure.message),
    SpecialistRunFailed: (failure) => fail(failure.message),
    ProfileNotInitialized: (failure) => fail(failure.message),
    ProviderConfigError: (failure) => fail(failure.message),
    ProviderCallError: (failure) => fail(failure.message),
    AuthProviderUnknown: (failure) => fail(failure.message),
    AuthTypeUnsupported: (failure) => fail(failure.message),
    AuthFlowFailed: (failure) => fail(failure.message),
    ModelProviderUnknown: (failure) => fail(failure.message),
    ModelUnknown: (failure) => fail(failure.message),
    ModelThinkingUnsupported: (failure) => fail(failure.message),
    ModelOperationFailed: (failure) => fail(failure.message),
    ModelSettingsWriteFailed: (failure) => fail(failure.message),
    SetupIncomplete: (failure) => fail(failure.message),
    MemoryIdInvalid: (failure) => fail(failure.message),
    MemoryDocumentInvalid: (failure) => fail(failure.message),
    MemoryFileSystemError: (failure) => fail(failure.message),
    AutomationInvalid: (failure) => fail(failure.message),
    AutomationNotFound: (failure) => fail(failure.message),
    AutomationPaused: (failure) => fail(failure.message),
    AutomationFileSystemError: (failure) => fail(failure.message),
    AutomationGateFailed: (failure) => fail(failure.message),
    AutomationDatabaseError: (failure) => fail(failure.message),
    AutomationProjectionError: (failure) => fail(failure.message),
    AutomationSchedulerError: (failure) => fail(failure.message),
    GatewayConfigError: (failure) => fail(failure.message),
    GatewayOwnerError: (failure) => fail(failure.message),
    ResidentServiceError: (failure) => fail(failure.message),
    SessionReadFailed: (failure) => fail(failure.message),
    SessionNotFound: (failure) => fail(failure.message),
    ExtensionCatalogInvalid: (failure) => fail(failure.message),
    ExtensionCatalogUnavailable: (failure) => fail(failure.message),
    ExtensionCatalogInstallFailed: (failure) => fail(failure.message),
    ZiggyUpdateUnavailable: (failure) => fail(failure.message),
    AcpFaceError: (failure) => fail(failure.message),
  }),
  Effect.provide(
    Layer.mergeAll(
      ProfilesLive,
      AutomationDefinitionsLive,
      AuthLive,
      ModelsLive,
      DoctorLive.pipe(
        Layer.provide(Layer.mergeAll(AuthLive, ModelsLive, ProfileExtensionsProvided)),
      ),
      SetupLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            ProfilesLive,
            AuthLive,
            ModelsLive,
            DoctorLive.pipe(
              Layer.provide(Layer.mergeAll(AuthLive, ModelsLive, ProfileExtensionsProvided)),
            ),
          ),
        ),
      ),
      ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)),
      GatewayLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
      DiscordGatewayLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
      SlackGatewayLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
      AutomationsLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
      ProfileAgentsProvided,
      SessionsLive,
      SchedulerProvided,
      ResidentProvided,
      ResidentServiceProvided,
      ProfileExtensionsProvided,
      SelfUpdateProvided,
      MemoryLive.pipe(Layer.provide(MemoryFilesLive)),
    ),
  ),
);

BunRuntime.runMain(
  program,
  isForegroundResidentArguments(process.argv.slice(2))
    ? {
        disableErrorReporting: true,
        teardown: (exit, onExit) => {
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) onExit(0);
          else Runtime.defaultTeardown(exit, onExit);
        },
      }
    : { disableErrorReporting: true },
);
