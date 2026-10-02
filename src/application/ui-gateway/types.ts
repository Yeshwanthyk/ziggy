import type { UiGroupStore, UiPinStore } from "../../adapters/fs/ui-state";
import type { ExtensionsApi, PluginSecretsApi } from "../../extensions";
import type { ProfileId } from "../../domain/profile-directory";
import type { ResidentProfileBranch } from "../profile-runtime-directory";
import type { ProfileAgentsApi } from "../../agents";
import type { DoctorApi } from "../doctor";
import type { AutomationDefinitionsApi } from "../automation-definitions";
import type { AutomationSchedulerApi } from "../automation-scheduler";
import type { AutomationsApi } from "../automations";
import type { MemoryApi } from "../../memory";
import type { SessionsApi } from "../../session";
import type { ZiggyAgentApi } from "../../session";
import type { LiveSessionsApi } from "../../resident/live-sessions";
import {
  type ProviderAuthStatus,
  type KnownModel,
  type ProfileTarget,
  type ModelsApi,
  type AuthApi,
} from "../../profile";

export type UiGatewayBranch = ResidentProfileBranch;

/** Dependencies for one shared gateway. Every operation resolves a branch by ProfileId. */
export interface UiGatewayDependencies {
  readonly defaultProfile: UiGatewayBranch;
  readonly profileDirectory?: import("../profile-directory").ProfileDirectoryApi;
  readonly runtimeDirectory?: import("../profile-runtime-directory").ProfileRuntimeDirectoryApi;
  /** Directory that bare Profile names resolve under; enables short CLI targets. */
  readonly profilesDirectory?: string | undefined;
  readonly sessions: SessionsApi;
  readonly agent: ZiggyAgentApi;
  readonly profileExtensions: ExtensionsApi;
  readonly profileAgents?: ProfileAgentsApi;
  readonly models?: ModelsApi;
  readonly auth?: AuthApi;
  readonly doctor?: DoctorApi;
  readonly automationDefinitions?: AutomationDefinitionsApi;
  readonly automationScheduler?: AutomationSchedulerApi;
  readonly automations?: AutomationsApi;
  readonly memory?: MemoryApi;
  /** Writes plugin `${NAME}` values; the gateway never returns or logs them. */
  readonly pluginSecrets?: Pick<PluginSecretsApi, "set">;
  readonly pins?: UiPinStore;
  readonly groups?: UiGroupStore;
}

// Keep these imports type-only above even though the corresponding APIs are often assembled
// together by a resident. This module is the capability dependency contract, not a runtime
// composition edge.
export type UiGatewayCapabilityTypes = {
  readonly profileId: ProfileId;
  readonly target: ProfileTarget;
  readonly live: LiveSessionsApi;
  readonly model?: KnownModel;
  readonly auth?: ProviderAuthStatus;
};
