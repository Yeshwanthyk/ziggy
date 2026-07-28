import { makeRecentIds } from "../bun/recent-ids";

export interface SlackInboundMessage {
  readonly channel: string;
  readonly channelType: "im" | "channel" | "group" | "mpim";
  readonly userId: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs: string | undefined;
}

export class SlackSocketError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Slack socket failed: ${reason}`);
    this.name = "SlackSocketError";
    this.reason = reason;
  }
}

export interface SlackSocket {
  readonly next: () => Promise<SlackInboundMessage>;
  readonly close: () => Promise<void>;
}

export const normalizeSlackSocketError = (cause: unknown): SlackSocketError =>
  cause instanceof SlackSocketError ? cause : new SlackSocketError("unexpected socket failure");

interface PendingMessage {
  readonly resolve: (message: SlackInboundMessage) => void;
  readonly reject: (error: SlackSocketError) => void;
}

interface SocketEnvelope {
  readonly type: string;
  readonly envelopeId: string | undefined;
  readonly payload: Record<string, unknown> | undefined;
}

const CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_EVENT_IDS = 1_000;
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_authed",
  "missing_scope",
  "forbidden_team",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringProperty = (value: Record<string, unknown>, key: string): string | undefined => {
  if (!(key in value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
};

const objectProperty = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  if (!(key in value)) {
    return undefined;
  }
  const property = value[key];
  return isRecord(property) ? property : undefined;
};

const decodeConnectionResponse = (
  value: unknown,
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string }
  | undefined => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return undefined;
  }
  if (value.ok) {
    const url = stringProperty(value, "url");
    return url === undefined ? undefined : { ok: true, url };
  }
  const error = stringProperty(value, "error");
  return error === undefined ? undefined : { ok: false, error };
};

const decodeEnvelope = (value: unknown): SocketEnvelope | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = stringProperty(value, "type");
  return type === undefined
    ? undefined
    : {
        type,
        envelopeId: stringProperty(value, "envelope_id"),
        payload: objectProperty(value, "payload"),
      };
};

const channelType = (value: string | undefined): SlackInboundMessage["channelType"] | undefined => {
  switch (value) {
    case "im":
    case "channel":
    case "group":
    case "mpim":
      return value;
    default:
      return undefined;
  }
};

const decodeMessage = (value: unknown): SlackInboundMessage | undefined => {
  if (!isRecord(value) || stringProperty(value, "type") !== "message") {
    return undefined;
  }
  if ("subtype" in value || "bot_id" in value) {
    return undefined;
  }
  const channel = stringProperty(value, "channel");
  const decodedChannelType = channelType(stringProperty(value, "channel_type"));
  const userId = stringProperty(value, "user");
  const text = stringProperty(value, "text");
  const ts = stringProperty(value, "ts");
  if (
    channel === undefined ||
    decodedChannelType === undefined ||
    userId === undefined ||
    userId.length === 0 ||
    text === undefined ||
    ts === undefined
  ) {
    return undefined;
  }
  return {
    channel,
    channelType: decodedChannelType,
    userId,
    text,
    ts,
    threadTs: stringProperty(value, "thread_ts"),
  };
};

const parseJson = (text: string): unknown => JSON.parse(text);

export const openSlackSocket = (appToken: string): SlackSocket => {
  const buffered: Array<SlackInboundMessage> = [];
  const pending: Array<PendingMessage> = [];
  const eventIds = makeRecentIds(MAX_EVENT_IDS);
  let currentSocket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelayMs = 1_000;
  let stopped = false;
  let failure: SlackSocketError | undefined;

  const clearReconnect = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const rejectPending = (error: SlackSocketError) => {
    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  };

  const fail = (error: SlackSocketError) => {
    if (stopped || failure !== undefined) {
      return;
    }
    failure = error;
    clearReconnect();
    const socket = currentSocket;
    currentSocket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    rejectPending(error);
  };

  const enqueue = (message: SlackInboundMessage) => {
    const waiter = pending.shift();
    if (waiter === undefined) {
      buffered.push(message);
    } else {
      waiter.resolve(message);
    }
  };

  const abandon = (socket: WebSocket) => {
    if (socket !== currentSocket) {
      return false;
    }
    currentSocket = undefined;
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    return true;
  };

  const scheduleReconnect = (delayMs: number) => {
    if (stopped || failure !== undefined) {
      return;
    }
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delayMs);
  };

  const reconnect = (socket: WebSocket) => {
    if (!abandon(socket)) {
      return;
    }
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    scheduleReconnect(delay);
  };

  const acknowledge = (socket: WebSocket, envelopeId: string | undefined) => {
    if (
      envelopeId !== undefined &&
      socket === currentSocket &&
      socket.readyState === WebSocket.OPEN
    ) {
      socket.send(JSON.stringify({ envelope_id: envelopeId }));
    }
  };

  const handleEnvelope = (socket: WebSocket, envelope: SocketEnvelope) => {
    if (envelope.type === "hello") {
      reconnectDelayMs = 1_000;
      return;
    }

    acknowledge(socket, envelope.envelopeId);
    if (envelope.type === "disconnect") {
      if (abandon(socket)) {
        scheduleReconnect(0);
      }
      return;
    }
    if (envelope.type !== "events_api" || envelope.payload === undefined) {
      return;
    }

    const eventId = stringProperty(envelope.payload, "event_id");
    if (eventId !== undefined && !eventIds.remember(eventId)) {
      return;
    }
    const message = decodeMessage(objectProperty(envelope.payload, "event"));
    if (message !== undefined) {
      enqueue(message);
    }
  };

  const attachSocket = (url: string) => {
    if (stopped || failure !== undefined) {
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay);
      return;
    }
    currentSocket = socket;

    socket.addEventListener("message", (event) => {
      if (socket !== currentSocket || typeof event.data !== "string") {
        return;
      }
      try {
        const envelope = decodeEnvelope(parseJson(event.data));
        if (envelope !== undefined) {
          handleEnvelope(socket, envelope);
        }
      } catch {
        // Invalid frames are ignored; Slack will redeliver unacknowledged envelopes.
      }
    });

    socket.addEventListener("error", () => {
      setTimeout(() => {
        if (socket === currentSocket) {
          reconnect(socket);
        }
      }, 0);
    });

    socket.addEventListener("close", () => {
      if (socket !== currentSocket) {
        return;
      }
      currentSocket = undefined;
      if (stopped) {
        return;
      }
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay);
    });
  };

  async function connect(): Promise<void> {
    if (stopped || failure !== undefined || currentSocket !== undefined) {
      return;
    }
    try {
      // oxlint-disable-next-line ziggy-effect/no-raw-fetch -- Slack Socket Mode requires global fetch.
      const response = await fetch(CONNECTIONS_OPEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      });
      const envelope = decodeConnectionResponse(parseJson(await response.text()));
      if (envelope === undefined) {
        throw new Error("invalid connections.open response");
      }
      if (!envelope.ok) {
        if (AUTH_ERRORS.has(envelope.error)) {
          fail(new SlackSocketError(`authentication failed: ${envelope.error}`));
          return;
        }
        throw new Error("connections.open rejected");
      }
      attachSocket(envelope.url);
    } catch {
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay);
    }
  }

  void connect();

  return {
    next: () => {
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      if (stopped) {
        return Promise.reject(new SlackSocketError("closed"));
      }
      const message = buffered.shift();
      if (message !== undefined) {
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    close: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearReconnect();
      rejectPending(new SlackSocketError("closed"));
      const socket = currentSocket;
      currentSocket = undefined;
      if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.addEventListener(
          "open",
          () => {
            socket.close(1000);
          },
          { once: true },
        );
        try {
          socket.close(1000);
        } catch {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
          }
        }
      });
    },
  };
};
