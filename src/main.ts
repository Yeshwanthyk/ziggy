import { homedir } from "node:os";
import * as path from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Clock, Effect, Exit, Layer, Runtime } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { makePiAgentLive } from "./adapters/pi/pi-agent";
import { terminalAuthInteraction } from "./adapters/terminal/auth-interaction";
import { ZiggyAgent, ZiggyAgentLive } from "./application/agent";
import { Auth, AuthLive } from "./application/auth";
import {
  AutomationDefinitions,
  AutomationDefinitionsLive,
} from "./application/automation-definitions";
import { AutomationScheduler, AutomationSchedulerLive } from "./application/automation-scheduler";
import { Automations, AutomationsLive } from "./application/automations";
import { DiscordGatewayLive } from "./application/discord-gateway";
import { GatewayLive } from "./application/gateway";
import { Models, ModelsLive } from "./application/models";
import { ProfileAgents, ProfileAgentsLive } from "./application/profile-agents";
import { Profiles, ProfilesLive } from "./application/profiles";
import { ResidentGateway, ResidentGatewayLive } from "./application/resident-gateway";
import { Sessions, SessionsLive } from "./application/sessions";
import { SlackGatewayLive } from "./application/slack-gateway";
import { validateAutomationId } from "./domain/automation";
import {
  resolveProfileTarget,
  resolveProfilesDirectory,
  resolveProfilesRegistry,
} from "./domain/profile";
import {
  renderProfileAgent,
  renderProfileAgents,
  renderProfileAgentValidation,
} from "./faces/agents-cli";
import {
  renderAutomationCreated,
  renderAutomationDefinitions,
  renderAutomationOutcome,
  renderAutomationRuns,
  renderAutomationStatus,
  renderAutomationValidation,
} from "./faces/automation-cli";
import { decodeCliCommand, renderHelp } from "./faces/cli";
import { renderModelSelection, renderModels, renderModelStatus } from "./faces/models-cli";
import { renderSession, renderSessionList } from "./faces/sessions-cli";

const resolutionOptions = {
  cwd: process.cwd(),
  homedir: homedir(),
  ziggyHome: process.env.ZIGGY_HOME,
};

const repositoryRoot = path.resolve(import.meta.dir, "..");
const PiAgentLive = makePiAgentLive(repositoryRoot);
const AgentLive = ZiggyAgentLive.pipe(Layer.provide(PiAgentLive));
const AutomationsProvided = AutomationsLive.pipe(Layer.provide(AgentLive));
const ProfileAgentsProvided = ProfileAgentsLive.pipe(
  Layer.provide(Layer.merge(AgentLive, ModelsLive)),
);
const SchedulerProvided = AutomationSchedulerLive.pipe(Layer.provide(AutomationsProvided));
const ResidentProvided = ResidentGatewayLive.pipe(
  Layer.provide(
    Layer.merge(
      SchedulerProvided,
      Layer.merge(
        GatewayLive.pipe(Layer.provide(AgentLive)),
        Layer.merge(
          DiscordGatewayLive.pipe(Layer.provide(AgentLive)),
          SlackGatewayLive.pipe(Layer.provide(AgentLive)),
        ),
      ),
    ),
  ),
);

const fail = (message: string) =>
  Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });

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
  const profileAgents = yield* ProfileAgents;
  const automationDefinitions = yield* AutomationDefinitions;
  const automations = yield* Automations;
  const automationScheduler = yield* AutomationScheduler;
  const residentGateway = yield* ResidentGateway;
  const sessions = yield* Sessions;

  switch (command._tag) {
    case "Init": {
      const result = yield* profiles.initProfile(
        resolveProfileTarget(command.target, resolutionOptions),
      );
      yield* profiles
        .registerProfile(resolveProfilesRegistry(resolutionOptions), result.path)
        .pipe(Effect.catch(() => Effect.void));
      console.log(
        result.created
          ? `created profile at ${result.path}`
          : `profile already initialized at ${result.path}`,
      );
      return;
    }
    case "Profiles": {
      const listings = yield* profiles.listProfiles(
        resolveProfilesDirectory(resolutionOptions),
        resolveProfilesRegistry(resolutionOptions),
      );
      if (listings.length === 0) {
        console.log("no profiles yet — try: ziggy init <name>");
        return;
      }
      for (const profile of listings) console.log(`${profile.name}\t${profile.path}`);
      return;
    }
    case "SkillsList": {
      const listing = yield* profiles.listSkills(
        resolveProfileTarget(command.target, resolutionOptions),
        repositoryRoot,
      );
      console.log("installed:");
      if (listing.installed.length === 0) console.log("(none)");
      else for (const skill of listing.installed) console.log(skill.id);
      console.log("available:");
      if (listing.available.length === 0) console.log("(none)");
      else for (const skill of listing.available) console.log(skill.id);
      return;
    }
    case "SkillsAdd": {
      const installed = yield* profiles.addSkill(
        resolveProfileTarget(command.target, resolutionOptions),
        repositoryRoot,
        command.source,
        resolutionOptions.cwd,
        command.force,
      );
      console.log(
        `${installed.replaced ? "replaced" : "installed"} ${installed.id} at ${installed.destinationPath}`,
      );
      return;
    }
    case "ExtensionsList": {
      const extensions = yield* profiles.listExtensions(repositoryRoot);
      for (const extension of extensions) {
        console.log(
          `${extension.id}\t${extension.kind}\t${extension.required ? "required" : "optional"}\t${extension.description}`,
        );
      }
      return;
    }
    case "ExtensionsShow": {
      const extension = yield* profiles.showExtension(repositoryRoot, command.id);
      console.log(`id\t${extension.id}`);
      console.log(`kind\t${extension.kind}`);
      console.log(`status\t${extension.required ? "required" : "optional"}`);
      console.log(`description\t${extension.description}`);
      console.log(`path\t${path.relative(repositoryRoot, extension.packagePath)}`);
      for (const skill of extension.skills) {
        console.log(`skill\t${skill.name} — ${skill.description}`);
      }
      for (const extensionPath of extension.extensionPaths) {
        console.log(`executable\t${path.relative(repositoryRoot, extensionPath)}`);
      }
      return;
    }
    case "ExtensionsAdd":
    case "ExtensionsRemove": {
      const target = resolveProfileTarget(command.target, resolutionOptions);
      const result = yield* command._tag === "ExtensionsAdd"
        ? profiles.addExtension(target, repositoryRoot, command.id)
        : profiles.removeExtension(target, repositoryRoot, command.id);
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
      console.log(renderProfileAgents(listed));
      return;
    }
    case "AgentsShow": {
      const shown = yield* profileAgents.show(
        resolveProfileTarget(command.target, resolutionOptions),
        command.agentId,
      );
      console.log(renderProfileAgent(shown));
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
      const exitCode = yield* agent.runOnce(
        resolveProfileTarget(command.target, resolutionOptions),
        command.prompt,
        command.continueSession,
        { kind: "local" },
      );
      process.exitCode = exitCode;
      return;
    }
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
      console.log(renderAutomationDefinitions(listed));
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
      console.log(renderAutomationStatus(status));
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
      console.log(renderAutomationRuns(runs, yield* Clock.currentTimeMillis));
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
      console.log(renderSessionList(listed));
      return;
    }
    case "SessionsShow": {
      const shown = yield* sessions.show(
        resolveProfileTarget(command.target, resolutionOptions),
        command.reference,
      );
      console.log(renderSession(shown));
      return;
    }
    case "Gateway":
      return yield* residentGateway.run(resolveProfileTarget(command.target, resolutionOptions));
    case "UnsupportedResidentAlias":
      return yield* fail(
        `ziggy ${command.name} is no longer a resident command; use: ziggy gateway <name|path>`,
      );
    case "Tui":
      process.exitCode = yield* agent.openTui(
        resolveProfileTarget(command.target, resolutionOptions),
        { kind: "local" },
      );
      return;
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
    ProfileAgentInvalid: (failure) => fail(failure.message),
    SpecialistAgentNotFound: (failure) => fail(failure.message),
    SpecialistProviderUnsupported: (failure) => fail(failure.message),
    SpecialistModelUnsupported: (failure) => fail(failure.message),
    SpecialistAuthUnavailable: (failure) => fail(failure.message),
    SpecialistThinkingUnsupported: (failure) => fail(failure.message),
    SpecialistToolUnsupported: (failure) => fail(failure.message),
    SpecialistRunFailed: (failure) => fail(failure.message),
    ProfileSkillInvalid: (failure) => fail(failure.message),
    ProfileSkillNotFound: (failure) => fail(failure.message),
    ProfileSkillExists: (failure) => fail(failure.message),
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
    MemoryIdInvalid: (failure) => fail(failure.message),
    AutomationInvalid: (failure) => fail(failure.message),
    AutomationNotFound: (failure) => fail(failure.message),
    AutomationFileSystemError: (failure) => fail(failure.message),
    AutomationGateFailed: (failure) => fail(failure.message),
    AutomationDatabaseError: (failure) => fail(failure.message),
    AutomationProjectionError: (failure) => fail(failure.message),
    AutomationSchedulerError: (failure) => fail(failure.message),
    GatewayConfigError: (failure) => fail(failure.message),
    GatewayOwnerError: (failure) => fail(failure.message),
    SessionReadFailed: (failure) => fail(failure.message),
    SessionNotFound: (failure) => fail(failure.message),
  }),
  Effect.provide(
    Layer.merge(
      ProfilesLive,
      Layer.merge(
        AutomationDefinitionsLive,
        Layer.merge(
          AuthLive,
          Layer.merge(
            ModelsLive,
            Layer.merge(
              ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)),
              Layer.merge(
                GatewayLive.pipe(Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive)))),
                Layer.merge(
                  DiscordGatewayLive.pipe(
                    Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))),
                  ),
                  Layer.merge(
                    SlackGatewayLive.pipe(
                      Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))),
                    ),
                    Layer.merge(
                      AutomationsLive.pipe(
                        Layer.provide(ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))),
                      ),
                      Layer.merge(
                        ProfileAgentsProvided,
                        Layer.merge(
                          SessionsLive,
                          Layer.merge(SchedulerProvided, ResidentProvided),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
  ...(process.argv[2] === "gateway"
    ? {
        teardown: (exit, onExit) => {
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) onExit(0);
          else Runtime.defaultTeardown(exit, onExit);
        },
      }
    : {}),
});
