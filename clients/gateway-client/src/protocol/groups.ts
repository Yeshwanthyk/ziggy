import {
  hasOnlyKeys,
  isBoundedString,
  isProfileId,
  isRecord,
  isSafeInteger,
  type ZiggyProfileId,
} from "./common";
import { isRecipient, type ZiggyRecipientId } from "./conversations";

export interface ZiggyGroupRecord {
  readonly groupId: string;
  readonly conversationId: string;
  readonly hostProfileId: ZiggyProfileId;
  readonly memberAgentIds: ReadonlyArray<string>;
  readonly defaultRecipient: ZiggyRecipientId;
  readonly revision: number;
}

export interface ZiggyGroupListResult {
  readonly profileId: ZiggyProfileId;
  readonly groups: ReadonlyArray<ZiggyGroupRecord>;
}

export interface ZiggyGroupRequestMap {
  readonly "group.list": { readonly profileId: ZiggyProfileId };
}

export interface ZiggyGroupResultMap {
  readonly "group.list": ZiggyGroupListResult;
}

const isAgentId = (value: unknown): value is string =>
  isBoundedString(value, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

const isGroupRecord = (value: unknown): value is ZiggyGroupRecord =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "groupId",
    "conversationId",
    "hostProfileId",
    "memberAgentIds",
    "defaultRecipient",
    "revision",
  ]) &&
  isBoundedString(value.groupId, 64) &&
  isBoundedString(value.conversationId, 256) &&
  isProfileId(value.hostProfileId) &&
  Array.isArray(value.memberAgentIds) &&
  value.memberAgentIds.length <= 4 &&
  value.memberAgentIds.every(isAgentId) &&
  new Set(value.memberAgentIds).size === value.memberAgentIds.length &&
  isRecipient(value.defaultRecipient) &&
  isSafeInteger(value.revision);

export const isGroupListResult = (value: unknown): value is ZiggyGroupListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "groups"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.groups) &&
  value.groups.length <= 16 &&
  value.groups.every((group) => isGroupRecord(group) && group.hostProfileId === value.profileId);
