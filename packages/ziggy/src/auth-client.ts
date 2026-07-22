import { createConnection } from "node:net";
import { ZIGGY_VERSION } from "@ziggy/core";
import {
  decodeServerFrame,
  encodeClientRequest,
  PROTOCOL_VERSION,
  type AuthPromptEvent,
  type AuthStatus,
  type AuthType,
  type ClientRequestFrame,
  type ServerFrame,
} from "@ziggy/protocol";
import { Deferred, Effect, Fiber, FiberSet, Queue, Schema, Scope } from "effect";

export class AuthClientError extends Schema.TaggedErrorClass<AuthClientError>(
  "@ziggy/ziggy/AuthClientError",
)("AuthClientError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface AuthClientInteraction<E = AuthClientError> {
  prompt(event: AuthPromptEvent, signal: AbortSignal): Effect.Effect<string, E>;
  notify(message: string): Effect.Effect<void, E>;
}

export interface AuthClientTransport {
  onData(listener: (chunk: Buffer | string) => void): void;
  onConnect(listener: () => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  write(data: string, callback: (error?: Error) => void): void;
  destroy(): void;
}

export type AuthClientTransportFactory = (socketPath: string) => AuthClientTransport;

type LoginWaitResult<E> =
  | { readonly kind: "frame"; readonly frame: ServerFrame }
  | {
      readonly kind: "prompt";
      readonly loginId: string;
      readonly promptId: string;
      readonly result:
        | { readonly kind: "success"; readonly value: string }
        | { readonly kind: "failure"; readonly error: E };
    };

interface ActivePrompt<E> {
  readonly loginId: string;
  readonly promptId: string;
  readonly controller: AbortController;
  readonly fiber: Fiber.Fiber<void, never>;
  readonly outcome: Deferred.Deferred<LoginWaitResult<E>>;
}

const maxInboundFrameBytes = 1_048_576;
const maxQueuedFrameBytes = 262_144;
const maxQueuedFrames = 64;

interface QueuedFrame {
  readonly frame: ServerFrame;
  readonly bytes: number;
}

interface FrameTransport {
  readonly connected: Effect.Effect<void, AuthClientError>;
  readonly nextFrame: Effect.Effect<ServerFrame, AuthClientError>;
  write(frame: ClientRequestFrame): Effect.Effect<void, AuthClientError>;
  readonly destroy: Effect.Effect<void>;
}

export function queryProviderAuthStatus(
  socketPath: string,
  providerId?: string,
  createTransport: AuthClientTransportFactory = createNodeTransport,
): Effect.Effect<ReadonlyArray<AuthStatus>, AuthClientError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* createFrameTransport(createTransport(socketPath));
      return yield* Effect.gen(function* () {
        yield* transport.connected;
        yield* transport.write({
          schemaVersion: PROTOCOL_VERSION,
          requestId: "doctor-initialize",
          method: "initialize",
          params: { client: { name: "ziggy-doctor", version: ZIGGY_VERSION }, features: [] },
        });
        yield* requireAuthSupport(yield* transport.nextFrame, "doctor-initialize");
        yield* transport.write({
          schemaVersion: PROTOCOL_VERSION,
          requestId: "doctor-auth-status",
          method: "auth/status",
          params: providerId === undefined ? {} : { providerId },
        });
        const frame = yield* transport.nextFrame;
        if (
          frame.type !== "success" ||
          frame.requestId !== "doctor-auth-status" ||
          frame.method !== "auth/status"
        ) {
          return yield* new AuthClientError({
            operation: "auth-status",
            message: "Provider auth status failed",
          });
        }
        return frame.result.providers;
      }).pipe(Effect.ensuring(transport.destroy));
    }),
  );
}

export function loginProvider<E>(
  socketPath: string,
  providerId: string,
  type: AuthType,
  interaction: AuthClientInteraction<E>,
  createTransport: AuthClientTransportFactory = createNodeTransport,
): Effect.Effect<AuthStatus, AuthClientError | E> {
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* createFrameTransport(createTransport(socketPath));
      const promptFibers = yield* FiberSet.make<void, never>();
      let activePrompt: ActivePrompt<E> | undefined;

      const cancelActivePrompt = (): Effect.Effect<void> => {
        const prompt = activePrompt;
        if (prompt === undefined) return Effect.void;
        activePrompt = undefined;
        return Effect.sync(() => prompt.controller.abort()).pipe(
          Effect.andThen(Fiber.interrupt(prompt.fiber)),
        );
      };

      return yield* Effect.gen(function* () {
        yield* transport.connected;
        yield* transport.write({
          schemaVersion: PROTOCOL_VERSION,
          requestId: "auth-initialize",
          method: "initialize",
          params: { client: { name: "ziggy-auth", version: ZIGGY_VERSION }, features: [] },
        });
        yield* requireAuthSupport(yield* transport.nextFrame, "auth-initialize");
        yield* transport.write({
          schemaVersion: PROTOCOL_VERSION,
          requestId: "auth-login",
          method: "auth/login",
          params: { providerId, type },
        });
        let responseSequence = 0;
        const pendingResponses = new Set<string>();

        while (true) {
          const result =
            activePrompt === undefined
              ? yield* transport.nextFrame.pipe(
                  Effect.map((frame): LoginWaitResult<E> => ({ kind: "frame", frame })),
                )
              : yield* Effect.raceFirst(
                  transport.nextFrame.pipe(
                    Effect.map((frame): LoginWaitResult<E> => ({ kind: "frame", frame })),
                  ),
                  Deferred.await(activePrompt.outcome),
                );

          if (result.kind === "prompt") {
            const prompt = activePrompt;
            if (
              prompt === undefined ||
              prompt.loginId !== result.loginId ||
              prompt.promptId !== result.promptId
            ) {
              continue;
            }
            activePrompt = undefined;
            if (result.result.kind === "failure") {
              if (prompt.controller.signal.aborted) continue;
              return yield* Effect.fail(result.result.error);
            }
            responseSequence += 1;
            const requestId = `auth-response-${responseSequence}`;
            pendingResponses.add(requestId);
            yield* transport.write({
              schemaVersion: PROTOCOL_VERSION,
              requestId,
              method: "auth/respond",
              params: {
                loginId: result.loginId,
                promptId: result.promptId,
                value: result.result.value,
              },
            });
            continue;
          }

          const frame = result.frame;
          if (
            frame.type === "error" &&
            frame.requestId !== null &&
            pendingResponses.delete(frame.requestId)
          ) {
            yield* cancelActivePrompt();
            return yield* new AuthClientError({
              operation: "auth-respond",
              message: "Provider authentication response was rejected",
            });
          }
          if (
            frame.type === "success" &&
            frame.method === "auth/respond" &&
            pendingResponses.delete(frame.requestId)
          ) {
            continue;
          }
          if (frame.type === "error" && frame.requestId === "auth-login") {
            yield* cancelActivePrompt();
            return yield* new AuthClientError({
              operation: "auth-login",
              message: "Provider authentication failed",
            });
          }
          if (frame.type === "success" && frame.requestId === "auth-login") {
            yield* cancelActivePrompt();
            if (frame.method !== "auth/login") {
              return yield* new AuthClientError({
                operation: "auth-login",
                message: "Unexpected auth response",
              });
            }
            return frame.result.status;
          }
          if (frame.type !== "auth" || frame.requestId !== "auth-login") continue;

          const event = frame.event;
          if (
            event.kind === "text" ||
            event.kind === "secret" ||
            event.kind === "manual_code" ||
            event.kind === "select"
          ) {
            if (activePrompt !== undefined) {
              return yield* new AuthClientError({
                operation: "auth-prompt",
                message: "Concurrent auth prompts are unsupported",
              });
            }
            const controller = new AbortController();
            const outcome = yield* Deferred.make<LoginWaitResult<E>>();
            const loginId = frame.loginId;
            const promptId = event.promptId;
            const fiber = yield* FiberSet.run(
              promptFibers,
              interaction.prompt(event, controller.signal).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Deferred.succeed(outcome, {
                      kind: "prompt",
                      loginId,
                      promptId,
                      result: { kind: "failure", error },
                    }),
                  onSuccess: (value) =>
                    Deferred.succeed(outcome, {
                      kind: "prompt",
                      loginId,
                      promptId,
                      result: { kind: "success", value },
                    }),
                }),
              ),
              { startImmediately: true },
            );
            activePrompt = { loginId, promptId, controller, fiber, outcome };
          } else if (event.kind === "prompt_cancelled") {
            if (
              activePrompt?.loginId === frame.loginId &&
              activePrompt.promptId === event.promptId
            ) {
              yield* cancelActivePrompt();
            }
          } else if (event.kind === "auth_url") {
            yield* interaction.notify(
              event.instructions === undefined ? event.url : `${event.instructions}\n${event.url}`,
            );
          } else if (event.kind === "device_code") {
            yield* interaction.notify(`${event.verificationUri}\nCode: ${event.userCode}`);
          } else {
            yield* interaction.notify(event.message);
          }
        }
      }).pipe(
        Effect.ensuring(Effect.suspend(cancelActivePrompt)),
        Effect.ensuring(transport.destroy),
      );
    }),
  );
}

function createNodeTransport(socketPath: string): AuthClientTransport {
  const socket = createConnection(socketPath);
  return {
    onData(listener) {
      socket.on("data", listener);
    },
    onConnect(listener) {
      socket.once("connect", listener);
    },
    onClose(listener) {
      socket.once("close", listener);
    },
    onError(listener) {
      socket.on("error", listener);
    },
    write(data, callback) {
      socket.write(data, () => callback());
    },
    destroy() {
      socket.destroy();
    },
  };
}

function createFrameTransport(
  socket: AuthClientTransport,
): Effect.Effect<FrameTransport, never, Scope.Scope> {
  return Effect.gen(function* () {
    const frames = yield* Queue.unbounded<QueuedFrame, AuthClientError>();
    const connection = yield* Deferred.make<void, AuthClientError>();
    const fibers = yield* FiberSet.make<void, never>();
    const runHostEffect = yield* FiberSet.runtime(fibers)<never>();
    const writeWaiters = new Set<(effect: Effect.Effect<void, AuthClientError>) => void>();
    let buffer = Buffer.alloc(0);
    let connected = false;
    let queuedFrames = 0;
    let queuedFrameBytes = 0;
    let terminalError: AuthClientError | undefined;

    const terminate = (error: AuthClientError): void => {
      if (terminalError !== undefined) return;
      terminalError = error;
      buffer = Buffer.alloc(0);
      queuedFrames = 0;
      queuedFrameBytes = 0;
      for (const resume of writeWaiters) resume(Effect.fail(error));
      writeWaiters.clear();
      socket.destroy();
      runHostEffect(
        Effect.all([Deferred.fail(connection, error), Queue.fail(frames, error)], {
          discard: true,
        }),
      );
    };

    const acceptLine = (line: Buffer): void => {
      // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- boundary: protocol decoder throws and must become a stable transport failure
      try {
        const frame = decodeServerFrame(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (
          queuedFrames >= maxQueuedFrames ||
          queuedFrameBytes + line.byteLength > maxQueuedFrameBytes
        ) {
          terminate(
            new AuthClientError({
              operation: "queue-frame",
              message: "Attach server queued frames exceeded the inbound limit",
            }),
          );
          return;
        }
        queuedFrames += 1;
        queuedFrameBytes += line.byteLength;
        runHostEffect(
          Queue.offer(frames, { frame, bytes: line.byteLength }).pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : Effect.sync(() =>
                    terminate(
                      new AuthClientError({
                        operation: "queue-frame",
                        message: "Attach server frame queue is closed",
                      }),
                    ),
                  ),
            ),
          ),
        );
      } catch (cause) {
        terminate(
          new AuthClientError({
            operation: "decode-frame",
            message: "Malformed attach server frame",
            cause,
          }),
        );
      }
    };

    socket.onConnect(() => {
      if (terminalError !== undefined || connected) return;
      connected = true;
      runHostEffect(Deferred.succeed(connection, undefined));
    });
    socket.onClose(() =>
      terminate(
        new AuthClientError({
          operation: "transport-close",
          message: "Attach transport closed",
        }),
      ),
    );
    socket.onError((cause) =>
      terminate(
        new AuthClientError({
          operation: "transport-error",
          message: "Attach transport failed",
          cause,
        }),
      ),
    );
    socket.onData((chunk) => {
      if (terminalError !== undefined) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const newline = bytes.indexOf(0x0a, offset);
        const segmentEnd = newline < 0 ? bytes.byteLength : newline + 1;
        const segment = bytes.subarray(offset, segmentEnd);
        if (buffer.byteLength + segment.byteLength > maxInboundFrameBytes) {
          terminate(
            new AuthClientError({
              operation: "read-frame",
              message: "Attach server frame is too large",
            }),
          );
          return;
        }
        const line =
          buffer.byteLength === 0
            ? Buffer.from(segment)
            : Buffer.concat([buffer, segment], buffer.byteLength + segment.byteLength);
        if (newline < 0) {
          buffer = line;
          return;
        }
        buffer = Buffer.alloc(0);
        acceptLine(line);
        offset = segmentEnd;
      }
    });

    return {
      connected: Deferred.await(connection),
      nextFrame: Queue.take(frames).pipe(
        Effect.tap((queued) =>
          Effect.sync(() => {
            queuedFrames -= 1;
            queuedFrameBytes -= queued.bytes;
          }),
        ),
        Effect.map((queued) => queued.frame),
      ),
      write: (frame) =>
        Effect.callback<void, AuthClientError>((resume) => {
          const currentError = terminalError;
          if (currentError !== undefined) {
            resume(Effect.fail(currentError));
            return;
          }
          writeWaiters.add(resume);
          // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- boundary: transport write can throw before registering its callback
          try {
            socket.write(encodeClientRequest(frame), (error) => {
              writeWaiters.delete(resume);
              if (error !== undefined) {
                const failure = new AuthClientError({
                  operation: "transport-write",
                  message: "Attach transport write failed",
                  cause: error,
                });
                terminate(failure);
                resume(Effect.fail(failure));
              } else if (terminalError !== undefined) {
                resume(Effect.fail(terminalError));
              } else {
                resume(Effect.void);
              }
            });
          } catch (cause) {
            writeWaiters.delete(resume);
            const failure = new AuthClientError({
              operation: "transport-write",
              message: "Attach transport write failed",
              cause,
            });
            terminate(failure);
            resume(Effect.fail(failure));
          }
          return Effect.sync(() => {
            writeWaiters.delete(resume);
          });
        }),
      destroy: Effect.sync(() =>
        terminate(
          new AuthClientError({
            operation: "transport-destroy",
            message: "Attach transport closed",
          }),
        ),
      ),
    };
  });
}

function requireAuthSupport(
  frame: ServerFrame,
  requestId: string,
): Effect.Effect<void, AuthClientError> {
  if (frame.type !== "success" || frame.requestId !== requestId || frame.method !== "initialize") {
    return Effect.fail(
      new AuthClientError({
        operation: "initialize",
        message: "Attach protocol initialization failed",
      }),
    );
  }
  if (!frame.result.features.includes("providerAuth")) {
    return Effect.fail(
      new AuthClientError({
        operation: "initialize",
        message: "Daemon does not support Provider authentication",
      }),
    );
  }
  return Effect.void;
}
