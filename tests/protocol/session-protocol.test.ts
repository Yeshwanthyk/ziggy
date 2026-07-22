import { describe, expect, test } from "bun:test";
import {
  decodeSessionEnvelope,
  encodeSessionEnvelope,
  negotiateServerFeatures,
  type ApprovalResolveRequest,
  type ApprovalResolveResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ProtocolMethod,
  type SessionEnsureRequest,
  type SessionEnsureResponse,
  type SessionEnvelope,
  type SessionEvent,
  type SessionListRequest,
  type SessionListResponse,
  type SessionResumeRequest,
  type SessionResumeResponse,
  type SessionSummary,
  type SessionStartRequest,
  type SessionStartResponse,
  type SessionSubscribeRequest,
  type SessionSubscribeResponse,
  type SessionUnsubscribeRequest,
  type SessionUnsubscribeResponse,
  type TurnInterruptRequest,
  type TurnInterruptResponse,
  type TurnStartRequest,
  type TurnStartResponse,
  type TurnSteerRequest,
  type TurnSteerResponse,
} from "../../packages/protocol/src/index.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type IsAssignable<Actual, Expected> = Actual extends Expected ? true : false;
type EventOf<Type extends SessionEvent["type"]> = Extract<SessionEvent, { readonly type: Type }>;

function expectType<_Condition extends true>(): void {}

expectType<
  Equal<
    SessionEvent["type"],
    | "session-started"
    | "turn-started"
    | "step-started"
    | "model-chunk"
    | "model-response"
    | "tool-call"
    | "tool-result"
    | "step-ended"
    | "turn-ended"
    | "steer-received"
    | "follow-up-received"
    | "interrupt-received"
    | "approval-requested"
    | "approval-resolved"
  >
>();
expectType<IsAssignable<SessionEvent, { readonly sessionId: string }>>();
expectType<
  IsAssignable<
    EventOf<"turn-started">,
    {
      readonly sessionId: string;
      readonly turnId: string;
      readonly message: string;
      readonly origin: "user" | "follow-up";
    }
  >
>();
expectType<
  IsAssignable<
    EventOf<"step-started">,
    {
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly provider: string;
      readonly model: string;
    }
  >
>();
expectType<
  IsAssignable<
    EventOf<"model-chunk">,
    {
      readonly sessionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly contentIndex: number;
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  >
>();
expectType<
  IsAssignable<EventOf<"tool-call"> | EventOf<"tool-result">, { readonly sourceIndex: number }>
>();
expectType<
  IsAssignable<
    EventOf<"step-ended"> | EventOf<"turn-ended">,
    { readonly status: "completed" | "failed" | "interrupted" }
  >
>();
expectType<
  IsAssignable<
    EventOf<"approval-requested">,
    { readonly prompt: string; readonly choices: ReadonlyArray<"approve" | "deny"> }
  >
>();
expectType<Equal<keyof SessionEnvelope, "schemaVersion" | "seq" | "emittedAt" | "event">>();
expectType<
  Equal<
    ProtocolMethod,
    | "initialize"
    | "auth/login"
    | "auth/respond"
    | "auth/status"
    | "session/start"
    | "session/ensure"
    | "session/resume"
    | "session/list"
    | "session/subscribe"
    | "session/unsubscribe"
    | "turn/start"
    | "turn/steer"
    | "turn/interrupt"
    | "approval/resolve"
  >
>();
expectType<
  Equal<
    InitializeRequest,
    {
      readonly client: { readonly name: string; readonly version: string };
      readonly features: ReadonlyArray<"modelChunks" | "approvalRequests">;
    }
  >
>();
expectType<
  Equal<
    InitializeResponse,
    {
      readonly protocolVersion: 2;
      readonly features: ReadonlyArray<
        | "sessionReplay"
        | "turnSteering"
        | "turnInterrupt"
        | "approvals"
        | "stableMainSession"
        | "providerAuth"
      >;
    }
  >
>();
expectType<
  Equal<
    SessionSummary,
    {
      readonly sessionId: string;
      readonly createdAt: string;
      readonly lastSeq: number;
      readonly activeTurnId?: string;
    }
  >
>();
expectType<Equal<SessionStartRequest, Record<never, never>>>();
expectType<Equal<SessionStartResponse, { readonly session: SessionSummary }>>();
expectType<Equal<SessionEnsureRequest, { readonly sessionId: "main" }>>();
expectType<Equal<SessionEnsureResponse, { readonly session: SessionSummary }>>();
expectType<
  Equal<SessionResumeRequest, { readonly sessionId: string; readonly sinceSeq: number }>
>();
expectType<
  Equal<
    SessionResumeResponse,
    {
      readonly session: SessionSummary;
      readonly subscriptionId: string;
      readonly replayThroughSeq: number;
    }
  >
>();
expectType<Equal<SessionListRequest, Record<never, never>>>();
expectType<Equal<SessionListResponse, { readonly sessions: ReadonlyArray<SessionSummary> }>>();
expectType<
  Equal<SessionSubscribeRequest, { readonly sessionId: string; readonly sinceSeq: number }>
>();
expectType<
  Equal<
    SessionSubscribeResponse,
    { readonly subscriptionId: string; readonly replayThroughSeq: number }
  >
>();
expectType<Equal<SessionUnsubscribeRequest, { readonly subscriptionId: string }>>();
expectType<Equal<SessionUnsubscribeResponse, { readonly unsubscribed: boolean }>>();
expectType<Equal<TurnStartRequest, { readonly sessionId: string; readonly message: string }>>();
expectType<
  Equal<TurnStartResponse, { readonly turnId: string; readonly disposition: "started" | "queued" }>
>();
expectType<
  Equal<
    TurnSteerRequest,
    { readonly sessionId: string; readonly expectedTurnId: string; readonly message: string }
  >
>();
expectType<Equal<TurnSteerResponse, { readonly turnId: string }>>();
expectType<
  Equal<TurnInterruptRequest, { readonly sessionId: string; readonly expectedTurnId: string }>
>();
expectType<Equal<TurnInterruptResponse, { readonly turnId: string }>>();
expectType<
  Equal<
    ApprovalResolveRequest,
    {
      readonly sessionId: string;
      readonly approvalId: string;
      readonly decision: "approve" | "deny";
    }
  >
>();
expectType<Equal<ApprovalResolveResponse, { readonly outcome: "resolved" | "already-resolved" }>>();

const protocolMethods: ReadonlyArray<ProtocolMethod> = [
  "initialize",
  "session/start",
  "session/ensure",
  "session/resume",
  "session/list",
  "session/subscribe",
  "session/unsubscribe",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "approval/resolve",
];
const initializeRequest: InitializeRequest = {
  client: { name: "ziggy-test", version: "1.0.0" },
  features: ["modelChunks", "approvalRequests"],
};
const initializeResponse: InitializeResponse = {
  protocolVersion: 2,
  features: [
    "sessionReplay",
    "turnSteering",
    "turnInterrupt",
    "approvals",
    "stableMainSession",
    "providerAuth",
  ],
};
const session: SessionSummary = {
  sessionId: "session-a",
  createdAt: "2026-07-19T00:00:00.000Z",
  lastSeq: 4,
  activeTurnId: "turn-a",
};
const sessionStartRequest: SessionStartRequest = {};
const sessionStartResponse: SessionStartResponse = { session };
const sessionEnsureRequest: SessionEnsureRequest = { sessionId: "main" };
const sessionEnsureResponse: SessionEnsureResponse = {
  session: { ...session, sessionId: "main" },
};
const sessionResumeRequest: SessionResumeRequest = { sessionId: "session-a", sinceSeq: 4 };
const sessionResumeResponse: SessionResumeResponse = {
  session,
  subscriptionId: "subscription-a",
  replayThroughSeq: 4,
};
const sessionListRequest: SessionListRequest = {};
const sessionListResponse: SessionListResponse = { sessions: [session] };
const sessionSubscribeRequest: SessionSubscribeRequest = { sessionId: "session-a", sinceSeq: 4 };
const sessionSubscribeResponse: SessionSubscribeResponse = {
  subscriptionId: "subscription-a",
  replayThroughSeq: 4,
};
const sessionUnsubscribeRequest: SessionUnsubscribeRequest = {
  subscriptionId: "subscription-a",
};
const sessionUnsubscribeResponse: SessionUnsubscribeResponse = { unsubscribed: true };
const turnStartRequest: TurnStartRequest = { sessionId: "session-a", message: "next" };
const turnStartResponse: TurnStartResponse = { turnId: "turn-a", disposition: "started" };
const turnSteerRequest: TurnSteerRequest = {
  sessionId: "session-a",
  expectedTurnId: "turn-a",
  message: "change direction",
};
const turnSteerResponse: TurnSteerResponse = { turnId: "turn-a" };
const turnInterruptRequest: TurnInterruptRequest = {
  sessionId: "session-a",
  expectedTurnId: "turn-a",
};
const turnInterruptResponse: TurnInterruptResponse = { turnId: "turn-a" };
const approvalResolveRequest: ApprovalResolveRequest = {
  sessionId: "session-a",
  approvalId: "approval-a",
  decision: "approve",
};
const approvalResolvedResponse: ApprovalResolveResponse = { outcome: "resolved" };
const approvalAlreadyResolvedResponse: ApprovalResolveResponse = { outcome: "already-resolved" };

const turnStarted: SessionEvent = {
  type: "turn-started",
  sessionId: "session-a",
  turnId: "turn-a",
  message: "hello",
  origin: "user",
};

const events: ReadonlyArray<SessionEvent> = [
  {
    type: "session-started",
    sessionId: "session-a",
    snapshot: {
      systemPrompt: "You are Ziggy.\n\n<memory>remember this</memory>\n\n<user>Yesh</user>",
      tools: [
        {
          name: "memory",
          description: "Edit retained Memory.",
          inputSchema: {
            type: "object",
            properties: { action: { enum: ["add", "replace", "remove"] } },
            required: ["action"],
          },
        },
      ],
    },
  },
  turnStarted,
  {
    type: "step-started",
    sessionId: "session-a",
    turnId: "turn-a",
    stepId: "step-a",
    provider: "anthropic",
    model: "claude-test",
  },
  {
    type: "model-chunk",
    sessionId: "session-a",
    turnId: "turn-a",
    stepId: "step-a",
    contentIndex: 0,
    kind: "text",
    delta: "answer",
  },
  {
    type: "model-response",
    sessionId: "session-a",
    turnId: "turn-a",
    stepId: "step-a",
    response: {
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      responseId: "message-a",
      content: [
        {
          type: "thinking",
          thinking: "reasoning",
          thinkingSignature: "thinking-signature-a",
        },
        { type: "text", text: "answer", textSignature: "text-signature-a" },
        {
          type: "toolCall",
          id: "call-a",
          name: "memory",
          arguments: { action: "add", content: "fact", confidence: 0.75 },
          thoughtSignature: "thought-signature-a",
        },
      ],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 15,
      },
      stopReason: "toolUse",
      timestamp: 1_784_419_200_000,
    },
  },
  {
    type: "tool-call",
    sessionId: "session-a",
    turnId: "turn-a",
    stepId: "step-a",
    toolCallId: "call-a",
    toolName: "memory",
    input: { action: "add", content: "fact" },
    sourceIndex: 0,
  },
  {
    type: "tool-result",
    sessionId: "session-a",
    turnId: "turn-a",
    stepId: "step-a",
    toolCallId: "call-a",
    output: { changed: true },
    isError: false,
    sourceIndex: 0,
  },
  {
    type: "step-ended",
    sessionId: "session-a",
    turnId: "turn-a",
    stepId: "step-a",
    status: "completed",
  },
  {
    type: "turn-ended",
    sessionId: "session-a",
    turnId: "turn-a",
    status: "completed",
  },
  {
    type: "steer-received",
    sessionId: "session-a",
    turnId: "turn-a",
    message: "change direction",
  },
  {
    type: "follow-up-received",
    sessionId: "session-a",
    turnId: "turn-a",
    message: "then do this",
  },
  {
    type: "interrupt-received",
    sessionId: "session-a",
    turnId: "turn-a",
  },
  {
    type: "approval-requested",
    sessionId: "session-a",
    turnId: "turn-a",
    approvalId: "approval-a",
    toolCallId: "call-a",
    prompt: "Allow the memory update?",
    choices: ["approve", "deny"],
  },
  {
    type: "approval-resolved",
    sessionId: "session-a",
    turnId: "turn-a",
    approvalId: "approval-a",
    decision: "deny",
  },
];

const canonicalEnvelope: SessionEnvelope = {
  schemaVersion: 1,
  seq: 7,
  emittedAt: "2026-07-19T00:00:00.000Z",
  event: turnStarted,
};

const canonicalFrame =
  '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n';

describe("canonical Session events", () => {
  test("exposes the complete dependency-free event union with Session identity", () => {
    expect(events.map((event) => event.type)).toEqual([
      "session-started",
      "turn-started",
      "step-started",
      "model-chunk",
      "model-response",
      "tool-call",
      "tool-result",
      "step-ended",
      "turn-ended",
      "steer-received",
      "follow-up-received",
      "interrupt-received",
      "approval-requested",
      "approval-resolved",
    ]);
    expect(events.map((event) => event.sessionId)).toEqual(Array(14).fill("session-a"));
  });

  test("round-trips every event without losing frozen prompt or provider continuity data", () => {
    for (const [index, event] of events.entries()) {
      const envelope: SessionEnvelope = {
        schemaVersion: 1,
        seq: index + 1,
        emittedAt: "2026-07-19T00:00:00.000Z",
        event,
      };
      const encoded = encodeSessionEnvelope(envelope);

      expect(decodeSessionEnvelope(encoded)).toEqual(envelope);
      expect(encodeSessionEnvelope(decodeSessionEnvelope(encoded))).toBe(encoded);
    }
  });

  test("accepts pi-ai responses with omitted provider-optional continuity fields", () => {
    const envelope: SessionEnvelope = {
      schemaVersion: 1,
      seq: 1,
      emittedAt: "2026-07-19T00:00:00.000Z",
      event: {
        type: "model-response",
        sessionId: "session-a",
        turnId: "turn-a",
        stepId: "step-a",
        response: {
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          content: [
            { type: "thinking", thinking: "", redacted: true },
            { type: "text", text: "answer" },
            { type: "toolCall", id: "call-a", name: "memory", arguments: {} },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 3,
            cacheWrite: 1,
            cacheWrite1h: 1,
            reasoning: 2,
            totalTokens: 19,
          },
          stopReason: "toolUse",
          timestamp: 1_784_419_200_000,
        },
      },
    };

    expect(decodeSessionEnvelope(encodeSessionEnvelope(envelope))).toEqual(envelope);
  });

  test("persists one assembled stable prefix rather than a second Memory authority", () => {
    const first = events[0];

    expect(first?.type).toBe("session-started");
    if (first?.type !== "session-started") {
      throw new Error("Expected session-started fixture");
    }
    expect(first.snapshot).toEqual({
      systemPrompt: "You are Ziggy.\n\n<memory>remember this</memory>\n\n<user>Yesh</user>",
      tools: first.snapshot.tools,
    });
    expect(Object.keys(first.snapshot)).toEqual(["systemPrompt", "tools"]);
  });

  test("encodes one canonical newline-terminated NDJSON frame", () => {
    const encoded = encodeSessionEnvelope(canonicalEnvelope);

    expect(encoded).toBe(canonicalFrame);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.endsWith("\n\n")).toBe(false);
  });

  test("decodes one frame and round-trips byte-for-byte", () => {
    const decoded = decodeSessionEnvelope(canonicalFrame);

    expect(decoded).toEqual(canonicalEnvelope);
    expect(encodeSessionEnvelope(decoded)).toBe(canonicalFrame);
  });

  test("rejects unsupported schemas, unsafe sequences, invalid events, and non-canonical keys", () => {
    const invalidFrames: ReadonlyArray<string> = [
      '{"schemaVersion":2,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":0,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":1.5,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":9007199254740992,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":1e400,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"not-a-timestamp","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"unknown","sessionId":"session-a"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","turnId":"turn-a","message":"hello","origin":"user"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"queued"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"step-started","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","model":"claude-test"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"step-started","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","provider":"anthropic"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-chunk","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","kind":"text","delta":"x"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-chunk","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","contentIndex":0,"delta":"x"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-chunk","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","contentIndex":0,"kind":"text"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-chunk","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","contentIndex":0,"kind":"image","delta":"x"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"tool-call","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","toolCallId":"call-a","toolName":"memory","input":{}}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"tool-result","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","toolCallId":"call-a","output":{},"isError":false}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"step-ended","sessionId":"session-a","turnId":"turn-a","stepId":"step-a"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"step-ended","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","status":"pending"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-ended","sessionId":"session-a","turnId":"turn-a"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-ended","sessionId":"session-a","turnId":"turn-a","status":"pending"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"session-started","sessionId":"session-a","snapshot":{"systemPrompt":"You are Ziggy.","tools":[],"extra":true}}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"tool-call","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","toolCallId":"call-a","toolName":"memory","input":{"score":1e400},"sourceIndex":0}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-response","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","response":{"api":"anthropic-messages","provider":"anthropic","model":"claude-test","responseId":"message-a","content":[],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"stop","timestamp":1,"extra":true}}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"approval-requested","sessionId":"session-a","turnId":"turn-a","approvalId":"approval-a","toolCallId":"call-a","choices":["approve","deny"]}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"approval-requested","sessionId":"session-a","turnId":"turn-a","approvalId":"approval-a","toolCallId":"call-a","prompt":"Allow?"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"approval-requested","sessionId":"session-a","turnId":"turn-a","approvalId":"approval-a","toolCallId":"call-a","prompt":"Allow?","choices":["approve","later"]}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"approval-resolved","sessionId":"session-a","turnId":"turn-a","approvalId":"approval-a","decision":"later"}}\n',
      '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"},"extra":true}\n',
    ];

    for (const frame of invalidFrames) {
      expect(() => decodeSessionEnvelope(frame)).toThrow();
    }
  });

  test("rejects empty identifiers and invalid token or provider timestamps", () => {
    const invalidFrames: ReadonlyArray<string> = [
      canonicalFrame.replace('"sessionId":"session-a"', '"sessionId":""'),
      canonicalFrame.replace('"turnId":"turn-a"', '"turnId":""'),
      '{"schemaVersion":1,"seq":1,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-response","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","response":{"api":"anthropic-messages","provider":"anthropic","model":"claude-test","content":[],"usage":{"input":-1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":0},"stopReason":"stop","timestamp":1}}}\n',
      '{"schemaVersion":1,"seq":1,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-response","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","response":{"api":"anthropic-messages","provider":"anthropic","model":"claude-test","content":[],"usage":{"input":1.5,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"stop","timestamp":1}}}\n',
      '{"schemaVersion":1,"seq":1,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-response","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","response":{"api":"anthropic-messages","provider":"anthropic","model":"claude-test","content":[],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"stop","timestamp":-1}}}\n',
      '{"schemaVersion":1,"seq":1,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"model-response","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","response":{"api":"","provider":"anthropic","model":"claude-test","content":[],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"stop","timestamp":1}}}\n',
    ];

    for (const frame of invalidFrames) {
      expect(() => decodeSessionEnvelope(frame)).toThrow();
    }
  });

  test("preserves dangerous JSON keys without prototype mutation", () => {
    const frame =
      '{"schemaVersion":1,"seq":1,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"tool-call","sessionId":"session-a","turnId":"turn-a","stepId":"step-a","toolCallId":"call-a","toolName":"memory","input":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}},"sourceIndex":0}}\n';
    const decoded = decodeSessionEnvelope(frame);

    expect(decoded.event.type).toBe("tool-call");
    if (decoded.event.type !== "tool-call") {
      throw new Error("Expected tool-call frame");
    }
    expect(Object.hasOwn(decoded.event.input, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(decoded.event.input)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(encodeSessionEnvelope(decoded)).toBe(frame);
  });

  test("rejects unknown fields on every event variant", () => {
    for (const [index, event] of events.entries()) {
      const frame = `${JSON.stringify({
        schemaVersion: 1,
        seq: index + 1,
        emittedAt: "2026-07-19T00:00:00.000Z",
        event: { ...event, extra: true },
      })}\n`;

      expect(() => decodeSessionEnvelope(frame)).toThrow();
    }
  });

  test("rejects malformed, torn, empty, and multiple frames", () => {
    const invalidFrames: ReadonlyArray<string> = [
      "",
      "\n",
      "{not-json}\n",
      canonicalFrame.slice(0, -1),
      `${canonicalFrame}${canonicalFrame}`,
    ];

    for (const frame of invalidFrames) {
      expect(() => decodeSessionEnvelope(frame)).toThrow();
    }
  });
});

describe("attach method contracts", () => {
  test("keeps the complete S1 method vocabulary exact", () => {
    expect(protocolMethods).toEqual([
      "initialize",
      "session/start",
      "session/ensure",
      "session/resume",
      "session/list",
      "session/subscribe",
      "session/unsubscribe",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "approval/resolve",
    ]);
  });

  test("negotiates client rendering capabilities and server protocol features", () => {
    expect(initializeRequest).toEqual({
      client: { name: "ziggy-test", version: "1.0.0" },
      features: ["modelChunks", "approvalRequests"],
    });
    expect(initializeResponse).toEqual({
      protocolVersion: 2,
      features: [
        "sessionReplay",
        "turnSteering",
        "turnInterrupt",
        "approvals",
        "stableMainSession",
        "providerAuth",
      ],
    });
    expect(negotiateServerFeatures(false)).toEqual([
      "sessionReplay",
      "turnSteering",
      "turnInterrupt",
      "approvals",
      "stableMainSession",
    ]);
    expect(negotiateServerFeatures(true)).toEqual(initializeResponse.features);
  });

  test("covers every Session request and response shape", () => {
    expect([
      sessionStartRequest,
      sessionStartResponse,
      sessionEnsureRequest,
      sessionEnsureResponse,
      sessionResumeRequest,
      sessionResumeResponse,
      sessionListRequest,
      sessionListResponse,
      sessionSubscribeRequest,
      sessionSubscribeResponse,
      sessionUnsubscribeRequest,
      sessionUnsubscribeResponse,
    ]).toEqual([
      {},
      { session },
      { sessionId: "main" },
      { session: { ...session, sessionId: "main" } },
      { sessionId: "session-a", sinceSeq: 4 },
      { session, subscriptionId: "subscription-a", replayThroughSeq: 4 },
      {},
      { sessions: [session] },
      { sessionId: "session-a", sinceSeq: 4 },
      { subscriptionId: "subscription-a", replayThroughSeq: 4 },
      { subscriptionId: "subscription-a" },
      { unsubscribed: true },
    ]);
  });

  test("covers every Turn request and response shape", () => {
    expect(turnStartRequest).toEqual({ sessionId: "session-a", message: "next" });
    expect(turnStartResponse).toEqual({ turnId: "turn-a", disposition: "started" });
    expect(turnSteerRequest).toEqual({
      sessionId: "session-a",
      expectedTurnId: "turn-a",
      message: "change direction",
    });
    expect(turnSteerResponse).toEqual({ turnId: "turn-a" });
    expect(turnInterruptRequest).toEqual({
      sessionId: "session-a",
      expectedTurnId: "turn-a",
    });
    expect(turnInterruptResponse).toEqual({ turnId: "turn-a" });
  });

  test("requires replay and optimistic-concurrency boundaries", () => {
    const subscribe: SessionSubscribeRequest = { sessionId: "session-a", sinceSeq: 4 };
    const resume: SessionResumeRequest = { sessionId: "session-a", sinceSeq: 4 };
    const start: TurnStartRequest = { sessionId: "session-a", message: "next" };
    const steer: TurnSteerRequest = {
      sessionId: "session-a",
      expectedTurnId: "turn-a",
      message: "change direction",
    };
    const interrupt: TurnInterruptRequest = {
      sessionId: "session-a",
      expectedTurnId: "turn-a",
    };

    expect(subscribe.sinceSeq).toBe(4);
    expect(resume.sinceSeq).toBe(4);
    expect(sessionSubscribeResponse.replayThroughSeq).toBe(4);
    expect(sessionResumeResponse.replayThroughSeq).toBe(4);
    expect(sessionUnsubscribeRequest.subscriptionId).toBe("subscription-a");
    expect(start.sessionId).toBe("session-a");
    expect(steer.expectedTurnId).toBe("turn-a");
    expect(interrupt.expectedTurnId).toBe("turn-a");
  });

  test("restricts turn admission and approval decisions with first-response-wins outcomes", () => {
    const queued: TurnStartResponse = { turnId: "turn-b", disposition: "queued" };
    const deny: ApprovalResolveRequest = {
      sessionId: "session-a",
      approvalId: "approval-a",
      decision: "deny",
    };

    expect([turnStartResponse.disposition, queued.disposition]).toEqual(["started", "queued"]);
    expect([approvalResolveRequest.decision, deny.decision]).toEqual(["approve", "deny"]);
    expect([approvalResolvedResponse.outcome, approvalAlreadyResolvedResponse.outcome]).toEqual([
      "resolved",
      "already-resolved",
    ]);
  });
});
