import { Effect, Layer } from "effect";
import { ResidentServiceOperationsLive } from "./adapters/bun/resident-service-operations";
import { ZiggyPathsLive } from "./platform/paths";
import { ZiggyReleaseClientLive } from "./adapters/github/self-update";
import { DoctorChecksLive } from "./adapters/pi/doctor-checks";
import { PiStandaloneRuntimeLive } from "./adapters/pi/standalone-runtime";
import { ZiggyAgent } from "./session";
import { makeZiggyAgent, ProfileAgentsLive } from "./agents";
import { AutomationDefinitionsLive } from "./application/automation-definitions";
import { AutomationSchedulerLive } from "./application/automation-scheduler";
import { AutomationsLive } from "./application/automations";
import { DiscordGatewayLive } from "./application/discord-gateway";
import { DoctorLive } from "./application/doctor";
import { GatewayLive } from "./application/gateway";
import { ResidentGatewayLive } from "./application/resident-gateway";
import { ResidentServiceLive } from "./application/resident-service";
import { SelfUpdateLive } from "./application/self-update";
import { SetupLive } from "./application/setup";
import { SlackGatewayLive } from "./application/slack-gateway";
import { Extensions, extensionTools } from "./extensions";
import { Memory, memoryPrompt, memoryTools } from "./memory";
import { TerminalStyle } from "./faces/terminal-ui";
import { Auth, Models, Profiles } from "./profile";
import { Sessions } from "./session";

// The composition root: the one place adapter layers close application ports. Each layer is
// named once and shared by reference, so Effect builds each service once per program.

/** The agent every face and gateway talks to, backed by the Pi SDK adapter. */
const ZiggyAgentLayer = Layer.effect(
  ZiggyAgent,
  Effect.map(Extensions, (extensions) =>
    makeZiggyAgent({
      tools: [memoryTools, extensionTools(extensions)],
      prompts: [memoryPrompt],
    }),
  ),
).pipe(Layer.provide(Extensions.layer));

const DoctorLayer = DoctorLive.pipe(
  Layer.provide(Layer.mergeAll(Auth.layer, Models.layer, Extensions.layer, DoctorChecksLive)),
);

const SetupLayer = SetupLive.pipe(
  Layer.provide(Layer.mergeAll(Profiles.layer, Auth.layer, Models.layer, DoctorLayer)),
);

const AutomationsLayer = AutomationsLive.pipe(Layer.provide(ZiggyAgentLayer));

const AutomationSchedulerLayer = AutomationSchedulerLive.pipe(Layer.provide(AutomationsLayer));

const ProfileAgentsLayer = ProfileAgentsLive.pipe(
  Layer.provide(Layer.merge(ZiggyAgentLayer, Models.layer)),
);

const MemoryLayer = Memory.layer;

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
      Extensions.layer,
      ProfileAgentsLayer,
      Models.layer,
      Auth.layer,
      DoctorLayer,
      MemoryLayer,
      ZiggyPathsLive,
    ),
  ),
);

const ResidentServiceLayer = ResidentServiceLive.pipe(
  Layer.provide(
    ResidentServiceOperationsLive.pipe(
      Layer.provide(Layer.merge(AutomationSchedulerLayer, ZiggyPathsLive)),
    ),
  ),
);

/** `ziggy init`, `profiles`, `doctor`, `auth ...`: setting up and checking a Profile. */
export const ProfileCommandsLayer = Layer.mergeAll(
  SetupLayer,
  Profiles.layer,
  Auth.layer,
  DoctorLayer,
  ZiggyPathsLive,
  TerminalStyle.layer,
).pipe(Layer.provide(PiStandaloneRuntimeLive));

/** `ziggy update`: replace this Ziggy install with the latest release. */
export const UpdateCommandsLayer = SelfUpdateLayer;

/** `ziggy extensions ...`: the catalog and a Profile's selection. */
export const ExtensionsCommandsLayer = Layer.mergeAll(
  Profiles.layer,
  Extensions.layer,
  ResidentServiceLayer,
  ZiggyPathsLive,
  TerminalStyle.layer,
).pipe(Layer.provide(PiStandaloneRuntimeLive));

/** `ziggy agents ...`: a Profile's agent files and one-off agent runs. */
export const AgentsCommandsLayer = Layer.merge(ProfileAgentsLayer, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

/** `ziggy run` and `ziggy acp`: one session in the foreground. */
export const RunCommandsLayer = Layer.mergeAll(
  ZiggyAgentLayer,
  Models.layer,
  Sessions.layer,
  ZiggyPathsLive,
).pipe(Layer.provide(PiStandaloneRuntimeLive));

/** `ziggy automations ...` and `ziggy wake`. */
export const AutomationsCommandsLayer = Layer.mergeAll(
  AutomationDefinitionsLive,
  AutomationsLayer,
  AutomationSchedulerLayer,
  ResidentServiceLayer,
  ZiggyPathsLive,
).pipe(Layer.provide(PiStandaloneRuntimeLive));

/** `ziggy serve install|start|stop|...`, `web ...` and `open`: the managed resident. */
export const ResidentCommandsLayer = Layer.merge(ResidentServiceLayer, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

/** `ziggy serve <profile>`: the resident itself, in the foreground. */
export const ServeCommandsLayer = Layer.merge(ResidentGatewayLayer, ZiggyPathsLive).pipe(
  Layer.provide(PiStandaloneRuntimeLive),
);

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
