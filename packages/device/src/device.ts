/**
 * A Ziggy device: pairs once with a `zdp://` URI, then keeps one encrypted link to its Profile's
 * hub, reconnecting with backoff. It answers the hub's pings and tool calls, and exposes chat and
 * pushes as events.
 */
import {
  type KeyPair,
  NoiseError,
  generateKeyPair,
  keyPairFromPrivate,
  noiseInitiator,
} from "./noise";
import {
  type Json,
  type JsonObject,
  type RequestId,
  type ZdpFrame,
  ZDP_PATH,
  ZDP_PROLOGUE,
  ZDP_VERSION,
  ZdpClose,
  ZdpErrorCode,
  ZdpError,
  decodeFrame,
  encodeMessage,
  isJsonObject,
  parsePairingUri,
} from "./protocol";

/** What a paired device keeps. It holds the device's private key: store it like a password. */
export interface DeviceIdentity {
  readonly version: 1;
  /** The id the hub gave this device. */
  readonly id: string;
  /** The display name of the Profile it is paired to. */
  readonly profile: string;
  readonly name: string;
  readonly model: string;
  /** The device's static X25519 private key, base64url. */
  readonly privateKey: string;
  /** Where the hub is and its pinned static public key, base64url. */
  readonly hub: { readonly host: string; readonly port: number; readonly key: string };
}

export interface DeviceTiming {
  /** Ping after this long without sending. */
  readonly pingMs: number;
  /** Drop the link after this long without receiving. */
  readonly deadMs: number;
  readonly handshakeMs: number;
  /** A request without a reply fails after this long. */
  readonly requestMs: number;
  readonly backoffMinMs: number;
  readonly backoffMaxMs: number;
}

export const DEVICE_TIMING: DeviceTiming = {
  pingMs: 20_000,
  deadMs: 60_000,
  handshakeMs: 10_000,
  requestMs: 30_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 15_000,
};

export interface ScreenCapability {
  readonly width: number;
  readonly height: number;
  readonly formats: ReadonlyArray<"rgb565" | "jpeg">;
}

export interface AudioCapability {
  readonly in?: ReadonlyArray<"pcm16/16000">;
  readonly out?: ReadonlyArray<"mp3">;
}

export interface ZiggyDeviceOptions {
  /** How the device names itself when pairing; the hub derives its id from it. */
  readonly name: string;
  readonly model: string;
  readonly firmware?: string;
  /** From an earlier `pair`; without it the device must pair first. */
  readonly identity?: DeviceIdentity;
  /** Whether the device talks to the Profile. Default true. */
  readonly chat?: boolean;
  readonly screen?: ScreenCapability;
  readonly audio?: AudioCapability;
  readonly timing?: Partial<DeviceTiming>;
  /** Sees every frame after decryption, both ways; for logs and conformance transcripts. */
  readonly trace?: (direction: "in" | "out", frame: ZdpFrame) => void;
}

export type DeviceState = "idle" | "connecting" | "online" | "offline" | "stopped";

export interface DeviceClosed {
  readonly code: number;
  readonly reason: string;
}

export interface ToolContentText {
  readonly type: "text";
  readonly text: string;
}

export interface ToolContentImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface ToolResult {
  readonly content: ReadonlyArray<ToolContentText | ToolContentImage>;
  readonly isError?: boolean;
}

/** A command returns text, or a full MCP result; a thrown error becomes an `isError` result. */
export type CommandHandler = (
  args: JsonObject,
) => string | ToolResult | Promise<string | ToolResult>;

export interface CommandSpec {
  readonly description?: string;
  /** JSON Schema for the arguments. Default: an object with any properties. */
  readonly inputSchema?: JsonObject;
}

export type ChatEvent =
  | {
      readonly type: "status";
      readonly turn: string;
      readonly state: string;
      readonly tool?: string;
    }
  | { readonly type: "delta"; readonly turn: string; readonly text: string }
  | { readonly type: "transcript"; readonly turn: string; readonly text: string }
  | { readonly type: "done"; readonly turn: string; readonly text: string }
  | { readonly type: "error"; readonly turn: string; readonly message: string };

export type DisplayEvent =
  | { readonly text: string }
  | {
      readonly image: {
        readonly format: string;
        readonly width: number;
        readonly height: number;
        readonly data: Uint8Array;
      };
    };

export interface DeviceEvents {
  readonly state: (state: DeviceState, closed?: DeviceClosed) => void;
  readonly chat: (event: ChatEvent) => void;
  readonly notify: (notice: { readonly title?: string; readonly text: string }) => void;
  readonly display: (event: DisplayEvent) => void;
  readonly audio: (clip: { readonly format: string; readonly data: Uint8Array }) => void;
}

/** The hub answered a request with a JSON-RPC error. */
export class DeviceRpcError extends Error {
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message}`);
    this.name = "DeviceRpcError";
    this.code = code;
  }
}

/** The link closed, or never opened, before a reply. */
export class DeviceOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceOfflineError";
  }
}

/** The device stopped for good: it was revoked, replaced, refused, or stopped by the caller. */
export class DeviceStoppedError extends Error {
  readonly closed: DeviceClosed;

  constructor(closed: DeviceClosed) {
    super(`the device stopped: ${closed.reason || closed.code}`);
    this.name = "DeviceStoppedError";
    this.closed = closed;
  }
}

const COMMAND_NAME = /^[a-z0-9_]{1,48}$/;

/** Close codes after which reconnecting cannot help. */
const FINAL_CODES: ReadonlySet<number> = new Set([
  ZdpClose.unpaired,
  ZdpClose.replaced,
  ZdpClose.version,
]);

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** After a refused request the hub closes with its own code; give it a moment to say which. */
const closeAfterRefusal = async (link: Link, reason: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    link.closed,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 1_000);
    }),
  ]);
  clearTimeout(timer);
  link.close(1000, reason);
};

const toToolResult = (value: string | ToolResult): ToolResult =>
  typeof value === "string" ? { content: [{ type: "text", text: value }] } : value;

type Writable<T> = { -readonly [K in keyof T]: T[K] };

type ToolResultJson = { content: Json; isError?: boolean };

type ToolJson = { name: string; description?: string; inputSchema: JsonObject };

const toolResultJson = (result: ToolResult): JsonObject => {
  const json: ToolResultJson = {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType },
    ),
  };

  if (result.isError === true) json.isError = true;

  return json;
};

interface Pending {
  readonly method: string;
  readonly resolve: (result: Json) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Link {
  readonly hubKey: Uint8Array;
  readonly request: (method: string, params?: JsonObject) => Promise<Json>;
  readonly notify: (method: string, params?: JsonObject) => void;
  readonly closed: Promise<DeviceClosed>;
  readonly close: (code: number, reason: string) => void;
}

interface LinkHandlers {
  readonly onRequest: (
    method: string,
    params: Json | undefined,
  ) => Promise<{ readonly result: Json } | { readonly error: { code: number; message: string } }>;
  readonly onNotification: (method: string, params: Json | undefined) => void;
  readonly onChunk: (stream: number, last: boolean, data: Uint8Array) => void;
}

const openLink = async (
  host: string,
  port: number,
  keyPair: KeyPair,
  pinnedHubKey: Uint8Array,
  timing: DeviceTiming,
  handlers: LinkHandlers,
  trace: ZiggyDeviceOptions["trace"],
): Promise<Link> => {
  const socket = new WebSocket(
    `ws://${host.includes(":") ? `[${host}]` : host}:${port}${ZDP_PATH}`,
  );

  socket.binaryType = "arraybuffer";

  let resolveClosed: (closed: DeviceClosed) => void = () => undefined;

  const closed = new Promise<DeviceClosed>((resolve) => {
    resolveClosed = resolve;
  });

  let localClose: DeviceClosed | undefined;

  socket.addEventListener("close", (event) => resolveClosed(localClose ?? event));

  const close = (code: number, reason: string) => {
    localClose ??= { code, reason };
    socket.close(code, reason);
  };

  // The handshake: two messages out, one in, all within `handshakeMs`.
  const hubMessage = new Promise<Uint8Array>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) resolve(new Uint8Array(event.data));
      else reject(new ZdpError("the hub sent a text message"));
    });
    void closed.then(({ code, reason }) =>
      reject(
        new DeviceOfflineError(`the hub closed the link (${code}${reason ? ` ${reason}` : ""})`),
      ),
    );
  });

  // Read only once the socket is open; a link that never opens must not leave it unhandled.
  hubMessage.catch(() => undefined);

  const handshake = (async () => {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new DeviceOfflineError(`could not reach the hub at ${host}:${port}`)),
      );
    });

    const noise = noiseInitiator({ staticKeyPair: keyPair, prologue: ZDP_PROLOGUE });

    socket.send(noise.start());

    const { message, transport } = noise.respond(await hubMessage);

    if (!sameBytes(transport.remoteStatic, pinnedHubKey))
      throw new NoiseError("the hub proved a different key than the one this device pinned");

    socket.send(message);

    return transport;
  })();

  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  const transport = await Promise.race([
    handshake,
    new Promise<never>((_, reject) => {
      handshakeTimer = setTimeout(
        () => reject(new DeviceOfflineError("the handshake timed out")),
        timing.handshakeMs,
      );
    }),
  ])
    .catch((error: Error) => {
      close(error instanceof NoiseError ? ZdpClose.protocol : 1000, error.message);

      throw error;
    })
    .finally(() => clearTimeout(handshakeTimer));

  const pending = new Map<string, Pending>();

  let lastSent = Date.now();

  let lastReceived = Date.now();

  let nextId = 1;

  let nextPing = 1;

  const sendFrame = (frame: Uint8Array) => {
    if (socket.readyState !== WebSocket.OPEN) return false;

    socket.send(transport.encrypt(frame));
    lastSent = Date.now();

    return true;
  };

  const send = (message: JsonObject) => {
    const frame = encodeMessage(message);

    trace?.("out", decodeFrame(frame));

    return sendFrame(frame);
  };

  const request = (method: string, params?: JsonObject, id: RequestId = nextId++) =>
    new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new DeviceRpcError(method, ZdpErrorCode.timeout, "the hub did not answer"));
      }, timing.requestMs);

      pending.set(String(id), { method, resolve, reject, timer });

      if (!send(params === undefined ? { id, method } : { id, method, params })) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(new DeviceOfflineError(`${method}: the link is closed`));
      }
    });

  const answer = async (id: RequestId, method: string, params: Json | undefined) => {
    const reply = await handlers.onRequest(method, params);

    send({ id, ...reply });
  };

  const receive = (frame: ZdpFrame) => {
    if (frame.kind === "chunk") return handlers.onChunk(frame.stream, frame.last, frame.data);

    const { id, method, params, result, error } = frame.message;

    if (method !== undefined && id !== undefined) return void answer(id, method, params);

    if (method !== undefined) return handlers.onNotification(method, params);

    if (id === undefined) return;

    const waiting = pending.get(String(id));

    if (waiting === undefined) return;

    pending.delete(String(id));
    clearTimeout(waiting.timer);

    if (error !== undefined)
      waiting.reject(new DeviceRpcError(waiting.method, error.code, error.message));
    else waiting.resolve(result ?? null);
  };

  socket.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) return close(ZdpClose.protocol, "text message");

    lastReceived = Date.now();

    try {
      const frame = decodeFrame(transport.decrypt(new Uint8Array(event.data)));

      trace?.("in", frame);
      receive(frame);
    } catch (error) {
      close(ZdpClose.protocol, errorText(error));
    }
  });

  // Liveness: ping when idle, drop when the hub has gone quiet.
  const liveness = setInterval(
    () => {
      const now = Date.now();

      if (now - lastReceived > timing.deadMs) return close(ZdpClose.timeout, "the hub went quiet");

      if (now - lastSent > timing.pingMs)
        void request("ping", undefined, `d-${nextPing++}`).catch(() => undefined);
    },
    Math.min(1_000, timing.pingMs / 2),
  );

  void closed.then(({ code, reason }) => {
    clearInterval(liveness);

    for (const [id, waiting] of pending) {
      pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(
        new DeviceOfflineError(
          `${waiting.method}: the link closed (${code}${reason ? ` ${reason}` : ""})`,
        ),
      );
    }
  });

  return {
    hubKey: transport.remoteStatic,
    request,
    notify: (method, params) => {
      send(params === undefined ? { method } : { method, params });
    },
    closed,
    close,
  };
};

type Listeners = { [K in keyof DeviceEvents]: Set<DeviceEvents[K]> };

interface Stream {
  readonly kind: "display" | "audio";
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly parts: Array<Uint8Array>;
}

export class ZiggyDevice {
  readonly #options: ZiggyDeviceOptions;

  readonly #timing: DeviceTiming;

  readonly #commands = new Map<
    string,
    { readonly spec: CommandSpec; readonly run: CommandHandler }
  >();

  readonly #listeners: Listeners = {
    state: new Set(),
    chat: new Set(),
    notify: new Set(),
    display: new Set(),
    audio: new Set(),
  };

  readonly #streams = new Map<number, Stream>();

  #identity: DeviceIdentity | undefined;

  #state: DeviceState = "idle";

  #link: Link | undefined;

  #running = false;

  #wake: (() => void) | undefined;

  constructor(options: ZiggyDeviceOptions) {
    this.#options = options;
    this.#timing = { ...DEVICE_TIMING, ...options.timing };
    this.#identity = options.identity;
  }

  get identity(): DeviceIdentity | undefined {
    return this.#identity;
  }

  get state(): DeviceState {
    return this.#state;
  }

  on<K extends keyof DeviceEvents>(name: K, listener: DeviceEvents[K]): () => void {
    const set: Set<DeviceEvents[K]> = this.#listeners[name];

    set.add(listener);

    return () => set.delete(listener);
  }

  /** Adds a command the Profile can call as a tool. Commands added while online are announced. */
  command(name: string, spec: CommandSpec, run: CommandHandler): this {
    if (!COMMAND_NAME.test(name))
      throw new ZdpError(`command names match [a-z0-9_]{1,48}: ${name}`);

    this.#commands.set(name, { spec, run });

    if (this.#state === "online") this.#link?.notify("notifications/tools/list_changed");

    return this;
  }

  /**
   * Pairs with a `zdp://` URI from `ziggy devices pair`, then stays online on the same link.
   * Returns the identity to keep for every later `start`.
   */
  async pair(uri: string): Promise<DeviceIdentity> {
    if (this.#running) throw new ZdpError("the device is already running");

    const pairing = parsePairingUri(uri);

    const keyPair = generateKeyPair();

    this.#running = true;
    this.#setState("connecting");

    try {
      const link = await this.#open(pairing.host, pairing.port, keyPair, pairing.key);

      const paired = await link
        .request("device.pair", {
          code: pairing.code,
          name: this.#options.name,
          model: this.#options.model,
        })
        .catch(async (error: Error) => {
          await closeAfterRefusal(link, "pairing failed");

          throw error;
        });

      if (
        !isJsonObject(paired) ||
        typeof paired.id !== "string" ||
        typeof paired.profile !== "string"
      )
        throw new ZdpError("the hub answered device.pair without an id");

      this.#identity = {
        version: 1,
        id: paired.id,
        profile: paired.profile,
        name: this.#options.name,
        model: this.#options.model,
        privateKey: base64url(keyPair.privateKey),
        hub: { host: pairing.host, port: pairing.port, key: base64url(pairing.key) },
      };

      const online = this.#untilOnline();

      void this.#run(link);
      await online;

      return this.#identity;
    } catch (error) {
      this.#running = false;
      this.#setState("stopped", { code: 1000, reason: errorText(error) });

      throw error;
    }
  }

  /**
   * Connects with the stored identity and keeps reconnecting until `stop`. Resolves the first
   * time the device is online; rejects with `DeviceStoppedError` if it stops for good first.
   */
  start(): Promise<void> {
    if (this.#identity === undefined) return Promise.reject(new ZdpError("pair the device first"));

    if (this.#running) return Promise.reject(new ZdpError("the device is already running"));

    this.#running = true;

    const online = this.#untilOnline();

    void this.#run(undefined);

    return online;
  }

  /** Closes the link and stops reconnecting. */
  stop(): void {
    this.#running = false;
    this.#link?.close(1000, "stopped");
    this.#wake?.();
  }

  /** Starts a chat turn; the reply arrives as `chat` events. */
  async send(text: string): Promise<{ readonly turn: string }> {
    const result = await this.#request("chat.send", { text });

    if (!isJsonObject(result) || typeof result.turn !== "string")
      throw new ZdpError("the hub answered chat.send without a turn");

    return { turn: result.turn };
  }

  /** Stops the running turn, if any. */
  async abort(): Promise<void> {
    await this.#request("chat.abort");
  }

  #request(method: string, params?: JsonObject): Promise<Json> {
    if (this.#state !== "online" || this.#link === undefined)
      return Promise.reject(new DeviceOfflineError(`${method}: the device is ${this.#state}`));

    return this.#link.request(method, params);
  }

  #emit<K extends keyof DeviceEvents>(name: K, ...args: Parameters<DeviceEvents[K]>): void {
    for (const listener of this.#listeners[name]) {
      // SAFETY: each listener set holds only listeners for its own event name.
      (listener as (...values: Parameters<DeviceEvents[K]>) => void)(...args);
    }
  }

  #setState(state: DeviceState, closed?: DeviceClosed): void {
    this.#state = state;

    if (closed === undefined) this.#emit("state", state);
    else this.#emit("state", state, closed);
  }

  #untilOnline(): Promise<void> {
    return new Promise((resolve, reject) => {
      const off = this.on("state", (state, closed) => {
        if (state === "online") resolve();
        else if (state === "stopped")
          reject(new DeviceStoppedError(closed ?? { code: 1000, reason: "stopped" }));
        else return;

        off();
      });
    });
  }

  #capabilities(): JsonObject {
    const { screen, audio } = this.#options;

    const capabilities: Writable<JsonObject> = {};

    if (this.#commands.size > 0) capabilities.tools = { listChanged: true };

    if (screen !== undefined)
      capabilities.screen = {
        width: screen.width,
        height: screen.height,
        formats: [...screen.formats],
      };

    if (audio !== undefined) {
      const formats: Writable<JsonObject> = {};

      if (audio.in !== undefined) formats.in = [...audio.in];

      if (audio.out !== undefined) formats.out = [...audio.out];

      capabilities.audio = formats;
    }

    if (this.#options.chat !== false) capabilities.chat = {};

    return capabilities;
  }

  #open(host: string, port: number, keyPair: KeyPair, hubKey: Uint8Array): Promise<Link> {
    return openLink(
      host,
      port,
      keyPair,
      hubKey,
      this.#timing,
      {
        onRequest: (method, params) => this.#answer(method, params),
        onNotification: (method, params) => this.#notification(method, params),
        onChunk: (stream, last, data) => this.#chunk(stream, last, data),
      },
      this.#options.trace,
    );
  }

  async #hello(link: Link, identity: DeviceIdentity): Promise<void> {
    const welcome = await link.request("device.hello", {
      zdp: ZDP_VERSION,
      name: identity.name,
      model: identity.model,
      firmware: this.#options.firmware ?? "0.1.0",
      capabilities: this.#capabilities(),
    });

    if (!isJsonObject(welcome) || welcome.zdp !== ZDP_VERSION)
      throw new ZdpError("the hub answered device.hello with another version");
  }

  /** One link after another until stopped or refused for good. */
  async #run(first: Link | undefined): Promise<void> {
    let backoff = this.#timing.backoffMinMs;

    let link = first;

    while (this.#running) {
      const identity = this.#identity;

      if (identity === undefined) return;

      let closed: DeviceClosed;

      try {
        if (link === undefined) {
          this.#setState("connecting");
          link = await this.#open(
            identity.hub.host,
            identity.hub.port,
            keyPairFromPrivate(new Uint8Array(Buffer.from(identity.privateKey, "base64url"))),
            new Uint8Array(Buffer.from(identity.hub.key, "base64url")),
          );
        }

        this.#link = link;

        const current = link;

        await this.#hello(current, identity).catch(async (error: Error) => {
          await closeAfterRefusal(current, "hello failed");

          throw error;
        });

        backoff = this.#timing.backoffMinMs;
        this.#setState("online");
        closed = await link.closed;
      } catch (error) {
        closed = link === undefined ? { code: 1006, reason: errorText(error) } : await link.closed;
      }

      link = undefined;
      this.#link = undefined;
      this.#streams.clear();

      if (!this.#running || FINAL_CODES.has(closed.code)) {
        this.#running = false;
        this.#setState("stopped", closed);

        return;
      }

      this.#setState("offline", closed);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff * (0.8 + Math.random() * 0.4));

        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      backoff = Math.min(backoff * 2, this.#timing.backoffMaxMs);
    }

    this.#setState("stopped", { code: 1000, reason: "stopped" });
  }

  async #answer(
    method: string,
    params: Json | undefined,
  ): Promise<{ readonly result: Json } | { readonly error: { code: number; message: string } }> {
    if (method === "ping") return { result: {} };

    if (method === "tools/list")
      return {
        result: {
          tools: [...this.#commands].map(([name, { spec }]) => {
            const tool: ToolJson = { name, inputSchema: spec.inputSchema ?? { type: "object" } };

            if (spec.description !== undefined) tool.description = spec.description;

            return tool;
          }),
        },
      };

    if (method !== "tools/call")
      return {
        error: {
          code: ZdpErrorCode.methodNotFound,
          message: `${method} is not served by this device`,
        },
      };

    const name = isJsonObject(params) ? params.name : undefined;

    const args = isJsonObject(params) ? (params.arguments ?? {}) : undefined;

    const command = typeof name === "string" ? this.#commands.get(name) : undefined;

    if (command === undefined || !isJsonObject(args))
      return {
        error: { code: ZdpErrorCode.invalidParams, message: `no command ${String(name)}` },
      };

    try {
      return { result: toolResultJson(toToolResult(await command.run(args))) };
    } catch (error) {
      return {
        result: toolResultJson({
          content: [{ type: "text", text: errorText(error) }],
          isError: true,
        }),
      };
    }
  }

  #notification(method: string, params: Json | undefined): void {
    if (!isJsonObject(params)) return;

    const { turn, text, title, image, stream, format } = params;

    if (method.startsWith("chat.") && typeof turn === "string") {
      const kind = method.slice("chat.".length);

      if (kind === "status" && typeof params.state === "string")
        this.#emit(
          "chat",
          typeof params.tool === "string"
            ? { type: "status", turn, state: params.state, tool: params.tool }
            : { type: "status", turn, state: params.state },
        );

      if (
        (kind === "delta" || kind === "done" || kind === "transcript") &&
        typeof text === "string"
      )
        this.#emit("chat", { type: kind, turn, text });

      if (kind === "error" && typeof params.message === "string")
        this.#emit("chat", { type: "error", turn, message: params.message });

      return;
    }

    if (method === "notify" && typeof text === "string")
      this.#emit("notify", typeof title === "string" ? { title, text } : { text });

    if (method === "display.show" && typeof text === "string") this.#emit("display", { text });

    if (method === "display.show" && isJsonObject(image) && typeof image.stream === "number")
      this.#streams.set(image.stream, {
        kind: "display",
        format: String(image.format),
        width: Number(image.width),
        height: Number(image.height),
        parts: [],
      });

    if (method === "audio.play" && typeof stream === "number")
      this.#streams.set(stream, {
        kind: "audio",
        format: String(format),
        width: 0,
        height: 0,
        parts: [],
      });
  }

  #chunk(id: number, last: boolean, data: Uint8Array): void {
    const stream = this.#streams.get(id);

    if (stream === undefined) return;

    stream.parts.push(data.slice());

    if (!last) return;

    this.#streams.delete(id);

    const bytes = new Uint8Array(Buffer.concat(stream.parts));

    if (stream.kind === "audio") this.#emit("audio", { format: stream.format, data: bytes });
    else
      this.#emit("display", {
        image: { format: stream.format, width: stream.width, height: stream.height, data: bytes },
      });
  }
}
