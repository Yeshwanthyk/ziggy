/**
 * The device hub: one WebSocket listener per Profile speaking ZDP/1. Each link runs the Noise
 * handshake as responder, then either pairs an unknown key with an open code or greets a paired
 * device, and keeps the link alive with pings. Who is online is published to
 * `.runtime/device-hub.json` for the CLI.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Effect, Queue, Schema, Scope, Semaphore } from "effect";
import { writeFileAtomic } from "../platform/atomic-write";
import { noiseXX, type NoiseKeyPair, type NoiseSession } from "../platform/noise";
import { readPhysicalFile } from "../platform/tree";
import { serveWebSockets, type WebSocketLink } from "../platform/websocket-server";
import { deviceHubKey } from "./keys";
import {
  ZDP_PATH,
  ZDP_PROLOGUE,
  ZDP_VERSION,
  ZdpClose,
  ZdpErrorCode,
  type ZdpFrame,
  ZdpInvalid,
  type ZdpMessage,
  type ZdpRequest,
  decodeZdpFrame,
  encodeZdpMessageFrame,
} from "./protocol";
import {
  type DeviceRecord,
  findDeviceByKey,
  listDevices,
  pairingOpen,
  redeemPairingCode,
} from "./registry";

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
}

export const DEVICE_HUB_TIMING: DeviceHubTiming = {
  handshakeMs: 10_000,
  idlePingMs: 20_000,
  deadMs: 60_000,
  sweepMs: 2_000,
};

export interface DeviceHubOptions {
  readonly profilePath: string;
  readonly profileName: string;
  readonly hostname: string;
  readonly port: number;
  readonly timing?: DeviceHubTiming;
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

/** One authenticated link: encrypted, serialized sends and a clock of the last traffic. */
interface Channel {
  readonly receive: Effect.Effect<ZdpFrame, LinkDropped | ZdpInvalid>;
  readonly send: (message: ZdpMessage) => Effect.Effect<void, LinkDropped>;
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

    const send = (message: ZdpMessage) =>
      Effect.gen(function* () {
        const frame = yield* encodeZdpMessageFrame(message).pipe(
          Effect.mapError((failure) => drop(INTERNAL, `could not encode: ${failure.message}`)),
        );

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
      respond: (request, result) => send({ jsonrpc: "2.0", id: request.id, result }),
      refuse: (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } }),
      lastReceived: () => lastReceived,
      lastSent: () => lastSent,
    };

    return channel;
  });

/** The next JSON message, answering bad ones and skipping chunks. */
const receiveMessage = (channel: Channel): Effect.Effect<ZdpMessage, LinkDropped> =>
  channel.receive.pipe(
    Effect.flatMap((frame) =>
      frame.kind === "message" ? Effect.succeed(frame.message) : receiveMessage(channel),
    ),
    Effect.catchTag("ZdpInvalid", (failure) =>
      channel
        .refuse(failure.id ?? null, failure.code, failure.message)
        .pipe(Effect.andThen(receiveMessage(channel))),
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
      });

    /** Pings when idle and drops a silent link, until the link ends. */
    const keepAlive = (link: WebSocketLink, channel: Channel) =>
      Effect.gen(function* () {
        let pings = 0;

        const tick = Math.max(10, Math.min(1000, Math.floor(timing.idlePingMs / 4)));

        while (true) {
          yield* Effect.sleep(tick);

          const now = yield* Clock.currentTimeMillis;

          if (now - channel.lastReceived() > timing.deadMs) {
            yield* link.close(ZdpClose.timeout, "no message for too long");

            return;
          }

          if (now - channel.lastSent() > timing.idlePingMs) {
            pings += 1;
            yield* channel.send({ jsonrpc: "2.0", id: `h-${pings}`, method: "ping" });
          }
        }
      }).pipe(Effect.catchTag("LinkDropped", () => Effect.void));

    const serve = (channel: Channel) =>
      Effect.gen(function* () {
        while (true) {
          const message = yield* receiveMessage(channel);

          // Notifications and the device's answers to our pings need nothing back.
          if (!isRequest(message)) continue;

          if (message.method === "ping") yield* channel.respond(message, {});
          else if (message.method === "device.pair" || message.method === "device.hello")
            yield* channel.refuse(message.id, ZdpErrorCode.notAllowed, "already connected");
          else
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

        const device = yield* Effect.gen(function* () {
          const record = known ?? (yield* pair(channel, session, remote));

          yield* greet(channel, record);

          return record;
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

        yield* Effect.raceFirst(serve(channel), keepAlive(link, channel)).pipe(
          Effect.ensuring(leave),
        );
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
