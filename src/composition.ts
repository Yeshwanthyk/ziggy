import { Effect, Layer } from "effect";
import { ProfileExtensionMutationLockLive } from "./adapters/bun/profile-extension-lock";
import { ResidentServiceOperationsLive } from "./adapters/bun/resident-service-operations";
import { ZiggyPathsLive } from "./platform/paths";
import { MemoryFilesLive } from "./adapters/fs/memory-files";
import { ZiggyReleaseClientLive } from "./adapters/github/self-update";
import { DoctorChecksLive } from "./adapters/pi/doctor-checks";
import { memoryTools } from "./adapters/pi/memory-write-tool";
import {
  listProfileExtensionsWithHealth,
  ProfileExtensionPreflightLive,
} from "./adapters/pi/profile-extension-preflight";
import { PiStandaloneRuntimeLive } from "./adapters/pi/standalone-runtime";
import { agentTools } from "./adapters/pi/specialist";
import { extensionTools } from "./adapters/pi/profile-extension-tool";
import { ZiggyAgent } from "./application/agent";
import { AutomationDefinitionsLive } from "./application/automation-definitions";
import { AutomationSchedulerLive } from "./application/automation-scheduler";
import { AutomationsLive } from "./application/automations";
import { DiscordGatewayLive } from "./application/discord-gateway";
import { DoctorLive } from "./application/doctor";
import { ExtensionUpdateLive } from "./application/extension-update";
import { GatewayLive } from "./application/gateway";
import { MemoryLive } from "./application/memory";
import { ProfileAgentsLive } from "./application/profile-agents";
import { ProfileExtensions, ProfileExtensionsLive } from "./application/profile-extensions";
import { ExtensionHealth, ResidentGatewayLive } from "./application/resident-gateway";
import { ResidentServiceLive } from "./application/resident-service";
import { SelfUpdateLive } from "./application/self-update";
import { SetupLive } from "./application/setup";
import { SlackGatewayLive } from "./application/slack-gateway";
import { TerminalStyle } from "./faces/terminal-ui";
import { Auth, Models, Profiles } from "./profile";
import { makeZiggyAgent, Sessions } from "./session";

// The composition root: the one place adapter layers close application ports. Each layer is
// named once and shared by reference, so Effect builds each service once per program.

const ProfileExtensionsLayer = ProfileExtensionsLive.pipe(
  Layer.provide(Layer.mergeAll(ProfileExtensionPreflightLive, ProfileExtensionMutationLockLive)),
);

/** The agent every face and gateway talks to, backed by the Pi SDK adapter. */
const ZiggyAgentLayer = Layer.effect(
  ZiggyAgent,
  Effect.map(ProfileExtensions, (extensions) =>
    makeZiggyAgent({
      extensions,
      tools: [memoryTools, extensionTools(extensions), agentTools],
    }),
  ),
).pipe(Layer.provide(ProfileExtensionsLayer));

const DoctorLayer = DoctorLive.pipe(
  Layer.provide(Layer.mergeAll(Auth.layer, Models.layer, ProfileExtensionsLayer, DoctorChecksLive)),
);

const SetupLayer = SetupLive.pipe(
  Layer.provide(Layer.mergeAll(Profiles.layer, Auth.layer, Models.layer, DoctorLayer)),
);

const AutomationsLayer = AutomationsLive.pipe(Layer.provide(ZiggyAgentLayer));

const AutomationSchedulerLayer = AutomationSchedulerLive.pipe(Layer.provide(AutomationsLayer));

const ProfileAgentsLayer = ProfileAgentsLive.pipe(
  Layer.provide(Layer.merge(ZiggyAgentLayer, Models.layer)),
);

const MemoryLayer = MemoryLive.pipe(Layer.provide(MemoryFilesLive));

const SelfUpdateLayer = SelfUpdateLive.pipe(Layer.provide(ZiggyReleaseClientLive));

const ResidentGatewayLayer = ResidentGatewayLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      GatewayLive.pipe(Layer.provide(ZiggyAgentLayer)),
      DiscordGatewayLive.pipe(Layer.provide(ZiggyAgentLayer)),
      SlackGatewayLive.pipe(Layer.provide(ZiggyAgentLayer)),
      ZiggyAgentLayer,
      AutomationSchedulerLayer,
      AutomationsLayer,
      AutomationDefinitionsLive,
      Sessions.layer,
      ProfileExtensionsLayer,
      ProfileAgentsLayer,
      Models.layer,
      Auth.layer,
      DoctorLayer,
      MemoryLayer,
      Layer.succeed(ExtensionHealth, listProfileExtensionsWithHealth),
      ZiggyPathsLive,
    ),
  ),
);

const ResidentServiceLayer = ResidentServiceLive.pipe(
  Layer.provide(
    ResidentServiceOperationsLive.pipe(
      Layer.provide(Layer.mergeAll(ResidentGatewayLayer, AutomationSchedulerLayer, ZiggyPathsLive)),
    ),
  ),
);

const ExtensionUpdateLayer = ExtensionUpdateLive.pipe(
  Layer.provide(
    Layer.mergeAll(ProfileExtensionsLayer, ProfileExtensionMutationLockLive, ResidentServiceLayer),
  ),
);

const ResidentLayer = Layer.mergeAll(
  ResidentGatewayLayer,
  ResidentServiceLayer,
  ExtensionUpdateLayer,
);

/** Every service the CLI commands use, with Pi's standalone registrations installed first. */
export const CliLayer = Layer.mergeAll(
  Profiles.layer,
  ZiggyAgentLayer,
  Auth.layer,
  Models.layer,
  DoctorLayer,
  SetupLayer,
  ProfileAgentsLayer,
  AutomationDefinitionsLive,
  AutomationsLayer,
  AutomationSchedulerLayer,
  Sessions.layer,
  ProfileExtensionsLayer,
  SelfUpdateLayer,
  MemoryLayer,
  ResidentLayer,
  ZiggyPathsLive,
  TerminalStyle.layer,
).pipe(Layer.provide(PiStandaloneRuntimeLive));

/** `ziggy models ...`: the model catalog and a Profile's selection. */
export const ModelsCommandsLayer = Layer.mergeAll(Models.layer, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

/** `ziggy sessions ...`: a Profile's session history. */
export const SessionsCommandsLayer = Layer.mergeAll(Sessions.layer, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

/** `ziggy memory ...`: a Profile's memory files, read-only. */
export const MemoryCommandsLayer = Layer.mergeAll(MemoryLayer, ZiggyPathsLive);
