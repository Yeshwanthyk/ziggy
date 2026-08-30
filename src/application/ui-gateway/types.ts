import type { ProviderAuthStatus } from "../../adapters/pi/auth";
import type { KnownModel } from "../../adapters/pi/models";
import type { UiGroupStore, UiPinStore } from "../../adapters/fs/ui-state";
import type { ProfileExtensionsApi } from "../../domain/profile-extension";
import type { ProfileTarget } from "../../domain/profile";
import type { ProfileId } from "../../domain/profile-directory";
import type { ResidentProfileBranch } from "../profile-runtime-directory";
import type { ProfileAgentsApi } from "../profile-agents";
import type { ModelsApi } from "../models";
import type { AuthApi } from "../auth";
import type { DoctorApi } from "../doctor";
import type { AutomationDefinitionsApi } from "../automation-definitions";
import type { AutomationSchedulerApi } from "../automation-scheduler";
import type { AutomationsApi } from "../automations";
import type { MemoryApi } from "../memory";
import type { SessionsApi } from "../sessions";
import type { ZiggyAgentApi } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";

export type UiGatewayBranch = ResidentProfileBranch;

/** Dependencies for one shared gateway. Every operation resolves a branch by ProfileId. */
export interface UiGatewayDependencies {
  readonly defaultProfile: UiGatewayBranch;
  readonly profileDirectory?: import("../profile-directory").ProfileDirectoryApi;
  readonly runtimeDirectory?: import("../profile-runtime-directory").ProfileRuntimeDirectoryApi;
  readonly repositoryRoot: string;
  readonly sessions: SessionsApi;
  readonly agent: ZiggyAgentApi;
  readonly profileExtensions: ProfileExtensionsApi;
  readonly profileAgents?: ProfileAgentsApi;
  readonly models?: ModelsApi;
  readonly auth?: AuthApi;
  readonly doctor?: DoctorApi;
  readonly automationDefinitions?: AutomationDefinitionsApi;
  readonly automationScheduler?: AutomationSchedulerApi;
  readonly automations?: AutomationsApi;
  readonly memory?: MemoryApi;
  readonly pins?: UiPinStore;
  readonly groups?: UiGroupStore;
}

// Keep these imports type-only above even though the corresponding APIs are often assembled
// together by a resident. This module is the capability dependency contract, not a runtime
// composition edge.
export type UiGatewayCapabilityTypes = {
  readonly profileId: ProfileId;
  readonly target: ProfileTarget;
  readonly registry: ChatRegistryApi;
  readonly model?: KnownModel;
  readonly auth?: ProviderAuthStatus;
};
