import {
  createZiggyConnection,
  type ZiggyConnectionOptions,
  type ZiggySocket,
  type ZiggySocketFactory,
} from "./connection";
import type {
  ZiggyClientEvent,
  ZiggyConnectionState,
  ZiggyEventCursor,
  ZiggyGatewayEvent,
  ZiggyMethod,
  ZiggyProfileId,
  ZiggyRequestMap,
  ZiggyResultMap,
} from "./protocol";
import {
  type ZiggyConversationContext,
  type ZiggySessionHistoryResult,
  type ZiggySessionRef,
  type ZiggySessionListResult,
  type ZiggySessionShowResult,
} from "./protocol/conversations";
import type {
  ZiggyAgentCreateResult,
  ZiggyAgentListResult,
  ZiggyAgentRunResult,
  ZiggyAgentShowResult,
  ZiggyAgentValidateResult,
} from "./protocol/agents";
import type {
  ZiggyAutomationDocument,
  ZiggyAutomationListResult,
  ZiggyAutomationRunsResult,
  ZiggyAutomationStatusResult,
  ZiggyAutomationTransitionResult,
  ZiggyAutomationValidationResult,
} from "./protocol/automations";
import type {
  ZiggyAuthStatusResult,
  ZiggyModelListResult,
  ZiggyModelSetResult,
  ZiggyModelThinkingLevel,
  ZiggyModelStatusResult,
} from "./protocol/models";
import type {
  ZiggyExtensionId,
  ZiggyExtensionListResult,
  ZiggyExtensionMutationResult,
  ZiggyExtensionValidationResult,
} from "./protocol/extensions";
import type { ZiggyMemoryListResult, ZiggyMemoryShowResult } from "./protocol/memory";
import type { ZiggyMemoryPath } from "./protocol/memory";
import type {
  ZiggyPinListResult,
  ZiggyPinRemoveResult,
  ZiggyPinSetResult,
} from "./protocol/navigation";
import type {
  ZiggyProfileCurrentResult,
  ZiggyProfileHealthResult,
  ZiggyProfileListResult,
} from "./protocol/profiles";
import type { ZiggySystemCapabilitiesResult } from "./protocol/common";

export interface ConnectZiggyOptions extends ZiggyConnectionOptions {}

interface MutableModelSetParams {
  profileId: ZiggyProfileId;
  providerId: string;
  modelId: string;
  thinking?: ZiggyModelThinkingLevel;
  commandId?: string;
}

interface MutableAutomationSaveParams {
  profileId: ZiggyProfileId;
  automationId: string;
  source: string;
  expectedSource: string;
  commandId?: string;
}

interface MutablePinSetParams {
  profileId: ZiggyProfileId;
  pin: {
    readonly id: string;
    readonly ref: ZiggySessionRef;
    readonly order: number;
    readonly label?: string;
  };
  expectedRevision: number;
  commandId: string;
}

interface MutablePinRemoveParams {
  profileId: ZiggyProfileId;
  pinId: string;
  expectedRevision: number;
  commandId: string;
}

export interface ZiggyGatewayClient {
  readonly state: ZiggyConnectionState;
  readonly epoch: string | undefined;
  request<Method extends ZiggyMethod>(
    method: Method,
    params: ZiggyRequestMap[Method],
  ): Promise<ZiggyResultMap[Method]>;
  ping(): Promise<ZiggyResultMap["ping"]>;
  capabilities(): Promise<ZiggySystemCapabilitiesResult>;
  listProfiles(): Promise<ZiggyProfileListResult>;
  currentProfile(): Promise<ZiggyProfileCurrentResult>;
  profileHealth(profileId: ZiggyProfileId): Promise<ZiggyProfileHealthResult>;
  listSessions(profileId: ZiggyProfileId): Promise<ZiggySessionListResult>;
  showSession(ref: ZiggySessionRef): Promise<ZiggySessionShowResult>;
  getSessionHistory(ref: ZiggySessionRef, before?: string): Promise<ZiggySessionHistoryResult>;
  openMain(profileId: ZiggyProfileId, context?: ZiggyConversationContext): Promise<ZiggySessionRef>;
  openSpecialist(
    profileId: ZiggyProfileId,
    agentId: string,
    context?: ZiggyConversationContext,
  ): Promise<ZiggySessionRef>;
  watchSession(ref: ZiggySessionRef, cursor?: ZiggyEventCursor): Promise<void>;
  unwatchSession(ref: ZiggySessionRef): Promise<void>;
  closeSession(ref: ZiggySessionRef, commandId?: string): Promise<void>;
  submitPrompt(ref: ZiggySessionRef, text: string, commandId?: string): Promise<void>;
  steerSession(ref: ZiggySessionRef, text: string, commandId?: string): Promise<void>;
  followUp(ref: ZiggySessionRef, text: string, commandId?: string): Promise<void>;
  abortSession(ref: ZiggySessionRef, commandId?: string): Promise<void>;
  listAgents(profileId: ZiggyProfileId): Promise<ZiggyAgentListResult>;
  showAgent(profileId: ZiggyProfileId, agentId: string): Promise<ZiggyAgentShowResult>;
  createAgent(
    profileId: ZiggyProfileId,
    agentId: string,
    commandId?: string,
  ): Promise<ZiggyAgentCreateResult>;
  validateAgents(profileId: ZiggyProfileId, agentId?: string): Promise<ZiggyAgentValidateResult>;
  runAgent(
    profileId: ZiggyProfileId,
    agentId: string,
    task: string,
    commandId?: string,
  ): Promise<ZiggyAgentRunResult>;
  modelStatus(profileId: ZiggyProfileId): Promise<ZiggyModelStatusResult>;
  listModels(profileId: ZiggyProfileId, providerId?: string): Promise<ZiggyModelListResult>;
  availableModels(profileId: ZiggyProfileId): Promise<ZiggyResultMap["model.available"]>;
  setModel(
    profileId: ZiggyProfileId,
    providerId: string,
    modelId: string,
    thinking?: ZiggyModelThinkingLevel,
    commandId?: string,
  ): Promise<ZiggyModelSetResult>;
  authStatus(profileId: ZiggyProfileId): Promise<ZiggyAuthStatusResult>;
  listAutomations(profileId: ZiggyProfileId): Promise<ZiggyAutomationListResult>;
  showAutomation(profileId: ZiggyProfileId, automationId: string): Promise<ZiggyAutomationDocument>;
  createAutomation(
    profileId: ZiggyProfileId,
    automationId: string,
    commandId?: string,
  ): Promise<ZiggyResultMap["automation.create"]>;
  saveAutomation(
    profileId: ZiggyProfileId,
    automationId: string,
    source: string,
    expectedSource: string,
    commandId?: string,
  ): Promise<ZiggyAutomationDocument>;
  validateAutomation(
    profileId: ZiggyProfileId,
    automationId: string,
  ): Promise<ZiggyAutomationValidationResult>;
  pauseAutomation(
    profileId: ZiggyProfileId,
    automationId: string,
    commandId?: string,
  ): Promise<ZiggyAutomationTransitionResult>;
  resumeAutomation(
    profileId: ZiggyProfileId,
    automationId: string,
    commandId?: string,
  ): Promise<ZiggyAutomationTransitionResult>;
  runAutomation(
    profileId: ZiggyProfileId,
    automationId: string,
    commandId?: string,
  ): Promise<ZiggyResultMap["automation.run"]>;
  automationStatus(profileId: ZiggyProfileId): Promise<ZiggyAutomationStatusResult>;
  listAutomationRuns(
    profileId: ZiggyProfileId,
    automationId?: string,
  ): Promise<ZiggyAutomationRunsResult>;
  listMemory(profileId: ZiggyProfileId): Promise<ZiggyMemoryListResult>;
  showMemory(profileId: ZiggyProfileId, path: ZiggyMemoryPath): Promise<ZiggyMemoryShowResult>;
  listExtensionsForProfile(profileId: ZiggyProfileId): Promise<ZiggyExtensionListResult>;
  addExtension(
    profileId: ZiggyProfileId,
    id: ZiggyExtensionId,
    commandId?: string,
  ): Promise<ZiggyExtensionMutationResult>;
  removeExtension(
    profileId: ZiggyProfileId,
    id: ZiggyExtensionId,
    commandId?: string,
  ): Promise<ZiggyExtensionMutationResult>;
  validateExtensions(profileId: ZiggyProfileId): Promise<ZiggyExtensionValidationResult>;
  listPins(profileId: ZiggyProfileId): Promise<ZiggyPinListResult>;
  setPin(
    profileId: ZiggyProfileId,
    pin: MutablePinSetParams["pin"],
    expectedRevision: number,
    commandId: string,
  ): Promise<ZiggyPinSetResult>;
  removePin(
    profileId: ZiggyProfileId,
    pinId: string,
    expectedRevision: number,
    commandId: string,
  ): Promise<ZiggyPinRemoveResult>;
  on<Name extends ZiggyClientEvent["event"]>(
    eventName: Name,
    handler: (event: Extract<ZiggyClientEvent, { readonly event: Name }>) => void,
  ): () => void;
  onAny(handler: (event: ZiggyClientEvent) => void): () => void;
  close(): void;
}

export const connectZiggy = (options: ConnectZiggyOptions): ZiggyGatewayClient => {
  const connection = createZiggyConnection(options);
  const client: ZiggyGatewayClient = {
    get state() {
      return connection.state;
    },
    get epoch() {
      return connection.epoch;
    },
    request: connection.request,
    ping: () => connection.request("ping", {}),
    capabilities: () => connection.request("system.capabilities", {}),
    listProfiles: () => connection.request("profile.list", {}),
    currentProfile: () => connection.request("profile.current", {}),
    profileHealth: (profileId) => connection.request("profile.health", { profileId }),
    listSessions: (profileId) => connection.request("session.list", { profileId }),
    showSession: (ref) => connection.request("session.show", { ref }),
    getSessionHistory: (ref, before) =>
      connection.request("session.history", before === undefined ? { ref } : { ref, before }),
    openMain: async (profileId, context = { kind: "local" }) => {
      const result = await connection.request("session.open", { profileId, context });
      return result.ref;
    },
    openSpecialist: async (profileId, agentId, context = { kind: "local" }) => {
      const result = await connection.request("session.open", { profileId, context, agentId });
      return result.ref;
    },
    watchSession: (ref, cursor) => connection.watch(ref, cursor),
    unwatchSession: (ref) => connection.unwatch(ref),
    closeSession: (ref, commandId) =>
      connection
        .request("session.close", commandId === undefined ? { ref } : { ref, commandId })
        .then(() => undefined),
    submitPrompt: (ref, text, commandId) =>
      connection
        .request(
          "prompt.submit",
          commandId === undefined ? { ref, text } : { ref, text, commandId },
        )
        .then(() => undefined),
    steerSession: (ref, text, commandId) =>
      connection
        .request(
          "session.steer",
          commandId === undefined ? { ref, text } : { ref, text, commandId },
        )
        .then(() => undefined),
    followUp: (ref, text, commandId) =>
      connection
        .request(
          "session.follow-up",
          commandId === undefined ? { ref, text } : { ref, text, commandId },
        )
        .then(() => undefined),
    abortSession: (ref, commandId) =>
      connection
        .request("session.abort", commandId === undefined ? { ref } : { ref, commandId })
        .then(() => undefined),
    listAgents: (profileId) => connection.request("agent.list", { profileId }),
    showAgent: (profileId, agentId) => connection.request("agent.show", { profileId, agentId }),
    createAgent: (profileId, agentId, commandId) =>
      connection.request(
        "agent.create",
        commandId === undefined ? { profileId, agentId } : { profileId, agentId, commandId },
      ),
    validateAgents: (profileId, agentId) =>
      connection.request(
        "agent.validate",
        agentId === undefined ? { profileId } : { profileId, agentId },
      ),
    runAgent: (profileId, agentId, task, commandId) =>
      connection.request(
        "agent.run",
        commandId === undefined
          ? { profileId, agentId, task }
          : { profileId, agentId, task, commandId },
      ),
    modelStatus: (profileId) => connection.request("model.status", { profileId }),
    listModels: (profileId, providerId) =>
      connection.request(
        "model.list",
        providerId === undefined ? { profileId } : { profileId, providerId },
      ),
    availableModels: (profileId) => connection.request("model.available", { profileId }),
    setModel: (profileId, providerId, modelId, thinking, commandId) => {
      const params: MutableModelSetParams = { profileId, providerId, modelId };
      if (thinking !== undefined) params.thinking = thinking;
      if (commandId !== undefined) params.commandId = commandId;
      return connection.request("model.set", params);
    },
    authStatus: (profileId) => connection.request("auth.status", { profileId }),
    listAutomations: (profileId) => connection.request("automation.list", { profileId }),
    showAutomation: (profileId, automationId) =>
      connection.request("automation.show", { profileId, automationId }),
    createAutomation: (profileId, automationId, commandId) =>
      commandId === undefined
        ? connection.request("automation.create", { profileId, automationId })
        : connection.request("automation.create", { profileId, automationId, commandId }),
    saveAutomation: (profileId, automationId, source, expectedSource, commandId) => {
      const params: MutableAutomationSaveParams = {
        profileId,
        automationId,
        source,
        expectedSource,
      };
      if (commandId !== undefined) params.commandId = commandId;
      return connection.request("automation.save", params);
    },
    validateAutomation: (profileId, automationId) =>
      connection.request("automation.validate", { profileId, automationId }),
    pauseAutomation: (profileId, automationId, commandId) =>
      connection.request(
        "automation.pause",
        commandId === undefined
          ? { profileId, automationId }
          : { profileId, automationId, commandId },
      ),
    resumeAutomation: (profileId, automationId, commandId) =>
      connection.request(
        "automation.resume",
        commandId === undefined
          ? { profileId, automationId }
          : { profileId, automationId, commandId },
      ),
    runAutomation: (profileId, automationId, commandId) =>
      commandId === undefined
        ? connection.request("automation.run", { profileId, automationId })
        : connection.request("automation.run", { profileId, automationId, commandId }),
    automationStatus: (profileId) => connection.request("automation.status", { profileId }),
    listAutomationRuns: (profileId, automationId) =>
      connection.request(
        "automation.runs",
        automationId === undefined ? { profileId } : { profileId, automationId },
      ),
    listMemory: (profileId) => connection.request("memory.list", { profileId }),
    showMemory: (profileId, path) => connection.request("memory.show", { profileId, path }),
    listExtensionsForProfile: (profileId) =>
      connection.request("extension.list-for-profile", { profileId }),
    addExtension: (profileId, id, commandId) => {
      if (commandId === undefined) return connection.request("extension.add", { profileId, id });
      return connection.request("extension.add", { profileId, id, commandId });
    },
    removeExtension: (profileId, id, commandId) => {
      if (commandId === undefined) return connection.request("extension.remove", { profileId, id });
      return connection.request("extension.remove", { profileId, id, commandId });
    },
    validateExtensions: (profileId) => connection.request("extension.validate", { profileId }),
    listPins: (profileId) => connection.request("pin.list", { profileId }),
    setPin: (profileId, pin, expectedRevision, commandId) => {
      const params: MutablePinSetParams = { profileId, pin, expectedRevision, commandId };
      return connection.request("pin.set", params);
    },
    removePin: (profileId, pinId, expectedRevision, commandId) => {
      const params: MutablePinRemoveParams = { profileId, pinId, expectedRevision, commandId };
      return connection.request("pin.remove", params);
    },
    on: connection.on,
    onAny: connection.onAny,
    close: connection.close,
  };
  return client;
};

export type { ZiggyGatewayEvent, ZiggySocket, ZiggySocketFactory };
