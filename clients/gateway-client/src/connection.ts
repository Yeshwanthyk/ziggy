import {
  decodeJson,
  decodeResponseFrame,
  isClientEventNamed,
  ZiggyGatewayError,
  isMethodParams,
  isMethodResult,
  isRecord,
  isSafeInteger,
  isServerEpoch,
  type ZiggyClientEvent,
  type ZiggyConnectionState,
  type ZiggyEventName,
  type ZiggyGatewayEvent,
  type ZiggyMethod,
  type ZiggyProfileId,
  type ZiggyRequestMap,
  type ZiggyResultMap,
  type ZiggySessionRef,
  type ZiggyEventCursor,
  type ZiggyReconciliationEvent,
} from "./protocol";
import { isEventCursor, isGatewayEvent, isSessionReference } from "./protocol/conversations";

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/** A sent request may have committed even though its response was not observed. Never retry it automatically. */
export class ZiggyRequestOutcomeUnknownError extends Error {
  readonly method: ZiggyMethod;
  readonly commandId: string | undefined;

  constructor(method: ZiggyMethod, params: unknown) {
    super(`Ziggy gateway disconnected after sending ${method}; request outcome is unknown`);
    this.name = "ZiggyRequestOutcomeUnknownError";
    this.method = method;
    this.commandId =
      isRecord(params) && typeof params.commandId === "string" ? params.commandId : undefined;
  }
}

export interface ZiggySocketEvent {
  readonly data?: unknown;
}

export interface ZiggySocket {
  readonly readyState: number;
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly addEventListener: (
    name: "open" | "message" | "close" | "error",
    listener: (event: ZiggySocketEvent) => void,
  ) => void;
}

export type ZiggySocketFactory = (url: string) => ZiggySocket;

export interface ZiggyConnectionOptions {
  readonly url: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly socketFactory?: ZiggySocketFactory;
  readonly now?: () => number;
}

export interface ZiggyConnection {
  readonly state: ZiggyConnectionState;
  readonly epoch: string | undefined;
  request<Method extends ZiggyMethod>(
    method: Method,
    params: ZiggyRequestMap[Method],
  ): Promise<ZiggyResultMap[Method]>;
  watch(ref: ZiggySessionRef, cursor?: ZiggyEventCursor): Promise<void>;
  unwatch(ref: ZiggySessionRef): Promise<void>;
  on<Name extends ZiggyClientEvent["event"]>(
    eventName: Name,
    handler: (event: Extract<ZiggyClientEvent, { readonly event: Name }>) => void,
  ): () => void;
  onAny(handler: (event: ZiggyClientEvent) => void): () => void;
  close(): void;
}

interface PendingRequest {
  readonly method: ZiggyMethod;
  readonly params: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  sentGeneration: number | undefined;
}

interface WatchState {
  readonly ref: ZiggySessionRef;
  cursor: ZiggyEventCursor | undefined;
}

interface SequenceState {
  readonly epoch: string;
  seq: number;
}

const boundedDelay = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;

const authenticatedUrl = (value: string, token: string): string => {
  const url = new URL(value);
  url.searchParams.set("token", token);
  return url.toString();
};

const watchKey = (ref: ZiggySessionRef): string =>
  ref.kind === "live" ? `${ref.profileId}:live:${ref.key}` : `${ref.profileId}:stored:${ref.id}`;

const streamKeyForRef = (ref: ZiggySessionRef): string =>
  ref.kind === "live" ? `${ref.profileId}:live:${ref.key}` : `${ref.profileId}:stored:${ref.id}`;

const eventKey = (event: ZiggyGatewayEvent): string =>
  `${streamKeyForRef(event.session)}:${event.eventId}`;

const streamKey = (event: ZiggyGatewayEvent): string => streamKeyForRef(event.session);

const sequenceCursor = (event: ZiggyGatewayEvent): ZiggyEventCursor => ({
  epoch: event.epoch,
  seq: event.seq,
});

export const createZiggyConnection = (options: ZiggyConnectionOptions): ZiggyConnection => {
  const requestTimeoutMs = boundedDelay(options.requestTimeoutMs, 10_000);
  const reconnectBaseDelayMs = boundedDelay(options.reconnectBaseDelayMs, 250);
  const reconnectMaxDelayMs = Math.max(
    reconnectBaseDelayMs,
    boundedDelay(options.reconnectMaxDelayMs, 5_000),
  );
  const socketFactory = options.socketFactory ?? ((url: string): ZiggySocket => new WebSocket(url));
  const url = authenticatedUrl(options.url, options.token);
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingRequest>();
  const watches = new Map<string, WatchState>();
  const cursors = new Map<string, SequenceState>();
  const seenEventIds = new Set<string>();
  const handlers = new Map<ZiggyEventName, Set<(event: ZiggyClientEvent) => void>>();
  const anyHandlers = new Set<(event: ZiggyClientEvent) => void>();
  let socket: ZiggySocket | undefined;
  let connectionState: ZiggyConnectionState = "connecting";
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  let requestCounter = 0;
  let stopped = false;
  let currentEpoch: string | undefined;

  const emit = (event: ZiggyClientEvent): void => {
    for (const handler of handlers.get(event.event) ?? []) handler(event);
    for (const handler of anyHandlers) handler(event);
  };

  const setState = (state: ZiggyConnectionState): void => {
    if (connectionState === state) return;
    connectionState = state;
    emit({ event: "connection-state", state });
  };

  const reconcile = (
    profileId: ZiggyProfileId,
    session: ZiggySessionRef,
    reason: ZiggyReconciliationEvent["reason"],
    previous: ZiggyEventCursor | undefined,
    current: ZiggyEventCursor | undefined,
  ): void => {
    if (previous !== undefined && current !== undefined) {
      emit({
        event: "history-reconciliation",
        profileId,
        session,
        reason,
        previousEpoch: previous.epoch,
        previousSequence: previous.seq,
        currentEpoch: current.epoch,
        currentSequence: current.seq,
      });
    } else if (previous !== undefined) {
      emit({
        event: "history-reconciliation",
        profileId,
        session,
        reason,
        previousEpoch: previous.epoch,
        previousSequence: previous.seq,
      });
    } else if (current !== undefined) {
      emit({
        event: "history-reconciliation",
        profileId,
        session,
        reason,
        currentEpoch: current.epoch,
        currentSequence: current.seq,
      });
    } else {
      emit({ event: "history-reconciliation", profileId, session, reason });
    }
  };

  const send = (id: string, entry: PendingRequest): void => {
    if (socket?.readyState !== SOCKET_OPEN) return;
    const frame = { id, method: entry.method, params: entry.params };
    socket.send(JSON.stringify(frame));
    entry.sentGeneration = generation;
  };

  const request = <Method extends ZiggyMethod>(
    method: Method,
    params: ZiggyRequestMap[Method],
  ): Promise<ZiggyResultMap[Method]> => {
    if (stopped) return Promise.reject(new Error("Ziggy gateway client is closed"));
    if (!isMethodParams(method, params)) {
      return Promise.reject(new Error(`Invalid Ziggy gateway parameters for ${method}`));
    }
    const id = `ziggy-${now().toString(36)}-${(++requestCounter).toString(36)}`;
    return new Promise<ZiggyResultMap[Method]>((resolve, reject) => {
      let entry: PendingRequest | undefined;
      const timeout = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(
          entry?.sentGeneration === undefined
            ? new Error(`Ziggy gateway request timed out before send: ${method}`)
            : new ZiggyRequestOutcomeUnknownError(method, params),
        );
      }, requestTimeoutMs);
      entry = {
        method,
        params,
        resolve: (value) => {
          if (!isMethodResult(method, params, value)) {
            reject(new Error(`Invalid Ziggy gateway response for ${method}`));
            return;
          }
          resolve(value);
        },
        reject,
        timeout,
        sentGeneration: undefined,
      };
      pending.set(id, entry);
      send(id, entry);
    });
  };

  const rememberWatchFromRequest = (entry: PendingRequest): void => {
    if (!isRecord(entry.params)) return;
    if (entry.method === "session.watch" && isSessionReference(entry.params.ref)) {
      const ref = entry.params.ref;
      const key = watchKey(ref);
      const previous = watches.get(key);
      const latest = streamKeyForRef(ref);
      const latestSequence = cursors.get(latest);
      const cursor =
        latestSequence === undefined
          ? isSafeInteger(entry.params.afterSeq) && isServerEpoch(entry.params.epoch)
            ? { epoch: entry.params.epoch, seq: entry.params.afterSeq }
            : previous?.cursor
          : { epoch: latestSequence.epoch, seq: latestSequence.seq };
      watches.set(key, {
        ref,
        cursor,
      });
      if (cursor !== undefined) cursors.set(latest, { epoch: cursor.epoch, seq: cursor.seq });
      return;
    }
    if (
      (entry.method === "session.unwatch" || entry.method === "session.close") &&
      isSessionReference(entry.params.ref)
    ) {
      watches.delete(watchKey(entry.params.ref));
      const stream = streamKeyForRef(entry.params.ref);
      cursors.delete(stream);
    }
  };

  const handleEvent = (event: ZiggyGatewayEvent): void => {
    const key = streamKey(event);
    const prior = cursors.get(key);
    const incoming = sequenceCursor(event);
    if (seenEventIds.has(eventKey(event))) return;
    if (prior !== undefined && prior.epoch === event.epoch && event.seq <= prior.seq) {
      seenEventIds.add(eventKey(event));
      return;
    }
    if (event.event === "replay-gap") {
      seenEventIds.add(eventKey(event));
      const watch = watches.get(watchKey(event.session));
      if (watch !== undefined) watch.cursor = undefined;
      cursors.delete(key);
      reconcile(event.profileId, event.session, "replay-gap", prior, incoming);
      emit(event);
      return;
    }
    if (prior !== undefined && prior.epoch === event.epoch && event.seq > prior.seq + 1) {
      reconcile(event.profileId, event.session, "sequence-gap", prior, incoming);
    }
    if (currentEpoch !== undefined && currentEpoch !== event.epoch) {
      reconcile(event.profileId, event.session, "epoch-changed", prior, incoming);
      cursors.delete(key);
    }
    currentEpoch = event.epoch;
    cursors.set(key, { epoch: event.epoch, seq: event.seq });
    for (const watch of watches.values()) {
      if (
        watch.ref.kind === "live" &&
        watch.ref.profileId === event.profileId &&
        event.session.kind === "live" &&
        watch.ref.key === event.session.key
      ) {
        watch.cursor = incoming;
      }
    }
    seenEventIds.add(eventKey(event));
    while (seenEventIds.size > 4_096) {
      const first = seenEventIds.values().next().value;
      if (typeof first !== "string") break;
      seenEventIds.delete(first);
    }
    emit(event);
  };

  const handleMessage = (socketEvent: ZiggySocketEvent): void => {
    const decoded = decodeJson(socketEvent.data);
    if (decoded === undefined) return;
    const response = decodeResponseFrame(decoded);
    if (response !== undefined) {
      const entry = pending.get(response.id);
      if (entry === undefined) return;
      pending.delete(response.id);
      clearTimeout(entry.timeout);
      if (!response.ok) {
        entry.reject(
          new ZiggyGatewayError(
            response.error.code,
            response.error.message,
            response.error.details,
          ),
        );
        return;
      }
      if (entry.method === "system.capabilities" && isRecord(response.result)) {
        const epoch = response.result.serverEpoch;
        if (isServerEpoch(epoch)) {
          if (currentEpoch !== undefined && currentEpoch !== epoch) {
            for (const watch of watches.values()) {
              if (watch.ref.kind === "live") {
                reconcile(
                  watch.ref.profileId,
                  watch.ref,
                  "epoch-changed",
                  {
                    epoch: currentEpoch,
                    seq: cursors.get(`${watch.ref.profileId}:${watch.ref.key}`)?.seq ?? 0,
                  },
                  { epoch, seq: 0 },
                );
              }
            }
            cursors.clear();
            for (const watch of watches.values()) watch.cursor = undefined;
          }
          currentEpoch = epoch;
        }
      }
      rememberWatchFromRequest(entry);
      entry.resolve(response.result);
      return;
    }
    if (isGatewayEvent(decoded)) handleEvent(decoded);
  };

  const rejectSentRequests = (closedGeneration: number): void => {
    for (const [id, entry] of pending) {
      if (entry.sentGeneration !== closedGeneration) continue;
      pending.delete(id);
      clearTimeout(entry.timeout);
      entry.reject(new ZiggyRequestOutcomeUnknownError(entry.method, entry.params));
    }
  };

  const restoreWatches = (): void => {
    for (const watch of watches.values()) {
      if (watch.ref.kind !== "live") continue;
      const ref = watch.ref;
      const params =
        watch.cursor === undefined
          ? { ref }
          : { ref, afterSeq: watch.cursor.seq, epoch: watch.cursor.epoch };
      void request("session.watch", params).catch((reason: unknown) => {
        if (
          reason instanceof ZiggyGatewayError &&
          (reason.code === "stale_cursor" || reason.code === "replay_gap")
        ) {
          const previous = watch.cursor;
          watch.cursor = undefined;
          cursors.delete(streamKeyForRef(ref));
          reconcile(ref.profileId, ref, "replay-gap", previous, undefined);
        }
      });
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    setState("reconnecting");
    const delay = Math.min(reconnectBaseDelayMs * 2 ** reconnectAttempt, reconnectMaxDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
  };

  const openSocket = (): void => {
    if (stopped) return;
    const currentGeneration = ++generation;
    const current = socketFactory(url);
    socket = current;
    current.addEventListener("open", () => {
      if (stopped || socket !== current) return;
      reconnectAttempt = 0;
      setState("open");
      restoreWatches();
      for (const [id, entry] of pending) {
        if (entry.sentGeneration === undefined) send(id, entry);
      }
    });
    current.addEventListener("message", (event) => {
      if (socket === current) handleMessage(event);
    });
    current.addEventListener("close", () => {
      if (socket !== current) return;
      rejectSentRequests(currentGeneration);
      socket = undefined;
      scheduleReconnect();
    });
    current.addEventListener("error", () => {
      if (socket === current && current.readyState !== SOCKET_OPEN) current.close();
    });
  };

  openSocket();

  const connection: ZiggyConnection = {
    get state() {
      return connectionState;
    },
    get epoch() {
      return currentEpoch;
    },
    request,
    watch: async (ref, cursor) => {
      if (!isSessionReference(ref)) throw new Error("Invalid Ziggy session reference");
      if (ref.kind !== "live") throw new Error("Only live sessions can be watched");
      if (cursor !== undefined && !isEventCursor(cursor))
        throw new Error("Invalid Ziggy event cursor");
      await request(
        "session.watch",
        cursor === undefined ? { ref } : { ref, afterSeq: cursor.seq, epoch: cursor.epoch },
      );
    },
    unwatch: async (ref) => {
      if (!isSessionReference(ref)) throw new Error("Invalid Ziggy session reference");
      if (ref.kind !== "live") throw new Error("Only live sessions can be unwatched");
      await request("session.unwatch", { ref });
    },
    on: (eventName, handler) => {
      const eventHandlers = handlers.get(eventName) ?? new Set();
      const wrapper = (event: ZiggyClientEvent): void => {
        if (isClientEventNamed(event, eventName)) handler(event);
      };
      eventHandlers.add(wrapper);
      handlers.set(eventName, eventHandlers);
      return () => eventHandlers.delete(wrapper);
    },
    onAny: (handler) => {
      anyHandlers.add(handler);
      return () => anyHandlers.delete(handler);
    },
    close: () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error("Ziggy gateway client is closed"));
      }
      pending.clear();
      socket?.close(1000, "client closing");
      socket = undefined;
      setState("closed");
    },
  };
  return connection;
};

export { authenticatedUrl };
