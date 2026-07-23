import { describe, expect, test } from "bun:test";
import {
  decodeBroadcastPlan,
  decodeBroadcastResult,
  decodeGatewayIdentityRequest,
  decodeGatewayIdentityResponse,
  decodeGatewayInboundMessage,
  decodeGatewayResumeHandle,
  decodeGatewaySessionResolveResponse,
  decodeGatewayStreamHandle,
  gatewayInboundMessageKey,
  summarizeBroadcastResult,
  validateBroadcastResult,
} from "../../packages/protocol/src/index.ts";
import type {
  BroadcastPlan,
  BroadcastResult,
  BroadcastSummary,
  GatewayIdentityRequest,
  GatewayIdentityResponse,
  GatewayInboundMessage,
  GatewayResumeHandle,
  GatewayStreamHandle,
  SessionEnvelope,
} from "../../packages/protocol/src/index.ts";
import { FakeGatewayAttachPeer } from "../../packages/protocol/src/gateway-testing.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

function expectType<_Condition extends true>(): void {}

const inbound: GatewayInboundMessage = {
  gatewayId: "telegram-owner-bot",
  messageId: "message-42",
  conversation: { chatId: "chat-7", threadId: "topic-3", kind: "group" },
  senderId: "sender-9",
  sentAt: "2026-07-23T12:00:00.000Z",
  text: "new question",
  replyTo: { messageId: "message-41", text: "quoted context" },
};

const conversationResume: GatewayResumeHandle = {
  type: "gateway-resume",
  gatewayId: "telegram-owner-bot",
  route: {
    type: "conversation",
    conversation: { chatId: "chat-7", threadId: "topic-3" },
  },
};

const peerResume: GatewayResumeHandle = {
  type: "gateway-resume",
  gatewayId: "telegram-owner-bot",
  route: {
    type: "peer",
    conversation: { chatId: "chat-7", threadId: "topic-3" },
    senderId: "sender-9",
  },
};

describe("normalized inbound Gateway contract", () => {
  test("preserves opaque message, conversation, thread, and sender identity without leaf payloads", () => {
    expect(decodeGatewayInboundMessage(inbound)).toEqual(inbound);
    expect(Object.keys(decodeGatewayInboundMessage(inbound)).sort()).toEqual([
      "conversation",
      "gatewayId",
      "messageId",
      "replyTo",
      "senderId",
      "sentAt",
      "text",
    ]);
  });

  test("uses chat-scoped message identity independent of sender and policy context", () => {
    const changedContext: GatewayInboundMessage = {
      ...inbound,
      conversation: { ...inbound.conversation, kind: "direct" },
      senderId: "another-sender",
    };
    expect(gatewayInboundMessageKey(changedContext)).toBe(gatewayInboundMessageKey(inbound));
    expect(
      gatewayInboundMessageKey({
        ...inbound,
        conversation: { ...inbound.conversation, threadId: "another-topic" },
      }),
    ).not.toBe(gatewayInboundMessageKey(inbound));
  });

  test("fails closed on unknown kinds, invalid time, missing quote content, and service fields", () => {
    const invalid: ReadonlyArray<unknown> = [
      { ...inbound, conversation: { chatId: "chat-7", kind: "channel" } },
      { ...inbound, sentAt: "yesterday" },
      { ...inbound, replyTo: { messageId: "message-41" } },
      { ...inbound, raw: { update_id: 1 } },
      { ...inbound, text: "" },
    ];
    for (const value of invalid) expect(() => decodeGatewayInboundMessage(value)).toThrow();
  });
});

describe("resume and stream handle separation", () => {
  test("keeps the two handles structurally disjoint", () => {
    expectType<Equal<GatewayResumeHandle["type"], "gateway-resume">>();
    expectType<Equal<GatewayStreamHandle["type"], "session-stream">>();
    expect(decodeGatewayResumeHandle(conversationResume)).toEqual(conversationResume);
    expect(decodeGatewayStreamHandle({ type: "session-stream", sessionId: "session-a" })).toEqual({
      type: "session-stream",
      sessionId: "session-a",
    });
    expect(() =>
      decodeGatewayResumeHandle({ ...conversationResume, sessionId: "session-a" }),
    ).toThrow();
    expect(() =>
      decodeGatewayStreamHandle({
        type: "session-stream",
        sessionId: "session-a",
        route: conversationResume.route,
      }),
    ).toThrow();
  });

  test("rejects crossed tags and unknown resolution outcomes", () => {
    expect(() => decodeGatewayResumeHandle({ type: "session-stream", sessionId: "s" })).toThrow();
    expect(() =>
      decodeGatewayStreamHandle({ type: "gateway-resume", gatewayId: "g", route: {} }),
    ).toThrow();
    expect(() =>
      decodeGatewaySessionResolveResponse({
        disposition: "created-again",
        streamHandle: { type: "session-stream", sessionId: "s" },
      }),
    ).toThrow();
  });
});

describe("Gateway identity and policy contracts", () => {
  test("covers resolve, owner-link, and Person approval requests", () => {
    const requests: ReadonlyArray<GatewayIdentityRequest> = [
      {
        type: "resolve",
        identity: { gatewayId: "telegram-owner-bot", senderId: "sender-9" },
        conversation: { chatId: "chat-7", kind: "group" },
      },
      {
        type: "link-owner",
        identity: { gatewayId: "telegram-owner-bot", senderId: "sender-9" },
        code: "one-time-code",
      },
      { type: "approve-person", personId: "person-2" },
    ];
    expect(requests.map((request) => decodeGatewayIdentityRequest(request).type)).toEqual([
      "resolve",
      "link-owner",
      "approve-person",
    ]);
  });

  test("makes primary Memory owner-only while preserving group conversation policy", () => {
    const responses: ReadonlyArray<GatewayIdentityResponse> = [
      {
        type: "resolved",
        authorization: { type: "owner", personId: "owner", memoryAccess: "primary" },
      },
      {
        type: "resolved",
        authorization: { type: "owner", personId: "owner", memoryAccess: "conversation" },
      },
      {
        type: "resolved",
        authorization: {
          type: "person",
          personId: "person-2",
          status: "provisional",
          memoryAccess: "conversation",
        },
      },
      {
        type: "resolved",
        authorization: {
          type: "person",
          personId: "person-2",
          status: "approved",
          memoryAccess: "person",
        },
      },
      { type: "owner-link-rejected", reason: "code-used" },
      { type: "person-approval-rejected", reason: "not-provisional" },
    ];
    for (const response of responses) {
      expect(decodeGatewayIdentityResponse(response)).toEqual(response);
    }
    expect(() =>
      decodeGatewayIdentityResponse({
        type: "resolved",
        authorization: {
          type: "person",
          personId: "person-2",
          status: "approved",
          memoryAccess: "primary",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeGatewayIdentityResponse({
        type: "resolved",
        authorization: {
          type: "person",
          personId: "person-2",
          status: "provisional",
          memoryAccess: "person",
        },
      }),
    ).toThrow();
  });
});

describe("Broadcast delivery contracts", () => {
  const plan: BroadcastPlan = {
    type: "deliver",
    rules: [
      {
        on: "result",
        target: {
          type: "gateway",
          gatewayId: "telegram-owner-bot",
          conversation: { chatId: "chat-7", threadId: "topic-3" },
        },
      },
      { on: "always", target: { type: "session", sessionId: "session-a" } },
    ],
  };

  test("keeps silent exclusive and preserves ordered service-neutral targets", () => {
    expect(decodeBroadcastPlan({ type: "silent" })).toEqual({ type: "silent" });
    expect(decodeBroadcastPlan(plan)).toEqual(plan);
    expect(() => decodeBroadcastPlan({ type: "silent", rules: [] })).toThrow();
    expect(() => decodeBroadcastPlan({ type: "deliver", rules: [] })).toThrow();
    expect(() =>
      decodeBroadcastPlan({
        type: "deliver",
        rules: [{ on: "result", target: { type: "telegram", chatId: "chat-7" } }],
      }),
    ).toThrow();
  });

  test("derives delivered, skipped, partial, and failed without contradictory aggregate state", () => {
    const results: ReadonlyArray<readonly [BroadcastResult, BroadcastSummary]> = [
      [{ outcomes: [{ ruleIndex: 0, status: "delivered" }] }, "delivered"],
      [{ outcomes: [{ ruleIndex: 0, status: "skipped", code: "condition-not-met" }] }, "skipped"],
      [
        {
          outcomes: [
            { ruleIndex: 0, status: "delivered" },
            { ruleIndex: 1, status: "failed", code: "target-unavailable" },
          ],
        },
        "partial",
      ],
      [{ outcomes: [{ ruleIndex: 0, status: "failed", code: "outcome-unknown" }] }, "failed"],
    ];
    for (const [result, expected] of results) {
      expect(decodeBroadcastResult(result)).toEqual(result);
      expect(summarizeBroadcastResult(result)).toBe(expected);
    }
  });

  test("requires exactly one normalized outcome per rule and rejects raw diagnostics", () => {
    const partial: BroadcastResult = {
      outcomes: [
        { ruleIndex: 0, status: "delivered" },
        { ruleIndex: 1, status: "failed", code: "delivery-rejected" },
      ],
    };
    expect(validateBroadcastResult(plan, partial)).toEqual(partial);
    expect(validateBroadcastResult({ type: "silent" }, { outcomes: [] })).toEqual({ outcomes: [] });
    expect(() =>
      validateBroadcastResult(plan, { outcomes: [{ ruleIndex: 0, status: "delivered" }] }),
    ).toThrow();
    expect(() =>
      validateBroadcastResult(plan, {
        outcomes: [
          { ruleIndex: 1, status: "delivered" },
          { ruleIndex: 0, status: "failed", code: "internal" },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeBroadcastResult({
        outcomes: [
          {
            ruleIndex: 0,
            status: "failed",
            code: "target-unavailable",
            serviceError: "Telegram 429: raw response",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("dependency-free fake Gateway attach peer", () => {
  test("atomically resolves repeated routes without creating a duplicate Session", () => {
    const peer = new FakeGatewayAttachPeer();
    const first = peer.resolveSession({ resumeHandle: conversationResume });
    const retryAfterLostResponse = peer.resolveSession({ resumeHandle: conversationResume });

    expect(first.disposition).toBe("started");
    expect(retryAfterLostResponse).toEqual({
      disposition: "resumed",
      streamHandle: first.streamHandle,
    });
    expect(peer.sessionCount).toBe(1);
  });

  test("supports conversation and peer route granularity without service-specific semantics", () => {
    const peer = new FakeGatewayAttachPeer();
    const conversation = peer.resolveSession({ resumeHandle: conversationResume });
    const firstPeer = peer.resolveSession({ resumeHandle: peerResume });
    const secondPeer = peer.resolveSession({
      resumeHandle: {
        type: "gateway-resume",
        gatewayId: "telegram-owner-bot",
        route: {
          type: "peer",
          conversation: { chatId: "chat-7", threadId: "topic-3" },
          senderId: "sender-10",
        },
      },
    });
    expect(
      new Set([conversation, firstPeer, secondPeer].map((item) => item.streamHandle.sessionId))
        .size,
    ).toBe(3);
    expect(peer.sessionCount).toBe(3);
  });

  test("replays only ordered unseen Session envelopes and replay never creates a Session", () => {
    const peer = new FakeGatewayAttachPeer();
    const resolved = peer.resolveSession({ resumeHandle: conversationResume });
    const events = [
      envelope(resolved.streamHandle.sessionId, 1, "one"),
      envelope(resolved.streamHandle.sessionId, 2, "two"),
      envelope(resolved.streamHandle.sessionId, 3, "three"),
    ];
    peer.append(resolved.streamHandle, events);

    expect(peer.stream({ streamHandle: resolved.streamHandle, sinceSeq: 1 })).toEqual({
      replayThroughSeq: 3,
      events: events.slice(1),
    });
    expect(peer.stream({ streamHandle: resolved.streamHandle, sinceSeq: 3 })).toEqual({
      replayThroughSeq: 3,
      events: [],
    });
    expect(peer.sessionCount).toBe(1);
  });

  test("rejects unordered, duplicate, cross-Session, and unknown stream replay", () => {
    const peer = new FakeGatewayAttachPeer();
    const resolved = peer.resolveSession({ resumeHandle: conversationResume });
    expect(() =>
      peer.append(resolved.streamHandle, [envelope(resolved.streamHandle.sessionId, 2, "gap")]),
    ).toThrow();
    expect(() =>
      peer.append(resolved.streamHandle, [envelope("another-session", 1, "wrong")]),
    ).toThrow();
    peer.append(resolved.streamHandle, [envelope(resolved.streamHandle.sessionId, 1, "one")]);
    expect(() =>
      peer.append(resolved.streamHandle, [
        envelope(resolved.streamHandle.sessionId, 1, "duplicate"),
      ]),
    ).toThrow();
    expect(() =>
      peer.stream({
        streamHandle: { type: "session-stream", sessionId: "missing" },
        sinceSeq: 0,
      }),
    ).toThrow();
    expect(peer.sessionCount).toBe(1);
  });
});

function envelope(sessionId: string, seq: number, message: string): SessionEnvelope {
  return {
    schemaVersion: 1,
    seq,
    emittedAt: "2026-07-23T12:00:00.000Z",
    event: {
      type: "turn-started",
      sessionId,
      turnId: `turn-${seq}`,
      message,
      origin: "user",
    },
  };
}
