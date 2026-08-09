import { Cause, Duration, Effect, Option, Queue, Result, Schema } from "effect";
import type * as Scope from "effect/Scope";
import { type SlackApiError, connectionsOpen } from "./api";
import { makeRecentIds } from "../bun/recent-ids";

export interface SlackInboundMessage {
  readonly channel: string;
  readonly channelType: "im" | "channel" | "group" | "mpim";
  readonly userId: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs: string | undefined;
}

export class SlackSocketError extends Schema.TaggedErrorClass<SlackSocketError>()(
  "SlackSocketError",
  {
    operation: Schema.Literals(["connect", "receive", "close"]),
    reason: Schema.Literals([
      "authentication",
      "connection",
      "queue-overflow",
      "closed",
      "close-timeout",
    ]),
    retriable: Schema.Boolean,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface SlackSocket {
  readonly next: Effect.Effect<SlackInboundMessage, SlackSocketError>;
  readonly nextConnectionState: Effect.Effect<SlackSocketConnectionState>;
  readonly close: Effect.Effect<void, SlackSocketError>;
}

export type SlackSocketInboundDecision = "deliver" | "acknowledge";
export type SlackSocketInboundAdmit = (
  message: SlackInboundMessage,
  eventId: string | undefined,
) => Effect.Effect<SlackSocketInboundDecision, SlackSocketError>;

export type SlackSocketConnectionState =
  | { readonly state: "connected" }
  | {
      readonly state: "reconnecting";
      readonly failure: "connection" | "queue-overflow" | "socket";
    };

export interface SlackSocketConnection {
  readonly readyState: () => number;
  readonly send: (data: string) => void;
  readonly close: (code?: number) => void;
  readonly onOpen: (listener: () => void) => () => void;
  readonly onMessage: (listener: (data: unknown) => void) => () => void;
  readonly onError: (listener: () => void) => () => void;
  readonly onClose: (listener: () => void) => () => void;
}

export interface SlackSocketDependencies {
  readonly connectionsOpen: (
    token: string,
  ) => Effect.Effect<{ readonly url: string }, SlackApiError>;
  readonly connect: (url: string) => SlackSocketConnection;
  readonly schedule: (delayMs: number, task: () => void) => () => void;
  readonly inboundCapacity: number;
  readonly commandCapacity: number;
  readonly closeTimeout: Duration.Input;
  readonly reportConnected: () => void;
  readonly reportConnectionFailure: (failure: SlackSocketError) => void;
  readonly reportCleanupFailure: (failure: SlackSocketError) => void;
}

type Command =
  | { readonly _tag: "Connect" }
  | { readonly _tag: "Frame"; readonly connection: SlackSocketConnection; readonly text: string }
  | { readonly _tag: "SocketError"; readonly connection: SlackSocketConnection }
  | { readonly _tag: "SocketClosed"; readonly connection: SlackSocketConnection };

interface AttachedSocket {
  readonly connection: SlackSocketConnection;
  readonly removeListeners: () => void;
}

const SocketEnvelopeSchema = Schema.Struct({
  type: Schema.String,
  envelope_id: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
const EventsPayloadSchema = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Unknown),
});
const MessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  subtype: Schema.optional(Schema.Unknown),
  bot_id: Schema.optional(Schema.Unknown),
  channel: Schema.String,
  channel_type: Schema.Literals(["im", "channel", "group", "mpim"]),
  user: Schema.String.check(Schema.isMinLength(1)),
  text: Schema.String,
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
});

const decodeEnvelopeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SocketEnvelopeSchema));
const decodeEventsPayload = Schema.decodeUnknownEffect(EventsPayloadSchema);
const decodeMessagePayload = Schema.decodeUnknownEffect(MessageSchema);

const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_EVENT_IDS = 1_000;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

const error = (
  operation: SlackSocketError["operation"],
  reason: SlackSocketError["reason"],
  retriable: boolean,
  cause: unknown,
): SlackSocketError =>
  new SlackSocketError({
    operation,
    reason,
    retriable,
    message:
      reason === "authentication"
        ? "Slack socket authentication failed"
        : `Slack socket ${reason.replaceAll("-", " ")}`,
    cause,
  });

const liveConnection = (url: string): SlackSocketConnection => {
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
      socket.addEventListener("close", listener);
      return () => socket.removeEventListener("close", listener);
    },
  };
};

const liveDependencies: SlackSocketDependencies = {
  connectionsOpen,
  connect: liveConnection,
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
  inboundCapacity: 256,
  commandCapacity: 256,
  closeTimeout: Duration.seconds(2),
  reportConnected: () => console.log("[slack] socket connected"),
  reportConnectionFailure: (failure) =>
    console.error(`[slack] socket connection degraded: ${failure.message}; reconnecting`),
  reportCleanupFailure: (failure) =>
    console.error(`[slack] socket cleanup failed: ${failure.message}`),
};

export const openSlackSocket = (
  appToken: string,
  dependencies: SlackSocketDependencies = liveDependencies,
  admitInbound: SlackSocketInboundAdmit = () => Effect.succeed("deliver"),
): Effect.Effect<SlackSocket, SlackSocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const inbound = yield* Queue.dropping<SlackInboundMessage, SlackSocketError>(
      dependencies.inboundCapacity,
    );
    const connectionStates = yield* Queue.sliding<SlackSocketConnectionState>(16);
    const commands = yield* Queue.dropping<Command>(dependencies.commandCapacity);
    const eventIds = makeRecentIds(MAX_EVENT_IDS);
    let current: AttachedSocket | undefined;
    let cancelReconnect: (() => void) | undefined;
    let reconnectDelayMs = 1_000;
    let stopped = false;
    let failed = false;

    const reportState = (state: SlackSocketConnectionState) => {
      Queue.offerUnsafe(connectionStates, state);
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

    const terminalFailure = (failure: SlackSocketError): Effect.Effect<void, SlackSocketError> =>
      Effect.gen(function* () {
        if (stopped || failed) {
          return;
        }
        failed = true;
        reportState({
          state: "reconnecting",
          failure: failure.reason === "queue-overflow" ? "queue-overflow" : "socket",
        });
        clearReconnect();
        const attached = current;
        if (attached !== undefined) {
          closeWithoutWaiting(attached);
        }
        yield* Queue.clear(inbound);
        yield* Queue.fail(inbound, failure);
      });

    const offerCommand = (command: Command) => {
      if (stopped || failed || !Queue.offerUnsafe(commands, command)) {
        if (!stopped && !failed) {
          const failure = error(
            "receive",
            "queue-overflow",
            false,
            new Error("Slack command queue capacity exceeded"),
          );
          failed = true;
          reportState({ state: "reconnecting", failure: "queue-overflow" });
          Queue.failCauseUnsafe(inbound, Cause.fail(failure));
          const attached = current;
          if (attached !== undefined) {
            closeWithoutWaiting(attached);
          }
        }
      }
    };

    const scheduleReconnect = (delayMs: number) => {
      if (stopped || failed) {
        return;
      }
      clearReconnect();
      cancelReconnect = dependencies.schedule(delayMs, () => {
        cancelReconnect = undefined;
        offerCommand({ _tag: "Connect" });
      });
    };

    const abandon = (connection: SlackSocketConnection): boolean => {
      const attached = current;
      if (attached === undefined || attached.connection !== connection) {
        return false;
      }
      closeWithoutWaiting(attached);
      return true;
    };

    const reconnect = (connection: SlackSocketConnection) => {
      if (!abandon(connection)) {
        return;
      }
      reportState({ state: "reconnecting", failure: "connection" });
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect(delay);
    };

    const acknowledge = (connection: SlackSocketConnection, envelopeId: string | undefined) => {
      if (
        envelopeId === undefined ||
        current?.connection !== connection ||
        connection.readyState() !== SOCKET_OPEN
      ) {
        return;
      }
      try {
        connection.send(JSON.stringify({ envelope_id: envelopeId }));
      } catch {
        reconnect(connection);
      }
    };

    const attachSocket = (url: string): Effect.Effect<void, SlackSocketError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const connection = yield* Effect.try({
            try: () => dependencies.connect(url),
            catch: (cause) => error("connect", "connection", true, cause),
          });
          const removers: Array<() => void> = [];
          const attached = yield* Effect.try({
            try: () => {
              removers.push(
                connection.onOpen(() => {
                  dependencies.reportConnected();
                  reportState({ state: "connected" });
                }),
              );
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
                connection.onClose(() => offerCommand({ _tag: "SocketClosed", connection })),
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

    const handleFrame = (
      connection: SlackSocketConnection,
      text: string,
    ): Effect.Effect<void, SlackSocketError> =>
      Effect.gen(function* () {
        const decodedEnvelope = yield* decodeEnvelopeJson(text).pipe(Effect.result);
        if (Result.isFailure(decodedEnvelope) || current?.connection !== connection) {
          // Slack redelivers malformed, unacknowledged envelopes.
          return;
        }
        const envelope = decodedEnvelope.success;
        if (envelope.type === "hello") {
          reconnectDelayMs = 1_000;
          return;
        }

        if (envelope.type === "disconnect") {
          acknowledge(connection, envelope.envelope_id);
          if (abandon(connection)) {
            reportState({ state: "reconnecting", failure: "connection" });
            scheduleReconnect(0);
          }
          return;
        }
        if (envelope.type !== "events_api") {
          acknowledge(connection, envelope.envelope_id);
          return;
        }

        const decodedPayload = yield* decodeEventsPayload(envelope.payload).pipe(Effect.option);
        if (Option.isNone(decodedPayload)) {
          acknowledge(connection, envelope.envelope_id);
          return;
        }
        const eventId = decodedPayload.value.event_id;
        if (eventId !== undefined && eventIds.has(eventId)) {
          acknowledge(connection, envelope.envelope_id);
          return;
        }
        const decodedMessage = yield* decodeMessagePayload(decodedPayload.value.event).pipe(
          Effect.option,
        );
        if (
          Option.isNone(decodedMessage) ||
          decodedMessage.value.subtype !== undefined ||
          decodedMessage.value.bot_id !== undefined
        ) {
          if (eventId !== undefined) {
            eventIds.remember(eventId);
          }
          acknowledge(connection, envelope.envelope_id);
          return;
        }
        const payload = decodedMessage.value;
        const message: SlackInboundMessage = {
          channel: payload.channel,
          channelType: payload.channel_type,
          userId: payload.user,
          text: payload.text,
          ts: payload.ts,
          threadTs: payload.thread_ts,
        };
        const decision = yield* admitInbound(message, eventId);
        if (decision === "acknowledge") {
          if (eventId !== undefined) {
            eventIds.remember(eventId);
          }
          acknowledge(connection, envelope.envelope_id);
          return;
        }
        if (yield* Queue.offer(inbound, message)) {
          if (eventId !== undefined) {
            eventIds.remember(eventId);
          }
          acknowledge(connection, envelope.envelope_id);
        } else {
          yield* terminalFailure(
            error(
              "receive",
              "queue-overflow",
              false,
              new Error("Slack inbound queue capacity exceeded"),
            ),
          );
        }
      });

    const connect = (): Effect.Effect<void, SlackSocketError> =>
      Effect.gen(function* () {
        if (stopped || failed || current !== undefined) {
          return;
        }
        const bootstrap = yield* dependencies.connectionsOpen(appToken).pipe(Effect.result);
        if (Result.isFailure(bootstrap)) {
          if (bootstrap.failure.reason === "authentication") {
            yield* terminalFailure(error("connect", "authentication", false, bootstrap.failure));
          } else {
            reportState({ state: "reconnecting", failure: "connection" });
            dependencies.reportConnectionFailure(
              error("connect", "connection", true, bootstrap.failure),
            );
            const delay = reconnectDelayMs;
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
            scheduleReconnect(delay);
          }
          return;
        }
        yield* attachSocket(bootstrap.success.url).pipe(
          Effect.catch((failure) => {
            dependencies.reportConnectionFailure(failure);
            const delay = reconnectDelayMs;
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
            return Effect.sync(() => scheduleReconnect(delay));
          }),
        );
      });

    const processCommand = (command: Command): Effect.Effect<void, SlackSocketError> => {
      switch (command._tag) {
        case "Connect":
          return connect();
        case "Frame":
          return handleFrame(command.connection, command.text);
        case "SocketError":
          return Effect.sync(() => {
            dependencies.reportConnectionFailure(
              error("receive", "connection", true, new Error("Slack socket emitted an error")),
            );
            reconnect(command.connection);
          });
        case "SocketClosed":
          return Effect.sync(() => {
            if (current?.connection !== command.connection) {
              return;
            }
            const attached = current;
            detach(attached);
            if (stopped) {
              return;
            }
            dependencies.reportConnectionFailure(
              error("receive", "closed", true, new Error("Slack socket closed unexpectedly")),
            );
            reportState({ state: "reconnecting", failure: "connection" });
            const delay = reconnectDelayMs;
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
            scheduleReconnect(delay);
          });
      }
    };

    const supervisor = Queue.take(commands).pipe(
      Effect.flatMap(processCommand),
      Effect.forever,
      Effect.catch((failure) => terminalFailure(failure)),
    );
    yield* supervisor.pipe(Effect.forkScoped);
    yield* Queue.offer(commands, { _tag: "Connect" });

    const close: Effect.Effect<void, SlackSocketError> = Effect.suspend(() => {
      if (stopped) {
        return Effect.void;
      }
      stopped = true;
      clearReconnect();
      const attached = current;
      if (attached === undefined || attached.connection.readyState() === SOCKET_CLOSED) {
        if (attached !== undefined) {
          detach(attached);
        }
        return Queue.clear(inbound).pipe(
          Effect.orElseSucceed(() => []),
          Effect.andThen(Queue.fail(inbound, error("close", "closed", false, new Error("closed")))),
          Effect.andThen(Queue.shutdown(commands)),
          Effect.andThen(Queue.shutdown(connectionStates)),
          Effect.asVoid,
        );
      }

      const waitForClose = Effect.callback<void, SlackSocketError>((resume) => {
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
        Effect.ensuring(Effect.sync(() => detach(attached))),
      );

      return Queue.clear(inbound).pipe(
        Effect.orElseSucceed(() => []),
        Effect.andThen(Queue.fail(inbound, error("close", "closed", false, new Error("closed")))),
        Effect.andThen(Queue.shutdown(commands)),
        Effect.andThen(Queue.shutdown(connectionStates)),
        Effect.andThen(waitForClose),
      );
    });

    yield* Effect.addFinalizer(() =>
      close.pipe(
        Effect.catch((failure) => Effect.logWarning("Slack socket cleanup failed", { failure })),
      ),
    );

    return {
      next: Queue.take(inbound),
      nextConnectionState: Queue.take(connectionStates),
      close,
    };
  });
