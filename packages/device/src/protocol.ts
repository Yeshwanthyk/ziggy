/**
 * ZDP/1 on the device side: constants, frames and the pairing URI. `docs/devices/protocol.md` in
 * the Ziggy repository is the contract; the hub decodes it strictly, so this side sends only what
 * that page names.
 */

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

export type Json = null | boolean | number | string | ReadonlyArray<Json> | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

export type RequestId = number | string;

/** A malformed frame or URI. */
export class ZdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZdpError";
  }
}

export const isJsonObject = (value: Json | undefined): value is JsonObject =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);

/** One JSON-RPC message with only the fields a receiver dispatches on read out. */
export interface ZdpEnvelope {
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: Json;
  readonly result?: Json;
  readonly error?: { readonly code: number; readonly message: string };
}

export type ZdpFrame =
  | { readonly kind: "message"; readonly message: ZdpEnvelope }
  | {
      readonly kind: "chunk";
      readonly stream: number;
      readonly last: boolean;
      readonly data: Uint8Array;
    };

const JSON_FRAME = 0x7b;

const CHUNK_FRAME = 0x01;

const CHUNK_HEADER = 4;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const textEncoder = new TextEncoder();

const parseJson = (text: string): Json => {
  try {
    // SAFETY: JSON.parse only produces JSON values.
    return JSON.parse(text) as Json;
  } catch {
    throw new ZdpError("the frame is not JSON");
  }
};

const readEnvelope = (value: Json): ZdpEnvelope => {
  if (!isJsonObject(value) || value.jsonrpc !== "2.0")
    throw new ZdpError("the frame is not JSON-RPC 2.0");

  const { id, method, params, result, error } = value;

  const envelope: { -readonly [K in keyof ZdpEnvelope]: ZdpEnvelope[K] } = {};

  if (typeof id === "number" || typeof id === "string") envelope.id = id;

  if (typeof method === "string") envelope.method = method;

  if (params !== undefined) envelope.params = params;

  if (result !== undefined) envelope.result = result;

  if (isJsonObject(error) && typeof error.code === "number" && typeof error.message === "string")
    envelope.error = { code: error.code, message: error.message };

  return envelope;
};

/** One decrypted frame. Throws `ZdpError` on anything ZDP does not define. */
export const decodeFrame = (frame: Uint8Array): ZdpFrame => {
  if (frame[0] === CHUNK_FRAME) {
    if (frame.length < CHUNK_HEADER) throw new ZdpError("a chunk is shorter than its header");

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

    return {
      kind: "chunk",
      stream: view.getUint16(1, false),
      last: (view.getUint8(3) & 1) === 1,
      data: frame.subarray(CHUNK_HEADER),
    };
  }

  if (frame[0] !== JSON_FRAME) throw new ZdpError("not a ZDP frame");

  let text: string;

  try {
    text = textDecoder.decode(frame);
  } catch {
    throw new ZdpError("the frame is not UTF-8");
  }

  return { kind: "message", message: readEnvelope(parseJson(text)) };
};

export const encodeMessage = (message: JsonObject): Uint8Array =>
  textEncoder.encode(JSON.stringify({ jsonrpc: "2.0", ...message }));

export const encodeChunk = (stream: number, last: boolean, data: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(CHUNK_HEADER + data.length);

  const view = new DataView(frame.buffer);

  view.setUint8(0, CHUNK_FRAME);
  view.setUint16(1, stream, false);
  view.setUint8(3, last ? 1 : 0);
  frame.set(data, CHUNK_HEADER);

  return frame;
};

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

/** Reads `zdp://<host>:<port>/pair?code=…&key=…`. Throws `ZdpError` when it is malformed. */
export const parsePairingUri = (text: string): ZdpPairing => {
  let url: URL;

  try {
    url = new URL(text.trim());
  } catch {
    throw new ZdpError("the pairing URI is not a URI");
  }

  if (url.protocol !== "zdp:" || url.pathname !== "/pair")
    throw new ZdpError("the pairing URI must start zdp://<host>:<port>/pair");

  const port = Number(url.port);

  if (url.hostname === "" || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ZdpError("the pairing URI needs a host and port");

  const code = (url.searchParams.get("code") ?? "").replaceAll("-", "").toUpperCase();

  if (!PAIRING_CODE.test(code))
    throw new ZdpError("the pairing code must be ten base32 characters");

  const keyText = url.searchParams.get("key") ?? "";

  const key = new Uint8Array(Buffer.from(keyText, "base64url"));

  if (key.length !== 32 || Buffer.from(key).toString("base64url") !== keyText)
    throw new ZdpError("the pairing key must be 32 bytes, base64url");

  return { host: url.hostname, port, code, key };
};
