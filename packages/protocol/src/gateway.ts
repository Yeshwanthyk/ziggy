import {
  arrayValue,
  canonicalTimestampFor,
  exactRecord,
  identifierValue,
  nonnegativeSafeInteger,
  objectRecord,
  stringValue,
} from "./client.ts";
import type { SessionEnvelope } from "./types.ts";

const MAX_ID_LENGTH = 512;
const MAX_LINK_CODE_LENGTH = 512;
const MAX_TEXT_LENGTH = 65_536;
const MAX_BROADCAST_RULES = 256;

/** Service-neutral address inside one configured Gateway instance. */
export interface GatewayConversationAddress {
  readonly chatId: string;
  readonly threadId?: string;
}

/** Conversation kind is policy context and is deliberately not part of resume identity. */
export interface GatewayConversation extends GatewayConversationAddress {
  readonly kind: "direct" | "group";
}

export interface GatewayQuotedText {
  readonly messageId: string;
  readonly text: string;
}

/**
 * Text-first inbound envelope shared by leaf Gateways. `gatewayId` names a configured Gateway
 * instance, not a model Provider. Service payloads and display metadata stay at the leaf.
 */
export interface GatewayInboundMessage {
  readonly gatewayId: string;
  readonly messageId: string;
  readonly conversation: GatewayConversation;
  readonly senderId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly replyTo?: GatewayQuotedText;
}

export type GatewayResumeRoute =
  | {
      readonly type: "conversation";
      readonly conversation: GatewayConversationAddress;
    }
  | {
      readonly type: "peer";
      readonly conversation: GatewayConversationAddress;
      readonly senderId: string;
    };

/** Gateway-reconstructable route identity. It never contains a Session identity. */
export interface GatewayResumeHandle {
  readonly type: "gateway-resume";
  readonly gatewayId: string;
  readonly route: GatewayResumeRoute;
}

/** Runtime-owned Session observation identity. It never contains Gateway route identity. */
export interface GatewayStreamHandle {
  readonly type: "session-stream";
  readonly sessionId: string;
}

export interface GatewaySessionResolveRequest {
  readonly resumeHandle: GatewayResumeHandle;
}

export interface GatewaySessionResolveResponse {
  readonly disposition: "started" | "resumed";
  readonly streamHandle: GatewayStreamHandle;
}

export interface GatewayStreamRequest {
  readonly streamHandle: GatewayStreamHandle;
  readonly sinceSeq: number;
}

export interface GatewayStreamResponse {
  readonly replayThroughSeq: number;
  readonly events: ReadonlyArray<SessionEnvelope>;
}

export interface GatewayExternalIdentity {
  readonly gatewayId: string;
  readonly senderId: string;
}

export type GatewayIdentityRequest =
  | {
      readonly type: "resolve";
      readonly identity: GatewayExternalIdentity;
      readonly conversation: GatewayConversation;
    }
  | {
      readonly type: "link-owner";
      readonly identity: GatewayExternalIdentity;
      readonly code: string;
    }
  | {
      readonly type: "approve-person";
      readonly personId: string;
    };

export type GatewayAuthorization =
  | {
      readonly type: "owner";
      readonly personId: string;
      readonly memoryAccess: "conversation" | "primary";
    }
  | {
      readonly type: "person";
      readonly personId: string;
      readonly status: "provisional";
      readonly memoryAccess: "conversation";
    }
  | {
      readonly type: "person";
      readonly personId: string;
      readonly status: "approved";
      readonly memoryAccess: "conversation" | "person";
    };

export type GatewayIdentityResponse =
  | {
      readonly type: "resolved";
      readonly authorization: GatewayAuthorization;
    }
  | {
      readonly type: "owner-linked";
      readonly personId: string;
    }
  | {
      readonly type: "person-approved";
      readonly personId: string;
    }
  | {
      readonly type: "owner-link-rejected";
      readonly reason: "invalid-code" | "code-used" | "identity-conflict";
    }
  | {
      readonly type: "person-approval-rejected";
      readonly reason: "person-not-found" | "not-provisional";
    };

export type BroadcastTarget =
  | {
      readonly type: "gateway";
      readonly gatewayId: string;
      readonly conversation: GatewayConversationAddress;
    }
  | {
      readonly type: "session";
      readonly sessionId: string;
    };

export interface BroadcastRule {
  readonly on: "result" | "failure" | "always";
  readonly target: BroadcastTarget;
}

export type BroadcastPlan =
  | { readonly type: "silent" }
  | {
      readonly type: "deliver";
      readonly rules: readonly [BroadcastRule, ...ReadonlyArray<BroadcastRule>];
    };

export type BroadcastTargetOutcome =
  | {
      readonly ruleIndex: number;
      readonly status: "delivered";
    }
  | {
      readonly ruleIndex: number;
      readonly status: "skipped";
      readonly code: "condition-not-met" | "no-content" | "policy-denied";
    }
  | {
      readonly ruleIndex: number;
      readonly status: "failed";
      readonly code:
        | "target-not-found"
        | "target-unavailable"
        | "delivery-rejected"
        | "outcome-unknown"
        | "internal";
    };

export interface BroadcastResult {
  readonly outcomes: ReadonlyArray<BroadcastTargetOutcome>;
}

export type BroadcastSummary = "delivered" | "skipped" | "partial" | "failed";

export function decodeGatewayInboundMessage(value: unknown): GatewayInboundMessage {
  const message = exactRecord(
    value,
    ["gatewayId", "messageId", "conversation", "senderId", "sentAt", "text"],
    ["replyTo"],
  );
  return {
    gatewayId: boundedId(message.gatewayId, "gatewayId"),
    messageId: boundedId(message.messageId, "messageId"),
    conversation: decodeGatewayConversation(message.conversation),
    senderId: boundedId(message.senderId, "senderId"),
    sentAt: canonicalTimestampFor(message.sentAt, "sentAt"),
    text: boundedNonemptyString(message.text, "text", MAX_TEXT_LENGTH),
    ...(Object.hasOwn(message, "replyTo") ? { replyTo: decodeQuotedText(message.replyTo) } : {}),
  };
}

/** Stable inbound idempotency identity; sender and routing policy cannot change it. */
export function gatewayInboundMessageKey(message: GatewayInboundMessage): string {
  const decoded = decodeGatewayInboundMessage(message);
  return JSON.stringify([
    decoded.gatewayId,
    decoded.conversation.chatId,
    decoded.conversation.threadId ?? null,
    decoded.messageId,
  ]);
}

export function decodeGatewayResumeHandle(value: unknown): GatewayResumeHandle {
  const handle = exactRecord(value, ["type", "gatewayId", "route"]);
  if (handle.type !== "gateway-resume") throw new TypeError("Unknown Gateway resume handle type");
  return {
    type: "gateway-resume",
    gatewayId: boundedId(handle.gatewayId, "gatewayId"),
    route: decodeResumeRoute(handle.route),
  };
}

export function decodeGatewayStreamHandle(value: unknown): GatewayStreamHandle {
  const handle = exactRecord(value, ["type", "sessionId"]);
  if (handle.type !== "session-stream") throw new TypeError("Unknown Gateway stream handle type");
  return { type: "session-stream", sessionId: boundedId(handle.sessionId, "sessionId") };
}

export function decodeGatewaySessionResolveRequest(value: unknown): GatewaySessionResolveRequest {
  const request = exactRecord(value, ["resumeHandle"]);
  return { resumeHandle: decodeGatewayResumeHandle(request.resumeHandle) };
}

export function decodeGatewaySessionResolveResponse(value: unknown): GatewaySessionResolveResponse {
  const response = exactRecord(value, ["disposition", "streamHandle"]);
  return {
    disposition: sessionDisposition(response.disposition),
    streamHandle: decodeGatewayStreamHandle(response.streamHandle),
  };
}

export function decodeGatewayStreamRequest(value: unknown): GatewayStreamRequest {
  const request = exactRecord(value, ["streamHandle", "sinceSeq"]);
  return {
    streamHandle: decodeGatewayStreamHandle(request.streamHandle),
    sinceSeq: nonnegativeSafeInteger(request.sinceSeq, "sinceSeq"),
  };
}

export function decodeGatewayIdentityRequest(value: unknown): GatewayIdentityRequest {
  const request = objectRecord(value);
  switch (request.type) {
    case "resolve": {
      const exact = exactRecord(request, ["type", "identity", "conversation"]);
      return {
        type: "resolve",
        identity: decodeExternalIdentity(exact.identity),
        conversation: decodeGatewayConversation(exact.conversation),
      };
    }
    case "link-owner": {
      const exact = exactRecord(request, ["type", "identity", "code"]);
      return {
        type: "link-owner",
        identity: decodeExternalIdentity(exact.identity),
        code: boundedNonemptyString(exact.code, "code", MAX_LINK_CODE_LENGTH),
      };
    }
    case "approve-person": {
      const exact = exactRecord(request, ["type", "personId"]);
      return { type: "approve-person", personId: boundedId(exact.personId, "personId") };
    }
    default:
      throw new TypeError("Unknown Gateway identity request type");
  }
}

export function decodeGatewayIdentityResponse(value: unknown): GatewayIdentityResponse {
  const response = objectRecord(value);
  switch (response.type) {
    case "resolved": {
      const exact = exactRecord(response, ["type", "authorization"]);
      return { type: "resolved", authorization: decodeAuthorization(exact.authorization) };
    }
    case "owner-linked":
    case "person-approved": {
      const exact = exactRecord(response, ["type", "personId"]);
      return { type: response.type, personId: boundedId(exact.personId, "personId") };
    }
    case "owner-link-rejected": {
      const exact = exactRecord(response, ["type", "reason"]);
      return { type: "owner-link-rejected", reason: ownerLinkRejection(exact.reason) };
    }
    case "person-approval-rejected": {
      const exact = exactRecord(response, ["type", "reason"]);
      return {
        type: "person-approval-rejected",
        reason: personApprovalRejection(exact.reason),
      };
    }
    default:
      throw new TypeError("Unknown Gateway identity response type");
  }
}

export function decodeBroadcastPlan(value: unknown): BroadcastPlan {
  const plan = objectRecord(value);
  if (plan.type === "silent") {
    exactRecord(plan, ["type"]);
    return { type: "silent" };
  }
  if (plan.type !== "deliver") throw new TypeError("Unknown Broadcast plan type");
  const exact = exactRecord(plan, ["type", "rules"]);
  const rules = arrayValue(exact.rules, decodeBroadcastRule, "rules");
  const first = rules[0];
  if (first === undefined) throw new TypeError("Broadcast delivery rules must not be empty");
  if (rules.length > MAX_BROADCAST_RULES) throw new TypeError("Too many Broadcast delivery rules");
  return { type: "deliver", rules: [first, ...rules.slice(1)] };
}

export function decodeBroadcastResult(value: unknown): BroadcastResult {
  const result = exactRecord(value, ["outcomes"]);
  const outcomes = arrayValue(result.outcomes, decodeBroadcastOutcome, "outcomes");
  if (outcomes.length > MAX_BROADCAST_RULES) throw new TypeError("Too many Broadcast outcomes");
  return { outcomes };
}

/** Validate result cardinality/order against its plan and return the canonical result. */
export function validateBroadcastResult(
  plan: BroadcastPlan,
  result: BroadcastResult,
): BroadcastResult {
  const decodedPlan = decodeBroadcastPlan(plan);
  const decodedResult = decodeBroadcastResult(result);
  const expectedCount = decodedPlan.type === "silent" ? 0 : decodedPlan.rules.length;
  if (decodedResult.outcomes.length !== expectedCount) {
    throw new TypeError("Broadcast result must contain one outcome per delivery rule");
  }
  for (const [index, outcome] of decodedResult.outcomes.entries()) {
    if (outcome.ruleIndex !== index) {
      throw new TypeError("Broadcast outcomes must preserve rule order with contiguous indexes");
    }
  }
  return decodedResult;
}

export function summarizeBroadcastResult(result: BroadcastResult): BroadcastSummary {
  const decoded = decodeBroadcastResult(result);
  let delivered = false;
  let failed = false;
  for (const outcome of decoded.outcomes) {
    if (outcome.status === "delivered") delivered = true;
    if (outcome.status === "failed") failed = true;
  }
  if (delivered && failed) return "partial";
  if (delivered) return "delivered";
  if (failed) return "failed";
  return "skipped";
}

function decodeGatewayConversation(value: unknown): GatewayConversation {
  const conversation = exactRecord(value, ["chatId", "kind"], ["threadId"]);
  return {
    chatId: boundedId(conversation.chatId, "chatId"),
    ...(Object.hasOwn(conversation, "threadId")
      ? { threadId: boundedId(conversation.threadId, "threadId") }
      : {}),
    kind: conversationKind(conversation.kind),
  };
}

function decodeConversationAddress(value: unknown): GatewayConversationAddress {
  const conversation = exactRecord(value, ["chatId"], ["threadId"]);
  return {
    chatId: boundedId(conversation.chatId, "chatId"),
    ...(Object.hasOwn(conversation, "threadId")
      ? { threadId: boundedId(conversation.threadId, "threadId") }
      : {}),
  };
}

function decodeQuotedText(value: unknown): GatewayQuotedText {
  const quote = exactRecord(value, ["messageId", "text"]);
  return {
    messageId: boundedId(quote.messageId, "replyTo.messageId"),
    text: boundedNonemptyString(quote.text, "replyTo.text", MAX_TEXT_LENGTH),
  };
}

function decodeResumeRoute(value: unknown): GatewayResumeRoute {
  const route = objectRecord(value);
  if (route.type === "conversation") {
    const exact = exactRecord(route, ["type", "conversation"]);
    return { type: "conversation", conversation: decodeConversationAddress(exact.conversation) };
  }
  if (route.type === "peer") {
    const exact = exactRecord(route, ["type", "conversation", "senderId"]);
    return {
      type: "peer",
      conversation: decodeConversationAddress(exact.conversation),
      senderId: boundedId(exact.senderId, "senderId"),
    };
  }
  throw new TypeError("Unknown Gateway resume route type");
}

function decodeExternalIdentity(value: unknown): GatewayExternalIdentity {
  const identity = exactRecord(value, ["gatewayId", "senderId"]);
  return {
    gatewayId: boundedId(identity.gatewayId, "gatewayId"),
    senderId: boundedId(identity.senderId, "senderId"),
  };
}

function decodeAuthorization(value: unknown): GatewayAuthorization {
  const authorization = objectRecord(value);
  if (authorization.type === "owner") {
    const exact = exactRecord(authorization, ["type", "personId", "memoryAccess"]);
    return {
      type: "owner",
      personId: boundedId(exact.personId, "personId"),
      memoryAccess: ownerMemoryAccess(exact.memoryAccess),
    };
  }
  if (authorization.type !== "person") throw new TypeError("Unknown Gateway principal type");
  const exact = exactRecord(authorization, ["type", "personId", "status", "memoryAccess"]);
  const personId = boundedId(exact.personId, "personId");
  if (exact.status === "provisional") {
    if (exact.memoryAccess !== "conversation") {
      throw new TypeError("A provisional Person is limited to conversation Memory");
    }
    return { type: "person", personId, status: "provisional", memoryAccess: "conversation" };
  }
  if (exact.status === "approved") {
    return {
      type: "person",
      personId,
      status: "approved",
      memoryAccess: approvedPersonMemoryAccess(exact.memoryAccess),
    };
  }
  throw new TypeError("Unknown Gateway Person status");
}

function decodeBroadcastRule(value: unknown): BroadcastRule {
  const rule = exactRecord(value, ["on", "target"]);
  return { on: broadcastCondition(rule.on), target: decodeBroadcastTarget(rule.target) };
}

function decodeBroadcastTarget(value: unknown): BroadcastTarget {
  const target = objectRecord(value);
  if (target.type === "gateway") {
    const exact = exactRecord(target, ["type", "gatewayId", "conversation"]);
    return {
      type: "gateway",
      gatewayId: boundedId(exact.gatewayId, "gatewayId"),
      conversation: decodeConversationAddress(exact.conversation),
    };
  }
  if (target.type === "session") {
    const exact = exactRecord(target, ["type", "sessionId"]);
    return { type: "session", sessionId: boundedId(exact.sessionId, "sessionId") };
  }
  throw new TypeError("Unknown Broadcast target type");
}

function decodeBroadcastOutcome(value: unknown): BroadcastTargetOutcome {
  const outcome = objectRecord(value);
  if (outcome.status === "delivered") {
    const exact = exactRecord(outcome, ["ruleIndex", "status"]);
    return {
      ruleIndex: nonnegativeSafeInteger(exact.ruleIndex, "ruleIndex"),
      status: "delivered",
    };
  }
  if (outcome.status === "skipped") {
    const exact = exactRecord(outcome, ["ruleIndex", "status", "code"]);
    return {
      ruleIndex: nonnegativeSafeInteger(exact.ruleIndex, "ruleIndex"),
      status: "skipped",
      code: broadcastSkipCode(exact.code),
    };
  }
  if (outcome.status === "failed") {
    const exact = exactRecord(outcome, ["ruleIndex", "status", "code"]);
    return {
      ruleIndex: nonnegativeSafeInteger(exact.ruleIndex, "ruleIndex"),
      status: "failed",
      code: broadcastFailureCode(exact.code),
    };
  }
  throw new TypeError("Unknown Broadcast outcome status");
}

function boundedId(value: unknown, name: string): string {
  const identifier = identifierValue(value, name);
  if (identifier.length > MAX_ID_LENGTH) throw new TypeError(`${name} is too long`);
  return identifier;
}

function boundedNonemptyString(value: unknown, name: string, maximum: number): string {
  const decoded = stringValue(value, name);
  if (decoded.length === 0) throw new TypeError(`${name} must not be empty`);
  if (decoded.length > maximum) throw new TypeError(`${name} is too long`);
  return decoded;
}

function conversationKind(value: unknown): GatewayConversation["kind"] {
  if (value === "direct" || value === "group") return value;
  throw new TypeError("Unknown Gateway conversation kind");
}

function sessionDisposition(value: unknown): GatewaySessionResolveResponse["disposition"] {
  if (value === "started" || value === "resumed") return value;
  throw new TypeError("Unknown Gateway Session resolution disposition");
}

function ownerMemoryAccess(value: unknown): "conversation" | "primary" {
  if (value === "conversation" || value === "primary") return value;
  throw new TypeError("Unknown owner Memory access");
}

function approvedPersonMemoryAccess(value: unknown): "conversation" | "person" {
  if (value === "conversation" || value === "person") return value;
  throw new TypeError("An approved non-owner cannot access primary Memory");
}

function ownerLinkRejection(
  value: unknown,
): Extract<GatewayIdentityResponse, { readonly type: "owner-link-rejected" }>["reason"] {
  if (value === "invalid-code" || value === "code-used" || value === "identity-conflict") {
    return value;
  }
  throw new TypeError("Unknown owner-link rejection reason");
}

function personApprovalRejection(
  value: unknown,
): Extract<GatewayIdentityResponse, { readonly type: "person-approval-rejected" }>["reason"] {
  if (value === "person-not-found" || value === "not-provisional") return value;
  throw new TypeError("Unknown Person-approval rejection reason");
}

function broadcastCondition(value: unknown): BroadcastRule["on"] {
  if (value === "result" || value === "failure" || value === "always") return value;
  throw new TypeError("Unknown Broadcast condition");
}

function broadcastSkipCode(
  value: unknown,
): Extract<BroadcastTargetOutcome, { readonly status: "skipped" }>["code"] {
  if (value === "condition-not-met" || value === "no-content" || value === "policy-denied") {
    return value;
  }
  throw new TypeError("Unknown Broadcast skip code");
}

function broadcastFailureCode(
  value: unknown,
): Extract<BroadcastTargetOutcome, { readonly status: "failed" }>["code"] {
  if (
    value === "target-not-found" ||
    value === "target-unavailable" ||
    value === "delivery-rejected" ||
    value === "outcome-unknown" ||
    value === "internal"
  ) {
    return value;
  }
  throw new TypeError("Unknown Broadcast failure code");
}
