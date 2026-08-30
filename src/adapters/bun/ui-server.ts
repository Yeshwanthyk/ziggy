import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, FiberMap, Option, Queue, Schema, Scope } from "effect";
import {
  UiRequestEnvelope,
  UiRequestId,
  UI_PROTOCOL_MAX_FRAME_BYTES,
  type UiRequestEnvelope as UiRequestEnvelopeValue,
} from "../../domain/ui-gateway";
import { fileSystemCauseDetails } from "../fs/cause";

export const UI_SERVER_MAX_FRAME_BYTES = UI_PROTOCOL_MAX_FRAME_BYTES;
export const UI_SERVER_BACKPRESSURE_BYTES = 256 * 1024;
export const UI_SERVER_MAX_IN_FLIGHT = 16;
export const UI_SERVER_COMMAND_CAPACITY = 256;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const Token = Schema.String.check(
  Schema.makeFilter((value) => TOKEN_PATTERN.test(value), {
    expected: "a 32-byte lower-case hexadecimal token",
  }),
);

const Port = Schema.Int.check(
  Schema.makeFilter((value) => value > 0 && value <= 65_535, {
    expected: "a TCP port",
  }),
);
const decodeOutgoingId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: UiRequestId })),
  { onExcessProperty: "ignore" },
);

export const UiServerProjection = Schema.Struct({
  version: Schema.Literal(1),
  port: Port,
  token: Token,
});
export type UiServerProjection = typeof UiServerProjection.Type;

const decodeProjectionJson = Schema.decodeUnknownEffect(Schema.fromJsonString(UiServerProjection), {
  onExcessProperty: "error",
});
const decodeRequest = Schema.decodeUnknownOption(UiRequestEnvelope, {
  onExcessProperty: "error",
});
const decodeRecoverableRequestId = Schema.decodeUnknownOption(Schema.Struct({ id: UiRequestId }));
const decodeTextFrame = Schema.decodeUnknownOption(Schema.String);

export class UiServerError extends Schema.TaggedErrorClass<UiServerError>()("UiServerError", {
  operation: Schema.Literals(["start", "read", "write", "send", "close"]),
  path: Schema.optionalKey(Schema.String),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface UiServerConnection {
  readonly id: string;
  readonly isOpen: () => boolean;
  /** Synchronous for use by ChatHandle event callbacks; closes on failed delivery. */
  readonly send: (text: string) => void;
  readonly close: (code?: number, reason?: string) => Effect.Effect<void, UiServerError>;
}

export interface UiServerHandlers {
  /** Completes after the response for this request has been sent. */
  readonly onRequest: (
    connection: UiServerConnection,
    request: UiRequestEnvelopeValue,
  ) => Effect.Effect<void>;
  /** Removes only connection-owned subscriptions and other connection state. */
  readonly onClose: (connection: UiServerConnection) => Effect.Effect<void>;
}

export interface UiServer {
  readonly port: number;
  readonly projectionPath: string;
  readonly close: Effect.Effect<void>;
}

export interface UiServerOptions {
  readonly commandCapacity?: number;
  readonly maxInFlightPerSocket?: number;
}

interface SocketState {
  readonly id: string;
  readonly activeIds: Map<string, string>;
  readonly requestKeys: Set<string>;
  socket: Bun.ServerWebSocket<SocketState> | undefined;
  connection: UiServerConnection | undefined;
  inFlight: number;
  sequence: number;
  accepting: boolean;
  cleaned: boolean;
}

type Command =
  | {
      readonly _tag: "Request";
      readonly state: SocketState;
      readonly request: UiRequestEnvelopeValue;
      readonly key: string;
    }
  | { readonly _tag: "Close"; readonly state: SocketState };

const serverError = (
  operation: UiServerError["operation"],
  message: string,
  cause?: unknown,
  path?: string,
): UiServerError =>
  path !== undefined
    ? cause !== undefined
      ? new UiServerError({ operation, message, path, cause })
      : new UiServerError({ operation, message, path })
    : cause !== undefined
      ? new UiServerError({ operation, message, cause })
      : new UiServerError({ operation, message });

export const uiServerProjectionPath = (profilePath: string): string =>
  join(profilePath, ".runtime", "ui-server.json");

const readPhysicalFile = (path: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      catch: (cause) => cause,
    }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.readFile("utf8"),
        catch: (cause) => cause,
      }),
    (handle) => Effect.promise(() => handle.close()),
  );

export const readUiServerProjection = (
  profilePath: string,
): Effect.Effect<UiServerProjection, UiServerError> => {
  const path = uiServerProjectionPath(profilePath);
  const runtimePath = dirname(path);
  return Effect.gen(function* () {
    const runtime = yield* Effect.tryPromise({
      try: () => lstat(runtimePath),
      catch: (cause) =>
        serverError("read", "could not inspect UI runtime directory", cause, runtimePath),
    });
    if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
      return yield* serverError(
        "read",
        "UI runtime directory is not physical",
        undefined,
        runtimePath,
      );
    }
    const status = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => serverError("read", "could not inspect UI server projection", cause, path),
    });
    if (!status.isFile() || status.isSymbolicLink()) {
      return yield* serverError(
        "read",
        "UI server projection is not a physical file",
        undefined,
        path,
      );
    }
    const source = yield* readPhysicalFile(path).pipe(
      Effect.mapError((cause) =>
        serverError("read", "could not read UI server projection", cause, path),
      ),
    );
    return yield* decodeProjectionJson(source).pipe(
      Effect.mapError((cause) =>
        serverError("read", "UI server projection is invalid", cause, path),
      ),
    );
  });
};

const publishProjection = (
  profilePath: string,
  projection: UiServerProjection,
): Effect.Effect<void, UiServerError> => {
  const destination = uiServerProjectionPath(profilePath);
  const runtimePath = dirname(destination);
  const temporary = join(runtimePath, `.ui-server-${randomUUID()}.tmp`);
  return Effect.tryPromise({
    try: async () => {
      await mkdir(runtimePath, { recursive: true, mode: 0o700 });
      const runtime = await lstat(runtimePath);
      if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
        throw new Error("unsafe UI runtime path");
      }
      const candidate = await open(temporary, "wx", 0o600);
      try {
        await candidate.writeFile(`${JSON.stringify(projection)}\n`, "utf8");
        await candidate.sync();
      } finally {
        await candidate.close();
      }
      await rename(temporary, destination);
    },
    catch: (cause) =>
      serverError("write", "could not publish UI server projection", cause, destination),
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({ try: () => rm(temporary, { force: true }), catch: () => undefined }).pipe(
        Effect.catch(() => Effect.void),
      ),
    ),
  );
};

const removeMatchingProjection = (profilePath: string, token: string): Effect.Effect<void> => {
  const path = uiServerProjectionPath(profilePath);
  const runtimePath = dirname(path);
  return Effect.gen(function* () {
    const runtime = yield* Effect.tryPromise({
      try: () => lstat(runtimePath),
      catch: (cause) => cause,
    });
    if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
      return yield* Effect.fail(new Error("unsafe UI runtime directory during cleanup"));
    }
    const status = yield* Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause });
    if (!status.isFile() || status.isSymbolicLink()) {
      return yield* Effect.fail(new Error("unsafe UI server projection during cleanup"));
    }
    const source = yield* readPhysicalFile(path);
    const projection = yield* decodeProjectionJson(source);
    if (constantTokenEqual(projection.token, token)) {
      yield* Effect.tryPromise({ try: () => unlink(path), catch: (cause) => cause });
    }
  }).pipe(
    Effect.catch((cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? Effect.void
        : Effect.logWarning("UI server projection cleanup failed", { path }),
    ),
  );
};

const constantTokenEqual = (candidate: string, expected: string): boolean => {
  if (!TOKEN_PATTERN.test(candidate) || !TOKEN_PATTERN.test(expected)) return false;
  const candidateBytes = Buffer.from(candidate, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
};

const bearerToken = (authorization: string | null): string | undefined => {
  if (authorization === null) return undefined;
  const match = /^Bearer ([0-9a-f]{64})$/iu.exec(authorization);
  return match?.[1]?.toLowerCase();
};

const authenticated = (request: Request, token: string): boolean => {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  const header = bearerToken(authorization);
  const queryValues = url.searchParams.getAll("token");
  const query = queryValues.length === 1 ? queryValues[0] : undefined;
  if (authorization !== null && header === undefined) return false;
  if (queryValues.length > 0 && (query === undefined || !TOKEN_PATTERN.test(query))) return false;
  if (header === undefined && query === undefined) return false;
  if (header !== undefined && query !== undefined && !constantTokenEqual(header, query))
    return false;
  return constantTokenEqual(header ?? query ?? "", token);
};

const failureFrame = (id: string, code: "bad_params" | "internal", message: string): string =>
  JSON.stringify({ id, ok: false, error: { code, message } });

const trySend = (state: SocketState, text: string): boolean => {
  const socket = state.socket;
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
  try {
    if (Buffer.byteLength(text, "utf8") > UI_SERVER_MAX_FRAME_BYTES) {
      const frame = decodeOutgoingId(text);
      if (Option.isNone(frame)) return false;
      return (
        socket.send(failureFrame(frame.value.id, "internal", "response exceeded frame limit")) !== 0
      );
    }
    return socket.send(text) !== 0;
  } catch {
    return false;
  }
};

const closeSocket = (state: SocketState, code: number, reason: string): void => {
  state.accepting = false;
  try {
    state.socket?.close(code, reason);
  } catch {
    // The close callback or server shutdown still performs connection cleanup.
  }
};

const makeConnection = (state: SocketState): UiServerConnection => ({
  id: state.id,
  isOpen: () => state.socket?.readyState === WebSocket.OPEN,
  send: (text) => {
    if (!trySend(state, text)) closeSocket(state, 1013, "delivery failed");
  },
  close: (code = 1000, reason = "") =>
    Effect.try({
      try: () => closeSocket(state, code, reason),
      catch: (cause) => serverError("close", "could not close UI socket", cause),
    }),
});

export const openUiServer = (
  profilePath: string,
  handlers: UiServerHandlers,
  options: UiServerOptions = {},
): Effect.Effect<UiServer, UiServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const commandCapacity = options.commandCapacity ?? UI_SERVER_COMMAND_CAPACITY;
    const maxInFlight = options.maxInFlightPerSocket ?? UI_SERVER_MAX_IN_FLIGHT;
    if (!Number.isSafeInteger(commandCapacity) || commandCapacity < 1) {
      return yield* serverError("start", "UI server command capacity must be a positive integer");
    }
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      return yield* serverError("start", "UI server in-flight limit must be a positive integer");
    }

    const token = randomBytes(32).toString("hex");
    const commands = yield* Queue.dropping<Command>(commandCapacity);
    const requestFibers = yield* FiberMap.make<string, void, never>();
    const connections = new Map<string, SocketState>();
    let stopped = false;

    const releaseRequest = (state: SocketState, id: string, key: string): void => {
      if (state.activeIds.get(id) === key) state.activeIds.delete(id);
      state.requestKeys.delete(key);
      state.inFlight = Math.max(0, state.inFlight - 1);
    };

    const cleanupConnection = (state: SocketState): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (state.cleaned) return;
        state.cleaned = true;
        state.accepting = false;
        connections.delete(state.id);
        const keys = [...state.requestKeys];
        yield* Effect.forEach(keys, (key) => FiberMap.remove(requestFibers, key), {
          discard: true,
        });
        const connection = state.connection ?? makeConnection(state);
        yield* handlers
          .onClose(connection)
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("UI connection cleanup failed", { connectionId: state.id }),
            ),
          );
      });

    const handleCommand = (command: Command): Effect.Effect<void> => {
      if (command._tag === "Close") return cleanupConnection(command.state);
      const { state, request, key } = command;
      if (!state.accepting || state.cleaned) {
        return Effect.sync(() => releaseRequest(state, request.id, key));
      }
      const connection = state.connection ?? makeConnection(state);
      state.connection = connection;
      const requestWork = handlers.onRequest(connection, request).pipe(
        Effect.catchCause(() =>
          Effect.sync(() =>
            connection.send(failureFrame(request.id, "internal", "request handler failed")),
          ),
        ),
        Effect.ensuring(Effect.sync(() => releaseRequest(state, request.id, key))),
      );
      return FiberMap.run(requestFibers, key, requestWork, { onlyIfMissing: true });
    };

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(commands).pipe(Effect.flatMap(handleCommand))),
    );

    const enqueueClose = (state: SocketState): void => {
      if (state.cleaned || stopped || Queue.offerUnsafe(commands, { _tag: "Close", state })) return;
      setTimeout(() => enqueueClose(state), 0);
    };

    const rejectOverflow = (state: SocketState): void => {
      closeSocket(state, 1013, "capacity exceeded");
    };

    let server: Bun.Server<SocketState>;
    server = yield* Effect.try({
      try: () =>
        Bun.serve<SocketState>({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request, current) => {
            const url = new URL(request.url);
            if (url.pathname !== "/ws") return new Response("Not Found", { status: 404 });
            if (!authenticated(request, token)) {
              return new Response("Unauthorized", { status: 401 });
            }
            const state: SocketState = {
              id: randomUUID(),
              activeIds: new Map(),
              requestKeys: new Set(),
              socket: undefined,
              connection: undefined,
              inFlight: 0,
              sequence: 0,
              accepting: true,
              cleaned: false,
            };
            if (current.upgrade(request, { data: state })) return;
            return new Response("WebSocket upgrade required", { status: 400 });
          },
          websocket: {
            maxPayloadLength: UI_SERVER_MAX_FRAME_BYTES,
            backpressureLimit: UI_SERVER_BACKPRESSURE_BYTES,
            closeOnBackpressureLimit: true,
            open: (socket) => {
              const state = socket.data;
              state.socket = socket;
              state.connection = makeConnection(state);
              connections.set(state.id, state);
            },
            message: (socket, message) => {
              const state = socket.data;
              if (!state.accepting || state.cleaned) return;
              const textFrame = decodeTextFrame(message);
              if (Option.isNone(textFrame)) {
                closeSocket(state, 1003, "text frames required");
                return;
              }
              const text = textFrame.value;
              if (Buffer.byteLength(text, "utf8") > UI_SERVER_MAX_FRAME_BYTES) {
                closeSocket(state, 1009, "frame too large");
                return;
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                console.warn("[ui] dropped malformed JSON request");
                return;
              }
              const decoded = decodeRequest(parsed);
              if (Option.isNone(decoded)) {
                const recoverable = decodeRecoverableRequestId(parsed);
                if (Option.isSome(recoverable))
                  trySend(
                    state,
                    failureFrame(recoverable.value.id, "bad_params", "invalid request"),
                  );
                else console.warn("[ui] dropped invalid request without a recoverable id");
                return;
              }
              const request = decoded.value;
              if (state.activeIds.has(request.id)) {
                trySend(
                  state,
                  failureFrame(request.id, "bad_params", "duplicate active request id"),
                );
                return;
              }
              if (state.inFlight >= maxInFlight) {
                rejectOverflow(state);
                return;
              }
              const key = `${state.id}:${state.sequence++}`;
              state.activeIds.set(request.id, key);
              state.requestKeys.add(key);
              state.inFlight += 1;
              if (!Queue.offerUnsafe(commands, { _tag: "Request", state, request, key })) {
                releaseRequest(state, request.id, key);
                rejectOverflow(state);
              }
            },
            close: (socket) => {
              const state = socket.data;
              state.accepting = false;
              enqueueClose(state);
            },
          },
        }),
      catch: (cause) => serverError("start", "could not start UI server", cause),
    });

    const port = server.port;
    if (port === undefined) {
      yield* Effect.promise(() => server.stop(true));
      return yield* serverError("start", "UI server did not bind a TCP port");
    }

    const projectionPath = uiServerProjectionPath(profilePath);
    let shutdownStarted = false;
    let projectionPublished = false;
    const shutdown = Effect.suspend(() => {
      if (shutdownStarted) return Effect.void;
      shutdownStarted = true;
      stopped = true;
      const current = [...connections.values()];
      for (const state of current) closeSocket(state, 1001, "server stopping");
      return Effect.forEach(current, cleanupConnection, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.andThen(
          Effect.promise(() =>
            Promise.race([
              server.stop(true),
              new Promise<void>((resolve) => setTimeout(resolve, 250)),
            ]),
          ),
        ),
        Effect.catchCause(() => Effect.void),
        Effect.andThen(
          projectionPublished ? removeMatchingProjection(profilePath, token) : Effect.void,
        ),
        Effect.andThen(Queue.shutdown(commands)),
      );
    });

    yield* Effect.addFinalizer(() => shutdown);
    yield* publishProjection(profilePath, { version: 1, port, token }).pipe(
      Effect.tapError(() => shutdown),
    );
    projectionPublished = true;

    return { port, projectionPath, close: shutdown };
  });
