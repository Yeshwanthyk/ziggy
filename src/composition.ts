import { Effect, Layer } from "effect";
import { ProfileExtensionMutationLockLive } from "./adapters/bun/profile-extension-lock";
import { ResidentServiceOperationsLive } from "./adapters/bun/resident-service-operations";
import { ZiggyPathsLive } from "./adapters/bun/ziggy-paths";
import { MemoryFilesLive } from "./adapters/fs/memory-files";
import { ProfileStoreLive } from "./adapters/fs/profile-store";
import { ExtensionArchiveClientLive } from "./adapters/github/extension-catalog";
import { ZiggyReleaseClientLive } from "./adapters/github/self-update";
import { DoctorChecksLive } from "./adapters/pi/doctor-checks";
import { makePiAgent, PiAgent } from "./adapters/pi/pi-agent";
import {
  listProfileExtensionsWithHealth,
  ProfileExtensionPreflightLive,
} from "./adapters/pi/profile-extension-preflight";
import { PiStandaloneRuntimeLive } from "./adapters/pi/standalone-runtime";
import { ZiggyAgentLive } from "./application/agent";
import { AuthLive } from "./application/auth";
import { AutomationDefinitionsLive } from "./application/automation-definitions";
import { AutomationSchedulerLive } from "./application/automation-scheduler";
import { AutomationsLive } from "./application/automations";
import { DiscordGatewayLive } from "./application/discord-gateway";
import { DoctorLive } from "./application/doctor";
import { ExtensionUpdateLive } from "./application/extension-update";
import { GatewayLive } from "./application/gateway";
import { MemoryLive } from "./application/memory";
import { ModelsLive } from "./application/models";
import { ProfileAgentsLive } from "./application/profile-agents";
import { ProfileExtensions, ProfileExtensionsLive } from "./application/profile-extensions";
import { ProfilesLive } from "./application/profiles";
import { ExtensionHealth, ResidentGatewayLive } from "./application/resident-gateway";
import { ResidentServiceLive } from "./application/resident-service";
import { SelfUpdateLive } from "./application/self-update";
import { SessionsLive } from "./application/sessions";
import { SetupLive } from "./application/setup";
import { SlackGatewayLive } from "./application/slack-gateway";
import { TerminalStyle } from "./faces/terminal-ui";

// The composition root: the one place adapter layers close application ports. Each layer is
// named once and shared by reference, so Effect builds each service once per program.

const ProfileExtensionsLayer = ProfileExtensionsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ExtensionArchiveClientLive,
      ProfileExtensionPreflightLive,
      ProfileExtensionMutationLockLive,
    ),
  ),
);

/** The Pi SDK adapter: the only Pi importer, behind the client-neutral `ZiggyAgent`. */
const PiAgentLayer = Layer.effect(
  PiAgent,
  Effect.map(ProfileExtensions, (profileExtensions) => makePiAgent(profileExtensions)),
).pipe(Layer.provide(ProfileExtensionsLayer));

/** The application agent every face and gateway talks to. */
const ZiggyAgentLayer = ZiggyAgentLive.pipe(Layer.provide(PiAgentLayer));

const ProfilesLayer = ProfilesLive.pipe(Layer.provide(ProfileStoreLive));

const DoctorLayer = DoctorLive.pipe(
  Layer.provide(Layer.mergeAll(AuthLive, ModelsLive, ProfileExtensionsLayer, DoctorChecksLive)),
);

const SetupLayer = SetupLive.pipe(
  Layer.provide(Layer.mergeAll(ProfilesLayer, AuthLive, ModelsLive, DoctorLayer)),
);

const AutomationsLayer = AutomationsLive.pipe(Layer.provide(ZiggyAgentLayer));

const AutomationSchedulerLayer = AutomationSchedulerLive.pipe(Layer.provide(AutomationsLayer));

const ProfileAgentsLayer = ProfileAgentsLive.pipe(
  Layer.provide(Layer.merge(ZiggyAgentLayer, ModelsLive)),
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
      SessionsLive,
      ProfileExtensionsLayer,
      ProfileAgentsLayer,
      ModelsLive,
      AuthLive,
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
    Layer.mergeAll(
      ExtensionArchiveClientLive,
      ProfileExtensionsLayer,
      ProfileExtensionMutationLockLive,
      ResidentServiceLayer,
    ),
  ),
);

const ResidentLayer = Layer.mergeAll(
  ResidentGatewayLayer,
  ResidentServiceLayer,
  ExtensionUpdateLayer,
);

/** Every service the CLI commands use, with Pi's standalone registrations installed first. */
export const CliLayer = Layer.mergeAll(
  ProfilesLayer,
  ZiggyAgentLayer,
  AuthLive,
  ModelsLive,
  DoctorLayer,
  SetupLayer,
  ProfileAgentsLayer,
  AutomationDefinitionsLive,
  AutomationsLayer,
  AutomationSchedulerLayer,
  SessionsLive,
  ProfileExtensionsLayer,
  SelfUpdateLayer,
  MemoryLayer,
  ResidentLayer,
  ZiggyPathsLive,
  TerminalStyle.layer,
).pipe(Layer.provide(PiStandaloneRuntimeLive));

/** `ziggy models ...`: the model catalog and a Profile's selection. */
export const ModelsCommandsLayer = Layer.mergeAll(ModelsLive, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

/** `ziggy sessions ...`: a Profile's session history. */
export const SessionsCommandsLayer = Layer.mergeAll(SessionsLive, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

/** `ziggy memory ...`: a Profile's memory files, read-only. */
export const MemoryCommandsLayer = Layer.mergeAll(MemoryLayer, ZiggyPathsLive);
