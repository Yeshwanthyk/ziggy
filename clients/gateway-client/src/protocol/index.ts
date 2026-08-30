export * from "./common";
export * from "./profiles";
export * from "./conversations";
export * from "./agents";
export * from "./models";
export * from "./automations";
export * from "./memory";
export * from "./extensions";
export * from "./navigation";

import {
  isEmptyRecord,
  hasOnlyKeys,
  isProfileId,
  isRecord,
  isBoundedCodePointString,
  isBoundedString,
  isCommandId,
  isCursor,
  isServerEpoch,
  isSafeInteger,
  type ZiggyMethod,
  type ZiggyRequestMap,
  type ZiggyResultMap,
} from "./common";
import {
  isAgentListResult,
  isAgentRunResult,
  isAgentShowResult,
  isAgentValidateResult,
} from "./agents";
import {
  isAutomationDefinitionResult,
  isAutomationDocumentResult,
  isAutomationListResult,
  isAutomationRunCommandResult,
  isAutomationRunsResult,
  isAutomationStatusResult,
  isAutomationTransitionResult,
  isAutomationValidationResult,
} from "./automations";
import {
  isConversationContextValue,
  isRecipient,
  isSessionHistoryResult,
  isSessionListResult,
  isSessionNameValue,
  isSessionReference,
  isSessionShowResult,
} from "./conversations";
import {
  isExtensionIdValue,
  isExtensionListResult,
  isExtensionMutationResult,
  isExtensionValidationResult,
} from "./extensions";
import { isMemoryListResult, isMemoryPath, isMemoryShowResult } from "./memory";
import {
  isAuthStatusResult,
  isModelListResult,
  isModelSetResult,
  isModelStatusResult,
  isThinkingLevelValue,
} from "./models";
import { isPinListResult, isPinRemoveResult, isPinSetResult } from "./navigation";
import { isProfileCurrentResult, isProfileHealthResult, isProfileListResult } from "./profiles";

export const isMethodResult = <Method extends ZiggyMethod>(
  method: Method,
  params: unknown,
  value: unknown,
): value is ZiggyResultMap[Method] => {
  switch (method) {
    case "ping":
      return isRecord(value) && value.pong === true && Object.keys(value).length === 1;
    case "system.capabilities":
      return isCapabilitiesResult(value);
    case "profile.list":
      return isProfileListResult(value);
    case "profile.current":
      return isProfileCurrentResult(value);
    case "profile.health":
      return isProfileHealthResult(value) && profileMatches(value.profileId, params);
    case "session.list":
      return isSessionListResult(value) && profileMatches(value.profileId, params);
    case "session.show":
      return isSessionShowResult(value) && refProfileMatches(value.profileId, params);
    case "session.history":
      return isSessionHistoryResult(value) && refProfileMatches(value.profileId, params);
    case "session.open":
      return (
        isRecord(value) &&
        Object.keys(value).length === 1 &&
        isRecord(value.ref) &&
        isSessionReference(value.ref) &&
        value.ref.kind === "live" &&
        profileMatches(value.ref.profileId, params)
      );
    case "session.watch":
    case "session.unwatch":
    case "session.close":
    case "prompt.submit":
    case "session.steer":
    case "session.follow-up":
    case "session.abort":
      return isEmptyRecord(value);
    case "agent.list":
      return isAgentListResult(value) && profileMatches(value.profileId, params);
    case "agent.show":
    case "agent.create":
      return isAgentShowResult(value) && profileMatches(value.profileId, params);
    case "agent.validate":
      return isAgentValidateResult(value) && profileMatches(value.profileId, params);
    case "agent.run":
      return isAgentRunResult(value) && profileMatches(value.profileId, params);
    case "model.status":
      return isModelStatusResult(value) && profileMatches(value.profileId, params);
    case "model.list":
      return isModelListResult(value) && profileMatches(value.profileId, params);
    case "model.available":
      return isModelListResult(value) && profileMatches(value.profileId, params);
    case "model.set":
      return isModelSetResult(value) && profileMatches(value.profileId, params);
    case "auth.status":
      return isAuthStatusResult(value) && profileMatches(value.profileId, params);
    case "automation.list":
      return isAutomationListResult(value) && profileMatches(value.profileId, params);
    case "automation.show":
      return isAutomationDocumentResult(value) && profileMatches(value.profileId, params);
    case "automation.create":
      return isAutomationDefinitionResult(value) && profileMatches(value.profileId, params);
    case "automation.save":
      return isAutomationDocumentResult(value) && profileMatches(value.profileId, params);
    case "automation.validate":
      return isAutomationValidationResult(value) && profileMatches(value.profileId, params);
    case "automation.pause":
    case "automation.resume":
      return isAutomationTransitionResult(value) && profileMatches(value.profileId, params);
    case "automation.run":
      return isAutomationRunCommandResult(value) && profileMatches(value.profileId, params);
    case "automation.status":
      return isAutomationStatusResult(value) && profileMatches(value.profileId, params);
    case "automation.runs":
      return isAutomationRunsResult(value) && profileMatches(value.profileId, params);
    case "memory.list":
      return isMemoryListResult(value) && profileMatches(value.profileId, params);
    case "memory.show":
      return (
        isMemoryShowResult(value) &&
        profileMatches(value.profileId, params) &&
        isRecord(params) &&
        isMemoryPath(params.path) &&
        value.path === params.path
      );
    case "extension.list-for-profile":
      return isExtensionListResult(value) && profileMatches(value.profileId, params);
    case "extension.add":
    case "extension.remove":
      return isExtensionMutationResult(value) && profileMatches(value.profileId, params);
    case "extension.validate":
      return isExtensionValidationResult(value) && profileMatches(value.profileId, params);
    case "pin.list":
      return isPinListResult(value) && profileMatches(value.profileId, params);
    case "pin.set":
      return isPinSetResult(value) && profileMatches(value.profileId, params);
    case "pin.remove":
      return isPinRemoveResult(value) && profileMatches(value.profileId, params);
  }
};

const profileMatches = (profileId: unknown, params: unknown): boolean =>
  isProfileId(profileId) && isRecord(params) && profileId === params.profileId;

const refProfileMatches = (profileId: unknown, params: unknown): boolean =>
  isProfileId(profileId) &&
  isRecord(params) &&
  isSessionReference(params.ref) &&
  profileId === params.ref.profileId;

const isCapabilitiesResult = (value: unknown): value is ZiggyResultMap["system.capabilities"] =>
  isRecord(value) &&
  Object.keys(value).length === 6 &&
  value.protocolVersion === 1 &&
  isProfileId(value.defaultProfileId) &&
  isServerEpoch(value.serverEpoch) &&
  Array.isArray(value.methods) &&
  value.methods.length <= 128 &&
  value.methods.every((method) => isBoundedString(method, 64)) &&
  Array.isArray(value.events) &&
  value.events.length <= 32 &&
  value.events.every((event) => isBoundedString(event, 64)) &&
  isRecord(value.bounds) &&
  Object.keys(value.bounds).length === 3 &&
  isSafeInteger(value.bounds.maxPromptCodePoints) &&
  isSafeInteger(value.bounds.replayWindow) &&
  isSafeInteger(value.bounds.maxHistoryEntries);

export const isMethodParams = <Method extends ZiggyMethod>(
  method: Method,
  value: unknown,
): value is ZiggyRequestMap[Method] => {
  if (!isRecord(value)) return false;
  switch (method) {
    case "ping":
    case "system.capabilities":
    case "profile.list":
    case "profile.current":
      return isEmptyRecord(value);
    case "profile.health":
    case "session.list":
    case "agent.list":
    case "model.status":
    case "model.available":
    case "auth.status":
    case "automation.list":
    case "automation.status":
    case "memory.list":
    case "extension.list-for-profile":
    case "extension.validate":
    case "pin.list":
      return hasProfileIdOnly(value);
    case "session.show":
      return hasRefOnly(value);
    case "session.history":
      return (
        hasRef(value) &&
        (value.before === undefined || isCursor(value.before)) &&
        Object.keys(value).every((key) => ["ref", "before"].includes(key))
      );
    case "session.open":
      return (
        Object.keys(value).every((key) =>
          ["profileId", "context", "name", "agentId", "commandId"].includes(key),
        ) &&
        isProfileId(value.profileId) &&
        isConversationContextValue(value.context) &&
        (value.name === undefined || isSessionNameValue(value.name)) &&
        (value.agentId === undefined || isAgentId(value.agentId)) &&
        (value.commandId === undefined || isCommandId(value.commandId))
      );
    case "session.watch":
      return (
        hasRef(value) &&
        Object.keys(value).every((key) =>
          ["ref", "commandId", "afterSeq", "epoch"].includes(key),
        ) &&
        (value.commandId === undefined || isCommandId(value.commandId)) &&
        (value.afterSeq === undefined || isSafeInteger(value.afterSeq)) &&
        (value.epoch === undefined || isServerEpoch(value.epoch))
      );
    case "session.unwatch":
    case "session.close":
    case "session.abort":
      return hasRef(value) && hasOptionalCommandId(value, ["ref", "commandId"]);
    case "prompt.submit":
    case "session.steer":
    case "session.follow-up":
      return (
        hasRef(value) &&
        hasOptionalCommandId(value, ["ref", "text", "recipient", "commandId"]) &&
        (value.recipient === undefined || isRecipient(value.recipient)) &&
        isBoundedCodePointString(value.text, 60_000)
      );
    case "agent.show":
      return hasProfileString(value, "agentId", isAgentId);
    case "agent.create":
      return (
        hasProfileString(value, "agentId", isAgentId) &&
        hasOptionalCommandId(value, ["profileId", "agentId", "commandId"])
      );
    case "agent.validate":
      return (
        hasProfileIdOnlyOr(value, "agentId", isAgentId) &&
        Object.keys(value).every((key) => ["profileId", "agentId"].includes(key))
      );
    case "agent.run":
      return (
        hasProfileString(value, "agentId", isAgentId) &&
        hasProfileString(value, "task", (entry) => isBoundedCodePointString(entry, 60_000)) &&
        hasOptionalCommandId(value, ["profileId", "agentId", "task", "commandId"])
      );
    case "model.list":
      return (
        hasProfileIdOnlyOr(value, "providerId", (entry) => isBoundedString(entry, 128)) &&
        Object.keys(value).every((key) => ["profileId", "providerId"].includes(key))
      );
    case "model.set":
      return (
        hasProfileString(value, "providerId", (entry) => isBoundedString(entry, 128)) &&
        hasProfileString(value, "modelId", (entry) => isBoundedString(entry, 256)) &&
        hasOptionalCommandId(value, [
          "profileId",
          "providerId",
          "modelId",
          "thinking",
          "commandId",
        ]) &&
        (value.thinking === undefined || isThinkingLevelValue(value.thinking))
      );
    case "automation.show":
    case "automation.validate":
      return (
        hasProfileString(value, "automationId", isAutomationId) &&
        Object.keys(value).every((key) => ["profileId", "automationId"].includes(key))
      );
    case "automation.create":
      return (
        hasProfileString(value, "automationId", isAutomationId) &&
        hasOptionalCommandId(value, ["profileId", "automationId", "commandId"])
      );
    case "automation.save":
      return (
        hasProfileString(value, "automationId", isAutomationId) &&
        hasString(value, "source", (entry) => isBoundedCodePointString(entry, 60_000, 0)) &&
        hasString(value, "expectedSource", (entry) => isBoundedCodePointString(entry, 60_000, 0)) &&
        hasOptionalCommandId(value, [
          "profileId",
          "automationId",
          "source",
          "expectedSource",
          "commandId",
        ]) &&
        isBoundedCodePointString(value.expectedSource, 60_000, 0)
      );
    case "automation.pause":
    case "automation.resume":
      return (
        hasProfileString(value, "automationId", isAutomationId) &&
        hasOptionalCommandId(value, ["profileId", "automationId", "commandId"])
      );
    case "automation.run":
      return (
        hasProfileString(value, "automationId", isAutomationId) &&
        hasOptionalCommandId(value, ["profileId", "automationId", "commandId"])
      );
    case "automation.runs":
      return (
        hasProfileIdOnlyOr(value, "automationId", isAutomationId) &&
        Object.keys(value).every((key) => ["profileId", "automationId"].includes(key))
      );
    case "memory.show":
      return (
        hasProfileString(value, "path", isMemoryPath) &&
        Object.keys(value).every((key) => ["profileId", "path"].includes(key))
      );
    case "extension.add":
    case "extension.remove":
      return (
        hasProfileString(value, "id", isExtensionIdValue) &&
        Object.keys(value).every((key) => ["profileId", "id", "commandId"].includes(key)) &&
        (value.commandId === undefined || isCommandId(value.commandId))
      );
    case "pin.set":
      return (
        isProfileId(value.profileId) &&
        Object.keys(value).every((key) =>
          ["profileId", "pin", "expectedRevision", "commandId"].includes(key),
        ) &&
        isRecord(value.pin) &&
        hasOnlyKeys(value.pin, ["id", "ref", "label", "order"]) &&
        isSessionReference(value.pin.ref) &&
        value.pin.ref.profileId === value.profileId &&
        isBoundedString(value.pin.id, 128) &&
        isSafeInteger(value.pin.order, 0) &&
        value.pin.order <= 1_000_000 &&
        (value.pin.label === undefined || isBoundedString(value.pin.label, 160)) &&
        isSafeInteger(value.expectedRevision) &&
        isCommandId(value.commandId)
      );
    case "pin.remove":
      return (
        isProfileId(value.profileId) &&
        hasString(value, "pinId", (entry) => isBoundedString(entry, 128)) &&
        Object.keys(value).every((key) =>
          ["profileId", "pinId", "expectedRevision", "commandId"].includes(key),
        ) &&
        isSafeInteger(value.expectedRevision) &&
        isCommandId(value.commandId)
      );
  }
};

const isAgentId = (value: unknown): value is string =>
  isBoundedString(value, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

const isAutomationId = (value: unknown): value is string =>
  isBoundedString(value, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

const hasProfileIdOnly = (value: Record<string, unknown>): boolean =>
  isProfileId(value.profileId) && Object.keys(value).length === 1;

const hasProfileIdOnlyOr = (
  value: Record<string, unknown>,
  optionalKey: string,
  optionalGuard: (value: unknown) => boolean,
): boolean =>
  isProfileId(value.profileId) &&
  Object.keys(value).every((key) => key === "profileId" || key === optionalKey) &&
  (value[optionalKey] === undefined || optionalGuard(value[optionalKey]));

const hasRefOnly = (value: Record<string, unknown>): boolean =>
  isSessionReference(value.ref) && Object.keys(value).length === 1;

const hasRef = (value: Record<string, unknown>): boolean => isSessionReference(value.ref);

const hasProfileString = (
  value: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => boolean,
): boolean => isProfileId(value.profileId) && hasString(value, key, guard);

const hasString = (
  value: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => boolean,
): boolean => guard(value[key]);

const hasOptionalCommandId = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  (value.commandId === undefined || isCommandId(value.commandId));
