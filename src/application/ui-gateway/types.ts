import type { Effect } from "effect";
import type { ProfileExtensionHealthListing } from "../../adapters/pi/profile-extension-preflight";
import type { UiGroupStore, UiPinStore } from "../../adapters/fs/ui-state";
import type { ProfileExtensionsApi, ProfileExtensionError } from "../../domain/profile-extension";
import type { ProfileId } from "../../domain/profile-directory";
import type { ResidentProfileBranch } from "../profile-runtime-directory";
import type { ProfileAgentsApi } from "../profile-agents";
import type { DoctorApi } from "../doctor";
import type { AutomationDefinitionsApi } from "../automation-definitions";
import type { AutomationSchedulerApi } from "../automation-scheduler";
import type { AutomationsApi } from "../automations";
import type { MemoryApi } from "../memory";
import type { SessionsApi } from "../sessions";
import type { ZiggyAgentApi } from "../agent";
import type { ChatRegistryApi } from "../chat-registry";
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
  readonly profileExtensions: ProfileExtensionsApi;
  readonly extensionHealth: (
    profilePath: string,
    extensions: ProfileExtensionsApi,
  ) => Effect.Effect<ProfileExtensionHealthListing, ProfileExtensionError>;
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
