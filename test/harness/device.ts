/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/**
 * A minimal ZDP/1 device: the Noise initiator over a WebSocket, JSON-RPC requests with ids, and
 * automatic answers to the hub's pings. It is the reference the firmware SDK is checked against.
 */
import { Effect, type Schema } from "effect";
import {
  type ZdpMessage,
  ZDP_PATH,
  ZDP_PROLOGUE,
  decodeZdpFrame,
  encodeZdpMessageFrame,
} from "ziggy/devices/index";
import {
  generateNoiseKeyPair,
  noiseXX,
  type NoiseKeyPair,
  type NoiseSession,
} from "ziggy/platform/noise";
import { eventually } from "./eventually";

interface DeviceReply {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface DeviceClient {
  readonly keyPair: NoiseKeyPair;
  /** The hub's static key, proven by the handshake. */
  readonly hubKey: Uint8Array;
  readonly request: (method: string, params?: Schema.Json) => Promise<DeviceReply>;
  /** Sends one raw plaintext frame, for protocol violations. */
  readonly sendFrame: (frame: Uint8Array) => void;
  /** Every message the hub sent, in order, including its pings. */
  readonly received: ReadonlyArray<ZdpMessage>;
  /** Stop answering the hub's pings, to look dead. */
  readonly mute: () => void;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  readonly close: () => void;
}

export interface ConnectDeviceOptions {
  readonly host?: string;
  readonly port: number;
  readonly keyPair?: NoiseKeyPair;
}

/** Opens a link and completes the handshake; the device has not said anything yet. */
export const connectDevice = async (options: ConnectDeviceOptions): Promise<DeviceClient> => {
  const keyPair = options.keyPair ?? generateNoiseKeyPair();

  const socket = new WebSocket(`ws://${options.host ?? "127.0.0.1"}:${options.port}${ZDP_PATH}`);

  socket.binaryType = "arraybuffer";

  const inbox: Array<Uint8Array> = [];

  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) inbox.push(new Uint8Array(event.data));
  };

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("the device could not connect"));
  });

  const next = () => eventually("a hub message", () => inbox.shift());

  const noise = noiseXX({ role: "initiator", staticKeyPair: keyPair, prologue: ZDP_PROLOGUE });

  socket.send(Effect.runSync(noise.write()));
  Effect.runSync(noise.read(await next()));
  socket.send(Effect.runSync(noise.write()));

  const session: NoiseSession = Effect.runSync(noise.finish);

  const received: Array<ZdpMessage> = [];

  const replies = new Map<string, DeviceReply>();

  let muted = false;

  const send = (message: ZdpMessage) => {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(Effect.runSync(session.send(Effect.runSync(encodeZdpMessageFrame(message)))));
  };

  // Decrypt in arrival order; replies are matched by id, pings answered at once.
  socket.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;

    const frame = Effect.runSync(
      Effect.flatMap(session.receive(new Uint8Array(event.data)), decodeZdpFrame),
    );

    if (frame.kind !== "message") return;

    const message = frame.message;

    received.push(message);

    if ("method" in message && "id" in message && message.method === "ping" && !muted)
      send({ jsonrpc: "2.0", id: message.id, result: {} });

    if ("result" in message) replies.set(String(message.id), { result: message.result });

    if ("error" in message) replies.set(String(message.id), { error: message.error });
  };

  // The handshake's last message may have raced a hub frame into the first handler.
  for (const early of inbox.splice(0))
    socket.onmessage(new MessageEvent("message", { data: early.slice().buffer }));

  let nextId = 1;

  const request = async (method: string, params?: Schema.Json): Promise<DeviceReply> => {
    const id = nextId++;

    const text = JSON.stringify(
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params },
    );

    if (socket.readyState === WebSocket.OPEN)
      socket.send(Effect.runSync(session.send(new TextEncoder().encode(text))));

    // A link the hub closed never answers; fail at once instead of waiting out the poll.
    return Promise.race([
      eventually(`a reply to ${method}`, () => replies.get(String(id))),
      closed.then(async ({ code }) => {
        await Bun.sleep(50);

        return (
          replies.get(String(id)) ?? Promise.reject(new Error(`${method}: link closed (${code})`))
        );
      }),
    ]);
  };

  return {
    keyPair,
    hubKey: session.remoteStatic,
    request,
    sendFrame: (frame) => socket.send(Effect.runSync(session.send(frame))),
    received,
    mute: () => {
      muted = true;
    },
    closed,
    close: () => socket.close(),
  };
};
