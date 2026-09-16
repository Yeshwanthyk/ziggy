/* oxlint-disable ziggy-effect/no-native-promise-ownership -- The Pi event bus is the extension-to-extension async boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Protocol failures become bounded Pi tool failures. */
/* oxlint-disable ziggy/no-unknown-parameters -- Event bus replies are decoded at this boundary. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread -- Exact optional reply fields are projected from schema-decoded data. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import type { BrowserJobBridge } from "./browser-jobs.ts";

const CHANNEL = "ziggy:computer-use:browser-bridge:v1";
const BridgeErrorCode = Type.Union([
  Type.Literal("browser-busy"),
  Type.Literal("invalid-owner"),
  Type.Literal("aborted"),
  Type.Literal("invalid-request"),
  Type.Literal("browser-error"),
]);
const Failure = Type.Object(
  {
    version: Type.Literal(1),
    ok: Type.Literal(false),
    requestId: Type.String(),
    operation: Type.String(),
    error: Type.Object({ code: BridgeErrorCode, message: Type.String({ maxLength: 1_024 }) }),
  },
  { additionalProperties: false },
);
const SuccessBase = {
  version: Type.Literal(1),
  ok: Type.Literal(true),
  requestId: Type.String(),
};
const AcquireReply = Type.Union([
  Failure,
  Type.Object(
    {
      ...SuccessBase,
      operation: Type.Literal("acquire"),
      token: Type.String({ minLength: 1, maxLength: 256 }),
      stateId: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
const NavigateReply = Type.Union([
  Failure,
  Type.Object(
    { ...SuccessBase, operation: Type.Literal("navigate"), stateId: Type.String() },
    { additionalProperties: false },
  ),
]);
const WaitReply = Type.Union([
  Failure,
  Type.Object(
    {
      ...SuccessBase,
      operation: Type.Literal("wait"),
      stateId: Type.String(),
      found: Type.Boolean(),
      timedOut: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
const EvaluateReply = Type.Union([
  Failure,
  Type.Object(
    {
      ...SuccessBase,
      operation: Type.Literal("evaluate"),
      stateId: Type.String(),
      value: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
]);
const ReleaseReply = Type.Union([
  Failure,
  Type.Object(
    { ...SuccessBase, operation: Type.Literal("release"), released: Type.Boolean() },
    { additionalProperties: false },
  ),
]);

class BrowserBridgeError extends Error {
  constructor(
    readonly code: Static<typeof BridgeErrorCode>,
    message: string,
  ) {
    super(message);
  }
}

const request = async <
  Reply extends { readonly requestId: string; readonly operation: string },
>(input: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly operation: "acquire" | "navigate" | "wait" | "evaluate" | "release";
  readonly payload: object;
  readonly signal: AbortSignal;
  readonly decode: (value: unknown) => Reply;
}): Promise<Reply> => {
  input.signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const reply = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    input.pi.events.emit(CHANNEL, {
      version: 1,
      requestId,
      operation: input.operation,
      ...input.payload,
      ctx: input.ctx,
      signal: input.signal,
      accept: () => {
        accepted = true;
      },
      reply: finish,
    });
    if (!accepted && !settled) {
      settled = true;
      reject(
        new BrowserBridgeError(
          "invalid-request",
          "The computer-use browser bridge is not loaded in this Profile.",
        ),
      );
    }
  });
  const decoded = input.decode(reply);
  if (decoded.requestId !== requestId || decoded.operation !== input.operation) {
    throw new BrowserBridgeError(
      "invalid-request",
      "Computer-use returned a mismatched bridge reply.",
    );
  }
  return decoded;
};

export const makeBrowserJobBridge = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): BrowserJobBridge => ({
  acquire: async (parameters, signal) => {
    const reply = await request({
      pi,
      ctx,
      operation: "acquire",
      payload: parameters,
      signal,
      decode: (value) => Parse(AcquireReply, value),
    });
    if (!reply.ok) throw new BrowserBridgeError(reply.error.code, reply.error.message);
    return { token: reply.token };
  },
  navigate: async (parameters, signal) => {
    const reply = await request({
      pi,
      ctx,
      operation: "navigate",
      payload: parameters,
      signal,
      decode: (value) => Parse(NavigateReply, value),
    });
    if (!reply.ok) throw new BrowserBridgeError(reply.error.code, reply.error.message);
  },
  wait: async (parameters, signal) => {
    const reply = await request({
      pi,
      ctx,
      operation: "wait",
      payload: parameters,
      signal,
      decode: (value) => Parse(WaitReply, value),
    });
    if (!reply.ok) throw new BrowserBridgeError(reply.error.code, reply.error.message);
    return {
      found: reply.found,
      ...(reply.timedOut === undefined ? {} : { timedOut: reply.timedOut }),
    };
  },
  evaluate: async (parameters, signal) => {
    const reply = await request({
      pi,
      ctx,
      operation: "evaluate",
      payload: parameters,
      signal,
      decode: (value) => Parse(EvaluateReply, value),
    });
    if (!reply.ok) throw new BrowserBridgeError(reply.error.code, reply.error.message);
    return { value: reply.value };
  },
  release: async (parameters) => {
    const releaseSignal = new AbortController().signal;
    const reply = await request({
      pi,
      ctx,
      operation: "release",
      payload: parameters,
      signal: releaseSignal,
      decode: (value) => Parse(ReleaseReply, value),
    });
    if (!reply.ok) throw new BrowserBridgeError(reply.error.code, reply.error.message);
  },
});
