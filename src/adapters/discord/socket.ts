import { Cause, Duration, Effect, Option, Queue, Result, Schema } from "effect";
import type * as Scope from "effect/Scope";
import { type DiscordApiError, getGatewayBot } from "./api";
import { makeRecentIds } from "../bun/recent-ids";
import type { DiscordIngressAttachmentReference } from "../../domain/discord-ingress";

export interface DiscordInboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | undefined;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly attachments: ReadonlyArray<DiscordIngressAttachmentReference>;
  readonly omittedAttachmentCount: number;
}

export interface DiscordInboundInteraction {
  readonly id: string;
  readonly token: string;
  readonly guildId: string | undefined;
  readonly channelId: string | undefined;
  readonly channelType: number | undefined;
  readonly parentChannelId: string | undefined;
  readonly authorId: string;
  readonly commandName: string;
}

const SocketCloseCode = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export class DiscordSocketError extends Schema.TaggedErrorClass<DiscordSocketError>()(
  "DiscordSocketError",
  {
    operation: Schema.Literals(["connect", "receive", "close"]),
    reason: Schema.Literals([
      "authentication",
      "connection",
      "malformed-frame",
      "fatal-close",
      "queue-overflow",
      "closed",
      "close-timeout",
    ]),
    retriable: Schema.Boolean,
    closeCode: Schema.optional(SocketCloseCode),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface DiscordSocket {
  readonly next: Effect.Effect<DiscordInboundMessage, DiscordSocketError>;
  readonly nextInteraction?: Effect.Effect<DiscordInboundInteraction, DiscordSocketError>;
  readonly nextConnectionState: Effect.Effect<DiscordSocketConnectionState>;
  readonly close: Effect.Effect<void, DiscordSocketError>;
}

export type DiscordSocketConnectionState =
  | { readonly state: "connected" }
  | {
      readonly state: "reconnecting";
      readonly reason: "connection" | "queue-overflow" | "socket";
    }
  | {
      readonly state: "failed";
      readonly reason: "authentication" | "connection" | "queue-overflow" | "socket";
    }
  | { readonly state: "stopped" };

export interface DiscordSocketConnection {
  readonly readyState: () => number;
  readonly send: (data: string) => void;
  readonly close: (code?: number) => void;
  readonly onOpen: (listener: () => void) => () => void;
  readonly onMessage: (listener: (data: unknown) => void) => () => void;
  readonly onError: (listener: () => void) => () => void;
  readonly onClose: (listener: (code: number) => void) => () => void;
}

export interface DiscordSocketDependencies {
  readonly getGatewayBot: (
    token: string,
  ) => Effect.Effect<{ readonly url: string }, DiscordApiError>;
  readonly connect: (url: string) => DiscordSocketConnection;
  readonly schedule: (delayMs: number, task: () => void) => () => void;
  readonly random: () => number;
  readonly inboundCapacity: number;
  readonly commandCapacity: number;
  readonly closeTimeout: Duration.Input;
  readonly reportCleanupFailure: (failure: DiscordSocketError) => void;
}

type ConnectMode = "auto" | "fresh" | "resume";

type Command =
  | { readonly _tag: "Connect"; readonly mode: ConnectMode }
  | { readonly _tag: "Frame"; readonly connection: DiscordSocketConnection; readonly text: string }
  | { readonly _tag: "SocketError"; readonly connection: DiscordSocketConnection }
  | {
      readonly _tag: "SocketClosed";
      readonly connection: DiscordSocketConnection;
      readonly code: number;
    };

interface AttachedSocket {
  readonly connection: DiscordSocketConnection;
  readonly removeListeners: () => void;
}

const Integer = Schema.Finite.check(Schema.isInt());
const GatewayFrameSchema = Schema.Struct({
  op: Integer,
  d: Schema.optional(Schema.Unknown),
  s: Schema.optional(Schema.NullOr(Integer)),
  t: Schema.optional(Schema.NullOr(Schema.String)),
});
const ReadySchema = Schema.Struct({
  session_id: Schema.String,
  resume_gateway_url: Schema.String,
  user: Schema.Struct({ id: Schema.String }),
});
const HelloSchema = Schema.Struct({
  heartbeat_interval: Schema.Finite.check(Schema.isGreaterThan(0)),
});
const MessageSchema = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  guild_id: Schema.optional(Schema.String),
  author: Schema.Struct({
    id: Schema.String,
    bot: Schema.optional(Schema.Boolean),
  }),
  content: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});
const MessageAttachmentSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  filename: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  content_type: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
});
const InteractionSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  type: Integer,
  guild_id: Schema.optional(Schema.String),
  channel_id: Schema.optional(Schema.String),
  channel: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      type: Integer,
      parent_id: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  member: Schema.optional(Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })),
  user: Schema.optional(Schema.Struct({ id: Schema.String })),
  data: Schema.optional(
    Schema.Struct({
      type: Integer,
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    }),
  ),
});

const decodeGatewayFrameJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GatewayFrameSchema),
);
const decodeReadyPayload = Schema.decodeUnknownEffect(ReadySchema);
const decodeHelloPayload = Schema.decodeUnknownEffect(HelloSchema);
const decodeMessagePayload = Schema.decodeUnknownEffect(MessageSchema);
const decodeMessageAttachment = Schema.decodeUnknownEffect(MessageAttachmentSchema);
const decodeInteractionPayload = Schema.decodeUnknownEffect(InteractionSchema);

const normalizeGatewayFrame = (decoded: typeof GatewayFrameSchema.Type) => ({
  op: decoded.op,
  d: decoded.d,
  s: decoded.s ?? null,
  t: decoded.t ?? null,
});
type GatewayFrame = ReturnType<typeof normalizeGatewayFrame>;

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const GATEWAY_QUERY = "v=10&encoding=json";
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_MESSAGE_IDS = 1_000;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

const error = (
  operation: DiscordSocketError["operation"],
  reason: DiscordSocketError["reason"],
  retriable: boolean,
  cause: unknown,
  closeCode?: number,
): DiscordSocketError =>
  new DiscordSocketError({
    operation,
    reason,
    retriable,
    message:
      reason === "authentication"
        ? "Discord gateway authentication failed"
        : `Discord gateway ${reason.replaceAll("-", " ")}`,
    cause,
    ...(closeCode === undefined ? {} : { closeCode }),
  });

const gatewaySocketUrl = (baseUrl: string): Effect.Effect<string, DiscordSocketError> =>
  Effect.try({
    try: () => {
      const url = new URL(baseUrl);
      url.search = GATEWAY_QUERY;
      return url.toString();
    },
    catch: (cause) => error("connect", "connection", true, cause),
  });

const liveConnection = (url: string): DiscordSocketConnection => {
  const socket = new WebSocket(url);
  return {
    readyState: () => socket.readyState,
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    onOpen: (listener) => {
      socket.addEventListener("open", listener);
      return () => socket.removeEventListener("open", listener);
    },
    onMessage: (listener) => {
      const handle = (event: MessageEvent) => listener(event.data);
      socket.addEventListener("message", handle);
      return () => socket.removeEventListener("message", handle);
    },
    onError: (listener) => {
      socket.addEventListener("error", listener);
      return () => socket.removeEventListener("error", listener);
    },
    onClose: (listener) => {
      const handle = (event: CloseEvent) => listener(event.code);
      socket.addEventListener("close", handle);
      return () => socket.removeEventListener("close", handle);
    },
  };
};

const liveDependencies: DiscordSocketDependencies = {
  getGatewayBot,
  connect: liveConnection,
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
  random: Math.random,
  inboundCapacity: 256,
  commandCapacity: 256,
  closeTimeout: Duration.seconds(2),
  reportCleanupFailure: (failure) =>
    console.error(`[discord] socket cleanup failed: ${failure.message}`),
};

export const openDiscordSocket = (
  token: string,
  intents: number,
  dependencies: DiscordSocketDependencies = liveDependencies,
): Effect.Effect<DiscordSocket, DiscordSocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const inbound = yield* Queue.dropping<DiscordInboundMessage, DiscordSocketError>(
      dependencies.inboundCapacity,
    );
    const interactions = yield* Queue.dropping<DiscordInboundInteraction, DiscordSocketError>(
      dependencies.inboundCapacity,
    );
    const connectionStates = yield* Queue.sliding<DiscordSocketConnectionState>(16);
    const commands = yield* Queue.dropping<Command>(dependencies.commandCapacity);
    const messageIds = makeRecentIds(MAX_MESSAGE_IDS);
    const interactionIds = makeRecentIds(MAX_MESSAGE_IDS);
    let current: AttachedSocket | undefined;
    let cancelHeartbeat: (() => void) | undefined;
    let cancelReconnect: (() => void) | undefined;
    let reconnectDelayMs = 1_000;
    let heartbeatIntervalMs = 0;
    let sequence: number | null = null;
    let sessionId: string | undefined;
    let resumeGatewayUrl: string | undefined;
    let ownUserId: string | undefined;
    let heartbeatAcknowledged = true;
    let stopped = false;
    let failed = false;

    const reportState = (state: DiscordSocketConnectionState) => {
      Queue.offerUnsafe(connectionStates, state);
    };

    const clearHeartbeat = () => {
      cancelHeartbeat?.();
      cancelHeartbeat = undefined;
    };

    const clearReconnect = () => {
      cancelReconnect?.();
      cancelReconnect = undefined;
    };

    const detach = (attached: AttachedSocket) => {
      attached.removeListeners();
      if (current === attached) {
        current = undefined;
      }
    };

    const closeWithoutWaiting = (attached: AttachedSocket) => {
      detach(attached);
      if (attached.connection.readyState() < SOCKET_CLOSING) {
        try {
          attached.connection.close();
        } catch (cause) {
          dependencies.reportCleanupFailure(error("close", "connection", false, cause));
        }
      }
    };

    const terminalFailure = (
      failure: DiscordSocketError,
    ): Effect.Effect<void, DiscordSocketError> =>
      Effect.gen(function* () {
        if (stopped || failed) {
          return;
        }
        failed = true;
        reportState({
          state: "failed",
          reason:
            failure.reason === "authentication"
              ? "authentication"
              : failure.reason === "queue-overflow"
                ? "queue-overflow"
                : failure.reason === "connection"
                  ? "connection"
                  : "socket",
        });
        clearHeartbeat();
        clearReconnect();
        const attached = current;
        if (attached !== undefined) {
          closeWithoutWaiting(attached);
        }
        yield* Queue.clear(inbound);
        yield* Queue.fail(inbound, failure);
        yield* Queue.clear(interactions);
        yield* Queue.fail(interactions, failure);
      });

    const offerCommand = (command: Command) => {
      if (stopped || failed || !Queue.offerUnsafe(commands, command)) {
        if (!stopped && !failed) {
          const failure = error(
            "receive",
            "queue-overflow",
            false,
            new Error("Discord command queue capacity exceeded"),
          );
          failed = true;
          reportState({ state: "failed", reason: "queue-overflow" });
          Queue.failCauseUnsafe(inbound, Cause.fail(failure));
          const attached = current;
          if (attached !== undefined) {
            closeWithoutWaiting(attached);
          }
        }
      }
    };

    const scheduleReconnect = (delayMs: number, mode: ConnectMode = "auto") => {
      if (stopped || failed) {
        return;
      }
      clearReconnect();
      reportState({ state: "reconnecting", reason: "connection" });
      cancelReconnect = dependencies.schedule(delayMs, () => {
        cancelReconnect = undefined;
        offerCommand({ _tag: "Connect", mode });
      });
    };

    const abandon = (connection: DiscordSocketConnection): boolean => {
      const attached = current;
      if (attached === undefined || attached.connection !== connection) {
        return false;
      }
      clearHeartbeat();
      closeWithoutWaiting(attached);
      return true;
    };

    const reconnect = (connection: DiscordSocketConnection, mode: ConnectMode = "auto") => {
      if (!abandon(connection)) {
        return;
      }
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay, mode);
    };

    const send = (connection: DiscordSocketConnection, payload: object): boolean => {
      if (current?.connection !== connection || connection.readyState() !== SOCKET_OPEN) {
        return false;
      }
      try {
        connection.send(JSON.stringify(payload));
        return true;
      } catch {
        reconnect(connection);
        return false;
      }
    };

    const sendHeartbeat = (connection: DiscordSocketConnection) => {
      if (current?.connection !== connection) {
        return;
      }
      heartbeatAcknowledged = false;
      send(connection, { op: 1, d: sequence });
    };

    const scheduleHeartbeat = (connection: DiscordSocketConnection, delayMs: number) => {
      clearHeartbeat();
      cancelHeartbeat = dependencies.schedule(delayMs, () => {
        cancelHeartbeat = undefined;
        if (current?.connection !== connection) {
          return;
        }
        if (!heartbeatAcknowledged) {
          reconnect(connection, "resume");
          return;
        }
        sendHeartbeat(connection);
        scheduleHeartbeat(connection, heartbeatIntervalMs);
      });
    };

    const attachSocket = (url: string): Effect.Effect<void, DiscordSocketError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const socketUrl = yield* gatewaySocketUrl(url);
          const connection = yield* Effect.try({
            try: () => dependencies.connect(socketUrl),
            catch: (cause) => error("connect", "connection", true, cause),
          });
          const removers: Array<() => void> = [];
          const attached = yield* Effect.try({
            try: () => {
              removers.push(
                connection.onMessage((data) => {
                  if (typeof data === "string") {
                    offerCommand({ _tag: "Frame", connection, text: data });
                  }
                }),
              );
              removers.push(
                connection.onError(() => offerCommand({ _tag: "SocketError", connection })),
              );
              removers.push(
                connection.onClose((code) =>
                  offerCommand({ _tag: "SocketClosed", connection, code }),
                ),
              );
              return {
                connection,
                removeListeners: () => {
                  for (const remove of removers) remove();
                },
              } satisfies AttachedSocket;
            },
            catch: (cause) => error("connect", "connection", true, cause),
          }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                for (const remove of removers) {
                  try {
                    remove();
                  } catch (cause) {
                    dependencies.reportCleanupFailure(error("close", "connection", false, cause));
                  }
                }
                if (connection.readyState() < SOCKET_CLOSING) {
                  try {
                    connection.close();
                  } catch (cause) {
                    dependencies.reportCleanupFailure(error("close", "connection", false, cause));
                  }
                }
              }),
            ),
          );
          current = attached;
        }),
      );

    const handleDispatch = (
      connection: DiscordSocketConnection,
      frame: GatewayFrame,
    ): Effect.Effect<void, DiscordSocketError> =>
      Effect.gen(function* () {
        if (frame.s !== null) {
          sequence = frame.s;
        }
        if (frame.t === "READY") {
          const decodedReady = yield* decodeReadyPayload(frame.d).pipe(Effect.result);
          if (Result.isFailure(decodedReady)) {
            yield* terminalFailure(
              error("receive", "malformed-frame", false, decodedReady.failure),
            );
            return;
          }
          const ready = {
            sessionId: decodedReady.success.session_id,
            resumeGatewayUrl: decodedReady.success.resume_gateway_url,
            userId: decodedReady.success.user.id,
          };
          sessionId = ready.sessionId;
          resumeGatewayUrl = ready.resumeGatewayUrl;
          ownUserId = ready.userId;
          reconnectDelayMs = 1_000;
          reportState({ state: "connected" });
          return;
        }
        if (frame.t === "RESUMED") {
          reconnectDelayMs = 1_000;
          reportState({ state: "connected" });
          return;
        }
        if (frame.t === "MESSAGE_CREATE") {
          const decoded = yield* decodeMessagePayload(frame.d).pipe(Effect.option);
          if (Option.isNone(decoded)) {
            return;
          }
          const payload = decoded.value;
          const rawAttachments = payload.attachments ?? [];
          const decodedAttachments = yield* Effect.forEach(
            rawAttachments.slice(0, 4),
            (attachment) => decodeMessageAttachment(attachment).pipe(Effect.option),
          );
          const attachments = decodedAttachments.flatMap((decodedAttachment) =>
            Option.isSome(decodedAttachment)
              ? [
                  {
                    id: decodedAttachment.value.id,
                    ...(decodedAttachment.value.filename === undefined
                      ? {}
                      : { filename: decodedAttachment.value.filename }),
                    ...(decodedAttachment.value.content_type === undefined
                      ? {}
                      : { mimeType: decodedAttachment.value.content_type }),
                    ...(decodedAttachment.value.size === undefined
                      ? {}
                      : { size: decodedAttachment.value.size }),
                    ...(decodedAttachment.value.url === undefined
                      ? {}
                      : { url: decodedAttachment.value.url }),
                  },
                ]
              : [],
          );
          const message: DiscordInboundMessage = {
            id: payload.id,
            channelId: payload.channel_id,
            guildId: payload.guild_id,
            authorId: payload.author.id,
            authorIsBot: payload.author.bot ?? false,
            content: payload.content ?? "",
            attachments,
            omittedAttachmentCount: Math.max(0, rawAttachments.length - attachments.length),
          };
          if (
            message.authorId !== ownUserId &&
            messageIds.remember(message.id) &&
            !(yield* Queue.offer(inbound, message))
          ) {
            yield* terminalFailure(
              error(
                "receive",
                "queue-overflow",
                false,
                new Error("Discord inbound queue capacity exceeded"),
              ),
            );
          }
          return;
        }
        if (frame.t === "INTERACTION_CREATE") {
          const decoded = yield* decodeInteractionPayload(frame.d).pipe(Effect.option);
          if (Option.isNone(decoded)) return;
          const payload = decoded.value;
          const authorId = payload.member?.user.id ?? payload.user?.id;
          if (
            payload.type !== 2 ||
            payload.data?.type !== 1 ||
            authorId === undefined ||
            !interactionIds.remember(payload.id)
          ) {
            return;
          }
          const interaction: DiscordInboundInteraction = {
            id: payload.id,
            token: payload.token,
            guildId: payload.guild_id,
            channelId: payload.channel_id ?? payload.channel?.id,
            channelType: payload.channel?.type,
            parentChannelId: payload.channel?.parent_id ?? undefined,
            authorId,
            commandName: payload.data.name,
          };
          if (!(yield* Queue.offer(interactions, interaction))) {
            yield* terminalFailure(
              error(
                "receive",
                "queue-overflow",
                false,
                new Error("Discord interaction queue capacity exceeded"),
              ),
            );
          }
        }
        void connection;
      });

    const handleFrame = (
      connection: DiscordSocketConnection,
      text: string,
    ): Effect.Effect<void, DiscordSocketError> =>
      Effect.gen(function* () {
        const decoded = yield* decodeGatewayFrameJson(text).pipe(Effect.result);
        if (Result.isFailure(decoded)) {
          yield* terminalFailure(error("receive", "malformed-frame", false, decoded.failure));
          return;
        }
        if (failed || current?.connection !== connection) {
          return;
        }
        const frame = normalizeGatewayFrame(decoded.success);
        switch (frame.op) {
          case 0:
            yield* handleDispatch(connection, frame);
            return;
          case 1:
            sendHeartbeat(connection);
            return;
          case 7:
            reconnect(connection, "resume");
            return;
          case 9:
            if (frame.d === false) {
              sessionId = undefined;
              resumeGatewayUrl = undefined;
              sequence = null;
              ownUserId = undefined;
              if (abandon(connection)) {
                scheduleReconnect(2_000, "fresh");
              }
            } else {
              reconnect(connection, "resume");
            }
            return;
          case 10: {
            const decodedHello = yield* decodeHelloPayload(frame.d).pipe(Effect.result);
            if (Result.isFailure(decodedHello)) {
              yield* terminalFailure(
                error("receive", "malformed-frame", false, decodedHello.failure),
              );
              return;
            }
            heartbeatAcknowledged = true;
            heartbeatIntervalMs = decodedHello.success.heartbeat_interval;
            scheduleHeartbeat(connection, heartbeatIntervalMs * dependencies.random());
            if (sessionId !== undefined && sequence !== null) {
              send(connection, { op: 6, d: { token, session_id: sessionId, seq: sequence } });
            } else {
              send(connection, {
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
      });

    const connect = (mode: ConnectMode): Effect.Effect<void, DiscordSocketError> =>
      Effect.gen(function* () {
        if (stopped || failed || current !== undefined) {
          return;
        }
        const resumeUrl = resumeGatewayUrl;
        const canResume =
          mode !== "fresh" &&
          sessionId !== undefined &&
          sequence !== null &&
          resumeUrl !== undefined;
        if (canResume) {
          yield* attachSocket(resumeUrl).pipe(
            Effect.catch(() => Effect.sync(() => scheduleReconnect(reconnectDelayMs, mode))),
          );
          return;
        }

        const bootstrap = yield* dependencies.getGatewayBot(token).pipe(Effect.result);
        if (Result.isFailure(bootstrap)) {
          if (bootstrap.failure.reason === "authentication") {
            yield* terminalFailure(error("connect", "authentication", false, bootstrap.failure));
          } else {
            const delay = reconnectDelayMs;
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
            scheduleReconnect(delay, mode);
          }
          return;
        }
        yield* attachSocket(bootstrap.success.url).pipe(
          Effect.catch(() => {
            const delay = reconnectDelayMs;
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
            return Effect.sync(() => scheduleReconnect(delay, mode));
          }),
        );
      });

    const processCommand = (command: Command): Effect.Effect<void, DiscordSocketError> => {
      switch (command._tag) {
        case "Connect":
          return connect(command.mode);
        case "Frame":
          return handleFrame(command.connection, command.text);
        case "SocketError":
          return Effect.sync(() => reconnect(command.connection));
        case "SocketClosed":
          return Effect.gen(function* () {
            if (current?.connection !== command.connection) {
              return;
            }
            const attached = current;
            detach(attached);
            clearHeartbeat();
            if (stopped) {
              return;
            }
            if (FATAL_CLOSE_CODES.has(command.code)) {
              yield* terminalFailure(
                error(
                  "receive",
                  "fatal-close",
                  false,
                  new Error(`Discord gateway close code ${command.code}`),
                  command.code,
                ),
              );
              return;
            }
            const delay = reconnectDelayMs;
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
            scheduleReconnect(delay);
          });
      }
    };

    const supervisor = Queue.take(commands).pipe(Effect.flatMap(processCommand), Effect.forever);
    yield* supervisor.pipe(Effect.forkScoped);
    yield* Queue.offer(commands, { _tag: "Connect", mode: "fresh" });

    const close: Effect.Effect<void, DiscordSocketError> = Effect.suspend(() => {
      if (stopped) {
        return Effect.void;
      }
      stopped = true;
      reportState({ state: "stopped" });
      clearHeartbeat();
      clearReconnect();
      const attached = current;
      if (attached === undefined || attached.connection.readyState() === SOCKET_CLOSED) {
        if (attached !== undefined) {
          detach(attached);
        }
        return Queue.clear(inbound).pipe(
          Effect.orElseSucceed(() => []),
          Effect.andThen(Queue.fail(inbound, error("close", "closed", false, new Error("closed")))),
          Effect.andThen(Queue.clear(interactions)),
          Effect.andThen(
            Queue.fail(interactions, error("close", "closed", false, new Error("closed"))),
          ),
          Effect.andThen(Queue.shutdown(commands)),
          Effect.asVoid,
        );
      }

      const waitForClose = Effect.callback<void, DiscordSocketError>((resume) => {
        const finish = () => resume(Effect.void);
        const removeClose = attached.connection.onClose(finish);
        const removeOpen = attached.connection.onOpen(() => {
          try {
            attached.connection.close(1000);
          } catch (cause) {
            resume(Effect.fail(error("close", "connection", false, cause)));
          }
        });
        try {
          attached.connection.close(1000);
        } catch (cause) {
          if (attached.connection.readyState() === SOCKET_CLOSED) {
            finish();
          } else {
            resume(Effect.fail(error("close", "connection", false, cause)));
          }
        }
        return Effect.sync(() => {
          removeClose();
          removeOpen();
        });
      }).pipe(
        Effect.timeoutOption(dependencies.closeTimeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                error("close", "close-timeout", false, new Error("close event timed out")),
              ),
            onSome: () => Effect.void,
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            detach(attached);
          }),
        ),
      );

      return Queue.clear(inbound).pipe(
        Effect.orElseSucceed(() => []),
        Effect.andThen(Queue.fail(inbound, error("close", "closed", false, new Error("closed")))),
        Effect.andThen(Queue.clear(interactions)),
        Effect.andThen(
          Queue.fail(interactions, error("close", "closed", false, new Error("closed"))),
        ),
        Effect.andThen(Queue.shutdown(commands)),
        Effect.andThen(waitForClose),
      );
    });

    yield* Effect.addFinalizer(() =>
      close.pipe(
        Effect.catch((failure) => Effect.logWarning("Discord socket cleanup failed", { failure })),
      ),
    );

    return {
      next: Queue.take(inbound),
      nextInteraction: Queue.take(interactions),
      nextConnectionState: Queue.take(connectionStates),
      close,
    };
  });
