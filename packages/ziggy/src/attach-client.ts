import {
  MAIN_SESSION_ID,
  PROTOCOL_VERSION,
  type ApprovalDecision,
  type ClientFeature,
  type ClientRequestFrame,
  type ServerFeature,
  type ServerFrame,
  type ServerSessionEventFrame,
  type ServerSuccessFrame,
  type SessionEnvelope,
  type SessionSummary,
  type TurnStartResponse,
} from "@ziggy/protocol";
import {
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import {
  AttachTransportClosedError,
  AttachTransportConfigurationError,
  type AttachTransport,
  type AttachTransportError,
  type AttachTransportFactory,
  AttachTransportOpenError,
  AttachTransportQueueOverflowError,
  AttachTransportReadError,
  AttachTransportWriteError,
} from "./attach-transport.ts";

const REQUIRED_PROTOCOL_VERSION = 2;
const DEFAULT_EVENT_QUEUE_CAPACITY = 256;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_REORDERED_EVENTS = 256;
const DEFAULT_MAX_ORPHAN_EVENTS = 256;
const DEFAULT_MAX_ACTIVE_SUBSCRIPTIONS = 64;
const DEFAULT_MAX_BUFFERED_EVENTS = 1_024;
const DEFAULT_MAX_BUFFERED_EVENT_BYTES = 16_777_216;
const DEFAULT_MAX_REQUEST_TOMBSTONES = 64;
const MAX_REQUEST_ID_BYTES = 128;
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_INITIAL_DELAY = "100 millis";

export class AttachDisconnectedError extends Schema.TaggedErrorClass<AttachDisconnectedError>()(
  "AttachDisconnectedError",
  { phase: Schema.Literals(["setup", "request", "replay"]) },
) {}

export class AttachOutcomeUnknownError extends Schema.TaggedErrorClass<AttachOutcomeUnknownError>()(
  "AttachOutcomeUnknownError",
  { sessionId: Schema.String },
) {}

export class AttachProtocolCompatibilityError extends Schema.TaggedErrorClass<AttachProtocolCompatibilityError>()(
  "AttachProtocolCompatibilityError",
  {
    protocolVersion: Schema.Number,
    missingFeature: Schema.optional(Schema.String),
  },
) {}

export class AttachProtocolRejectedError extends Schema.TaggedErrorClass<AttachProtocolRejectedError>()(
  "AttachProtocolRejectedError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

export class AttachProtocolStateError extends Schema.TaggedErrorClass<AttachProtocolStateError>()(
  "AttachProtocolStateError",
  { message: Schema.String },
) {}

export class AttachClientQueueOverflowError extends Schema.TaggedErrorClass<AttachClientQueueOverflowError>()(
  "AttachClientQueueOverflowError",
  {
    queue: Schema.Literals([
      "buffered-bytes",
      "buffered-events",
      "events",
      "orphans",
      "pending",
      "reorder",
      "subscriptions",
      "tombstones",
    ]),
    capacity: Schema.Number,
  },
) {}

export class AttachSetupRetryExhaustedError extends Schema.TaggedErrorClass<AttachSetupRetryExhaustedError>()(
  "AttachSetupRetryExhaustedError",
  { cause: Schema.Defect() },
) {}

export class AttachReconnectExhaustedError extends Schema.TaggedErrorClass<AttachReconnectExhaustedError>()(
  "AttachReconnectExhaustedError",
  {
    attempts: Schema.Number,
    lastCause: Schema.Defect(),
  },
) {}

export type AttachClientError =
  | AttachClientQueueOverflowError
  | AttachDisconnectedError
  | AttachOutcomeUnknownError
  | AttachProtocolCompatibilityError
  | AttachProtocolRejectedError
  | AttachProtocolStateError
  | AttachReconnectExhaustedError
  | AttachSetupRetryExhaustedError
  | AttachTransportConfigurationError
  | AttachTransportOpenError
  | AttachTransportQueueOverflowError
  | AttachTransportReadError
  | AttachTransportWriteError;

export type AttachSubscriptionChange =
  | { readonly type: "connection-lost" }
  | { readonly type: "retry-started"; readonly attempt: number }
  | { readonly type: "replay-started"; readonly replayThroughSeq: number };

export interface AttachSubscription {
  readonly sessionId: string;
  readonly next: Effect.Effect<SessionEnvelope, AttachClientError>;
  readonly nextChange?: Effect.Effect<AttachSubscriptionChange, AttachClientError>;
  readonly lastAppliedSeq: Effect.Effect<number>;
  readonly replayThroughSeq: Effect.Effect<number>;
  readonly close: Effect.Effect<void, AttachClientError>;
}

export interface AcceptedTurn {
  readonly acceptance: TurnStartResponse;
  readonly subscription: AttachSubscription;
}

export interface AttachClient {
  readonly ensureMain: Effect.Effect<SessionSummary, AttachClientError>;
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionSummary>, AttachClientError>;
  readonly subscribe: (
    sessionId: string,
    sinceSeq: number,
  ) => Effect.Effect<AttachSubscription, AttachClientError>;
  readonly startMainTurn: (
    message: string,
    sinceSeq?: number,
  ) => Effect.Effect<AcceptedTurn, AttachClientError>;
  readonly startTurn: (
    sessionId: string,
    message: string,
  ) => Effect.Effect<TurnStartResponse, AttachClientError>;
  readonly steerTurn: (
    sessionId: string,
    expectedTurnId: string,
    message: string,
  ) => Effect.Effect<string, AttachClientError>;
  readonly interruptTurn: (
    sessionId: string,
    expectedTurnId: string,
  ) => Effect.Effect<string, AttachClientError>;
  readonly resolveApproval: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<"already-resolved" | "resolved", AttachClientError>;
}

export interface CreateAttachClientOptions {
  readonly transport: AttachTransportFactory;
  readonly client: {
    readonly name: string;
    readonly version: string;
    readonly features?: ReadonlyArray<ClientFeature>;
  };
  readonly requiredFeatures?: ReadonlyArray<ServerFeature>;
  readonly eventQueueCapacity?: number;
  readonly maxPendingRequests?: number;
  readonly maxReorderedEvents?: number;
  readonly maxOrphanEvents?: number;
  readonly maxActiveSubscriptions?: number;
  readonly maxBufferedEvents?: number;
  readonly maxBufferedEventBytes?: number;
  readonly maxRequestTombstones?: number;
  readonly nextRequestId?: () => string;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<ServerSuccessFrame, AttachClientError>;
  readonly method: ClientRequestFrame["method"];
  readonly sessionId: string | undefined;
  writeAttempted: boolean;
}

interface BufferedEvent {
  readonly bytes: number;
  readonly envelope: SessionEnvelope;
  released: boolean;
}

interface BufferedOrphan {
  readonly event: BufferedEvent;
  readonly subscriptionId: string;
}

interface Connection {
  readonly id: number;
  readonly transport: AttachTransport;
  readonly pending: Map<string, PendingRequest>;
  readonly tombstones: Set<string>;
  readonly orphanEvents: BufferedOrphan[];
  staging: boolean;
  closed: boolean;
}

interface SubscriptionState {
  readonly sessionId: string;
  readonly queue: Queue.Queue<BufferedEvent, AttachClientError>;
  readonly changes: Queue.Queue<AttachSubscriptionChange, AttachClientError>;
  readonly reordered: Map<number, BufferedEvent>;
  readonly buffered: Set<BufferedEvent>;
  active: boolean;
  reconnectable: boolean;
  expectedSeq: number;
  lastAppliedSeq: number;
  replayWatermark: number;
  binding: { readonly connectionId: number; readonly subscriptionId: string } | undefined;
}

interface CandidateBinding {
  readonly subscription: SubscriptionState;
  readonly subscriptionId: string;
  readonly replayWatermark: number;
}

export function createAttachClient(
  options: CreateAttachClientOptions,
): Effect.Effect<AttachClient, AttachClientError, Scope.Scope> {
  return Effect.gen(function* () {
    const eventQueueCapacity = yield* positiveCapacity(
      options.eventQueueCapacity,
      DEFAULT_EVENT_QUEUE_CAPACITY,
      "events",
    );
    const maxPendingRequests = yield* positiveCapacity(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      "pending",
    );
    const maxReorderedEvents = yield* positiveCapacity(
      options.maxReorderedEvents,
      DEFAULT_MAX_REORDERED_EVENTS,
      "reorder",
    );
    const maxOrphanEvents = yield* positiveCapacity(
      options.maxOrphanEvents,
      DEFAULT_MAX_ORPHAN_EVENTS,
      "orphans",
    );
    const maxActiveSubscriptions = yield* positiveCapacity(
      options.maxActiveSubscriptions,
      DEFAULT_MAX_ACTIVE_SUBSCRIPTIONS,
      "subscriptions",
    );
    const maxBufferedEvents = yield* positiveCapacity(
      options.maxBufferedEvents,
      DEFAULT_MAX_BUFFERED_EVENTS,
      "buffered-events",
    );
    const maxBufferedEventBytes = yield* positiveCapacity(
      options.maxBufferedEventBytes,
      DEFAULT_MAX_BUFFERED_EVENT_BYTES,
      "buffered-bytes",
    );
    const maxRequestTombstones = yield* positiveCapacity(
      options.maxRequestTombstones,
      DEFAULT_MAX_REQUEST_TOMBSTONES,
      "tombstones",
    );
    const scope = yield* Effect.scope;
    const fibers = yield* FiberSet.make<void, never>();
    const connectionGate = yield* Semaphore.make(1);
    const bufferedEventCredits = yield* Semaphore.make(maxBufferedEvents);
    const bufferedByteCredits = yield* Semaphore.make(maxBufferedEventBytes);
    const subscriptions = new Set<SubscriptionState>();
    const openConnections = new Map<number, Connection>();
    let connection: Connection | undefined;
    let connectionSequence = 0;
    let requestSequence = 0;
    let reconnecting = false;
    let reconnectBarrier: Deferred.Deferred<void, AttachClientError> | undefined;
    let released = false;

    const requestIdInUse = (requestId: string): boolean =>
      [...openConnections.values()].some(
        (target) => target.pending.has(requestId) || target.tombstones.has(requestId),
      );

    const generateDefaultRequestId = (): string => {
      do {
        requestSequence = requestSequence === Number.MAX_SAFE_INTEGER ? 1 : requestSequence + 1;
      } while (requestIdInUse(`attach-${requestSequence}`));
      return `attach-${requestSequence}`;
    };

    const nextRequestId = (): Effect.Effect<string, AttachProtocolStateError> =>
      Effect.try({
        try: options.nextRequestId ?? generateDefaultRequestId,
        catch: () => new AttachProtocolStateError({ message: "Request id generator failed" }),
      }).pipe(Effect.flatMap(validateRequestId));

    const releaseBuffered = (event: BufferedEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (event.released) return Effect.void;
        event.released = true;
        return bufferedEventCredits
          .release(1)
          .pipe(Effect.andThen(bufferedByteCredits.release(event.bytes)), Effect.asVoid);
      });

    const releaseSubscriptionBuffers = (subscription: SubscriptionState): Effect.Effect<void> =>
      Effect.forEach([...subscription.buffered], releaseBuffered, { discard: true }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            subscription.buffered.clear();
            subscription.reordered.clear();
          }),
        ),
      );

    const releaseConnectionOrphans = (target: Connection): Effect.Effect<void> =>
      Effect.forEach(
        target.orphanEvents.splice(0).map((orphan) => orphan.event),
        releaseBuffered,
        { discard: true },
      );

    const acquireBuffered = (
      envelope: SessionEnvelope,
    ): Effect.Effect<BufferedEvent, AttachClientError> => {
      const bytes = decodedEventBytes(envelope);
      if (bytes > maxBufferedEventBytes) {
        return Effect.fail(
          new AttachClientQueueOverflowError({
            queue: "buffered-bytes",
            capacity: maxBufferedEventBytes,
          }),
        );
      }
      return Effect.uninterruptibleMask((restore) =>
        restore(bufferedEventCredits.take(1)).pipe(
          Effect.flatMap((eventPermits) =>
            restore(bufferedByteCredits.take(bytes)).pipe(
              Effect.map(() => ({ bytes, envelope, released: false })),
              Effect.onInterrupt(() =>
                bufferedEventCredits.release(eventPermits).pipe(Effect.asVoid),
              ),
            ),
          ),
        ),
      );
    };

    const failSubscription = (
      subscription: SubscriptionState,
      error: AttachClientError,
    ): Effect.Effect<void> => {
      subscription.active = false;
      subscriptions.delete(subscription);
      return Queue.fail(subscription.queue, error).pipe(
        Effect.andThen(Queue.fail(subscription.changes, error)),
        Effect.andThen(releaseSubscriptionBuffers(subscription)),
        Effect.asVoid,
      );
    };

    const publishChange = (
      subscription: SubscriptionState,
      change: AttachSubscriptionChange,
    ): Effect.Effect<void, AttachClientError> =>
      Queue.offer(subscription.changes, change).pipe(Effect.asVoid);

    const publishConnectionLost = (): Effect.Effect<void, AttachClientError> =>
      Effect.forEach(
        [...subscriptions].filter(
          (subscription) => subscription.active && subscription.reconnectable,
        ),
        (subscription) => publishChange(subscription, { type: "connection-lost" }),
        { discard: true },
      );

    const failAllSubscriptions = (error: AttachClientError): Effect.Effect<void> =>
      Effect.forEach([...subscriptions], (subscription) => failSubscription(subscription, error), {
        discard: true,
      });

    const failPending = (
      target: Connection,
      cause: AttachClientError | AttachTransportError,
    ): Effect.Effect<void> =>
      Effect.forEach(
        [...target.pending.values()],
        (pending) => {
          const error: AttachClientError =
            pending.method === "turn/start" && pending.writeAttempted
              ? new AttachOutcomeUnknownError({ sessionId: pending.sessionId ?? "" })
              : Predicate.isTagged(cause, "AttachTransportQueueOverflowError")
                ? cause
                : new AttachDisconnectedError({ phase: "request" });
          return Deferred.fail(pending.deferred, error).pipe(Effect.asVoid);
        },
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            target.pending.clear();
          }),
        ),
      );

    const closeConnection = (
      target: Connection,
      cause: AttachClientError | AttachTransportError = new AttachDisconnectedError({
        phase: "request",
      }),
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (target.closed) return Effect.void;
        target.closed = true;
        openConnections.delete(target.id);
        if (connection?.id === target.id) connection = undefined;
        for (const subscription of subscriptions) {
          if (subscription.binding?.connectionId === target.id) {
            subscription.binding = undefined;
          }
        }
        return failPending(target, cause).pipe(
          Effect.andThen(releaseConnectionOrphans(target)),
          Effect.andThen(
            Effect.sync(() => {
              target.tombstones.clear();
            }),
          ),
          Effect.andThen(target.transport.close),
        );
      });

    const acceptSubscriptionEvent = (
      target: Connection,
      frame: ServerSessionEventFrame,
    ): Effect.Effect<void, AttachClientError> => {
      const subscription = [...subscriptions].find(
        (candidate) =>
          candidate.active &&
          candidate.binding?.connectionId === target.id &&
          candidate.binding.subscriptionId === frame.subscriptionId &&
          frame.event.event.sessionId === candidate.sessionId,
      );
      if (subscription === undefined || target.staging) {
        if (target.orphanEvents.length >= maxOrphanEvents) {
          return new AttachClientQueueOverflowError({
            queue: "orphans",
            capacity: maxOrphanEvents,
          });
        }
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const event = yield* restore(acquireBuffered(frame.event));
            target.orphanEvents.push({ event, subscriptionId: frame.subscriptionId });
          }),
        );
      }
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const event = yield* restore(acquireBuffered(frame.event));
          subscription.buffered.add(event);
          yield* restore(applyBufferedEnvelope(subscription, event)).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                subscription.buffered.delete(event);
              }).pipe(Effect.andThen(releaseBuffered(event))),
            ),
          );
        }),
      );
    };

    const applyBufferedEnvelope = (
      subscription: SubscriptionState,
      buffered: BufferedEvent,
    ): Effect.Effect<void, AttachClientError> =>
      Effect.gen(function* () {
        const envelope = buffered.envelope;
        if (!subscription.active || envelope.seq < subscription.expectedSeq) {
          yield* releaseBuffered(buffered);
          return;
        }
        subscription.buffered.add(buffered);
        if (envelope.seq > subscription.expectedSeq) {
          if (subscription.reordered.has(envelope.seq)) {
            subscription.buffered.delete(buffered);
            yield* releaseBuffered(buffered);
            return;
          }
          if (subscription.reordered.size >= maxReorderedEvents) {
            const error = new AttachClientQueueOverflowError({
              queue: "reorder",
              capacity: maxReorderedEvents,
            });
            yield* failSubscription(subscription, error);
            return yield* error;
          }
          subscription.reordered.set(envelope.seq, buffered);
          return;
        }
        let current: BufferedEvent | undefined = buffered;
        while (current !== undefined) {
          const accepted = yield* Queue.offer(subscription.queue, current);
          if (!accepted) {
            subscription.buffered.delete(current);
            yield* releaseBuffered(current);
            return;
          }
          subscription.expectedSeq += 1;
          current = subscription.reordered.get(subscription.expectedSeq);
          if (current !== undefined) subscription.reordered.delete(subscription.expectedSeq);
        }
      });

    const dispatch = (
      target: Connection,
      frame: ServerFrame,
    ): Effect.Effect<void, AttachClientError> => {
      if (frame.type === "event") return acceptSubscriptionEvent(target, frame);
      if (frame.type === "auth") return Effect.void;
      if (frame.requestId === null) {
        return new AttachProtocolStateError({ message: "Daemon sent an uncorrelated error" });
      }
      if (target.tombstones.delete(frame.requestId)) return Effect.void;
      const pending = target.pending.get(frame.requestId);
      if (pending === undefined) {
        return new AttachProtocolStateError({ message: "Daemon sent an unknown response id" });
      }
      target.pending.delete(frame.requestId);
      if (frame.type === "error") {
        return Deferred.fail(
          pending.deferred,
          new AttachProtocolRejectedError({ code: frame.code, message: frame.message }),
        ).pipe(Effect.asVoid);
      }
      if (frame.method !== pending.method) {
        const error = new AttachProtocolStateError({
          message: "Daemon response method did not match request",
        });
        return Deferred.fail(pending.deferred, error).pipe(Effect.asVoid);
      }
      return Deferred.succeed(pending.deferred, frame).pipe(Effect.asVoid);
    };

    const reader = (target: Connection): Effect.Effect<void> =>
      Effect.forever(
        target.transport.receive.pipe(Effect.flatMap((frame) => dispatch(target, frame))),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const hasUnknownTurnOutcome = [...target.pending.values()].some(
              (pending) => pending.method === "turn/start" && pending.writeAttempted,
            );
            const hasReconnectableSubscription = [...subscriptions].some(
              (subscription) => subscription.active && subscription.reconnectable,
            );
            const shouldReconnect =
              Predicate.isTagged(error, "AttachTransportClosedError") &&
              !hasUnknownTurnOutcome &&
              !released &&
              !reconnecting &&
              hasReconnectableSubscription;
            const barrier = shouldReconnect
              ? yield* Deferred.make<void, AttachClientError>()
              : undefined;
            if (barrier !== undefined) {
              reconnecting = true;
              reconnectBarrier = barrier;
            }
            yield* closeConnection(target, error);
            if (!Predicate.isTagged(error, "AttachTransportClosedError")) {
              yield* failAllSubscriptions(error);
              return;
            }
            if (hasUnknownTurnOutcome) {
              yield* failAllSubscriptions(new AttachDisconnectedError({ phase: "request" }));
              return;
            }
            if (barrier === undefined) return;
            yield* publishConnectionLost().pipe(
              Effect.andThen(reconnectSubscriptions()),
              Effect.matchEffect({
                onSuccess: () => Deferred.succeed(barrier, undefined).pipe(Effect.asVoid),
                onFailure: (reconnectError) =>
                  Deferred.fail(barrier, reconnectError).pipe(
                    Effect.andThen(failAllSubscriptions(reconnectError)),
                  ),
              }),
              Effect.ensuring(
                Effect.uninterruptible(
                  Deferred.fail(barrier, new AttachDisconnectedError({ phase: "setup" })).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        if (reconnectBarrier === barrier) reconnectBarrier = undefined;
                        reconnecting = false;
                      }),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      );

    const openInitialized = (): Effect.Effect<Connection, AttachClientError> =>
      Effect.gen(function* () {
        const transport = yield* Scope.provide(options.transport.connect, scope);
        connectionSequence += 1;
        const opened: Connection = {
          id: connectionSequence,
          transport,
          pending: new Map(),
          tombstones: new Set(),
          orphanEvents: [],
          staging: true,
          closed: false,
        };
        openConnections.set(opened.id, opened);
        return yield* Effect.gen(function* () {
          yield* FiberSet.run(fibers, reader(opened), { startImmediately: true });
          const initialized = yield* requestOn(opened, {
            schemaVersion: PROTOCOL_VERSION,
            requestId: yield* nextRequestId(),
            method: "initialize",
            params: {
              client: { name: options.client.name, version: options.client.version },
              features: options.client.features ?? [],
            },
          });
          if (initialized.method !== "initialize") {
            return yield* new AttachProtocolStateError({
              message: "Daemon returned the wrong initialize response",
            });
          }
          if (
            PROTOCOL_VERSION !== REQUIRED_PROTOCOL_VERSION ||
            initialized.result.protocolVersion !== REQUIRED_PROTOCOL_VERSION
          ) {
            return yield* new AttachProtocolCompatibilityError({
              protocolVersion: initialized.result.protocolVersion,
            });
          }
          const required: ReadonlyArray<ServerFeature> = [
            "stableMainSession",
            ...(options.requiredFeatures ?? []),
          ];
          for (const feature of required) {
            if (!initialized.result.features.includes(feature)) {
              return yield* new AttachProtocolCompatibilityError({
                protocolVersion: initialized.result.protocolVersion,
                missingFeature: feature,
              });
            }
          }
          return opened;
        }).pipe(Effect.onError(() => closeConnection(opened)));
      });

    const establish = (): Effect.Effect<Connection, AttachClientError> =>
      Effect.suspend(() => {
        const barrier = reconnectBarrier;
        if (barrier !== undefined) {
          return Deferred.await(barrier).pipe(Effect.andThen(establish));
        }
        return connectionGate.withPermit(
          Effect.gen(function* () {
            if (released) return yield* new AttachDisconnectedError({ phase: "setup" });
            const current = connection;
            if (current !== undefined && !current.closed) return current;
            const opened = yield* openInitialized();
            opened.staging = false;
            connection = opened;
            return opened;
          }),
        );
      });

    const abandonRequest = (
      target: Connection,
      requestId: string,
      pending: PendingRequest,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (target.pending.get(requestId) !== pending) return Effect.void;
        target.pending.delete(requestId);
        if (!pending.writeAttempted) return Effect.void;
        if (target.tombstones.size >= maxRequestTombstones) {
          return closeConnection(
            target,
            new AttachClientQueueOverflowError({
              queue: "tombstones",
              capacity: maxRequestTombstones,
            }),
          );
        }
        target.tombstones.add(requestId);
        return Effect.void;
      });

    const requestOn = (
      target: Connection,
      frame: ClientRequestFrame,
    ): Effect.Effect<ServerSuccessFrame, AttachClientError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* validateRequestId(frame.requestId);
          if (target.closed) return yield* new AttachDisconnectedError({ phase: "request" });
          if (target.pending.has(frame.requestId) || target.tombstones.has(frame.requestId)) {
            return yield* new AttachProtocolStateError({
              message: `Request id ${frame.requestId} is already in flight`,
            });
          }
          if (target.pending.size >= maxPendingRequests) {
            return yield* new AttachClientQueueOverflowError({
              queue: "pending",
              capacity: maxPendingRequests,
            });
          }
          const deferred = yield* Deferred.make<ServerSuccessFrame, AttachClientError>();
          const pending: PendingRequest = {
            deferred,
            method: frame.method,
            sessionId: frame.method === "turn/start" ? frame.params.sessionId : undefined,
            writeAttempted: false,
          };
          target.pending.set(frame.requestId, pending);
          pending.writeAttempted = true;
          const writeAndAwait = target.transport.write(frame).pipe(
            Effect.mapError((error) =>
              frame.method === "turn/start"
                ? new AttachOutcomeUnknownError({ sessionId: frame.params.sessionId })
                : transportRequestError(error),
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                if (target.pending.get(frame.requestId) === pending) {
                  target.pending.delete(frame.requestId);
                }
              }),
            ),
            Effect.andThen(Deferred.await(deferred)),
          );
          return yield* restore(writeAndAwait).pipe(
            Effect.onInterrupt(() => abandonRequest(target, frame.requestId, pending)),
          );
        }),
      );

    const request = (
      frame: ClientRequestFrame,
    ): Effect.Effect<ServerSuccessFrame, AttachClientError> =>
      establish().pipe(Effect.flatMap((target) => requestOn(target, frame)));

    const unsubscribeOn = (
      target: Connection,
      subscriptionId: string,
    ): Effect.Effect<void, AttachClientError> =>
      Effect.gen(function* () {
        const requestId = yield* nextRequestId();
        yield* requestOn(target, {
          schemaVersion: PROTOCOL_VERSION,
          requestId,
          method: "session/unsubscribe",
          params: { subscriptionId },
        });
      });

    const subscribeOn = (
      target: Connection,
      subscription: SubscriptionState,
    ): Effect.Effect<CandidateBinding | undefined, AttachClientError> =>
      Effect.gen(function* () {
        if (!subscription.active) return undefined;
        const sinceSeq = subscription.lastAppliedSeq;
        const requestId = yield* nextRequestId();
        const response = yield* requestOn(target, {
          schemaVersion: PROTOCOL_VERSION,
          requestId,
          method: "session/subscribe",
          params: {
            sessionId: subscription.sessionId,
            sinceSeq,
          },
        });
        if (response.method !== "session/subscribe") {
          return yield* new AttachProtocolStateError({
            message: "Daemon returned the wrong subscribe response",
          });
        }
        if (response.result.replayThroughSeq < sinceSeq) {
          return yield* new AttachProtocolStateError({
            message: "Daemon replay watermark preceded the requested sequence",
          });
        }
        if (target.closed) return yield* new AttachDisconnectedError({ phase: "request" });
        if (!subscription.active) {
          yield* unsubscribeOn(target, response.result.subscriptionId);
          return undefined;
        }
        return {
          subscription,
          subscriptionId: response.result.subscriptionId,
          replayWatermark: response.result.replayThroughSeq,
        };
      });

    const releaseStagedEvents = (target: Connection): Effect.Effect<void, AttachClientError> =>
      Effect.gen(function* () {
        const wasStaging = target.staging;
        do {
          const orphaned = target.orphanEvents.splice(0);
          for (const orphan of orphaned) {
            const subscription = [...subscriptions].find(
              (candidate) =>
                candidate.active &&
                candidate.binding?.connectionId === target.id &&
                candidate.binding.subscriptionId === orphan.subscriptionId &&
                orphan.event.envelope.event.sessionId === candidate.sessionId,
            );
            if (subscription !== undefined) {
              yield* applyBufferedEnvelope(subscription, orphan.event);
            } else if (wasStaging) {
              yield* releaseBuffered(orphan.event);
            } else {
              target.orphanEvents.push(orphan);
            }
          }
        } while (wasStaging && target.orphanEvents.length > 0);
        target.staging = false;
      });

    const commitBindings = (
      target: Connection,
      bindings: ReadonlyArray<CandidateBinding>,
    ): Effect.Effect<ReadonlyArray<string>> =>
      Effect.sync(() => {
        const inactive: string[] = [];
        for (const binding of bindings) {
          if (!binding.subscription.active) {
            inactive.push(binding.subscriptionId);
            continue;
          }
          binding.subscription.binding = {
            connectionId: target.id,
            subscriptionId: binding.subscriptionId,
          };
          binding.subscription.replayWatermark = binding.replayWatermark;
          binding.subscription.reconnectable = true;
        }
        connection = target;
        return inactive;
      });

    const reconnectSubscriptions = (): Effect.Effect<void, AttachClientError> => {
      let attempts = 0;
      const attempt = Effect.gen(function* () {
        if (released) return yield* new AttachDisconnectedError({ phase: "setup" });
        attempts += 1;
        const active = [...subscriptions].filter(
          (subscription) => subscription.active && subscription.reconnectable,
        );
        yield* Effect.forEach(
          active,
          (subscription) =>
            publishChange(subscription, { type: "retry-started", attempt: attempts }),
          { discard: true },
        );
        yield* connectionGate.withPermit(
          Effect.gen(function* () {
            const target = yield* openInitialized().pipe(
              Effect.catchTag("AttachDisconnectedError", (error) =>
                error.phase === "request"
                  ? Effect.fail(new AttachDisconnectedError({ phase: "setup" }))
                  : Effect.fail(error),
              ),
            );
            yield* Effect.gen(function* () {
              const bindings: CandidateBinding[] = [];
              for (const subscription of active) {
                if (!subscription.active) continue;
                const binding = yield* subscribeOn(target, subscription).pipe(
                  Effect.catchTag("AttachDisconnectedError", (error) =>
                    error.phase === "request"
                      ? Effect.fail(new AttachDisconnectedError({ phase: "replay" }))
                      : Effect.fail(error),
                  ),
                );
                if (binding !== undefined) bindings.push(binding);
              }
              const inactiveSubscriptionIds = yield* commitBindings(target, bindings);
              yield* Effect.forEach(
                inactiveSubscriptionIds,
                (subscriptionId) => unsubscribeOn(target, subscriptionId),
                { discard: true },
              );
              for (const binding of bindings) {
                if (!binding.subscription.active) continue;
                yield* publishChange(binding.subscription, {
                  type: "replay-started",
                  replayThroughSeq: binding.replayWatermark,
                });
              }
              yield* releaseStagedEvents(target);
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : closeConnection(target),
              ),
            );
          }),
        );
      });
      const retryPolicy = Schedule.max([
        Schedule.exponential(RECONNECT_INITIAL_DELAY),
        Schedule.recurs(RECONNECT_ATTEMPTS - 1),
      ]).pipe(
        Schedule.setInputType<AttachClientError>(),
        Schedule.while(({ input }) => !released && isReconnectDisconnect(input)),
      );
      return Effect.retryOrElse(attempt, retryPolicy, (lastCause) =>
        isReconnectDisconnect(lastCause)
          ? Effect.fail(new AttachReconnectExhaustedError({ attempts, lastCause }))
          : Effect.fail(lastCause),
      );
    };

    const makeSubscription = (
      sessionId: string,
      sinceSeq: number,
    ): Effect.Effect<AttachSubscription, AttachClientError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (subscriptions.size >= maxActiveSubscriptions) {
            return yield* new AttachClientQueueOverflowError({
              queue: "subscriptions",
              capacity: maxActiveSubscriptions,
            });
          }
          const queue = yield* Queue.bounded<BufferedEvent, AttachClientError>(eventQueueCapacity);
          const changes = yield* Queue.bounded<AttachSubscriptionChange, AttachClientError>(
            eventQueueCapacity,
          );
          const state: SubscriptionState = {
            sessionId,
            queue,
            changes,
            reordered: new Map(),
            buffered: new Set(),
            active: true,
            reconnectable: false,
            expectedSeq: sinceSeq + 1,
            lastAppliedSeq: sinceSeq,
            replayWatermark: sinceSeq,
            binding: undefined,
          };
          subscriptions.add(state);

          const shutdown = Effect.suspend(() => {
            state.active = false;
            subscriptions.delete(state);
            state.binding = undefined;
            return Queue.shutdown(state.queue).pipe(
              Effect.andThen(Queue.shutdown(state.changes)),
              Effect.andThen(releaseSubscriptionBuffers(state)),
            );
          });

          let setupTarget: Connection | undefined;
          let candidateSubscriptionId: string | undefined;
          const cleanup = Effect.uninterruptibleMask((restoreCleanup) =>
            Effect.suspend(() => {
              const currentBinding = state.binding;
              const owner =
                currentBinding === undefined
                  ? setupTarget
                  : openConnections.get(currentBinding.connectionId);
              const subscriptionId = currentBinding?.subscriptionId ?? candidateSubscriptionId;
              candidateSubscriptionId = undefined;
              return shutdown.pipe(
                Effect.andThen(
                  subscriptionId !== undefined && owner !== undefined
                    ? restoreCleanup(unsubscribeOn(owner, subscriptionId))
                    : setupTarget === undefined
                      ? Effect.void
                      : closeConnection(setupTarget),
                ),
              );
            }),
          );

          let transferred = false;
          return yield* restore(
            Effect.gen(function* () {
              const target = yield* establish();
              setupTarget = target;
              const binding = yield* subscribeOn(target, state);
              if (binding === undefined) {
                return yield* new AttachDisconnectedError({ phase: "setup" });
              }
              candidateSubscriptionId = binding.subscriptionId;
              yield* commitBindings(target, [binding]);
              candidateSubscriptionId = undefined;
              yield* releaseStagedEvents(target);
              const close = Effect.suspend(() => (state.active ? cleanup : Effect.void));
              const subscription: AttachSubscription = {
                sessionId,
                next: Queue.take(queue).pipe(
                  Effect.flatMap((buffered) =>
                    Effect.sync(() => {
                      state.buffered.delete(buffered);
                      state.lastAppliedSeq = Math.max(state.lastAppliedSeq, buffered.envelope.seq);
                      return buffered.envelope;
                    }).pipe(Effect.ensuring(releaseBuffered(buffered))),
                  ),
                ),
                nextChange: Queue.take(changes),
                lastAppliedSeq: Effect.sync(() => state.lastAppliedSeq),
                replayThroughSeq: Effect.sync(() => state.replayWatermark),
                close,
              };
              transferred = true;
              return subscription;
            }),
          ).pipe(
            Effect.onExit((exit) => (Exit.isSuccess(exit) && transferred ? Effect.void : cleanup)),
          );
        }),
      );

    const ensureMain = Effect.gen(function* () {
      const response = yield* request({
        schemaVersion: PROTOCOL_VERSION,
        requestId: yield* nextRequestId(),
        method: "session/ensure",
        params: { sessionId: MAIN_SESSION_ID },
      });
      return response.method === "session/ensure"
        ? response.result.session
        : yield* new AttachProtocolStateError({
            message: "Daemon returned the wrong ensure response",
          });
    });

    const setupMainTurn = (
      sinceSeq: number | undefined,
    ): Effect.Effect<AttachSubscription, AttachClientError> =>
      ensureMain.pipe(
        Effect.flatMap((summary) => makeSubscription(MAIN_SESSION_ID, sinceSeq ?? summary.lastSeq)),
      );

    const setupMainTurnOnceRetry = (
      sinceSeq: number | undefined,
    ): Effect.Effect<AttachSubscription, AttachClientError> =>
      setupMainTurn(sinceSeq).pipe(
        Effect.catch((firstError) => {
          if (!isSetupDisconnect(firstError)) return Effect.fail(firstError);
          return closeCurrent().pipe(
            Effect.andThen(setupMainTurn(sinceSeq)),
            Effect.mapError(
              (secondError) => new AttachSetupRetryExhaustedError({ cause: secondError }),
            ),
          );
        }),
      );

    const closeCurrent = (): Effect.Effect<void> => {
      const current = connection;
      return current === undefined ? Effect.void : closeConnection(current);
    };

    const startTurn = (
      sessionId: string,
      message: string,
    ): Effect.Effect<TurnStartResponse, AttachClientError> =>
      Effect.gen(function* () {
        const target = yield* establish();
        const response = yield* requestOn(target, {
          schemaVersion: PROTOCOL_VERSION,
          requestId: yield* nextRequestId(),
          method: "turn/start",
          params: { sessionId, message },
        });
        if (response.method !== "turn/start") {
          return yield* new AttachProtocolStateError({
            message: "Daemon returned the wrong turn/start response",
          });
        }
        return response.result;
      });

    const client: AttachClient = {
      ensureMain,
      listSessions: Effect.gen(function* () {
        const response = yield* request({
          schemaVersion: PROTOCOL_VERSION,
          requestId: yield* nextRequestId(),
          method: "session/list",
          params: {},
        });
        return response.method === "session/list"
          ? response.result.sessions
          : yield* new AttachProtocolStateError({
              message: "Daemon returned the wrong list response",
            });
      }),
      subscribe: makeSubscription,
      startMainTurn: (message, sinceSeq) =>
        Effect.gen(function* () {
          const subscription = yield* setupMainTurnOnceRetry(sinceSeq);
          return yield* startTurn(MAIN_SESSION_ID, message).pipe(
            Effect.map((acceptance) => ({ acceptance, subscription })),
            Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : subscription.close)),
          );
        }),
      startTurn,
      steerTurn: (sessionId, expectedTurnId, message) =>
        Effect.gen(function* () {
          const response = yield* request({
            schemaVersion: PROTOCOL_VERSION,
            requestId: yield* nextRequestId(),
            method: "turn/steer",
            params: { sessionId, expectedTurnId, message },
          });
          return response.method === "turn/steer"
            ? response.result.turnId
            : yield* new AttachProtocolStateError({
                message: "Daemon returned the wrong steer response",
              });
        }),
      interruptTurn: (sessionId, expectedTurnId) =>
        Effect.gen(function* () {
          const response = yield* request({
            schemaVersion: PROTOCOL_VERSION,
            requestId: yield* nextRequestId(),
            method: "turn/interrupt",
            params: { sessionId, expectedTurnId },
          });
          return response.method === "turn/interrupt"
            ? response.result.turnId
            : yield* new AttachProtocolStateError({
                message: "Daemon returned the wrong interrupt response",
              });
        }),
      resolveApproval: (sessionId, approvalId, decision) =>
        Effect.gen(function* () {
          const response = yield* request({
            schemaVersion: PROTOCOL_VERSION,
            requestId: yield* nextRequestId(),
            method: "approval/resolve",
            params: { sessionId, approvalId, decision },
          });
          return response.method === "approval/resolve"
            ? response.result.outcome
            : yield* new AttachProtocolStateError({
                message: "Daemon returned the wrong approval response",
              });
        }),
    };

    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        if (released) return;
        released = true;
        const barrier = reconnectBarrier;
        if (barrier !== undefined) {
          yield* Deferred.fail(barrier, new AttachDisconnectedError({ phase: "setup" }));
          if (reconnectBarrier === barrier) reconnectBarrier = undefined;
          reconnecting = false;
        }
        yield* Effect.forEach([...subscriptions], (subscription) => {
          subscription.active = false;
          return Queue.shutdown(subscription.queue).pipe(
            Effect.andThen(Queue.shutdown(subscription.changes)),
            Effect.andThen(releaseSubscriptionBuffers(subscription)),
          );
        });
        subscriptions.clear();
        yield* Effect.forEach([...openConnections.values()], (target) => closeConnection(target), {
          discard: true,
        });
      }),
    );

    return client;
  });
}

function isReconnectDisconnect(error: AttachClientError): boolean {
  return (
    Predicate.isTagged(error, "AttachTransportOpenError") ||
    (Predicate.isTagged(error, "AttachDisconnectedError") && error.phase !== "request")
  );
}

function isSetupDisconnect(error: AttachClientError): boolean {
  return (
    Predicate.isTagged(error, "AttachDisconnectedError") ||
    Predicate.isTagged(error, "AttachTransportOpenError")
  );
}

function transportRequestError(
  error: AttachTransportClosedError | AttachTransportWriteError,
): AttachDisconnectedError | AttachTransportWriteError {
  return Predicate.isTagged(error, "AttachTransportClosedError")
    ? new AttachDisconnectedError({ phase: "request" })
    : error;
}

function validateRequestId(requestId: string): Effect.Effect<string, AttachProtocolStateError> {
  return requestId.length > 0 && Buffer.byteLength(requestId, "utf8") <= MAX_REQUEST_ID_BYTES
    ? Effect.succeed(requestId)
    : Effect.fail(
        new AttachProtocolStateError({
          message: `Request id must contain 1-${MAX_REQUEST_ID_BYTES} UTF-8 bytes`,
        }),
      );
}

function decodedEventBytes(envelope: SessionEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function positiveCapacity(
  value: number | undefined,
  fallback: number,
  queue: AttachClientQueueOverflowError["queue"],
): Effect.Effect<number, AttachProtocolStateError> {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved > 0
    ? Effect.succeed(resolved)
    : Effect.fail(
        new AttachProtocolStateError({ message: `${queue} capacity must be a positive integer` }),
      );
}
