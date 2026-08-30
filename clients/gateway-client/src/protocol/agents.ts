import {
  hasOnlyKeys,
  isBoundedCodePointString,
  isBoundedString,
  isCommandId,
  isProfileId,
  isRecord,
  type ZiggyProfileId,
} from "./common";
import type { ZiggyStoredSessionId } from "./conversations";

export type ZiggyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ZiggyProfileAgent {
  readonly id: string;
  readonly description: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ZiggyThinkingLevel;
  readonly tools: ReadonlyArray<string>;
}

export interface ZiggyAgentListResult {
  readonly profileId: ZiggyProfileId;
  readonly agents: ReadonlyArray<ZiggyProfileAgent>;
}

export interface ZiggyAgentShowResult {
  readonly profileId: ZiggyProfileId;
  readonly agent: ZiggyProfileAgent;
}

export type ZiggyAgentCreateResult = ZiggyAgentShowResult;

export interface ZiggyAgentValidation {
  readonly id: string;
  readonly valid: boolean;
  readonly message?: string;
}

export interface ZiggyAgentValidateResult {
  readonly profileId: ZiggyProfileId;
  readonly validations: ReadonlyArray<ZiggyAgentValidation>;
}

export interface ZiggyAgentRunParams {
  readonly profileId: ZiggyProfileId;
  readonly agentId: string;
  readonly task: string;
  readonly commandId?: string;
}

export interface ZiggyAgentRunResult {
  readonly profileId: ZiggyProfileId;
  readonly agentId: string;
  readonly answer: string;
  readonly sessionId: ZiggyStoredSessionId;
}

export interface ZiggyAgentRequestMap {
  readonly "agent.list": { readonly profileId: ZiggyProfileId };
  readonly "agent.show": { readonly profileId: ZiggyProfileId; readonly agentId: string };
  readonly "agent.create": {
    readonly profileId: ZiggyProfileId;
    readonly agentId: string;
    readonly commandId?: string;
  };
  readonly "agent.validate": { readonly profileId: ZiggyProfileId; readonly agentId?: string };
  readonly "agent.run": ZiggyAgentRunParams;
}

export interface ZiggyAgentResultMap {
  readonly "agent.list": ZiggyAgentListResult;
  readonly "agent.show": ZiggyAgentShowResult;
  readonly "agent.create": ZiggyAgentCreateResult;
  readonly "agent.validate": ZiggyAgentValidateResult;
  readonly "agent.run": ZiggyAgentRunResult;
}

const isAgentId = (value: unknown): value is string =>
  isBoundedString(value, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

const isAgent = (value: unknown): value is ZiggyProfileAgent =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "description", "provider", "model", "thinking", "tools"]) &&
  isAgentId(value.id) &&
  isBoundedString(value.description, 2_048) &&
  (value.provider === undefined || isBoundedString(value.provider, 128)) &&
  (value.model === undefined || isBoundedString(value.model, 256)) &&
  (value.thinking === undefined ||
    value.thinking === "off" ||
    value.thinking === "minimal" ||
    value.thinking === "low" ||
    value.thinking === "medium" ||
    value.thinking === "high" ||
    value.thinking === "xhigh" ||
    value.thinking === "max") &&
  Array.isArray(value.tools) &&
  value.tools.length <= 128 &&
  value.tools.every((tool) => isBoundedString(tool, 128));

const isAgentValidation = (value: unknown): value is ZiggyAgentValidation =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "valid", "message"]) &&
  isAgentId(value.id) &&
  typeof value.valid === "boolean" &&
  (value.message === undefined || isBoundedString(value.message, 360));

export const isAgentListResult = (value: unknown): value is ZiggyAgentListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "agents"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.agents) &&
  value.agents.length <= 256 &&
  value.agents.every(isAgent);

export const isAgentShowResult = (value: unknown): value is ZiggyAgentShowResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "agent"]) &&
  isProfileId(value.profileId) &&
  isAgent(value.agent);

export const isAgentValidateResult = (value: unknown): value is ZiggyAgentValidateResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "validations"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.validations) &&
  value.validations.length <= 256 &&
  value.validations.every(isAgentValidation);

export const isAgentRunResult = (value: unknown): value is ZiggyAgentRunResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "agentId", "answer", "sessionId"]) &&
  isProfileId(value.profileId) &&
  isAgentId(value.agentId) &&
  isBoundedCodePointString(value.answer, 60_000, 0) &&
  isStoredSessionId(value.sessionId);

const isStoredSessionId = (value: unknown): value is ZiggyStoredSessionId =>
  isBoundedString(value, 256) &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("..") &&
  !value.startsWith(".");

export const isAgentCommandId = isCommandId;
export const isProfileAgent = isAgent;
