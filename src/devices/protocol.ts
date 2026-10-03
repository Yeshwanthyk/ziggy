/**
 * ZDP/1, the Ziggy device protocol: frames, JSON-RPC messages and the pairing URI.
 * `docs/devices/protocol.md` is the contract; these schemas decode it strictly.
 */
import { Effect, Schema } from "effect";

export const ZDP_VERSION = "1";

export const ZDP_PATH = "/zdp/1";

export const ZDP_PROLOGUE = new TextEncoder().encode("zdp/1");

/** JSON-RPC error codes, standard and ZDP's own. */
export const ZdpErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  busy: -32001,
  notAllowed: -32002,
  version: -32003,
  timeout: -32004,
} as const;

/** WebSocket close codes. */
export const ZdpClose = {
  protocol: 4400,
  unpaired: 4401,
  timeout: 4408,
  replaced: 4409,
  version: 4426,
} as const;

const RequestId = Schema.Union([Schema.Int, Schema.String]);

/**
 * A message or frame that does not match the protocol; `code` is the JSON-RPC error to answer,
 * and `id` the request's id when it could be read.
 */
export class ZdpInvalid extends Schema.TaggedErrorClass<ZdpInvalid>()("ZdpInvalid", {
  code: Schema.Int,
  message: Schema.String,
  id: Schema.optionalKey(RequestId),
}) {}

const strict = { onExcessProperty: "error" } as const;

const NoParams = Schema.Struct({});

const DeviceId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/));

const ToolName = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,48}$/));

const StreamId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }));

const ImageFormat = Schema.Literals(["rgb565", "jpeg"]);

const AudioIn = Schema.Literal("pcm16/16000");

const AudioOut = Schema.Literal("mp3");

const JsonObject = Schema.Record(Schema.String, Schema.Json);

// Pairing and session.

const DevicePair = Schema.Struct({
  /** The pairing code from the URI; dashes and case are ignored. */
  code: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
});

const DevicePaired = Schema.Struct({ id: DeviceId, profile: Schema.String });

export const DeviceCapabilities = Schema.Struct({
  tools: Schema.optionalKey(Schema.Struct({ listChanged: Schema.optionalKey(Schema.Boolean) })),
  screen: Schema.optionalKey(
    Schema.Struct({
      width: Dimension,
      height: Dimension,
      formats: Schema.NonEmptyArray(ImageFormat),
    }),
  ),
  audio: Schema.optionalKey(
    Schema.Struct({
      in: Schema.optionalKey(Schema.Array(AudioIn)),
      out: Schema.optionalKey(Schema.Array(AudioOut)),
    }),
  ),
  chat: Schema.optionalKey(Schema.Struct({})),
});

export type DeviceCapabilities = typeof DeviceCapabilities.Type;

const DeviceHello = Schema.Struct({
  zdp: Schema.String,
  name: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  firmware: Schema.String,
  capabilities: DeviceCapabilities,
});

const DeviceWelcome = Schema.Struct({ id: DeviceId, profile: Schema.String, zdp: Schema.String });

// Tools: MCP's shapes.

export const DeviceTool = Schema.Struct({
  name: ToolName,
  description: Schema.optionalKey(Schema.String),
  inputSchema: JsonObject,
});

export type DeviceTool = typeof DeviceTool.Type;

const ToolsList = Schema.Struct({ tools: Schema.Array(DeviceTool) });

const ToolCall = Schema.Struct({ name: ToolName, arguments: Schema.optionalKey(JsonObject) });

const ToolContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
]);

export const ToolResult = Schema.Struct({
  content: Schema.Array(ToolContent),
  isError: Schema.optionalKey(Schema.Boolean),
});

export type ToolResult = typeof ToolResult.Type;

// Chat.

const ChatSend = Schema.Union([
  Schema.Struct({ text: Schema.NonEmptyString }),
  Schema.Struct({ audio: Schema.Struct({ stream: StreamId, format: AudioIn }) }),
]);

const Turn = Schema.NonEmptyString;

const ChatAccepted = Schema.Struct({ turn: Turn });

const ChatStatus = Schema.Union([
  Schema.Struct({ turn: Turn, state: Schema.Literal("thinking") }),
  Schema.Struct({ turn: Turn, state: Schema.Literal("tool"), tool: Schema.String }),
]);

const ChatText = Schema.Struct({ turn: Turn, text: Schema.String });

const ChatError = Schema.Struct({ turn: Turn, message: Schema.String });

// Push.

const Notify = Schema.Struct({ title: Schema.optionalKey(Schema.String), text: Schema.String });

const DisplayShow = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({
    image: Schema.Struct({
      stream: StreamId,
      format: ImageFormat,
      width: Dimension,
      height: Dimension,
    }),
  }),
]);

const AudioPlay = Schema.Struct({ stream: StreamId, format: AudioOut });

const Version = Schema.Literal("2.0");

const request = <const M extends string, P extends Schema.Constraint>(method: M, params: P) =>
  Schema.Struct({ jsonrpc: Version, id: RequestId, method: Schema.Literal(method), params });

const bareRequest = <const M extends string>(method: M) =>
  Schema.Struct({
    jsonrpc: Version,
    id: RequestId,
    method: Schema.Literal(method),
    params: Schema.optionalKey(NoParams),
  });

const notification = <const M extends string, P extends Schema.Constraint>(method: M, params: P) =>
  Schema.Struct({ jsonrpc: Version, method: Schema.Literal(method), params });

const result = <const M extends string, R extends Schema.Constraint>(method: M, value: R) =>
  Schema.Struct({ method: Schema.Literal(method), result: value });

const ZdpRequest = Schema.Union([
  request("device.pair", DevicePair),
  request("device.hello", DeviceHello),
  bareRequest("ping"),
  bareRequest("tools/list"),
  request("tools/call", ToolCall),
  request("chat.send", ChatSend),
  bareRequest("chat.abort"),
]);

export type ZdpRequest = typeof ZdpRequest.Type;

export type ZdpRequestMethod = ZdpRequest["method"];

const ZdpNotification = Schema.Union([
  Schema.Struct({
    jsonrpc: Version,
    method: Schema.Literal("notifications/tools/list_changed"),
    params: Schema.optionalKey(NoParams),
  }),
  notification("chat.status", ChatStatus),
  notification("chat.delta", ChatText),
  notification("chat.done", ChatText),
  notification("chat.transcript", ChatText),
  notification("chat.error", ChatError),
  notification("notify", Notify),
  notification("display.show", DisplayShow),
  notification("audio.play", AudioPlay),
]);

export type ZdpNotification = typeof ZdpNotification.Type;

export type ZdpNotificationMethod = ZdpNotification["method"];

const ZdpSuccess = Schema.Struct({ jsonrpc: Version, id: RequestId, result: Schema.Json });

const ZdpFailure = Schema.Struct({
  jsonrpc: Version,
  id: Schema.NullOr(RequestId),
  error: Schema.Struct({
    code: Schema.Int,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  }),
});

/** A response's result is decoded once the requester matches it to its method. */
const ZdpResult = Schema.Union([
  result("device.pair", DevicePaired),
  result("device.hello", DeviceWelcome),
  result("ping", NoParams),
  result("tools/list", ToolsList),
  result("tools/call", ToolResult),
  result("chat.send", ChatAccepted),
  result("chat.abort", NoParams),
]);

export type ZdpResult = typeof ZdpResult.Type;

export const ZdpMessage = Schema.Union([ZdpRequest, ZdpNotification, ZdpSuccess, ZdpFailure]);

export type ZdpMessage = typeof ZdpMessage.Type;

/** Just enough of a message to answer it: an unknown method is -32601, bad params -32602. */
const Envelope = Schema.Struct({
  jsonrpc: Version,
  id: Schema.optionalKey(Schema.NullOr(RequestId)),
  method: Schema.optionalKey(Schema.String),
});

const methods: ReadonlySet<string> = new Set<ZdpRequestMethod | ZdpNotificationMethod>([
  "device.pair",
  "device.hello",
  "ping",
  "tools/list",
  "tools/call",
  "chat.send",
  "chat.abort",
  "notifications/tools/list_changed",
  "chat.status",
  "chat.delta",
  "chat.done",
  "chat.transcript",
  "chat.error",
  "notify",
  "display.show",
  "audio.play",
]);

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);

const decodeMessage = Schema.decodeUnknownEffect(ZdpMessage, strict);

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(ZdpMessage));

const decodeResultFor = Schema.decodeUnknownEffect(ZdpResult, strict);

/** Decodes a JSON message strictly, failing with the JSON-RPC code to answer it with. */
export const decodeZdpMessage = (text: string): Effect.Effect<ZdpMessage, ZdpInvalid> =>
  Effect.gen(function* () {
    const json = yield* decodeJson(text).pipe(
      Effect.mapError(
        () => new ZdpInvalid({ code: ZdpErrorCode.parse, message: "the frame is not JSON" }),
      ),
    );

    const envelope = yield* decodeEnvelope(json).pipe(
      Effect.mapError(
        () =>
          new ZdpInvalid({
            code: ZdpErrorCode.invalidRequest,
            message: "not a JSON-RPC 2.0 message",
          }),
      ),
    );

    const id = envelope.id ?? undefined;

    const answer = id === undefined ? {} : { id };

    if (envelope.method !== undefined && !methods.has(envelope.method))
      return yield* new ZdpInvalid({
        code: ZdpErrorCode.methodNotFound,
        message: `unknown method ${envelope.method}`,
        ...answer,
      });

    return yield* decodeMessage(json).pipe(
      Effect.mapError(
        (issue) =>
          new ZdpInvalid({
            code:
              envelope.method === undefined
                ? ZdpErrorCode.invalidRequest
                : ZdpErrorCode.invalidParams,
            message: issue.message,
            ...answer,
          }),
      ),
    );
  });

/** The JSON text of a message, checked against the schemas on the way out. */
export const encodeZdpMessage = (message: ZdpMessage): Effect.Effect<string, ZdpInvalid> =>
  encodeMessage(message).pipe(
    Effect.mapError(
      (issue) => new ZdpInvalid({ code: ZdpErrorCode.internal, message: issue.message }),
    ),
  );

/** Decodes a success response's result for the method its request named. */
export const decodeZdpResult = (
  method: ZdpRequestMethod,
  value: Schema.Json,
): Effect.Effect<ZdpResult, ZdpInvalid> =>
  decodeResultFor({ method, result: value }).pipe(
    Effect.mapError(
      (issue) => new ZdpInvalid({ code: ZdpErrorCode.invalidParams, message: issue.message }),
    ),
  );

// Frames.

const JSON_FRAME = 0x7b;

const CHUNK_FRAME = 0x01;

const CHUNK_HEADER = 4;

export type ZdpFrame =
  | { readonly kind: "message"; readonly message: ZdpMessage }
  | {
      readonly kind: "chunk";
      readonly stream: number;
      readonly last: boolean;
      readonly data: Uint8Array;
    };

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** One decrypted frame: a JSON message or a stream chunk. */
export const decodeZdpFrame = (frame: Uint8Array): Effect.Effect<ZdpFrame, ZdpInvalid> => {
  if (frame[0] === CHUNK_FRAME) {
    if (frame.length < CHUNK_HEADER)
      return Effect.fail(
        new ZdpInvalid({ code: ZdpErrorCode.parse, message: "a chunk is shorter than its header" }),
      );

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

    return Effect.succeed({
      kind: "chunk",
      stream: view.getUint16(1, false),
      last: (view.getUint8(3) & 1) === 1,
      data: frame.subarray(CHUNK_HEADER),
    });
  }

  if (frame[0] !== JSON_FRAME)
    return Effect.fail(new ZdpInvalid({ code: ZdpErrorCode.parse, message: "not a ZDP frame" }));

  return Effect.try({
    try: () => textDecoder.decode(frame),
    catch: () => new ZdpInvalid({ code: ZdpErrorCode.parse, message: "the frame is not UTF-8" }),
  }).pipe(
    Effect.flatMap(decodeZdpMessage),
    Effect.map((message) => ({ kind: "message" as const, message })),
  );
};

const textEncoder = new TextEncoder();

export const encodeZdpMessageFrame = (message: ZdpMessage): Effect.Effect<Uint8Array, ZdpInvalid> =>
  Effect.map(encodeZdpMessage(message), (text) => textEncoder.encode(text));

export const encodeZdpChunk = (stream: number, last: boolean, data: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(CHUNK_HEADER + data.length);

  const view = new DataView(frame.buffer);

  view.setUint8(0, CHUNK_FRAME);
  view.setUint16(1, stream, false);
  view.setUint8(3, last ? 1 : 0);
  frame.set(data, CHUNK_HEADER);

  return frame;
};

// Pairing URI.

export class ZdpPairingInvalid extends Schema.TaggedErrorClass<ZdpPairingInvalid>()(
  "ZdpPairingInvalid",
  { message: Schema.String },
) {}

/** What a device needs to pair: where the hub is, the one-time code, and the hub's key. */
export interface ZdpPairing {
  readonly host: string;
  readonly port: number;
  /** Ten Crockford base32 characters, upper-case, no dashes. */
  readonly code: string;
  /** The hub's static X25519 public key. */
  readonly key: Uint8Array;
}

const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** The code as typed or read aloud: case and dashes do not matter. */
export const normalizeZdpPairingCode = (code: string): string =>
  code.replaceAll("-", "").toUpperCase();

export const formatZdpPairing = (pairing: ZdpPairing): string => {
  const code = `${pairing.code.slice(0, 4)}-${pairing.code.slice(4, 8)}-${pairing.code.slice(8)}`;

  const key = Buffer.from(pairing.key).toString("base64url");

  return `zdp://${pairing.host}:${pairing.port}/pair?code=${code}&key=${key}`;
};

const invalidPairing = (message: string) => Effect.fail(new ZdpPairingInvalid({ message }));

export const decodeZdpPairing = (text: string): Effect.Effect<ZdpPairing, ZdpPairingInvalid> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(text),
      catch: () => new ZdpPairingInvalid({ message: "the pairing URI is not a URI" }),
    });

    if (url.protocol !== "zdp:" || url.pathname !== "/pair")
      return yield* invalidPairing("the pairing URI must start zdp://<host>:<port>/pair");

    const port = Number(url.port);

    if (url.hostname === "" || !Number.isInteger(port) || port < 1 || port > 65_535)
      return yield* invalidPairing("the pairing URI needs a host and port");

    const code = normalizeZdpPairingCode(url.searchParams.get("code") ?? "");

    if (!PAIRING_CODE.test(code))
      return yield* invalidPairing("the pairing code must be ten base32 characters");

    const keyText = url.searchParams.get("key") ?? "";

    const key = new Uint8Array(Buffer.from(keyText, "base64url"));

    if (key.length !== 32 || Buffer.from(key).toString("base64url") !== keyText)
      return yield* invalidPairing("the pairing key must be 32 bytes, base64url");

    return { host: url.hostname, port, code, key };
  });
