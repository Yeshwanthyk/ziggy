import { makeRecentIds } from "../bun/recent-ids";

export interface DiscordInboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | undefined;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
}

export class DiscordSocketError extends Error {
  readonly reason: string;
  readonly closeCode: number | undefined;

  constructor(reason: string, closeCode?: number) {
    super(`Discord gateway failed: ${reason}`);
    this.name = "DiscordSocketError";
    this.reason = reason;
    this.closeCode = closeCode;
  }
}

export interface DiscordSocket {
  readonly next: () => Promise<DiscordInboundMessage>;
  readonly close: () => Promise<void>;
}

interface PendingMessage {
  readonly resolve: (message: DiscordInboundMessage) => void;
  readonly reject: (error: DiscordSocketError) => void;
}

interface GatewayFrame {
  readonly op: number;
  readonly d: unknown;
  readonly s: number | null;
  readonly t: string | null;
}

interface ReadyPayload {
  readonly sessionId: string;
  readonly resumeGatewayUrl: string;
  readonly userId: string;
}

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const GATEWAY_QUERY = "v=10&encoding=json";
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_MESSAGE_IDS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringProperty = (value: Record<string, unknown>, key: string): string | undefined => {
  if (!(key in value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
};

const booleanProperty = (value: Record<string, unknown>, key: string): boolean | undefined => {
  if (!(key in value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "boolean" ? property : undefined;
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

const decodeGatewayUrl = (value: unknown): string | undefined =>
  isRecord(value) ? stringProperty(value, "url") : undefined;

const decodeFrame = (value: unknown): GatewayFrame | undefined => {
  if (!isRecord(value) || typeof value.op !== "number") {
    return undefined;
  }
  const sequence =
    "s" in value && (typeof value.s === "number" || value.s === null) ? value.s : null;
  const eventName =
    "t" in value && (typeof value.t === "string" || value.t === null) ? value.t : null;
  return {
    op: value.op,
    d: "d" in value ? value.d : null,
    s: sequence,
    t: eventName,
  };
};

const decodeHeartbeatInterval = (value: unknown): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const interval = value.heartbeat_interval;
  return typeof interval === "number" && Number.isFinite(interval) && interval > 0
    ? interval
    : undefined;
};

const decodeReady = (value: unknown): ReadyPayload | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const user = objectProperty(value, "user");
  const sessionId = stringProperty(value, "session_id");
  const resumeGatewayUrl = stringProperty(value, "resume_gateway_url");
  const userId = user === undefined ? undefined : stringProperty(user, "id");
  return sessionId === undefined || resumeGatewayUrl === undefined || userId === undefined
    ? undefined
    : { sessionId, resumeGatewayUrl, userId };
};

const decodeMessage = (value: unknown): DiscordInboundMessage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const author = objectProperty(value, "author");
  const id = stringProperty(value, "id");
  const channelId = stringProperty(value, "channel_id");
  const authorId = author === undefined ? undefined : stringProperty(author, "id");
  if (
    author === undefined ||
    id === undefined ||
    channelId === undefined ||
    authorId === undefined
  ) {
    return undefined;
  }
  return {
    id,
    channelId,
    guildId: stringProperty(value, "guild_id"),
    authorId,
    authorIsBot: booleanProperty(author, "bot") ?? false,
    content: stringProperty(value, "content") ?? "",
  };
};

const gatewaySocketUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.search = GATEWAY_QUERY;
  return url.toString();
};

const parseJson = (text: string): unknown => JSON.parse(text);

export const openDiscordSocket = (token: string, intents: number): DiscordSocket => {
  const buffered: Array<DiscordInboundMessage> = [];
  const pending: Array<PendingMessage> = [];
  const messageIds = makeRecentIds(MAX_MESSAGE_IDS);
  let currentSocket: WebSocket | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelayMs = 1_000;
  let heartbeatIntervalMs = 0;
  let sequence: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;
  let ownUserId: string | undefined;
  let heartbeatAcknowledged = true;
  let stopped = false;
  let failure: DiscordSocketError | undefined;

  const clearHeartbeat = () => {
    if (heartbeatTimer !== undefined) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const rejectPending = (error: DiscordSocketError) => {
    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  };

  const fail = (error: DiscordSocketError) => {
    if (stopped || failure !== undefined) {
      return;
    }
    failure = error;
    clearHeartbeat();
    clearReconnect();
    const socket = currentSocket;
    currentSocket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    rejectPending(error);
  };

  const send = (socket: WebSocket, payload: object) => {
    if (socket === currentSocket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const enqueue = (message: DiscordInboundMessage) => {
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
    clearHeartbeat();
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    return true;
  };

  const scheduleReconnect = (delayMs: number, mode: "auto" | "fresh" | "resume" = "auto") => {
    if (stopped || failure !== undefined) {
      return;
    }
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect(mode);
    }, delayMs);
  };

  const reconnect = (socket: WebSocket, mode: "auto" | "fresh" | "resume" = "auto") => {
    if (!abandon(socket)) {
      return;
    }
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    scheduleReconnect(delay, mode);
  };

  const sendHeartbeat = (socket: WebSocket) => {
    if (socket !== currentSocket) {
      return;
    }
    heartbeatAcknowledged = false;
    send(socket, { op: 1, d: sequence });
  };

  const scheduleHeartbeat = (socket: WebSocket, delayMs: number) => {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      if (socket !== currentSocket) {
        return;
      }
      if (!heartbeatAcknowledged) {
        reconnect(socket, "resume");
        return;
      }
      sendHeartbeat(socket);
      scheduleHeartbeat(socket, heartbeatIntervalMs);
    }, delayMs);
  };

  const handleDispatch = (socket: WebSocket, frame: GatewayFrame) => {
    if (frame.s !== null) {
      sequence = frame.s;
    }
    if (frame.t === "READY") {
      const ready = decodeReady(frame.d);
      if (ready === undefined) {
        fail(new DiscordSocketError("invalid READY payload"));
        return;
      }
      sessionId = ready.sessionId;
      resumeGatewayUrl = ready.resumeGatewayUrl;
      ownUserId = ready.userId;
      reconnectDelayMs = 1_000;
      return;
    }
    if (frame.t === "RESUMED") {
      reconnectDelayMs = 1_000;
      return;
    }
    if (frame.t === "MESSAGE_CREATE") {
      const message = decodeMessage(frame.d);
      if (
        message !== undefined &&
        message.authorId !== ownUserId &&
        messageIds.remember(message.id)
      ) {
        enqueue(message);
      }
    }
  };

  const handleFrame = (socket: WebSocket, frame: GatewayFrame) => {
    switch (frame.op) {
      case 0:
        handleDispatch(socket, frame);
        return;
      case 1:
        sendHeartbeat(socket);
        return;
      case 7:
        reconnect(socket, "resume");
        return;
      case 9:
        if (frame.d === false) {
          sessionId = undefined;
          resumeGatewayUrl = undefined;
          sequence = null;
          ownUserId = undefined;
          if (abandon(socket)) {
            scheduleReconnect(2_000, "fresh");
          }
        } else {
          reconnect(socket, "resume");
        }
        return;
      case 10: {
        const intervalMs = decodeHeartbeatInterval(frame.d);
        if (intervalMs === undefined) {
          fail(new DiscordSocketError("invalid Hello payload"));
          return;
        }
        heartbeatAcknowledged = true;
        heartbeatIntervalMs = intervalMs;
        scheduleHeartbeat(socket, intervalMs * Math.random());
        if (sessionId !== undefined && sequence !== null) {
          send(socket, { op: 6, d: { token, session_id: sessionId, seq: sequence } });
        } else {
          send(socket, {
            op: 2,
            d: {
              token,
              intents,
              properties: { os: "darwin", browser: "ziggy", device: "ziggy" },
            },
          });
        }
        return;
      }
      case 11:
        heartbeatAcknowledged = true;
        return;
    }
  };

  const attachSocket = (url: string) => {
    if (stopped || failure !== undefined) {
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(gatewaySocketUrl(url));
    } catch {
      scheduleReconnect(reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      return;
    }
    currentSocket = socket;

    socket.addEventListener("message", (event) => {
      if (socket !== currentSocket || typeof event.data !== "string") {
        return;
      }
      try {
        const frame = decodeFrame(parseJson(event.data));
        if (frame === undefined) {
          fail(new DiscordSocketError("invalid gateway frame"));
        } else {
          handleFrame(socket, frame);
        }
      } catch {
        fail(new DiscordSocketError("invalid gateway JSON"));
      }
    });

    socket.addEventListener("error", () => {
      setTimeout(() => {
        if (socket === currentSocket) {
          reconnect(socket);
        }
      }, 0);
    });

    socket.addEventListener("close", (event) => {
      if (socket !== currentSocket) {
        return;
      }
      currentSocket = undefined;
      clearHeartbeat();
      if (stopped) {
        return;
      }
      if (FATAL_CLOSE_CODES.has(event.code)) {
        fail(new DiscordSocketError(`fatal close code ${event.code}`, event.code));
        return;
      }
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay);
    });
  };

  async function connect(mode: "auto" | "fresh" | "resume"): Promise<void> {
    if (stopped || failure !== undefined || currentSocket !== undefined) {
      return;
    }
    const resumeUrl = resumeGatewayUrl;
    const canResume =
      mode !== "fresh" && sessionId !== undefined && sequence !== null && resumeUrl !== undefined;
    if (canResume) {
      attachSocket(resumeUrl);
      return;
    }

    try {
      const response = await fetch(GATEWAY_BOT_URL, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const url = decodeGatewayUrl(parseJson(await response.text()));
      if (url === undefined) {
        throw new Error("invalid gateway response");
      }
      attachSocket(url);
    } catch {
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay, mode);
    }
  }

  void connect("fresh");

  return {
    next: () => {
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      if (stopped) {
        return Promise.reject(new DiscordSocketError("closed"));
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
      clearHeartbeat();
      clearReconnect();
      const closedError = new DiscordSocketError("closed");
      rejectPending(closedError);
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
