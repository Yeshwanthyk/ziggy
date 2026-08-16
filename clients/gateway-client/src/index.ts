// Protocol mirror: src/domain/ui-gateway.ts. Keep both v1 surfaces aligned.

export type ZiggySessionKey =
  | `ui/${string}`
  | `telegram/${string}`
  | `discord/${string}`
  | `slack/${string}`;

export type ZiggyGatewayErrorCode =
  | "unauthorized"
  | "unknown_method"
  | "bad_params"
  | "unknown_session"
  | "watch_only"
  | "session_busy"
  | "not_streaming"
  | "capacity_exceeded"
  | "internal";

export interface ZiggyLiveSession {
  readonly key: ZiggySessionKey;
  readonly kind: "telegram" | "discord" | "slack" | "ui";
  readonly idle: boolean;
}

export interface ZiggyStoredSession {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
}
export type ZiggyExtensionId = string;
export type ZiggyExtensionOperation = "list" | "add" | "remove" | "validate";
export type ZiggyExtensionFailureStage =
  | "catalog"
  | "download"
  | "checksum"
  | "archive"
  | "validation"
  | "validate"
  | "filesystem"
  | "resources"
  | "extensions"
  | "skills"
  | "services"
  | "lock"
  | "rollback"
  | "response";
export type ZiggyExtensionFailureCode = string;

export interface ZiggyExtensionFailure {
  readonly operation: ZiggyExtensionOperation;
  readonly stage: ZiggyExtensionFailureStage;
  readonly code: ZiggyExtensionFailureCode;
  readonly message: string;
  readonly id?: ZiggyExtensionId;
  readonly source?: string;
  readonly selectionChanged: boolean;
}

export type ZiggyExtensionFailureDetails = ZiggyExtensionFailure;

export type ZiggyExtensionChoiceKind = "skill" | "code" | "skill+code" | "remote";
export type ZiggyExtensionChoiceSource = "bundled" | "remote-approved" | "profile";

export interface ZiggyExtensionChoice {
  readonly id: ZiggyExtensionId;
  readonly description: string;
  readonly kind: ZiggyExtensionChoiceKind;
  readonly source: ZiggyExtensionChoiceSource;
}

export type ZiggyExtensionListForProfileParams = Record<string, never>;

export interface ZiggyExtensionAddParams {
  readonly id: ZiggyExtensionId;
}

export type ZiggyExtensionRemoveParams = ZiggyExtensionAddParams;
export type ZiggyExtensionValidateParams = Record<string, never>;

export interface ZiggyExtensionListForProfileResult {
  readonly available: ReadonlyArray<ZiggyExtensionChoice>;
  readonly selected: ReadonlyArray<ZiggyExtensionId>;
}

export interface ZiggyExtensionMutationResult {
  readonly id: ZiggyExtensionId;
  readonly profilePath: string;
  readonly changed: boolean;
  readonly selected: boolean;
}

export interface ZiggyExtensionValidationResult {
  readonly selected: ReadonlyArray<ZiggyExtensionId>;
  readonly preflight: {
    readonly extensionPathCount: number;
    readonly skillPathCount: number;
    readonly extensionFactoryCount: number;
  };
}

export type ZiggyExtensionListing = ZiggyExtensionListForProfileResult;
export type ZiggyExtensionMutation = ZiggyExtensionMutationResult;
export type ZiggyExtensionValidation = ZiggyExtensionValidationResult;

export interface ZiggyRequestMap {
  readonly ping: Record<string, never>;
  readonly "session.list": Record<string, never>;
  readonly "session.open": { readonly name: string };
  readonly "session.watch": { readonly session: ZiggySessionKey };
  readonly "prompt.submit": { readonly session: ZiggySessionKey; readonly text: string };
  readonly "session.steer": { readonly session: ZiggySessionKey; readonly text: string };
  readonly "session.abort": { readonly session: ZiggySessionKey };
  readonly "extension.list-for-profile": ZiggyExtensionListForProfileParams;
  readonly "extension.add": ZiggyExtensionAddParams;
  readonly "extension.remove": ZiggyExtensionRemoveParams;
  readonly "extension.validate": ZiggyExtensionValidateParams;
}

export interface ZiggyResultMap {
  readonly ping: { readonly pong: true };
  readonly "session.list": {
    readonly live: ReadonlyArray<ZiggyLiveSession>;
    readonly stored: ReadonlyArray<ZiggyStoredSession>;
  };
  readonly "session.open": { readonly session: ZiggySessionKey };
  readonly "session.watch": Record<string, never>;
  readonly "prompt.submit": Record<string, never>;
  readonly "session.steer": Record<string, never>;
  readonly "session.abort": Record<string, never>;
  readonly "extension.list-for-profile": ZiggyExtensionListForProfileResult;
  readonly "extension.add": ZiggyExtensionMutationResult;
  readonly "extension.remove": ZiggyExtensionMutationResult;
  readonly "extension.validate": ZiggyExtensionValidationResult;
}

export type ZiggyMethod = keyof ZiggyRequestMap;
export type ZiggyConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export type ZiggyGatewayEvent =
  | {
      readonly event: "assistant-text";
      readonly session: ZiggySessionKey;
      readonly payload: { readonly delta: string; readonly snapshot: string };
    }
  | {
      readonly event: "thinking";
      readonly session: ZiggySessionKey;
      readonly payload: { readonly delta: string };
    }
  | {
      readonly event: "tool";
      readonly session: ZiggySessionKey;
      readonly payload: {
        readonly phase: "start" | "update" | "end";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly failed: boolean;
        readonly detail?: string;
      };
    }
  | {
      readonly event: "voice";
      readonly session: ZiggySessionKey;
      readonly payload: { readonly agentId: string; readonly text: string };
    }
  | {
      readonly event: "settled";
      readonly session: ZiggySessionKey;
      readonly payload: Record<string, never>;
    }
  | {
      readonly event: "error";
      readonly session: ZiggySessionKey;
      readonly payload: { readonly message: string };
    }
  | {
      readonly event: "connection-state";
      readonly payload: { readonly state: ZiggyConnectionState };
    };

export type ZiggyEventName = ZiggyGatewayEvent["event"];
export type ZiggyEventOf<Name extends ZiggyEventName> = Extract<
  ZiggyGatewayEvent,
  { readonly event: Name }
>;

export class ZiggyGatewayError extends Error {
  readonly code: ZiggyGatewayErrorCode;
  readonly details?: ZiggyExtensionFailure;

  constructor(code: ZiggyGatewayErrorCode, message: string, details?: ZiggyExtensionFailure) {
    super(message);
    this.name = "ZiggyGatewayError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

interface SocketEventMap {
  readonly open: Event;
  readonly message: MessageEvent;
  readonly close: CloseEvent;
  readonly error: Event;
}

export interface ZiggySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<Name extends keyof SocketEventMap>(
    name: Name,
    listener: (event: SocketEventMap[Name]) => void,
  ): void;
}

export interface ConnectZiggyOptions {
  readonly url: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly socketFactory?: (url: string) => ZiggySocket;
}

export interface ZiggyGatewayClient {
  readonly state: ZiggyConnectionState;
  request<Method extends ZiggyMethod>(
    method: Method,
    params: ZiggyRequestMap[Method],
  ): Promise<ZiggyResultMap[Method]>;
  listExtensionsForProfile(): Promise<ZiggyExtensionListForProfileResult>;
  addExtension(id: ZiggyExtensionId): Promise<ZiggyExtensionMutationResult>;
  removeExtension(id: ZiggyExtensionId): Promise<ZiggyExtensionMutationResult>;
  validateExtensions(): Promise<ZiggyExtensionValidationResult>;
  on<Name extends ZiggyEventName>(
    eventName: Name,
    handler: (event: ZiggyEventOf<Name>) => void,
  ): () => void;
  onAny(handler: (event: ZiggyGatewayEvent) => void): () => void;
  close(): void;
}

interface PendingRequest {
  readonly method: ZiggyMethod;
  readonly params: ZiggyRequestMap[ZiggyMethod];
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  sentGeneration?: number;
}

interface SuccessFrame {
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

interface FailureFrame {
  readonly id: string;
  readonly ok: false;
  readonly error: {
    readonly code: ZiggyGatewayErrorCode;
    readonly message: string;
    readonly details?: ZiggyExtensionFailure;
  };
}

const SOCKET_OPEN = 1;
const ERROR_CODES = new Set<ZiggyGatewayErrorCode>([
  "unauthorized",
  "unknown_method",
  "bad_params",
  "unknown_session",
  "watch_only",
  "session_busy",
  "not_streaming",
  "capacity_exceeded",
  "internal",
]);
const EXTENSION_OPERATIONS = new Set<ZiggyExtensionOperation>([
  "list",
  "add",
  "remove",
  "validate",
]);
const EXTENSION_FAILURE_STAGES = new Set<ZiggyExtensionFailureStage>([
  "catalog",
  "download",
  "checksum",
  "archive",
  "validation",
  "validate",
  "filesystem",
  "resources",
  "extensions",
  "skills",
  "services",
  "lock",
  "rollback",
  "response",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGatewayErrorCode = (value: unknown): value is ZiggyGatewayErrorCode =>
  typeof value === "string" && ERROR_CODES.has(value as ZiggyGatewayErrorCode);

const isSessionKey = (value: unknown): value is ZiggySessionKey =>
  typeof value === "string" &&
  /^(?:ui|telegram|discord|slack)\/[A-Za-z0-9._%~-]{1,240}$/u.test(value) &&
  new TextEncoder().encode(value).byteLength <= 256;

const isEmptyRecord = (value: unknown): value is Record<string, never> =>
  isRecord(value) && Object.keys(value).length === 0;

const isLiveSession = (value: unknown): value is ZiggyLiveSession =>
  isRecord(value) &&
  isSessionKey(value.key) &&
  ["telegram", "discord", "slack", "ui"].includes(String(value.kind)) &&
  typeof value.idle === "boolean";

const isStoredSession = (value: unknown): value is ZiggyStoredSession =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.path === "string" &&
  typeof value.createdAt === "string";
const isBoundedString = (value: unknown, maximum: number, minimum = 1): value is string =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum;

const isExtensionId = (value: unknown): value is ZiggyExtensionId =>
  typeof value === "string" && value.length <= 128 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

const isExtensionOperation = (value: unknown): value is ZiggyExtensionOperation =>
  typeof value === "string" && EXTENSION_OPERATIONS.has(value as ZiggyExtensionOperation);

const isExtensionFailureStage = (value: unknown): value is ZiggyExtensionFailureStage =>
  typeof value === "string" && EXTENSION_FAILURE_STAGES.has(value as ZiggyExtensionFailureStage);

const isExtensionChoice = (value: unknown): value is ZiggyExtensionChoice =>
  isRecord(value) &&
  isExtensionId(value.id) &&
  isBoundedString(value.description, 2_048, 0) &&
  typeof value.kind === "string" &&
  ["skill", "code", "skill+code", "remote"].includes(value.kind) &&
  typeof value.source === "string" &&
  ["bundled", "remote-approved", "profile"].includes(value.source);

const isExtensionListForProfileResult = (
  value: unknown,
): value is ZiggyExtensionListForProfileResult =>
  isRecord(value) &&
  Array.isArray(value.available) &&
  value.available.length <= 128 &&
  value.available.every(isExtensionChoice) &&
  Array.isArray(value.selected) &&
  value.selected.length <= 128 &&
  value.selected.every(isExtensionId);

const isExtensionMutationResult = (value: unknown): value is ZiggyExtensionMutationResult =>
  isRecord(value) &&
  isExtensionId(value.id) &&
  isBoundedString(value.profilePath, 4_096) &&
  typeof value.changed === "boolean" &&
  typeof value.selected === "boolean";

const isNonNegativeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;

const isExtensionValidationResult = (value: unknown): value is ZiggyExtensionValidationResult =>
  isRecord(value) &&
  Array.isArray(value.selected) &&
  value.selected.length <= 128 &&
  value.selected.every(isExtensionId) &&
  isRecord(value.preflight) &&
  isNonNegativeCount(value.preflight.extensionPathCount) &&
  isNonNegativeCount(value.preflight.skillPathCount) &&
  isNonNegativeCount(value.preflight.extensionFactoryCount);

const isExtensionFailure = (value: unknown): value is ZiggyExtensionFailure => {
  if (
    !isRecord(value) ||
    !isExtensionOperation(value.operation) ||
    !isExtensionFailureStage(value.stage) ||
    !isBoundedString(value.code, 64) ||
    !/^[A-Za-z0-9_.-]+$/u.test(value.code) ||
    !isBoundedString(value.message, 360) ||
    typeof value.selectionChanged !== "boolean"
  ) {
    return false;
  }
  return (
    (value.id === undefined || isExtensionId(value.id)) &&
    (value.source === undefined || isBoundedString(value.source, 240))
  );
};

const isMethodResult = (method: ZiggyMethod, value: unknown): boolean => {
  switch (method) {
    case "ping":
      return isRecord(value) && value.pong === true;
    case "session.list":
      return (
        isRecord(value) &&
        Array.isArray(value.live) &&
        value.live.every(isLiveSession) &&
        Array.isArray(value.stored) &&
        value.stored.every(isStoredSession)
      );
    case "session.open":
      return isRecord(value) && isSessionKey(value.session);
    case "session.watch":
    case "prompt.submit":
    case "session.steer":
    case "session.abort":
      return isEmptyRecord(value);
    case "extension.list-for-profile":
      return isExtensionListForProfileResult(value);
    case "extension.add":
    case "extension.remove":
      return isExtensionMutationResult(value);
    case "extension.validate":
      return isExtensionValidationResult(value);
  }
};

const decodeResponse = (value: unknown): SuccessFrame | FailureFrame | undefined => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    return undefined;
  }
  if (value.ok) return { id: value.id, ok: true, result: value.result };
  if (!isRecord(value.error)) return undefined;
  const { code, message } = value.error;
  if (!isGatewayErrorCode(code)) return undefined;
  if (typeof message !== "string") return undefined;
  const details = isExtensionFailure(value.error.details) ? value.error.details : undefined;
  return {
    id: value.id,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
};

const decodeEvent = (value: unknown): ZiggyGatewayEvent | undefined => {
  if (!isRecord(value) || !isSessionKey(value.session) || !isRecord(value.payload)) {
    return undefined;
  }
  const { event, session, payload } = value;
  if (event === "assistant-text") {
    return typeof payload.delta === "string" && typeof payload.snapshot === "string"
      ? { event, session, payload: { delta: payload.delta, snapshot: payload.snapshot } }
      : undefined;
  }
  if (event === "thinking") {
    return typeof payload.delta === "string"
      ? { event, session, payload: { delta: payload.delta } }
      : undefined;
  }
  if (event === "tool") {
    const phase = payload.phase;
    if (
      !["start", "update", "end"].includes(String(phase)) ||
      typeof payload.toolCallId !== "string" ||
      typeof payload.toolName !== "string" ||
      typeof payload.failed !== "boolean" ||
      (payload.detail !== undefined && typeof payload.detail !== "string")
    ) {
      return undefined;
    }
    const base = {
      phase: phase as "start" | "update" | "end",
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      failed: payload.failed,
    };
    return payload.detail === undefined
      ? { event, session, payload: base }
      : { event, session, payload: { ...base, detail: payload.detail } };
  }
  if (event === "voice") {
    return typeof payload.agentId === "string" && typeof payload.text === "string"
      ? { event, session, payload: { agentId: payload.agentId, text: payload.text } }
      : undefined;
  }
  if (event === "settled") {
    return isEmptyRecord(payload) ? { event, session, payload: {} } : undefined;
  }
  if (event === "error") {
    return typeof payload.message === "string"
      ? { event, session, payload: { message: payload.message } }
      : undefined;
  }
  return undefined;
};

const authenticatedUrl = (value: string, token: string): string => {
  const url = new URL(value);
  url.searchParams.set("token", token);
  return url.toString();
};

export const connectZiggy = (options: ConnectZiggyOptions): ZiggyGatewayClient => {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 250;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 5_000;
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const url = authenticatedUrl(options.url, options.token);
  const pending = new Map<string, PendingRequest>();
  const watched = new Set<ZiggySessionKey>();
  const handlers = new Map<ZiggyEventName, Set<(event: ZiggyGatewayEvent) => void>>();
  const anyHandlers = new Set<(event: ZiggyGatewayEvent) => void>();
  let socket: ZiggySocket | undefined;
  let connectionState: ZiggyConnectionState = "connecting";
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  let sequence = 0;
  let stopped = false;

  const emit = (event: ZiggyGatewayEvent): void => {
    for (const handler of handlers.get(event.event) ?? []) handler(event);
    for (const handler of anyHandlers) handler(event);
  };

  const setState = (state: ZiggyConnectionState): void => {
    if (connectionState === state) return;
    connectionState = state;
    emit({ event: "connection-state", payload: { state } });
  };

  const send = (id: string, entry: PendingRequest): void => {
    if (socket?.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify({ id, method: entry.method, params: entry.params }));
    entry.sentGeneration = generation;
  };

  const beginRequest = <Method extends ZiggyMethod>(
    method: Method,
    params: ZiggyRequestMap[Method],
  ): Promise<ZiggyResultMap[Method]> => {
    if (stopped) return Promise.reject(new Error("Ziggy gateway client is closed"));
    const id = `ziggy-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    return new Promise<ZiggyResultMap[Method]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Ziggy gateway request timed out: ${method}`));
      }, requestTimeoutMs);
      const entry: PendingRequest = {
        method,
        params,
        resolve: (value) => resolve(value as ZiggyResultMap[Method]),
        reject,
        timeout,
      };
      pending.set(id, entry);
      send(id, entry);
    });
  };

  const handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(event.data);
    } catch {
      return;
    }
    const response = decodeResponse(decoded);
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
      if (!isMethodResult(entry.method, response.result)) {
        entry.reject(new Error(`Invalid Ziggy gateway response for ${entry.method}`));
        return;
      }
      const requestParams: unknown = entry.params;
      if (
        entry.method === "session.watch" &&
        isRecord(requestParams) &&
        typeof requestParams.session === "string"
      ) {
        watched.add(requestParams.session as ZiggySessionKey);
      } else if (
        entry.method === "session.open" &&
        isRecord(response.result) &&
        typeof response.result.session === "string"
      ) {
        watched.add(response.result.session as ZiggySessionKey);
      }
      entry.resolve(response.result);
      return;
    }
    const gatewayEvent = decodeEvent(decoded);
    if (gatewayEvent !== undefined) emit(gatewayEvent);
  };

  const rejectSentRequests = (closedGeneration: number): void => {
    for (const [id, entry] of pending) {
      if (entry.sentGeneration !== closedGeneration) continue;
      pending.delete(id);
      clearTimeout(entry.timeout);
      entry.reject(new Error("Ziggy gateway disconnected before responding"));
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
      for (const session of watched) {
        void beginRequest("session.watch", { session }).catch(() => undefined);
      }
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

  return {
    get state() {
      return connectionState;
    },
    request: beginRequest,
    listExtensionsForProfile: () => beginRequest("extension.list-for-profile", {}),
    addExtension: (id) => beginRequest("extension.add", { id }),
    removeExtension: (id) => beginRequest("extension.remove", { id }),
    validateExtensions: () => beginRequest("extension.validate", {}),
    on: (eventName, handler) => {
      const eventHandlers = handlers.get(eventName) ?? new Set();
      eventHandlers.add(handler as (event: ZiggyGatewayEvent) => void);
      handlers.set(eventName, eventHandlers);
      return () => eventHandlers.delete(handler as (event: ZiggyGatewayEvent) => void);
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
};
