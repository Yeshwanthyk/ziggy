/**
 * MCP Apps: a model-called MCP tool with a view (`_meta.ui.resourceUri`) carries an `app` record
 * on its tool event and history entry. The view reaches its own server only through
 * `app.callTool` and `app.readResource`; their results wait once at `/app-content/<contentId>`.
 */

import {
  hasOnlyKeys,
  isBoundedCodePointString,
  isBoundedString,
  isJsonValue,
  isProfileId,
  isRecord,
  isSafeInteger,
  type ZiggyJsonValue,
  type ZiggyProfileId,
} from "./common";
import { isSessionReference, isUploadId, type ZiggySessionRef } from "./conversations";

export interface ZiggyToolApp {
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly input?: ZiggyJsonValue;
  readonly result?: ZiggyJsonValue;
  /** The input or result was over its cap and left out. */
  readonly truncated?: true;
}

/** What a view asked to add to the model's context, sent once with the next `prompt.submit`. */
export interface ZiggyAppContext {
  readonly server: string;
  readonly text: string;
}

export interface ZiggyAppCallToolParams {
  readonly ref: ZiggySessionRef;
  readonly server: string;
  readonly resourceUri: string;
  readonly tool: string;
  readonly arguments?: { readonly [key: string]: ZiggyJsonValue };
}

export interface ZiggyAppReadResourceParams {
  readonly ref: ZiggySessionRef;
  readonly server: string;
  readonly uri: string;
}

export interface ZiggyAppContentResult {
  readonly profileId: ZiggyProfileId;
  readonly contentId: string;
  readonly bytes: number;
}

export interface ZiggyAppRequestMap {
  readonly "app.callTool": ZiggyAppCallToolParams;
  readonly "app.readResource": ZiggyAppReadResourceParams;
}

export interface ZiggyAppResultMap {
  readonly "app.callTool": ZiggyAppContentResult;
  readonly "app.readResource": ZiggyAppContentResult;
}

const TOOL_APP_MAX_BYTES = 40 * 1_024;

export const isMcpName = (value: unknown): value is string => isBoundedString(value, 256);

export const isAppResourceUri = (value: unknown): value is string =>
  isBoundedString(value, 2_048) && /^ui:\/\/\S+$/u.test(value);

export const isToolApp = (value: unknown): value is ZiggyToolApp =>
  isRecord(value) &&
  hasOnlyKeys(value, ["server", "tool", "resourceUri", "input", "result", "truncated"]) &&
  isMcpName(value.server) &&
  isMcpName(value.tool) &&
  isAppResourceUri(value.resourceUri) &&
  (value.input === undefined || isJsonValue(value.input)) &&
  (value.result === undefined || isJsonValue(value.result)) &&
  (value.truncated === undefined || value.truncated === true) &&
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= TOOL_APP_MAX_BYTES;

export const isAppContext = (value: unknown): value is ZiggyAppContext =>
  isRecord(value) &&
  hasOnlyKeys(value, ["server", "text"]) &&
  isMcpName(value.server) &&
  isBoundedCodePointString(value.text, 4_000);

export const isAppContextList = (value: unknown): value is ReadonlyArray<ZiggyAppContext> =>
  Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(isAppContext);

export const isAppCallToolParams = (value: unknown): value is ZiggyAppCallToolParams =>
  isRecord(value) &&
  hasOnlyKeys(value, ["ref", "server", "resourceUri", "tool", "arguments"]) &&
  isSessionReference(value.ref) &&
  isMcpName(value.server) &&
  isAppResourceUri(value.resourceUri) &&
  isMcpName(value.tool) &&
  (value.arguments === undefined || (isRecord(value.arguments) && isJsonValue(value.arguments)));

export const isAppReadResourceParams = (value: unknown): value is ZiggyAppReadResourceParams =>
  isRecord(value) &&
  hasOnlyKeys(value, ["ref", "server", "uri"]) &&
  isSessionReference(value.ref) &&
  isMcpName(value.server) &&
  isAppResourceUri(value.uri);

export const isAppContentResult = (value: unknown): value is ZiggyAppContentResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "contentId", "bytes"]) &&
  isProfileId(value.profileId) &&
  isUploadId(value.contentId) &&
  isSafeInteger(value.bytes);
