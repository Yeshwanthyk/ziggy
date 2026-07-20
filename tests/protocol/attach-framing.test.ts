import { describe, expect, test } from "bun:test";
import {
  decodeClientRequest,
  decodeServerFrame,
  encodeClientRequest,
  encodeServerFrame,
} from "../../packages/protocol/src/index.ts";
import type {
  ClientRequestFrame,
  ProtocolErrorCode,
  ServerErrorFrame,
  ServerFrame,
  ServerSessionEventFrame,
  ServerSuccessFrame,
  SessionEnvelope,
} from "../../packages/protocol/src/index.ts";
import { ProtocolDecodeError } from "../../packages/protocol/src/index.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

function expectType<_Condition extends true>(): void {}

function requestFrameAt(
  frames: ReadonlyArray<ClientRequestFrame>,
  index: number,
): ClientRequestFrame {
  const frame = frames[index];
  if (frame === undefined) {
    throw new Error(`missing request frame ${index}`);
  }
  return frame;
}

function successFrameAt(
  frames: ReadonlyArray<ServerSuccessFrame>,
  index: number,
): ServerSuccessFrame {
  const frame = frames[index];
  if (frame === undefined) {
    throw new Error(`missing success frame ${index}`);
  }
  return frame;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!isJsonObject(value)) {
    throw new Error("expected a JSON object");
  }
  return value;
}

const sessionSummary = {
  sessionId: "session-a",
  createdAt: "2026-07-19T00:00:00.000Z",
  lastSeq: 4,
  activeTurnId: "turn-a",
} as const;

const envelope: SessionEnvelope = {
  schemaVersion: 1,
  seq: 7,
  emittedAt: "2026-07-19T00:00:00.000Z",
  event: {
    type: "turn-started",
    sessionId: "session-a",
    turnId: "turn-a",
    message: "hello",
    origin: "user",
  },
};

const canonicalEnvelopeFrame =
  '{"schemaVersion":1,"seq":7,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"session-a","turnId":"turn-a","message":"hello","origin":"user"}}';

// One request frame per protocol method, exercising the existing request param shapes.
const requestFrames: ReadonlyArray<ClientRequestFrame> = [
  {
    schemaVersion: 1,
    requestId: "req-1",
    method: "initialize",
    params: { client: { name: "ziggy-test", version: "1.0.0" }, features: ["modelChunks"] },
  },
  { schemaVersion: 1, requestId: "req-2", method: "session/start", params: {} },
  {
    schemaVersion: 1,
    requestId: "req-3",
    method: "session/resume",
    params: { sessionId: "session-a", sinceSeq: 4 },
  },
  { schemaVersion: 1, requestId: "req-4", method: "session/list", params: {} },
  {
    schemaVersion: 1,
    requestId: "req-5",
    method: "session/subscribe",
    params: { sessionId: "session-a", sinceSeq: 0 },
  },
  {
    schemaVersion: 1,
    requestId: "req-6",
    method: "session/unsubscribe",
    params: { subscriptionId: "sub-a" },
  },
  {
    schemaVersion: 1,
    requestId: "req-7",
    method: "turn/start",
    params: { sessionId: "session-a", message: "next" },
  },
  {
    schemaVersion: 1,
    requestId: "req-8",
    method: "turn/steer",
    params: { sessionId: "session-a", expectedTurnId: "turn-a", message: "change direction" },
  },
  {
    schemaVersion: 1,
    requestId: "req-9",
    method: "turn/interrupt",
    params: { sessionId: "session-a", expectedTurnId: "turn-a" },
  },
  {
    schemaVersion: 1,
    requestId: "req-10",
    method: "approval/resolve",
    params: { sessionId: "session-a", approvalId: "approval-a", decision: "deny" },
  },
];

// One success frame per protocol method, exercising the existing response result shapes.
const successFrames: ReadonlyArray<ServerSuccessFrame> = [
  {
    schemaVersion: 1,
    requestId: "req-1",
    method: "initialize",
    type: "success",
    result: {
      protocolVersion: 1,
      features: ["sessionReplay", "turnSteering", "turnInterrupt", "approvals"],
    },
  },
  {
    schemaVersion: 1,
    requestId: "req-2",
    method: "session/start",
    type: "success",
    result: { session: sessionSummary },
  },
  {
    schemaVersion: 1,
    requestId: "req-3",
    method: "session/resume",
    type: "success",
    result: { session: sessionSummary, subscriptionId: "sub-a", replayThroughSeq: 4 },
  },
  {
    schemaVersion: 1,
    requestId: "req-4",
    method: "session/list",
    type: "success",
    result: { sessions: [sessionSummary] },
  },
  {
    schemaVersion: 1,
    requestId: "req-5",
    method: "session/subscribe",
    type: "success",
    result: { subscriptionId: "sub-a", replayThroughSeq: 0 },
  },
  {
    schemaVersion: 1,
    requestId: "req-6",
    method: "session/unsubscribe",
    type: "success",
    result: { unsubscribed: true },
  },
  {
    schemaVersion: 1,
    requestId: "req-7",
    method: "turn/start",
    type: "success",
    result: { turnId: "turn-a", disposition: "queued" },
  },
  {
    schemaVersion: 1,
    requestId: "req-8",
    method: "turn/steer",
    type: "success",
    result: { turnId: "turn-a" },
  },
  {
    schemaVersion: 1,
    requestId: "req-9",
    method: "turn/interrupt",
    type: "success",
    result: { turnId: "turn-a" },
  },
  {
    schemaVersion: 1,
    requestId: "req-10",
    method: "approval/resolve",
    type: "success",
    result: { outcome: "already-resolved" },
  },
];

const errorCodes: ReadonlyArray<ProtocolErrorCode> = [
  "version-mismatch",
  "malformed-frame",
  "unknown-method",
  "invalid-params",
  "unsafe-sequence",
  "not-initialized",
  "already-initialized",
  "session-not-found",
  "stale-turn",
  "overloaded",
  "shutting-down",
  "internal",
];

const eventFrame: ServerSessionEventFrame = {
  schemaVersion: 1,
  type: "event",
  subscriptionId: "sub-a",
  event: envelope,
};

describe("attach framing types", () => {
  test("ClientRequestFrame is a discriminated union over every ProtocolMethod", () => {
    expectType<
      Equal<
        ClientRequestFrame["method"],
        | "initialize"
        | "session/start"
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
    expectType<Equal<ClientRequestFrame["schemaVersion"], 1>>();
  });

  test("ServerSuccessFrame is correlated by requestId and discriminates result by method", () => {
    expectType<Equal<ServerSuccessFrame["type"], "success">>();
    expectType<Equal<ServerSuccessFrame["requestId"], string>>();
    expectType<
      Equal<
        Extract<ServerSuccessFrame, { readonly method: "turn/start" }>["result"],
        { readonly turnId: string; readonly disposition: "started" | "queued" }
      >
    >();
  });

  test("ServerErrorFrame carries the closed error-code union", () => {
    expectType<Equal<ServerErrorFrame["type"], "error">>();
    expectType<
      Equal<
        ServerErrorFrame["code"],
        | "version-mismatch"
        | "malformed-frame"
        | "unknown-method"
        | "invalid-params"
        | "unsafe-sequence"
        | "not-initialized"
        | "already-initialized"
        | "session-not-found"
        | "stale-turn"
        | "overloaded"
        | "shutting-down"
        | "internal"
      >
    >();
    expectType<Equal<ServerErrorFrame["requestId"], string | null>>();
  });

  test("ServerSessionEventFrame carries the canonical SessionEnvelope unchanged", () => {
    expectType<Equal<ServerSessionEventFrame["type"], "event">>();
    expectType<Equal<ServerSessionEventFrame["event"], SessionEnvelope>>();
  });
});

describe("client request frame codec", () => {
  test("round-trips every protocol method with byte-stable canonical framing", () => {
    expect(requestFrames.map((frame) => frame.method)).toEqual([
      "initialize",
      "session/start",
      "session/resume",
      "session/list",
      "session/subscribe",
      "session/unsubscribe",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "approval/resolve",
    ]);

    for (const frame of requestFrames) {
      const encoded = encodeClientRequest(frame);
      expect(encoded.endsWith("\n")).toBe(true);
      expect(encoded.endsWith("\n\n")).toBe(false);
      const decoded = decodeClientRequest(encoded);
      expect(decoded).toEqual(frame);
      expect(encodeClientRequest(decoded)).toBe(encoded);
    }
  });

  test("encodes the initialize request in canonical key order", () => {
    const encoded = encodeClientRequest(requestFrameAt(requestFrames, 0));
    expect(encoded).toBe(
      '{"schemaVersion":1,"requestId":"req-1","method":"initialize","params":{"client":{"name":"ziggy-test","version":"1.0.0"},"features":["modelChunks"]}}\n',
    );
  });

  test("encodes empty-param methods as params:{} and rejects extra params", () => {
    const start = requestFrameAt(requestFrames, 1);
    expect(encodeClientRequest(start)).toBe(
      '{"schemaVersion":1,"requestId":"req-2","method":"session/start","params":{}}\n',
    );
    const list = requestFrameAt(requestFrames, 3);
    expect(encodeClientRequest(list)).toBe(
      '{"schemaVersion":1,"requestId":"req-4","method":"session/list","params":{}}\n',
    );
  });

  test("rejects wrong schema version, unknown methods, invalid params, extra keys, and unsafe sequences", () => {
    const invalid: ReadonlyArray<string> = [
      '{"schemaVersion":2,"requestId":"req-1","method":"initialize","params":{"client":{"name":"c","version":"1"},"features":[]}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"initialize","params":{"client":{"name":"c"}}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"initialize","params":{"client":{"name":"c","version":"1"},"features":["unknown"]}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/start","params":{"extra":true}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/resume","params":{"sessionId":"s","sinceSeq":-1}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/resume","params":{"sessionId":"s","sinceSeq":1.5}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/resume","params":{"sessionId":"s","sinceSeq":1e400}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/subscribe","params":{"sessionId":"s","sinceSeq":9007199254740992}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"turn/start","params":{"sessionId":"s"}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"turn/steer","params":{"sessionId":"s","expectedTurnId":"t"}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"approval/resolve","params":{"sessionId":"s","approvalId":"a","decision":"later"}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/unsubscribe","params":{"subscriptionId":""}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/unknown","params":{}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"initialize","params":{"client":{"name":"c","version":"1"},"features":[]},"extra":true}\n',
      '{"schemaVersion":1,"requestId":"","method":"session/start","params":{}}\n',
      '{"schemaVersion":1,"method":"session/start","params":{}}\n',
      '{"schemaVersion":1,"requestId":"req-1","method":"session/start"}\n',
    ];
    for (const frame of invalid) {
      expect(() => decodeClientRequest(frame)).toThrow();
    }
  });

  test("rejects malformed, torn, empty, and multiple frames", () => {
    const valid = encodeClientRequest(requestFrameAt(requestFrames, 0));
    for (const frame of ["", "\n", "{not-json}\n", valid.slice(0, -1), `${valid}${valid}`]) {
      expect(() => decodeClientRequest(frame)).toThrow();
    }
  });
});

describe("server frame codec", () => {
  test("round-trips every success result correlated by requestId", () => {
    expect(successFrames.map((frame) => frame.method)).toEqual([
      "initialize",
      "session/start",
      "session/resume",
      "session/list",
      "session/subscribe",
      "session/unsubscribe",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "approval/resolve",
    ]);

    for (const frame of successFrames) {
      const encoded = encodeServerFrame(frame);
      expect(encoded.endsWith("\n")).toBe(true);
      const decoded = decodeServerFrame(encoded);
      expect(decoded).toEqual(frame);
      expect(encodeServerFrame(decoded)).toBe(encoded);
    }
  });

  test("round-trips every error code in the closed union", () => {
    for (const code of errorCodes) {
      const frame: ServerErrorFrame = {
        schemaVersion: 1,
        requestId: "req-err",
        type: "error",
        code,
        message: `rejected: ${code}`,
      };
      const encoded = encodeServerFrame(frame);
      const decoded = decodeServerFrame(encoded);
      expect(decoded).toEqual(frame);
      expect(encodeServerFrame(decoded)).toBe(encoded);
    }
  });

  test("encodes the initialize success in canonical key order", () => {
    const encoded = encodeServerFrame(successFrameAt(successFrames, 0));
    expect(encoded).toBe(
      '{"schemaVersion":1,"requestId":"req-1","method":"initialize","type":"success","result":{"protocolVersion":1,"features":["sessionReplay","turnSteering","turnInterrupt","approvals"]}}\n',
    );
  });

  test("round-trips the Session-event frame and preserves the canonical SessionEnvelope byte-for-byte", () => {
    const encoded = encodeServerFrame(eventFrame);
    expect(encoded).toBe(
      `{"schemaVersion":1,"type":"event","subscriptionId":"sub-a","event":${canonicalEnvelopeFrame}}\n`,
    );
    const decoded = decodeServerFrame(encoded);
    expect(decoded).toEqual(eventFrame);
    expect(encodeServerFrame(decoded)).toBe(encoded);
  });

  test("the event payload is the sole sequence authority; the frame adds no second seq field", () => {
    const encoded = encodeServerFrame(eventFrame);
    const object = jsonObject(JSON.parse(encoded.slice(0, -1)));
    expect(Object.keys(object).sort()).toEqual([
      "event",
      "schemaVersion",
      "subscriptionId",
      "type",
    ]);
    const event = jsonObject(object.event);
    expect(Object.keys(event).sort()).toEqual(["emittedAt", "event", "schemaVersion", "seq"]);
    expect(event.seq).toBe(7);
  });

  test("rejects wrong schema version, unknown frame type, unknown method, and extra keys on server frames", () => {
    const validSuccess = encodeServerFrame(successFrameAt(successFrames, 0));
    const validError = encodeServerFrame({
      schemaVersion: 1,
      requestId: "req-err",
      type: "error",
      code: "invalid-params",
      message: "bad",
    });
    const validEvent = encodeServerFrame(eventFrame);
    const invalid: ReadonlyArray<string> = [
      validSuccess.replace('"schemaVersion":1', '"schemaVersion":2'),
      validSuccess.replace('"method":"initialize"', '"method":"session/unknown"'),
      validSuccess.replace('"type":"success"', '"type":"unknown"'),
      `${validSuccess.slice(0, -2)},"extra":true}\n`,
      validError.replace('"code":"invalid-params"', '"code":"invented"'),
      `${validError.slice(0, -2)},"extra":true}\n`,
      validEvent.replace('"schemaVersion":1', '"schemaVersion":2'),
      `${validEvent.slice(0, -2)},"extra":true}\n`,
      '{"schemaVersion":1,"requestId":"req-1","type":"event","subscriptionId":"","event":' +
        canonicalEnvelopeFrame +
        "}\n",
    ];
    for (const frame of invalid) {
      expect(() => decodeServerFrame(frame)).toThrow();
    }
  });

  test("rejects a server frame missing the type discriminator", () => {
    expect(() =>
      decodeServerFrame('{"schemaVersion":1,"requestId":"req-1","method":"initialize"}\n'),
    ).toThrow();
  });

  test("rejects malformed, torn, empty, and multiple server frames", () => {
    const valid = encodeServerFrame(successFrameAt(successFrames, 0));
    for (const frame of ["", "\n", "{not-json}\n", valid.slice(0, -1), `${valid}${valid}`]) {
      expect(() => decodeServerFrame(frame)).toThrow();
    }
  });

  test("ServerFrame narrows to the three frame kinds", () => {
    const frames: ReadonlyArray<ServerFrame> = [
      ...successFrames,
      ...errorCodes.map(
        (code): ServerErrorFrame => ({
          schemaVersion: 1,
          requestId: "req-err",
          type: "error" as const,
          code,
          message: "m",
        }),
      ),
      eventFrame,
    ];
    const kinds = new Set(frames.map((frame) => frame.type));
    expect([...kinds].sort()).toEqual(["error", "event", "success"]);
  });
});

describe("Session-envelope authority preservation", () => {
  test("the event frame wraps a fully decoded canonical envelope across every event variant", () => {
    const events: ReadonlyArray<SessionEnvelope["event"]> = [
      { type: "session-started", sessionId: "s", snapshot: { systemPrompt: "p", tools: [] } },
      { type: "turn-started", sessionId: "s", turnId: "t", message: "m", origin: "user" },
      {
        type: "step-started",
        sessionId: "s",
        turnId: "t",
        stepId: "st",
        provider: "anthropic",
        model: "claude",
      },
      {
        type: "model-chunk",
        sessionId: "s",
        turnId: "t",
        stepId: "st",
        contentIndex: 0,
        kind: "text",
        delta: "x",
      },
      {
        type: "tool-call",
        sessionId: "s",
        turnId: "t",
        stepId: "st",
        toolCallId: "c",
        toolName: "memory",
        input: {},
        sourceIndex: 0,
      },
      {
        type: "tool-result",
        sessionId: "s",
        turnId: "t",
        stepId: "st",
        toolCallId: "c",
        output: null,
        isError: false,
        sourceIndex: 0,
      },
      { type: "step-ended", sessionId: "s", turnId: "t", stepId: "st", status: "completed" },
      { type: "turn-ended", sessionId: "s", turnId: "t", status: "failed" },
      { type: "steer-received", sessionId: "s", turnId: "t", message: "m" },
      { type: "follow-up-received", sessionId: "s", turnId: "t", message: "m" },
      { type: "interrupt-received", sessionId: "s", turnId: "t" },
      {
        type: "approval-requested",
        sessionId: "s",
        turnId: "t",
        approvalId: "a",
        toolCallId: "c",
        prompt: "p?",
        choices: ["approve", "deny"],
      },
      {
        type: "approval-resolved",
        sessionId: "s",
        turnId: "t",
        approvalId: "a",
        decision: "approve",
      },
    ];
    for (const [index, event] of events.entries()) {
      const env: SessionEnvelope = {
        schemaVersion: 1,
        seq: index + 1,
        emittedAt: "2026-07-19T00:00:00.000Z",
        event,
      };
      const frame: ServerSessionEventFrame = {
        schemaVersion: 1,
        type: "event",
        subscriptionId: "sub-a",
        event: env,
      };
      const encoded = encodeServerFrame(frame);
      const decoded = decodeServerFrame(encoded);
      expect(decoded).toEqual(frame);
      expect(encodeServerFrame(decoded)).toBe(encoded);
    }
  });

  test("rejects an event frame whose envelope has a torn/invalid seq", () => {
    const badEnvelope =
      '{"schemaVersion":1,"seq":0,"emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"s","turnId":"t","message":"m","origin":"user"}}';
    const frame = `{"schemaVersion":1,"type":"event","subscriptionId":"sub-a","event":${badEnvelope}}\n`;
    expect(() => decodeServerFrame(frame)).toThrow();
  });
});

/** Catch a decode failure and return it as a typed ProtocolDecodeError, or fail the test. */
function decodeFailure(thunk: () => unknown): ProtocolDecodeError {
  try {
    thunk();
  } catch (error) {
    if (error instanceof ProtocolDecodeError) {
      return error;
    }
    throw new Error(`expected ProtocolDecodeError, got ${String(error)}`);
  }
  throw new Error("expected decode to throw, but it succeeded");
}

describe("server error frame correlation", () => {
  test("round-trips a correlated error with a nonempty requestId", () => {
    const frame: ServerErrorFrame = {
      schemaVersion: 1,
      requestId: "req-error",
      type: "error",
      code: "invalid-params",
      message: "bad params",
    };
    const encoded = encodeServerFrame(frame);
    expect(encoded).toBe(
      '{"schemaVersion":1,"requestId":"req-error","type":"error","code":"invalid-params","message":"bad params"}\n',
    );
    const decoded = decodeServerFrame(encoded);
    expect(decoded).toEqual(frame);
    expect(encodeServerFrame(decoded)).toBe(encoded);
  });

  test("round-trips an uncorrelated error with requestId null", () => {
    const frame: ServerErrorFrame = {
      schemaVersion: 1,
      requestId: null,
      type: "error",
      code: "malformed-frame",
      message: "not valid JSON",
    };
    const encoded = encodeServerFrame(frame);
    expect(encoded).toBe(
      '{"schemaVersion":1,"requestId":null,"type":"error","code":"malformed-frame","message":"not valid JSON"}\n',
    );
    const decoded = decodeServerFrame(encoded);
    expect(decoded).toEqual(frame);
    expect(encodeServerFrame(decoded)).toBe(encoded);
  });

  test("every expanded error code round-trips with requestId null", () => {
    for (const code of errorCodes) {
      const frame: ServerErrorFrame = {
        schemaVersion: 1,
        requestId: null,
        type: "error",
        code,
        message: `uncorrelated: ${code}`,
      };
      const encoded = encodeServerFrame(frame);
      const decoded = decodeServerFrame(encoded);
      expect(decoded).toEqual(frame);
      expect(encodeServerFrame(decoded)).toBe(encoded);
    }
  });

  test("rejects an error frame missing requestId", () => {
    expect(() =>
      decodeServerFrame('{"schemaVersion":1,"type":"error","code":"internal","message":"m"}\n'),
    ).toThrow();
  });

  test("rejects an error frame with an invalid non-null requestId", () => {
    const invalid: ReadonlyArray<string> = [
      '{"schemaVersion":1,"requestId":"","type":"error","code":"internal","message":"m"}\n',
      '{"schemaVersion":1,"requestId":42,"type":"error","code":"internal","message":"m"}\n',
      '{"schemaVersion":1,"requestId":true,"type":"error","code":"internal","message":"m"}\n',
    ];
    for (const frame of invalid) {
      expect(() => decodeServerFrame(frame)).toThrow();
    }
  });
});

describe("typed client decode failures", () => {
  test("malformed JSON maps to malformed-frame with null requestId", () => {
    const error = decodeFailure(() => decodeClientRequest("{not-json}\n"));
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("missing requestId maps to malformed-frame with null requestId", () => {
    const error = decodeFailure(() =>
      decodeClientRequest('{"schemaVersion":1,"method":"session/start","params":{}}\n'),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("empty-string requestId maps to malformed-frame with null requestId", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":"","method":"session/start","params":{}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("non-string requestId maps to malformed-frame with null requestId", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":42,"method":"session/start","params":{}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("wrong schema version with valid requestId maps to version-mismatch and recovers the id", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":2,"requestId":"req-9","method":"session/start","params":{}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("version-mismatch");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("unknown method with valid requestId maps to unknown-method", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":"req-9","method":"session/unknown","params":{}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("unknown-method");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("invalid params with valid requestId maps to invalid-params", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":"req-9","method":"initialize","params":{"client":{"name":"c"}}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("invalid-params");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("unsafe sinceSeq with valid requestId maps to unsafe-sequence", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":"req-9","method":"session/resume","params":{"sessionId":"s","sinceSeq":-1}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("unsafe-sequence");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("extra top-level keys with valid requestId map to malformed-frame and recover the id", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":"req-9","method":"session/start","params":{},"extra":true}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("ProtocolDecodeError name is set", () => {
    const error = decodeFailure(() => decodeClientRequest("{not-json}\n"));
    expect(error.name).toBe("ProtocolDecodeError");
  });
});

describe("typed server decode failures", () => {
  test("non-object server frame maps to malformed-frame with null requestId", () => {
    const error = decodeFailure(() => decodeServerFrame("[1,2,3]\n"));
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("server frame with non-string type maps to malformed-frame", () => {
    const error = decodeFailure(() =>
      decodeServerFrame('{"schemaVersion":1,"requestId":"req-1","type":42}\n'),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("invalid success result maps to malformed-frame and recovers requestId", () => {
    const error = decodeFailure(() =>
      decodeServerFrame(
        '{"schemaVersion":1,"requestId":"req-1","method":"session/start","type":"success","result":{"session":"not-an-object"}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-1");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("missing success result keys map to malformed-frame and recover requestId", () => {
    const error = decodeFailure(() =>
      decodeServerFrame(
        '{"schemaVersion":1,"requestId":"req-1","method":"session/start","type":"success","result":{}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-1");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("invalid error message field maps to malformed-frame and recovers requestId", () => {
    const error = decodeFailure(() =>
      decodeServerFrame(
        '{"schemaVersion":1,"requestId":"req-1","type":"error","code":"internal","message":42}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-1");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("unknown error code maps to malformed-frame and recovers requestId", () => {
    const error = decodeFailure(() =>
      decodeServerFrame(
        '{"schemaVersion":1,"requestId":"req-1","type":"error","code":"invented","message":"m"}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-1");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("invalid event subscriptionId maps to malformed-frame with null requestId", () => {
    const error = decodeFailure(() =>
      decodeServerFrame(
        `{"schemaVersion":1,"type":"event","subscriptionId":42,"event":${canonicalEnvelopeFrame}}\n`,
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("invalid event payload (torn envelope) maps to malformed-frame with null requestId", () => {
    const badEnvelope =
      '{"schemaVersion":1,"seq":"not-a-number","emittedAt":"2026-07-19T00:00:00.000Z","event":{"type":"turn-started","sessionId":"s","turnId":"t","message":"m","origin":"user"}}';
    const error = decodeFailure(() =>
      decodeServerFrame(
        `{"schemaVersion":1,"type":"event","subscriptionId":"sub-a","event":${badEnvelope}}\n`,
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe(null);
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe("client method discriminator contract", () => {
  test("non-string method maps to malformed-frame (not unknown-method)", () => {
    const error = decodeFailure(() =>
      decodeClientRequest('{"schemaVersion":1,"requestId":"req-9","method":42,"params":{}}\n'),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("null method maps to malformed-frame (not unknown-method)", () => {
    const error = decodeFailure(() =>
      decodeClientRequest('{"schemaVersion":1,"requestId":"req-9","method":null,"params":{}}\n'),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("malformed-frame");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });

  test("syntactically valid but unregistered string method maps to unknown-method", () => {
    const error = decodeFailure(() =>
      decodeClientRequest(
        '{"schemaVersion":1,"requestId":"req-9","method":"session/unknown","params":{}}\n',
      ),
    );
    expect(error).toBeInstanceOf(ProtocolDecodeError);
    expect(error.code).toBe("unknown-method");
    expect(error.requestId).toBe("req-9");
    expect(error.message.length).toBeGreaterThan(0);
  });
});
