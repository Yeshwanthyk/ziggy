import { createConnection, type Socket } from "node:net";
import {
  decodeServerFrame,
  encodeClientRequest,
  type ClientRequestFrame,
  type ServerFrame,
} from "@ziggy/protocol";
import { Effect, FiberSet, Queue, Schema, Scope, Semaphore } from "effect";

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_QUEUED_BYTES = 1_048_576;
const DEFAULT_MAX_QUEUED_FRAMES = 128;

export class AttachTransportConfigurationError extends Schema.TaggedErrorClass<AttachTransportConfigurationError>()(
  "AttachTransportConfigurationError",
  { option: Schema.String },
) {}

export class AttachTransportOpenError extends Schema.TaggedErrorClass<AttachTransportOpenError>()(
  "AttachTransportOpenError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export class AttachTransportReadError extends Schema.TaggedErrorClass<AttachTransportReadError>()(
  "AttachTransportReadError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export class AttachTransportWriteError extends Schema.TaggedErrorClass<AttachTransportWriteError>()(
  "AttachTransportWriteError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export class AttachTransportClosedError extends Schema.TaggedErrorClass<AttachTransportClosedError>()(
  "AttachTransportClosedError",
  {},
) {}

export class AttachTransportQueueOverflowError extends Schema.TaggedErrorClass<AttachTransportQueueOverflowError>()(
  "AttachTransportQueueOverflowError",
  {
    queuedFrames: Schema.Number,
    queuedBytes: Schema.Number,
  },
) {}

export type AttachTransportError =
  | AttachTransportClosedError
  | AttachTransportConfigurationError
  | AttachTransportOpenError
  | AttachTransportQueueOverflowError
  | AttachTransportReadError
  | AttachTransportWriteError;

export interface AttachTransport {
  readonly receive: Effect.Effect<ServerFrame, AttachTransportError>;
  readonly write: (
    frame: ClientRequestFrame,
  ) => Effect.Effect<void, AttachTransportClosedError | AttachTransportWriteError>;
  readonly close: Effect.Effect<void>;
}

export interface AttachTransportFactory {
  readonly connect: Effect.Effect<
    AttachTransport,
    AttachTransportConfigurationError | AttachTransportOpenError,
    Scope.Scope
  >;
}

export interface UnixAttachTransportOptions {
  readonly maxFrameBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxQueuedFrames?: number;
}

interface QueuedFrame {
  readonly bytes: number;
  readonly frame: ServerFrame;
}

type SocketSignal =
  | { readonly type: "data"; readonly chunk: Buffer }
  | {
      readonly type: "terminal";
      readonly error: AttachTransportClosedError | AttachTransportReadError;
    };

export function unixAttachTransportFactory(
  socketPath: string,
  options: UnixAttachTransportOptions = {},
): AttachTransportFactory {
  return {
    connect: createUnixAttachTransport(socketPath, options),
  };
}

function createUnixAttachTransport(
  socketPath: string,
  options: UnixAttachTransportOptions = {},
): Effect.Effect<
  AttachTransport,
  AttachTransportConfigurationError | AttachTransportOpenError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const maxFrameBytes = yield* positiveCapacity(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    const maxQueuedBytes = yield* positiveCapacity(
      options.maxQueuedBytes,
      DEFAULT_MAX_QUEUED_BYTES,
      "maxQueuedBytes",
    );
    const maxQueuedFrames = yield* positiveCapacity(
      options.maxQueuedFrames,
      DEFAULT_MAX_QUEUED_FRAMES,
      "maxQueuedFrames",
    );
    const socket = yield* openUnixSocket(socketPath);
    const frames = yield* Queue.bounded<QueuedFrame, AttachTransportError>(maxQueuedFrames);
    const signals = yield* Queue.unbounded<SocketSignal>();
    const byteCredits = yield* Semaphore.make(maxQueuedBytes);
    const fibers = yield* FiberSet.make<void, never>();
    let queuedBytes = 0;
    let queuedFrames = 0;
    let terminal = false;
    let closed = false;

    const terminate = (error: AttachTransportError): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (terminal) return Effect.void;
        terminal = true;
        socket.pause();
        if (!socket.destroyed) socket.destroy();
        return Queue.fail(frames, error).pipe(Effect.asVoid);
      });

    const close = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      terminal = true;
      socket.pause();
      if (!socket.destroyed) socket.destroy();
      return Queue.shutdown(frames).pipe(
        Effect.andThen(FiberSet.clear(fibers)),
        Effect.andThen(byteCredits.releaseAll),
        Effect.asVoid,
      );
    });

    yield* Scope.addFinalizer(yield* Effect.scope, close);
    yield* waitForConnect(socket).pipe(Effect.onError(() => close));
    socket.pause();
    const removeSocketListeners = installSocketSignals(socket, signals);
    yield* Scope.addFinalizer(yield* Effect.scope, removeSocketListeners);

    const offerFrame = (line: Buffer): Effect.Effect<void, AttachTransportError> =>
      Effect.gen(function* () {
        if (line.byteLength > maxQueuedBytes) {
          return yield* new AttachTransportQueueOverflowError({ queuedBytes, queuedFrames });
        }
        const frame = yield* decodeFrame(line);
        yield* Effect.uninterruptibleMask((restore) =>
          restore(byteCredits.take(line.byteLength)).pipe(
            Effect.flatMap((acquired) =>
              restore(Queue.offer(frames, { bytes: line.byteLength, frame })).pipe(
                Effect.flatMap((accepted) => {
                  if (!accepted) {
                    return byteCredits
                      .release(acquired)
                      .pipe(Effect.andThen(Effect.fail(new AttachTransportClosedError())));
                  }
                  queuedBytes += line.byteLength;
                  queuedFrames += 1;
                  return Effect.void;
                }),
                Effect.onInterrupt(() => byteCredits.release(acquired).pipe(Effect.asVoid)),
              ),
            ),
          ),
        );
      });

    const ingest = Effect.gen(function* () {
      let buffered = Buffer.alloc(0);
      while (!terminal) {
        const signal = yield* Queue.take(signals);
        if (signal.type === "terminal") {
          yield* terminate(signal.error);
          return;
        }
        const chunk = signal.chunk;
        let offset = 0;
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(0x0a, offset);
          const end = newline < 0 ? chunk.byteLength : newline + 1;
          const segment = chunk.subarray(offset, end);
          if (buffered.byteLength + segment.byteLength > maxFrameBytes) {
            return yield* new AttachTransportReadError();
          }
          const line =
            buffered.byteLength === 0
              ? Buffer.from(segment)
              : Buffer.concat([buffered, segment], buffered.byteLength + segment.byteLength);
          if (newline < 0) {
            buffered = line;
            break;
          }
          buffered = Buffer.alloc(0);
          yield* offerFrame(line);
          offset = end;
        }
        if (!terminal) socket.resume();
      }
    }).pipe(Effect.catch(terminate));

    yield* FiberSet.run(fibers, ingest, { startImmediately: true });
    socket.resume();

    return {
      receive: Effect.uninterruptibleMask((restore) =>
        restore(Queue.take(frames)).pipe(
          Effect.flatMap((item) =>
            byteCredits.release(item.bytes).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  queuedBytes -= item.bytes;
                  queuedFrames -= 1;
                }),
              ),
              Effect.as(item.frame),
            ),
          ),
        ),
      ),
      write: (frame) => writeSocket(socket, encodeClientRequest(frame), () => terminal),
      close,
    };
  });
}

function decodeFrame(line: Buffer): Effect.Effect<ServerFrame, AttachTransportReadError> {
  return Effect.try({
    try: () => decodeServerFrame(new TextDecoder("utf-8", { fatal: true }).decode(line)),
    catch: (cause) => new AttachTransportReadError({ cause }),
  });
}

function installSocketSignals(
  socket: Socket,
  signals: Queue.Queue<SocketSignal>,
): Effect.Effect<void> {
  const onData = (chunk: Buffer): void => {
    socket.pause();
    Queue.offerUnsafe(signals, { type: "data", chunk });
  };
  const onEnd = (): void => {
    Queue.offerUnsafe(signals, { type: "terminal", error: new AttachTransportClosedError() });
  };
  const onClose = (): void => {
    Queue.offerUnsafe(signals, { type: "terminal", error: new AttachTransportClosedError() });
  };
  const onError = (cause: Error): void => {
    Queue.offerUnsafe(signals, {
      type: "terminal",
      error: new AttachTransportReadError({ cause }),
    });
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onClose);
  socket.once("error", onError);
  return Effect.sync(() => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onClose);
    socket.off("error", onError);
  });
}

function positiveCapacity(
  value: number | undefined,
  fallback: number,
  option: string,
): Effect.Effect<number, AttachTransportConfigurationError> {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved > 0
    ? Effect.succeed(resolved)
    : Effect.fail(new AttachTransportConfigurationError({ option }));
}

function openUnixSocket(socketPath: string): Effect.Effect<Socket, AttachTransportOpenError> {
  return Effect.try({
    try: () => createConnection(socketPath),
    catch: (cause) => new AttachTransportOpenError({ cause }),
  });
}

function waitForConnect(socket: Socket): Effect.Effect<void, AttachTransportOpenError> {
  return Effect.callback<void, AttachTransportOpenError>((resume) => {
    const onConnect = (): void => {
      socket.off("error", onError);
      resume(Effect.void);
    };
    const onError = (cause: Error): void => {
      socket.off("connect", onConnect);
      resume(Effect.fail(new AttachTransportOpenError({ cause })));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    });
  });
}

function writeSocket(
  socket: Socket,
  encoded: string,
  isTerminal: () => boolean,
): Effect.Effect<void, AttachTransportClosedError | AttachTransportWriteError> {
  return Effect.callback<void, AttachTransportClosedError | AttachTransportWriteError>((resume) => {
    if (isTerminal() || socket.destroyed) {
      resume(Effect.fail(new AttachTransportClosedError()));
      return;
    }
    // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- boundary: node:net write may throw before its callback and is immediately translated to a typed failure.
    try {
      socket.write(encoded, (cause) => {
        resume(
          cause === undefined || cause === null
            ? Effect.void
            : Effect.fail(new AttachTransportWriteError({ cause })),
        );
      });
    } catch (cause) {
      resume(Effect.fail(new AttachTransportWriteError({ cause })));
    }
  });
}
