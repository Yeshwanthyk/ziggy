/**
 * A binary WebSocket listener as Effects. Bun's callbacks only queue; each link's messages are
 * taken from its queue, which ends with `Cause.Done` when the socket closes.
 */
import { Cause, Effect, Queue, Schema, Scope } from "effect";

export class WebSocketServerFailed extends Schema.TaggedErrorClass<WebSocketServerFailed>()(
  "WebSocketServerFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export interface WebSocketLink {
  readonly id: number;
  readonly remoteAddress: string;
  /** Inbound binary messages, then `Cause.Done` once the socket has closed. */
  readonly messages: Queue.Dequeue<Uint8Array, Cause.Done>;
  /** False once the socket is closed or its send buffer overflowed. */
  readonly send: (data: Uint8Array) => Effect.Effect<boolean>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
}

export interface WebSocketServerOptions {
  readonly hostname: string;
  /** `0` picks a free port. */
  readonly port: number;
  /** The only path that upgrades; anything else is 404. */
  readonly path: string;
  readonly maxMessageBytes: number;
  /** Runs once per link, in its own fiber; the link is closed when it ends. */
  readonly onLink: (link: WebSocketLink) => Effect.Effect<void>;
}

export interface WebSocketServer {
  readonly port: number;
}

interface LinkState {
  readonly id: number;
  readonly remoteAddress: string;
  socket: Bun.ServerWebSocket<LinkState> | undefined;
  closed: boolean;
}

/** What Bun reported, in order; one fiber turns these into per-link queues. */
type SocketEvent =
  | { readonly _tag: "open"; readonly state: LinkState }
  | { readonly _tag: "message"; readonly state: LinkState; readonly data: Uint8Array }
  | { readonly _tag: "close"; readonly state: LinkState };

// A text message is not part of a binary protocol; 1003 is "unsupported data".
const UNSUPPORTED_DATA = 1003;

const BACKPRESSURE_BYTES = 1024 * 1024;

export const serveWebSockets = (
  options: WebSocketServerOptions,
): Effect.Effect<WebSocketServer, WebSocketServerFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;

    const events = yield* Queue.unbounded<SocketEvent>();

    const queues = new Map<number, Queue.Queue<Uint8Array, Cause.Done>>();

    const sockets = new Map<number, LinkState>();

    let nextId = 1;

    const closeState = (state: LinkState, code: number, reason: string) => {
      if (state.closed) return;

      state.closed = true;
      state.socket?.close(code, reason);
    };

    const toLink = (
      state: LinkState,
      messages: Queue.Queue<Uint8Array, Cause.Done>,
    ): WebSocketLink => ({
      id: state.id,
      remoteAddress: state.remoteAddress,
      messages,
      send: (data) =>
        Effect.sync(() => {
          if (state.closed || state.socket === undefined) return false;

          // -1 is backpressure; Bun closes the socket itself past the limit.
          return state.socket.send(data) > 0;
        }),
      close: (code, reason) => Effect.sync(() => closeState(state, code, reason)),
    });

    const dispatch = (event: SocketEvent): Effect.Effect<void> => {
      const { state } = event;

      if (event._tag === "message")
        return Effect.sync(() => {
          const messages = queues.get(state.id);

          if (messages !== undefined) Queue.offerUnsafe(messages, event.data);
        });

      if (event._tag === "close")
        return Effect.sync(() => {
          const messages = queues.get(state.id);

          queues.delete(state.id);

          if (messages !== undefined) Queue.endUnsafe(messages);
        });

      return Effect.gen(function* () {
        const messages = yield* Queue.unbounded<Uint8Array, Cause.Done>();

        queues.set(state.id, messages);

        yield* Effect.forkIn(
          options.onLink(toLink(state, messages)).pipe(
            Effect.catchCause((cause) => Effect.logWarning("websocket link failed", cause)),
            Effect.ensuring(Effect.sync(() => closeState(state, 1000, "done"))),
          ),
          scope,
        );
      });
    };

    yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(events), dispatch)), scope);

    const server = yield* Effect.try({
      try: () =>
        Bun.serve<LinkState>({
          hostname: options.hostname,
          port: options.port,
          fetch: (request, current) => {
            if (new URL(request.url).pathname !== options.path)
              return new Response("not found", { status: 404 });

            const state: LinkState = {
              id: nextId++,
              remoteAddress: current.requestIP(request)?.address ?? "unknown",
              socket: undefined,
              closed: false,
            };

            if (current.upgrade(request, { data: state })) return undefined;

            return new Response("WebSocket upgrade required", { status: 426 });
          },
          websocket: {
            maxPayloadLength: options.maxMessageBytes,
            backpressureLimit: BACKPRESSURE_BYTES,
            closeOnBackpressureLimit: true,
            open: (socket) => {
              socket.data.socket = socket;
              sockets.set(socket.data.id, socket.data);
              Queue.offerUnsafe(events, { _tag: "open", state: socket.data });
            },
            message: (socket, message) => {
              if (!Buffer.isBuffer(message)) {
                closeState(socket.data, UNSUPPORTED_DATA, "binary messages only");

                return;
              }

              Queue.offerUnsafe(events, {
                _tag: "message",
                state: socket.data,
                data: new Uint8Array(message),
              });
            },
            close: (socket) => {
              sockets.delete(socket.data.id);
              socket.data.closed = true;
              Queue.offerUnsafe(events, { _tag: "close", state: socket.data });
            },
          },
        }),
      catch: (cause) =>
        new WebSocketServerFailed({
          message: `could not listen on ${options.hostname}:${options.port}`,
          cause,
        }),
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const state of sockets.values()) closeState(state, 1001, "server stopping");

        yield* Effect.promise(() => server.stop(true)).pipe(Effect.timeoutOption(250));
      }),
    );

    if (server.port === undefined)
      return yield* new WebSocketServerFailed({
        message: "the listener did not bind a TCP port",
        cause: undefined,
      });

    return { port: server.port };
  });
