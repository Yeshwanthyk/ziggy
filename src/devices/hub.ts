/**
 * The device hub: one WebSocket listener per Profile speaking ZDP/1. Each link runs the Noise
 * handshake as responder, then either pairs an unknown key with an open code or greets a paired
 * device, and keeps the link alive with pings. Who is online is published to
 * `.runtime/device-hub.json` for the CLI.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Deferred, Effect, Queue, Schema, Scope, Semaphore } from "effect";
import { writeFileAtomic } from "../platform/atomic-write";
import { noiseXX, type NoiseKeyPair, type NoiseSession } from "../platform/noise";
import { readPhysicalFile } from "../platform/tree";
import { serveWebSockets, type WebSocketLink } from "../platform/websocket-server";
import { type DeviceChat, type DeviceChatEvent } from "./chat";
import { screenImage } from "./image";
import { deviceHubKey } from "./keys";
import {
  type DeviceLinksApi,
  type DevicePush,
  type DeviceToolArguments,
  DeviceToolFailed,
} from "./links";
import {
  ZDP_PATH,
  ZDP_PROLOGUE,
  ZDP_VERSION,
  type DeviceCapabilities,
  ZdpClose,
  ZdpErrorCode,
  type ZdpFrame,
  ZdpInvalid,
  type DeviceTool,
  type ToolResult,
  decodeZdpResult,
  type ZdpMessage,
  type ZdpRequest,
  decodeZdpFrame,
  encodeZdpChunk,
  encodeZdpMessageFrame,
} from "./protocol";
import {
  type DeviceRecord,
  findDeviceByKey,
  listDevices,
  pairingOpen,
  redeemPairingCode,
  setDeviceTools,
} from "./registry";
import { MAX_RECORDING_BYTES, MIN_RECORDING_BYTES, type Transcriber } from "./speech";

export class DeviceHubFailed extends Schema.TaggedErrorClass<DeviceHubFailed>()("DeviceHubFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface DeviceHubTiming {
  /** The handshake, and then pairing and hello, must each finish within this. */
  readonly handshakeMs: number;
  /** Ping after this long without sending. */
  readonly idlePingMs: number;
  /** Drop the link after this long without receiving. */
  readonly deadMs: number;
  /** How often revoked devices are looked for. */
  readonly sweepMs: number;
  /** How long the device has to answer a request. */
  readonly requestMs: number;
}

export const DEVICE_HUB_TIMING: DeviceHubTiming = {
  handshakeMs: 10_000,
  idlePingMs: 20_000,
  deadMs: 60_000,
  sweepMs: 2_000,
  requestMs: 30_000,
};

export interface DeviceHubOptions {
  readonly profilePath: string;
  readonly profileName: string;
  readonly hostname: string;
  readonly port: number;
  readonly timing?: DeviceHubTiming;
  /** Serves `chat.*` to devices that declared `chat`; without it `chat.send` is refused. */
  readonly chat?: DeviceChat;
  /** Turns a device's recorded speech into the text of a turn; without it audio is refused. */
  readonly transcribe?: Transcriber;
  /** Where connected devices are attached so device tools can reach them. */
  readonly links?: DeviceLinksApi;
  readonly log: (message: string) => Effect.Effect<void>;
}

export interface DeviceHub {
  readonly port: number;
}

/** Ends a link with a WebSocket close code. */
class LinkDropped extends Schema.TaggedErrorClass<LinkDropped>()("LinkDropped", {
  code: Schema.Int,
  reason: Schema.String,
  /** Worth a line in the log: a refusal or a fault, not a device going away. */
  logged: Schema.Boolean,
}) {}

const drop = (code: number, reason: string, logged = true) =>
  new LinkDropped({ code, reason, logged });

const GONE = 1000;

const INTERNAL = 1011;

const JSON_FRAME = 0x7b;

const MAX_MESSAGE_BYTES = 65_535;

/** Image and audio bytes go out in chunks this large, small enough for a device's buffers. */
const CHUNK_BYTES = 16 * 1_024;

/** A chunk of a hub stream, queued like a message so the two leave in order. */
interface OutgoingChunk {
  readonly stream: number;
  readonly last: boolean;
  readonly data: Uint8Array;
}

type Outgoing = ZdpMessage | OutgoingChunk;

type Outbox = Queue.Queue<Outgoing>;

const isChunk = (item: Outgoing): item is OutgoingChunk => !("jsonrpc" in item);

const projectionPath = (profilePath: string) => join(profilePath, ".runtime", "device-hub.json");

export const DeviceHubProjection = Schema.Struct({
  version: Schema.Literal(1),
  port: Schema.Int,
  online: Schema.Array(Schema.Struct({ id: Schema.String, since: Schema.String })),
});

export type DeviceHubProjection = typeof DeviceHubProjection.Type;

const decodeProjection = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceHubProjection));

/** What a running hub last published; undefined when none is running or it is unreadable. */
export const readDeviceHubProjection = (
  profilePath: string,
): Effect.Effect<DeviceHubProjection | undefined> =>
  readPhysicalFile(projectionPath(profilePath)).pipe(
    Effect.flatMap((bytes) =>
      bytes === undefined ? Effect.undefined : decodeProjection(new TextDecoder().decode(bytes)),
    ),
    Effect.catch(() => Effect.undefined),
  );

interface Online {
  readonly linkId: number;
  readonly since: string;
  readonly link: WebSocketLink;
}

type Request = Extract<ZdpMessage, { readonly id: unknown; readonly method: unknown }>;

const isRequest = (message: ZdpMessage): message is Request =>
  "method" in message && "id" in message;

const chatNotification = (turn: string, event: DeviceChatEvent): ZdpMessage => {
  switch (event.kind) {
    case "thinking":
      return { jsonrpc: "2.0", method: "chat.status", params: { turn, state: "thinking" } };
    case "tool":
      return {
        jsonrpc: "2.0",
        method: "chat.status",
        params: { turn, state: "tool", tool: event.tool },
      };
    case "delta":
      return { jsonrpc: "2.0", method: "chat.delta", params: { turn, text: event.text } };
    case "done":
      return { jsonrpc: "2.0", method: "chat.done", params: { turn, text: event.text } };
    case "error":
      return { jsonrpc: "2.0", method: "chat.error", params: { turn, message: event.message } };
  }
};

/** One authenticated link: encrypted, serialized sends and a clock of the last traffic. */
interface Channel {
  readonly receive: Effect.Effect<ZdpFrame, LinkDropped | ZdpInvalid>;
  readonly send: (message: ZdpMessage) => Effect.Effect<void, LinkDropped>;
  readonly sendChunk: (chunk: OutgoingChunk) => Effect.Effect<void, LinkDropped>;
  readonly respond: (request: Request, result: Schema.Json) => Effect.Effect<void, LinkDropped>;
  readonly refuse: (
    id: Request["id"] | null,
    code: number,
    message: string,
  ) => Effect.Effect<void, LinkDropped>;
  readonly lastReceived: () => number;
  readonly lastSent: () => number;
}

const nextBytes = (link: WebSocketLink) =>
  Queue.take(link.messages).pipe(Effect.mapError(() => drop(GONE, "closed", false)));

const handshake = (link: WebSocketLink, key: NoiseKeyPair) =>
  Effect.gen(function* () {
    const noise = noiseXX({ role: "responder", staticKeyPair: key, prologue: ZDP_PROLOGUE });

    yield* noise.read(yield* nextBytes(link));

    const reply = yield* noise.write();

    if (!(yield* link.send(reply))) return yield* drop(GONE, "closed", false);

    yield* noise.read(yield* nextBytes(link));

    return yield* noise.finish;
  }).pipe(
    Effect.catchTag("NoiseFailed", (failure) =>
      Effect.fail(drop(ZdpClose.protocol, `handshake failed: ${failure.message}`)),
    ),
  );

const makeChannel = (link: WebSocketLink, session: NoiseSession) =>
  Effect.gen(function* () {
    const sending = yield* Semaphore.make(1);

    let lastReceived = yield* Clock.currentTimeMillis;

    let lastSent = lastReceived;

    const sendFrame = (frame: Uint8Array) =>
      Effect.gen(function* () {
        // Encrypt and send under one permit, so frames leave in nonce order.
        const sent = yield* Semaphore.withPermits(
          sending,
          1,
        )(
          Effect.gen(function* () {
            const ciphertext = yield* session.send(frame);

            lastSent = yield* Clock.currentTimeMillis;

            return yield* link.send(ciphertext);
          }),
        ).pipe(
          Effect.mapError((failure) => drop(INTERNAL, `could not encrypt: ${failure.message}`)),
        );

        if (!sent) return yield* drop(GONE, "closed", false);
      });

    const send = (message: ZdpMessage) =>
      encodeZdpMessageFrame(message).pipe(
        Effect.mapError((failure) => drop(INTERNAL, `could not encode: ${failure.message}`)),
        Effect.flatMap(sendFrame),
      );

    const channel: Channel = {
      receive: Effect.gen(function* () {
        const bytes = yield* nextBytes(link);

        lastReceived = yield* Clock.currentTimeMillis;

        const plaintext = yield* session
          .receive(bytes)
          .pipe(
            Effect.mapError((failure) =>
              drop(ZdpClose.protocol, `could not decrypt: ${failure.message}`),
            ),
          );

        return yield* decodeZdpFrame(plaintext).pipe(
          // A frame that is not JSON or a chunk cannot be answered; a bad JSON message can.
          Effect.mapError((failure) =>
            plaintext[0] === JSON_FRAME ? failure : drop(ZdpClose.protocol, failure.message),
          ),
        );
      }),
      send,
      sendChunk: (chunk) => sendFrame(encodeZdpChunk(chunk.stream, chunk.last, chunk.data)),
      respond: (request, result) => send({ jsonrpc: "2.0", id: request.id, result }),
      refuse: (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } }),
      lastReceived: () => lastReceived,
      lastSent: () => lastSent,
    };

    return channel;
  });

/** The next frame, answering bad JSON messages. */
const receiveFrame = (channel: Channel): Effect.Effect<ZdpFrame, LinkDropped> =>
  channel.receive.pipe(
    Effect.catchTag("ZdpInvalid", (failure) =>
      channel
        .refuse(failure.id ?? null, failure.code, failure.message)
        .pipe(Effect.andThen(receiveFrame(channel))),
    ),
  );

/** The next JSON message, answering bad ones and skipping chunks. */
const receiveMessage = (channel: Channel): Effect.Effect<ZdpMessage, LinkDropped> =>
  receiveFrame(channel).pipe(
    Effect.flatMap((frame) =>
      frame.kind === "message" ? Effect.succeed(frame.message) : receiveMessage(channel),
    ),
  );

/** Waits for a request of `method`, refusing any other request meanwhile. */
const awaitRequest = <M extends ZdpRequest["method"]>(
  channel: Channel,
  method: M,
): Effect.Effect<Extract<ZdpRequest, { readonly method: M }>, LinkDropped> =>
  Effect.gen(function* () {
    while (true) {
      const message = yield* receiveMessage(channel);

      if (!isRequest(message)) continue;

      if (message.method === method) return yield* narrow(message, method);

      yield* channel.refuse(message.id, ZdpErrorCode.notAllowed, `send ${method} first`);
    }
  });

const narrow = <M extends ZdpRequest["method"]>(
  message: ZdpRequest,
  method: M,
): Effect.Effect<Extract<ZdpRequest, { readonly method: M }>, LinkDropped> => {
  const matches = (candidate: ZdpRequest): candidate is Extract<ZdpRequest, { method: M }> =>
    candidate.method === method;

  return matches(message)
    ? Effect.succeed(message)
    : Effect.fail(drop(INTERNAL, `expected ${method}`));
};

/** Hub stream ids: even, from 2, reused after 65534 (each stream has ended long before). */
const evenStreams = () => {
  let last = 0;

  return () => {
    last = last >= 65_534 ? 2 : last + 2;

    return last;
  };
};

/** The bytes as chunks of `stream`, the last one flagged. */
const chunks = (stream: number, data: Uint8Array): Array<OutgoingChunk> => {
  const count = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));

  return Array.from({ length: count }, (_, index) => ({
    stream,
    last: index === count - 1,
    data: data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
  }));
};

/**
 * A push becomes a notification on the link's outbox, after anything already queued. An image
 * is fitted to the screen and follows its `display.show` as one stream, queued together.
 */
const push = (
  outbox: Outbox,
  nextStream: () => number,
  deviceId: string,
  capabilities: DeviceCapabilities,
  message: DevicePush,
): Effect.Effect<void, DeviceToolFailed> => {
  if (message.method === "notify")
    return Queue.offer(outbox, {
      jsonrpc: "2.0",
      method: "notify",
      params:
        message.title === undefined
          ? { text: message.text }
          : { title: message.title, text: message.text },
    }).pipe(Effect.asVoid);

  const screen = capabilities.screen;

  if (screen === undefined)
    return Effect.fail(new DeviceToolFailed({ deviceId, message: `${deviceId} has no screen` }));

  if (message.method === "display.show")
    return Queue.offer(outbox, {
      jsonrpc: "2.0",
      method: "display.show",
      params: { text: message.text },
    }).pipe(Effect.asVoid);

  return screenImage(message.image, screen).pipe(
    Effect.mapError((failure) => new DeviceToolFailed({ deviceId, message: failure.message })),
    Effect.flatMap((image) => {
      const stream = nextStream();

      return Queue.offerAll(outbox, [
        {
          jsonrpc: "2.0",
          method: "display.show",
          params: {
            image: { stream, format: image.format, width: image.width, height: image.height },
          },
        },
        ...chunks(stream, image.data),
      ]);
    }),
    Effect.asVoid,
  );
};

/** Requests the hub sends to one device, matched to their answers by id. */
interface HubRequests {
  readonly nextId: () => string;
  readonly listTools: Effect.Effect<ReadonlyArray<DeviceTool>, DeviceToolFailed>;
  readonly callTool: (
    name: string,
    args: DeviceToolArguments,
  ) => Effect.Effect<ToolResult, DeviceToolFailed>;
  /** Settles the request `message` answers; false when it answers none. */
  readonly settle: (message: ZdpMessage) => Effect.Effect<boolean>;
  /** Fails every request still waiting, once the link ends. */
  readonly failAll: Effect.Effect<void>;
}

/** Requests go through the link's outbox, so the device sees them after any status sent before. */
const makeRequests = (outbox: Outbox, deviceId: string, timeoutMs: number): HubRequests => {
  let sent = 0;

  let closed = false;

  const pending = new Map<string, Deferred.Deferred<Schema.Json, DeviceToolFailed>>();

  const failed = (message: string) => new DeviceToolFailed({ deviceId, message });

  const nextId = () => {
    sent += 1;

    return `h-${sent}`;
  };

  const request = (
    method: "tools/list" | "tools/call",
    params?: { readonly name: string; readonly arguments: DeviceToolArguments },
  ) =>
    Effect.gen(function* () {
      if (closed) return yield* failed(`${deviceId} is offline`);

      const id = nextId();

      const answer = yield* Deferred.make<Schema.Json, DeviceToolFailed>();

      pending.set(id, answer);

      const answered = Effect.gen(function* () {
        yield* Queue.offer(
          outbox,
          params === undefined
            ? { jsonrpc: "2.0", id, method: "tools/list" }
            : { jsonrpc: "2.0", id, method: "tools/call", params },
        );

        const result = yield* Deferred.await(answer).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(failed(`${deviceId} did not answer ${method} within ${timeoutMs} ms`)),
          }),
        );

        return yield* decodeZdpResult(method, result).pipe(
          Effect.mapError((invalid) =>
            failed(`${deviceId} answered ${method} badly: ${invalid.message}`),
          ),
        );
      });

      return yield* answered.pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    });

  return {
    nextId,
    listTools: request("tools/list").pipe(
      Effect.map((result) => (result.method === "tools/list" ? result.result.tools : [])),
    ),
    callTool: (name, args) =>
      request("tools/call", { name, arguments: args }).pipe(
        Effect.flatMap((result) =>
          result.method === "tools/call"
            ? Effect.succeed(result.result)
            : Effect.fail(failed(`${deviceId} answered tools/call with another result`)),
        ),
      ),
    settle: (message) =>
      Effect.suspend(() => {
        if ("method" in message || message.id === null) return Effect.succeed(false);

        const answer = pending.get(String(message.id));

        if (answer === undefined) return Effect.succeed(false);

        pending.delete(String(message.id));

        return (
          "result" in message
            ? Deferred.succeed(answer, message.result)
            : Deferred.fail(answer, failed(message.error.message))
        ).pipe(Effect.as(true));
      }),
    failAll: Effect.suspend(() => {
      const waiting = [...pending.values()];

      closed = true;
      pending.clear();

      return Effect.forEach(
        waiting,
        (answer) => Deferred.fail(answer, failed(`${deviceId} went offline`)),
        { discard: true },
      );
    }),
  };
};

export const runDeviceHub = (
  options: DeviceHubOptions,
): Effect.Effect<DeviceHub, DeviceHubFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const timing = options.timing ?? DEVICE_HUB_TIMING;

    const { profilePath } = options;

    const key = yield* deviceHubKey(profilePath).pipe(
      Effect.mapError((cause) => new DeviceHubFailed({ message: cause.message, cause })),
    );

    const online = new Map<string, Online>();

    const publishing = yield* Semaphore.make(1);

    let port = 0;

    const publish = Semaphore.withPermits(
      publishing,
      1,
    )(
      Effect.gen(function* () {
        const projection: DeviceHubProjection = {
          version: 1,
          port,
          online: [...online].map(([id, entry]) => ({ id, since: entry.since })),
        };

        yield* Effect.tryPromise({
          try: () => mkdir(join(profilePath, ".runtime"), { recursive: true, mode: 0o700 }),
          catch: (cause) => new DeviceHubFailed({ message: "could not create .runtime", cause }),
        });

        yield* writeFileAtomic(
          projectionPath(profilePath),
          `${JSON.stringify(projection)}\n`,
          0o600,
        );
      }),
    ).pipe(
      Effect.catch((cause) =>
        options.log(`[devices] could not publish who is online: ${cause.message}`),
      ),
    );

    const registryFault = (cause: { readonly message: string }) =>
      drop(INTERNAL, `device registry: ${cause.message}`);

    /** Pairs an unknown key, or drops the link. */
    const pair = (channel: Channel, session: NoiseSession, remote: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const open = yield* pairingOpen(profilePath, now).pipe(Effect.mapError(registryFault));

        if (!open) return yield* drop(ZdpClose.unpaired, `unpaired key from ${remote}`);

        const request = yield* awaitRequest(channel, "device.pair");

        const record = yield* redeemPairingCode(
          profilePath,
          request.params.code,
          {
            name: request.params.name,
            model: request.params.model,
            publicKey: session.remoteStatic,
          },
          yield* Clock.currentTimeMillis,
        ).pipe(Effect.mapError(registryFault));

        if (record === undefined) {
          yield* channel.refuse(
            request.id,
            ZdpErrorCode.notAllowed,
            "the pairing code is wrong or expired",
          );

          return yield* drop(ZdpClose.unpaired, `wrong pairing code from ${remote}`);
        }

        yield* channel.respond(request, { id: record.id, profile: options.profileName });
        yield* options.log(`[devices] paired ${record.id} (${record.model}) from ${remote}`);

        return record;
      });

    const greet = (channel: Channel, device: DeviceRecord) =>
      Effect.gen(function* () {
        const hello = yield* awaitRequest(channel, "device.hello");

        if (hello.params.zdp !== ZDP_VERSION) {
          yield* channel.refuse(
            hello.id,
            ZdpErrorCode.version,
            `this hub speaks zdp ${ZDP_VERSION}`,
          );

          return yield* drop(ZdpClose.version, `${device.id} speaks zdp ${hello.params.zdp}`);
        }

        yield* channel.respond(hello, {
          id: device.id,
          profile: options.profileName,
          zdp: ZDP_VERSION,
        });

        return hello.params.capabilities;
      });

    /** Pings when idle and drops a silent link, until the link ends. */
    const keepAlive = (link: WebSocketLink, channel: Channel, requests: HubRequests) =>
      Effect.gen(function* () {
        const tick = Math.max(10, Math.min(1000, Math.floor(timing.idlePingMs / 4)));

        while (true) {
          yield* Effect.sleep(tick);

          const now = yield* Clock.currentTimeMillis;

          if (now - channel.lastReceived() > timing.deadMs) {
            yield* link.close(ZdpClose.timeout, "no message for too long");

            return;
          }

          if (now - channel.lastSent() > timing.idlePingMs) {
            yield* channel.send({ jsonrpc: "2.0", id: requests.nextId(), method: "ping" });
          }
        }
      }).pipe(Effect.catchTag("LinkDropped", () => Effect.void));

    /**
     * Starts a turn and says whether it was accepted. Its notifications go through `outbox` and are
     * held until the `{turn}` reply is queued, so the device always sees the reply first. A turn
     * from speech sends `chat.transcript` right after the reply.
     */
    const startTurn = (
      channel: Channel,
      outbox: Outbox,
      chat: DeviceChat,
      device: DeviceRecord,
      requestId: Request["id"],
      text: string,
      turn: string,
      spoken: boolean,
    ) =>
      Effect.gen(function* () {
        const held: Array<ZdpMessage> = [];

        let accepted = false;

        const emit = (event: DeviceChatEvent) => {
          const message = chatNotification(turn, event);

          if (accepted) Queue.offerUnsafe(outbox, message);
          else held.push(message);
        };

        const refused = yield* chat
          .start(device, text, emit)
          .pipe(Effect.as(undefined), Effect.catchTag("DeviceChatRefused", Effect.succeed));

        if (refused !== undefined) {
          yield* channel.refuse(
            requestId,
            refused.reason === "busy" ? ZdpErrorCode.busy : ZdpErrorCode.internal,
            refused.message,
          );

          return false;
        }

        return yield* Effect.sync(() => {
          Queue.offerUnsafe(outbox, { jsonrpc: "2.0", id: requestId, result: { turn } });

          if (spoken)
            Queue.offerUnsafe(outbox, {
              jsonrpc: "2.0",
              method: "chat.transcript",
              params: { turn, text },
            });

          Queue.offerAllUnsafe(outbox, held);
          accepted = true;

          return true;
        });
      });

    const serve = (
      channel: Channel,
      device: DeviceRecord,
      capabilities: DeviceCapabilities,
      outbox: Outbox,
      requests: HubRequests,
      refreshTools: Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const chat = capabilities.chat === undefined ? undefined : options.chat;

        let turns = 0;

        const nextTurn = () => `t${turns + 1}`;

        const accepted = (started: boolean) =>
          Effect.sync(() => {
            if (started) turns += 1;
          });

        /** The one recording being received, by its stream; a device speaks one at a time. */
        let recording:
          | {
              readonly stream: number;
              readonly requestId: Request["id"];
              readonly parts: Array<Uint8Array>;
              bytes: number;
            }
          | undefined;

        /** Transcribes a finished recording and starts its turn, off the receive loop. */
        const hear = (
          chat: DeviceChat,
          transcribe: Transcriber,
          requestId: Request["id"],
          pcm: Uint8Array,
        ) =>
          Effect.gen(function* () {
            const heard = yield* transcribe(pcm).pipe(
              Effect.map((text) => ({ text })),
              Effect.catchTag("SpeechFailed", (failure) =>
                Effect.succeed({ failure: failure.message }),
              ),
            );

            if ("failure" in heard) {
              yield* options.log(`[devices] ${device.id}: speech-to-text failed: ${heard.failure}`);

              return yield* channel.refuse(
                requestId,
                ZdpErrorCode.internal,
                `speech-to-text failed: ${heard.failure}`,
              );
            }

            if (heard.text === "")
              return yield* channel.refuse(
                requestId,
                ZdpErrorCode.invalidParams,
                "no speech was heard",
              );

            yield* accepted(
              yield* startTurn(
                channel,
                outbox,
                chat,
                device,
                requestId,
                heard.text,
                nextTurn(),
                true,
              ),
            );
          }).pipe(Effect.catchTag("LinkDropped", () => Effect.void));

        while (true) {
          const frame = yield* receiveFrame(channel);

          if (frame.kind === "chunk") {
            // Chunks of a refused or unknown stream are dropped.
            if (recording?.stream !== frame.stream) continue;

            recording.parts.push(frame.data);
            recording.bytes += frame.data.length;

            if (recording.bytes > MAX_RECORDING_BYTES) {
              yield* channel.refuse(
                recording.requestId,
                ZdpErrorCode.invalidParams,
                "a recording may last at most 20 seconds",
              );
              recording = undefined;
              continue;
            }

            if (!frame.last) continue;

            const { requestId, parts, bytes } = recording;

            recording = undefined;

            if (bytes < MIN_RECORDING_BYTES) {
              yield* channel.refuse(
                requestId,
                ZdpErrorCode.invalidParams,
                "a recording must last at least 0.3 seconds",
              );
              continue;
            }

            if (chat !== undefined && options.transcribe !== undefined)
              yield* Effect.forkChild(
                hear(chat, options.transcribe, requestId, Buffer.concat(parts)),
              );

            continue;
          }

          const message = frame.message;

          if (yield* requests.settle(message)) continue;

          if ("method" in message && message.method === "notifications/tools/list_changed") {
            yield* Effect.forkChild(refreshTools);
            continue;
          }

          // Other notifications and the device's answers to our pings need nothing back.
          if (!isRequest(message)) continue;

          if (message.method === "ping") yield* channel.respond(message, {});
          else if (message.method === "device.pair" || message.method === "device.hello")
            yield* channel.refuse(message.id, ZdpErrorCode.notAllowed, "already connected");
          else if (
            (message.method === "chat.send" || message.method === "chat.abort") &&
            chat === undefined
          )
            yield* channel.refuse(
              message.id,
              ZdpErrorCode.notAllowed,
              capabilities.chat === undefined
                ? "this device did not declare chat"
                : "this hub does not serve chat",
            );
          else if (message.method === "chat.send" && chat !== undefined) {
            const params = message.params;

            if ("text" in params)
              yield* accepted(
                yield* startTurn(
                  channel,
                  outbox,
                  chat,
                  device,
                  message.id,
                  params.text,
                  nextTurn(),
                  false,
                ),
              );
            else if (options.transcribe === undefined)
              yield* channel.refuse(
                message.id,
                ZdpErrorCode.notAllowed,
                "this hub has no speech-to-text; set speech.transcribe in devices.json",
              );
            else if (recording !== undefined)
              yield* channel.refuse(
                message.id,
                ZdpErrorCode.busy,
                "a recording is already arriving",
              );
            else if (params.audio.stream % 2 === 0)
              yield* channel.refuse(
                message.id,
                ZdpErrorCode.invalidParams,
                "a device's streams have odd ids",
              );
            else
              recording = {
                stream: params.audio.stream,
                requestId: message.id,
                parts: [],
                bytes: 0,
              };
          } else if (message.method === "chat.abort" && chat !== undefined) {
            yield* chat.abort(device);
            yield* channel.respond(message, {});
          } else
            yield* channel.refuse(
              message.id,
              ZdpErrorCode.methodNotFound,
              `${message.method} is not served by this hub`,
            );
        }
      });

    const handleLink = (link: WebSocketLink) =>
      Effect.gen(function* () {
        const remote = link.remoteAddress;

        const session = yield* handshake(link, key).pipe(
          Effect.timeoutOrElse({
            duration: timing.handshakeMs,
            orElse: () => Effect.fail(drop(ZdpClose.timeout, `handshake timed out from ${remote}`)),
          }),
        );

        const channel = yield* makeChannel(link, session);

        const known = yield* findDeviceByKey(profilePath, session.remoteStatic).pipe(
          Effect.mapError(registryFault),
        );

        const { device, capabilities } = yield* Effect.gen(function* () {
          const record = known ?? (yield* pair(channel, session, remote));

          return { device: record, capabilities: yield* greet(channel, record) };
        }).pipe(
          Effect.timeoutOrElse({
            duration: timing.handshakeMs,
            orElse: () => Effect.fail(drop(ZdpClose.timeout, `hello timed out from ${remote}`)),
          }),
        );

        const replaced = online.get(device.id);

        if (replaced !== undefined)
          yield* replaced.link.close(ZdpClose.replaced, "the device connected again");

        online.set(device.id, {
          linkId: link.id,
          since: new Date(yield* Clock.currentTimeMillis).toISOString(),
          link,
        });
        yield* publish;
        yield* options.log(`[devices] ${device.id} online from ${remote}`);

        const leave = Effect.gen(function* () {
          if (online.get(device.id)?.linkId !== link.id) return;

          online.delete(device.id);
          yield* publish;
          yield* options.log(`[devices] ${device.id} offline`);
        });

        const outbox = yield* Queue.unbounded<Outgoing>();

        const drain = Effect.forever(
          Queue.take(outbox).pipe(
            Effect.flatMap((item) =>
              isChunk(item) ? channel.sendChunk(item) : channel.send(item),
            ),
          ),
        );

        const streams = evenStreams();

        const requests = makeRequests(outbox, device.id, timing.requestMs);

        /** Stores the device's commands, which become `device__<id>__<cmd>` tools. */
        const refreshTools = requests.listTools.pipe(
          Effect.flatMap((tools) => setDeviceTools(profilePath, device.id, tools)),
          Effect.asVoid,
          Effect.catch((cause) =>
            options.log(`[devices] could not list ${device.id}'s tools: ${cause.message}`),
          ),
        );

        yield* Effect.gen(function* () {
          // A device may add its first command while online, so every link can be called.
          if (options.links !== undefined)
            yield* options.links.attach(profilePath, device.id, {
              call: requests.callTool,
              push: (message) => push(outbox, streams, device.id, capabilities, message),
            });

          if (capabilities.tools !== undefined) yield* Effect.forkScoped(refreshTools);

          // Whichever ends first, by success or failure, ends the link.
          yield* Effect.raceAllFirst([
            serve(channel, device, capabilities, outbox, requests, refreshTools),
            keepAlive(link, channel, requests),
            drain,
          ]);
        }).pipe(Effect.scoped, Effect.ensuring(requests.failAll), Effect.ensuring(leave));
      }).pipe(
        Effect.catchTag("LinkDropped", (dropped) =>
          Effect.gen(function* () {
            if (dropped.logged) yield* options.log(`[devices] ${dropped.reason}`);

            yield* link.close(dropped.code, dropped.reason);
          }),
        ),
      );

    const server = yield* serveWebSockets({
      hostname: options.hostname,
      port: options.port,
      path: ZDP_PATH,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      onLink: handleLink,
    }).pipe(Effect.mapError((cause) => new DeviceHubFailed({ message: cause.message, cause })));

    port = server.port;

    if (options.links !== undefined) yield* options.links.serve(profilePath);
    yield* publish;
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => rm(projectionPath(profilePath), { force: true })).pipe(
        Effect.catch(() => Effect.void),
      ),
    );

    // A revoked device is dropped within one sweep.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(timing.sweepMs);

          if (online.size === 0) continue;

          const paired = yield* listDevices(profilePath).pipe(
            Effect.map((records) => new Set(records.map((record) => record.id))),
            Effect.catch((cause) =>
              options
                .log(`[devices] could not check for revoked devices: ${cause.message}`)
                .pipe(Effect.as(undefined)),
            ),
          );

          if (paired === undefined) continue;

          for (const [id, entry] of online)
            if (!paired.has(id)) {
              yield* options.log(`[devices] ${id} was revoked; closing its link`);
              yield* entry.link.close(ZdpClose.unpaired, "revoked");
            }
        }
      }),
    );

    return { port: server.port };
  });
