import { describe, expect, it } from "bun:test";
import {
  MAIN_SESSION_ID,
  PROTOCOL_VERSION,
  type ClientRequestFrame,
  type ExtensionObservation,
  type ServerFeature,
  type ServerFrame,
  type SessionEnvelope,
  type SessionSummary,
} from "../../packages/protocol/src/index.ts";
import {
  AttachClientQueueOverflowError,
  AttachDisconnectedError,
  AttachOutcomeUnknownError,
  AttachProtocolCompatibilityError,
  AttachProtocolRejectedError,
  AttachProtocolStateError,
  AttachReconnectExhaustedError,
  AttachSetupRetryExhaustedError,
  AttachTransportClosedError,
  AttachTransportOpenError,
  AttachTransportQueueOverflowError,
  AttachTransportWriteError,
  createAttachClient,
  type AttachTransport,
  type AttachTransportError,
  type AttachTransportFactory,
} from "../../packages/ziggy/src/attach.ts";
import { Deferred, Effect, Exit, Fiber, Queue, Scope } from "effect";
import { runScopedEffect } from "../testkit/effect.ts";

const mainSummary: SessionSummary = {
  sessionId: MAIN_SESSION_ID,
  createdAt: "2026-07-21T00:00:00.000Z",
  lastSeq: 0,
};
const extensionDigest = "a".repeat(64);
const extensionObservation: ExtensionObservation = {
  id: "fixture",
  version: "1.0.0",
  name: "Fixture",
  enabled: false,
  trustTier: "community",
  treeDigest: extensionDigest,
  approvalEpoch: 0,
  health: "ready",
};

const envelope = (
  seq: number,
  turnId = "turn-1",
  sessionId = MAIN_SESSION_ID,
): SessionEnvelope => ({
  schemaVersion: 1,
  seq,
  emittedAt: "2026-07-21T00:00:00.000Z",
  event: {
    type: "turn-ended",
    sessionId,
    turnId,
    status: "completed",
  },
});

type WriteHandler = (
  request: ClientRequestFrame,
  transport: FakeAttachTransport,
) => Effect.Effect<void, AttachTransportClosedError | AttachTransportWriteError>;

class FakeAttachTransport implements AttachTransport {
  readonly writes: ClientRequestFrame[] = [];
  closeCalls = 0;
  private closed = false;

  constructor(
    private readonly inbound: Queue.Queue<ServerFrame, AttachTransportError>,
    private readonly received: Queue.Queue<ServerFrame>,
    private readonly onWrite: WriteHandler,
  ) {}

  get receive() {
    return Queue.take(this.inbound).pipe(Effect.tap((frame) => Queue.offer(this.received, frame)));
  }

  write = (
    request: ClientRequestFrame,
  ): Effect.Effect<void, AttachTransportClosedError | AttachTransportWriteError> =>
    Effect.suspend(() => {
      if (this.closed) return Effect.fail(new AttachTransportClosedError());
      this.writes.push(request);
      return this.onWrite(request, this);
    });

  readonly close = Effect.suspend(() => {
    if (this.closed) return Effect.void;
    this.closed = true;
    this.closeCalls += 1;
    return Queue.fail(this.inbound, new AttachTransportClosedError()).pipe(Effect.asVoid);
  });

  send(frame: ServerFrame): Effect.Effect<void> {
    return Queue.offer(this.inbound, frame).pipe(Effect.asVoid);
  }

  disconnect(): Effect.Effect<void> {
    return this.close;
  }

  failInbound(error: AttachTransportError): Effect.Effect<void> {
    return Queue.fail(this.inbound, error).pipe(Effect.asVoid);
  }

  get awaitReceived(): Effect.Effect<ServerFrame> {
    return Queue.take(this.received);
  }
}

interface FakeFactory {
  readonly factory: AttachTransportFactory;
  readonly transports: FakeAttachTransport[];
  readonly attempts: () => number;
}

function fakeFactory(
  handlers: ReadonlyArray<WriteHandler | "fail-open">,
): Effect.Effect<FakeFactory, never, Scope.Scope> {
  return Effect.sync(() => {
    const transports: FakeAttachTransport[] = [];
    let attempts = 0;
    const factory: AttachTransportFactory = {
      connect: Effect.suspend(() => {
        const handler = handlers[attempts];
        attempts += 1;
        if (handler === undefined || handler === "fail-open") {
          return Effect.fail(new AttachTransportOpenError());
        }
        return Effect.gen(function* () {
          const inbound = yield* Queue.unbounded<ServerFrame, AttachTransportError>();
          const received = yield* Queue.unbounded<ServerFrame>();
          const transport = new FakeAttachTransport(inbound, received, handler);
          transports.push(transport);
          yield* Scope.addFinalizer(yield* Effect.scope, transport.close);
          return transport;
        });
      }),
    };
    return { factory, transports, attempts: () => attempts };
  });
}

function clientFor(
  transport: AttachTransportFactory,
  options: {
    readonly eventQueueCapacity?: number;
    readonly maxOrphanEvents?: number;
    readonly maxPendingRequests?: number;
    readonly maxReorderedEvents?: number;
    readonly maxActiveSubscriptions?: number;
    readonly maxBufferedEvents?: number;
    readonly maxBufferedEventBytes?: number;
    readonly maxRequestTombstones?: number;
    readonly nextRequestId?: () => string;
  } = {},
) {
  const defaultNextRequestId = (() => {
    let id = 0;
    return () => `request-${++id}`;
  })();
  return createAttachClient({
    transport,
    client: { name: "attach-client-test", version: "0.0.0" },
    ...options,
    nextRequestId: options.nextRequestId ?? defaultNextRequestId,
  });
}

function standardResponse(
  request: ClientRequestFrame,
  features: ReadonlyArray<ServerFeature> = ["stableMainSession", "sessionReplay"],
): ServerFrame {
  switch (request.method) {
    case "initialize":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "initialize",
        type: "success",
        result: { protocolVersion: PROTOCOL_VERSION, features },
      };
    case "session/ensure":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/ensure",
        type: "success",
        result: { session: mainSummary },
      };
    case "session/subscribe":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/subscribe",
        type: "success",
        result: { subscriptionId: "subscription-1", replayThroughSeq: request.params.sinceSeq },
      };
    case "session/list":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/list",
        type: "success",
        result: { sessions: [mainSummary] },
      };
    case "turn/start":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "turn/start",
        type: "success",
        result: { turnId: "turn-1", disposition: "started" },
      };
    case "session/unsubscribe":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "session/unsubscribe",
        type: "success",
        result: { unsubscribed: true },
      };
    case "extension/install":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "extension/install",
        type: "success",
        result: { status: "installed", extension: extensionObservation },
      };
    case "extension/enable":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "extension/enable",
        type: "success",
        result: { status: "enabled", extension: { ...extensionObservation, enabled: true } },
      };
    case "extension/disable":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "extension/disable",
        type: "success",
        result: { extension: extensionObservation },
      };
    case "extension/list":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "extension/list",
        type: "success",
        result: { extensions: [extensionObservation] },
      };
    case "extension/doctor":
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: "extension/doctor",
        type: "success",
        result: {
          extension: extensionObservation,
          status: "ok",
          exitCode: 0,
          stdout: "healthy\n",
          stderr: "",
          truncated: false,
        },
      };
    default:
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        type: "error",
        code: "invalid-params",
        message: "unsupported fixture request",
      };
  }
}

const standardHandler: WriteHandler = (request, transport) =>
  transport.send(standardResponse(request));

function methods(
  transport: FakeAttachTransport | undefined,
): ReadonlyArray<ClientRequestFrame["method"]> | undefined {
  return transport?.writes.map((request) => request.method);
}

describe("scoped Effect Attach Client", () => {
  it("correlates responses while applying interleaved subscription events", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "turn/start"
              ? transport
                  .send({
                    schemaVersion: PROTOCOL_VERSION,
                    type: "event",
                    subscriptionId: "subscription-1",
                    event: envelope(1),
                  })
                  .pipe(Effect.andThen(transport.send(standardResponse(request))))
              : transport.send(standardResponse(request)),
        ]);
        const client = yield* clientFor(harness.factory);
        const accepted = yield* client.startMainTurn("hello", 0);
        const event = yield* accepted.subscription.next;
        return {
          acceptance: accepted.acceptance,
          eventSeq: event.seq,
          methods: methods(harness.transports[0]),
          schemaVersions: harness.transports[0]?.writes.map((request) => request.schemaVersion),
        };
      }),
    );

    expect(result).toEqual({
      acceptance: { turnId: "turn-1", disposition: "started" },
      eventSeq: 1,
      methods: ["initialize", "session/ensure", "session/subscribe", "turn/start"],
      schemaVersions: [2, 2, 2, 2],
    });
  });

  it("correlates concurrent responses that arrive in reverse request order", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const ensureWritten = yield* Deferred.make<void>();
        const releaseEnsure = yield* Deferred.make<void>();
        const harness = yield* fakeFactory([
          (request, transport) => {
            if (request.method === "session/ensure") {
              return Deferred.succeed(ensureWritten, undefined).pipe(
                Effect.andThen(Deferred.await(releaseEnsure)),
                Effect.andThen(transport.send(standardResponse(request))),
              );
            }
            if (request.method === "session/list") {
              return transport
                .send(standardResponse(request))
                .pipe(Effect.andThen(Deferred.succeed(releaseEnsure, undefined)), Effect.asVoid);
            }
            return transport.send(standardResponse(request));
          },
        ]);
        const client = yield* clientFor(harness.factory);
        const ensuredFiber = yield* Effect.forkScoped(client.ensureMain);
        yield* Deferred.await(ensureWritten);
        const listed = yield* client.listSessions;
        const ensured = yield* Fiber.join(ensuredFiber);
        return { ensured, listed };
      }),
    );

    expect(result).toEqual({ ensured: mainSummary, listed: [mainSummary] });
  });

  it("sends Extension lifecycle intent only through the negotiated attach connection", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) =>
            transport.send(
              standardResponse(request, [
                "stableMainSession",
                "sessionReplay",
                "extensionLifecycle",
              ]),
            ),
        ]);
        const client = yield* clientFor(harness.factory);
        const installed = yield* client.installExtension({
          sourcePath: "/tmp/fixture",
          approvals: [extensionDigest],
        });
        const enabled = yield* client.enableExtension({
          extensionId: "fixture",
          approvals: [extensionDigest],
        });
        const disabled = yield* client.disableExtension("fixture");
        const listed = yield* client.listExtensions;
        const doctor = yield* client.doctorExtension({
          extensionId: "fixture",
          approval: extensionDigest,
        });
        return {
          installed,
          enabled,
          disabled,
          listed,
          doctor,
          requests: harness.transports[0]?.writes,
        };
      }),
    );

    expect(result.installed).toEqual({ status: "installed", extension: extensionObservation });
    expect(result.enabled).toMatchObject({ status: "enabled", extension: { enabled: true } });
    expect(result.disabled).toEqual(extensionObservation);
    expect(result.listed).toEqual([extensionObservation]);
    expect(result.doctor).toMatchObject({ status: "ok", stdout: "healthy\n" });
    expect(result.requests?.map((request) => request.method)).toEqual([
      "initialize",
      "extension/install",
      "extension/enable",
      "extension/disable",
      "extension/list",
      "extension/doctor",
    ]);
  });

  it("rejects a concurrent request id collision without orphaning the first waiter", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const firstRequestWritten = yield* Deferred.make<void>();
        const releaseFirstRequest = yield* Deferred.make<void>();
        const harness = yield* fakeFactory([
          (request, transport) => {
            if (request.method === "initialize") {
              return transport.send(standardResponse(request));
            }
            return Deferred.succeed(firstRequestWritten, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstRequest)),
              Effect.andThen(transport.send(standardResponse(request))),
            );
          },
        ]);
        const client = yield* clientFor(harness.factory, {
          nextRequestId: () => "colliding-request",
        });
        const first = yield* Effect.forkScoped(client.ensureMain);
        yield* Deferred.await(firstRequestWritten);
        const collision = yield* Effect.flip(client.listSessions);
        yield* Deferred.succeed(releaseFirstRequest, undefined);
        const ensured = yield* Fiber.join(first);
        return { collision, ensured, methods: methods(harness.transports[0]) };
      }),
    );

    expect(result).toEqual({
      collision: new AttachProtocolStateError({
        message: "Request id colliding-request is already in flight",
      }),
      ensured: mainSummary,
      methods: ["initialize", "session/ensure"],
    });
  });

  it("deduplicates and reorders replay through the advertised watermark", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) => {
            if (request.method !== "session/subscribe") {
              return transport.send(standardResponse(request));
            }
            return transport
              .send({
                schemaVersion: PROTOCOL_VERSION,
                requestId: request.requestId,
                method: "session/subscribe",
                type: "success",
                result: { subscriptionId: "subscription-1", replayThroughSeq: 3 },
              })
              .pipe(
                Effect.andThen(
                  Effect.forEach([envelope(3), envelope(1), envelope(2), envelope(2)], (event) =>
                    transport.send({
                      schemaVersion: PROTOCOL_VERSION,
                      type: "event",
                      subscriptionId: "subscription-1",
                      event,
                    }),
                  ),
                ),
              );
          },
        ]);
        const client = yield* clientFor(harness.factory);
        yield* client.ensureMain;
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const events = yield* Effect.all(
          [subscription.next, subscription.next, subscription.next],
          { concurrency: 1 },
        );
        return {
          sequences: events.map((event) => event.seq),
          watermark: yield* subscription.replayThroughSeq,
          lastApplied: yield* subscription.lastAppliedSeq,
        };
      }),
    );

    expect(result).toEqual({ sequences: [1, 2, 3], watermark: 3, lastApplied: 3 });
  });

  it("backpressures a bounded event queue instead of dropping normal replay", async () => {
    const sequences = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? transport.send(standardResponse(request)).pipe(
                  Effect.andThen(
                    Effect.forEach([envelope(1), envelope(2)], (event) =>
                      transport.send({
                        schemaVersion: PROTOCOL_VERSION,
                        type: "event",
                        subscriptionId: "subscription-1",
                        event,
                      }),
                    ),
                  ),
                )
              : transport.send(standardResponse(request)),
        ]);
        const client = yield* clientFor(harness.factory, { eventQueueCapacity: 1 });
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        yield* Effect.sleep("20 millis");
        const events = yield* Effect.all([subscription.next, subscription.next], {
          concurrency: 1,
        });
        return events.map((event) => event.seq);
      }),
    );

    expect(sequences).toEqual([1, 2]);
  });

  it("closes a subscription while its full event queue blocks the reader", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? transport.send(standardResponse(request)).pipe(
                  Effect.andThen(
                    Effect.forEach([envelope(1), envelope(2)], (event) =>
                      transport.send({
                        schemaVersion: PROTOCOL_VERSION,
                        type: "event",
                        subscriptionId: "subscription-1",
                        event,
                      }),
                    ),
                  ),
                )
              : transport.send(standardResponse(request)),
        ]);
        const client = yield* clientFor(harness.factory, { eventQueueCapacity: 1 });
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        yield* Effect.sleep("20 millis");
        yield* subscription.close;
        return methods(harness.transports[0]);
      }),
    );

    expect(result).toEqual(["initialize", "session/subscribe", "session/unsubscribe"]);
  });

  it("surfaces transport queue overflow without reconnecting", async () => {
    const overflow = new AttachTransportQueueOverflowError({
      queuedFrames: 128,
      queuedBytes: 1_048_576,
    });
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([standardHandler, standardHandler]);
        const client = yield* clientFor(harness.factory);
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const transport = harness.transports.at(0);
        if (transport === undefined) return yield* new AttachTransportClosedError();
        yield* transport.failInbound(overflow);
        const error = yield* Effect.flip(subscription.next);
        return { error, attempts: harness.attempts() };
      }),
    );

    expect(result).toEqual({ error: overflow, attempts: 1 });
  });

  it("fails pending, reorder, and orphan bounds visibly", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const pendingWritten = yield* Deferred.make<void>();
        let pendingListWrites = 0;
        const pendingHarness = yield* fakeFactory([
          (request, transport) => {
            if (request.method !== "session/list") {
              return transport.send(standardResponse(request));
            }
            pendingListWrites += 1;
            return pendingListWrites === 1
              ? Deferred.succeed(pendingWritten, undefined).pipe(Effect.andThen(Effect.never))
              : transport.send(standardResponse(request));
          },
        ]);
        const pendingClient = yield* clientFor(pendingHarness.factory, { maxPendingRequests: 1 });
        yield* pendingClient.ensureMain;
        const pendingFiber = yield* Effect.forkScoped(pendingClient.listSessions);
        yield* Deferred.await(pendingWritten);
        const pendingError = yield* Effect.flip(pendingClient.listSessions);
        yield* Fiber.interrupt(pendingFiber);
        const interruptedRequest = pendingHarness.transports[0]?.writes.find(
          (request) => request.method === "session/list",
        );
        if (interruptedRequest === undefined) return yield* new AttachTransportClosedError();
        const pendingTransport = pendingHarness.transports[0];
        if (pendingTransport === undefined) return yield* new AttachTransportClosedError();
        yield* pendingTransport.send(standardResponse(interruptedRequest));
        yield* pendingTransport.awaitReceived;
        yield* Effect.yieldNow;
        const afterInterrupt = yield* pendingClient.listSessions;
        const pendingAttempts = pendingHarness.attempts();

        const reorderHarness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? transport.send(standardResponse(request)).pipe(
                  Effect.andThen(
                    Effect.forEach([envelope(3), envelope(4)], (event) =>
                      transport.send({
                        schemaVersion: PROTOCOL_VERSION,
                        type: "event",
                        subscriptionId: "subscription-1",
                        event,
                      }),
                    ),
                  ),
                )
              : transport.send(standardResponse(request)),
        ]);
        const reorderClient = yield* clientFor(reorderHarness.factory, {
          maxReorderedEvents: 1,
        });
        const reordered = yield* reorderClient.subscribe(MAIN_SESSION_ID, 0);
        const reorderError = yield* Effect.flip(reordered.next);

        const orphanHarness = yield* fakeFactory([standardHandler]);
        const orphanClient = yield* clientFor(orphanHarness.factory, { maxOrphanEvents: 1 });
        const orphaned = yield* orphanClient.subscribe(MAIN_SESSION_ID, 0);
        const orphanTransport = orphanHarness.transports.at(0);
        if (orphanTransport === undefined) return yield* new AttachTransportClosedError();
        for (const subscriptionId of ["unknown-1", "unknown-2"]) {
          yield* orphanTransport.send({
            schemaVersion: PROTOCOL_VERSION,
            type: "event",
            subscriptionId,
            event: envelope(1),
          });
        }
        const orphanError = yield* Effect.flip(orphaned.next);

        return { pendingError, afterInterrupt, pendingAttempts, reorderError, orphanError };
      }),
    );

    expect(result).toEqual({
      pendingError: new AttachClientQueueOverflowError({ queue: "pending", capacity: 1 }),
      afterInterrupt: [mainSummary],
      pendingAttempts: 1,
      reorderError: new AttachClientQueueOverflowError({ queue: "reorder", capacity: 1 }),
      orphanError: new AttachClientQueueOverflowError({ queue: "orphans", capacity: 1 }),
    });
  });

  it("tombstones an interrupted write without consuming active request capacity", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const firstWriteStarted = yield* Deferred.make<void>();
        let firstRequest: ClientRequestFrame | undefined;
        let listWrites = 0;
        const harness = yield* fakeFactory([
          (request, transport) => {
            if (request.method !== "session/list") {
              return transport.send(standardResponse(request));
            }
            listWrites += 1;
            if (listWrites === 1) {
              firstRequest = request;
              return Deferred.succeed(firstWriteStarted, undefined).pipe(
                Effect.andThen(Effect.never),
              );
            }
            return transport.send(standardResponse(request));
          },
        ]);
        const client = yield* clientFor(harness.factory, { maxPendingRequests: 1 });
        const interrupted = yield* Effect.forkScoped(client.listSessions);
        yield* Deferred.await(firstWriteStarted);
        yield* Fiber.interrupt(interrupted);
        const afterInterrupt = yield* client.listSessions;
        const transport = harness.transports.at(0);
        if (transport === undefined || firstRequest === undefined) {
          return yield* new AttachTransportClosedError();
        }
        yield* transport.send(standardResponse(firstRequest));
        yield* transport.awaitReceived;
        const afterLateResponse = yield* client.listSessions;
        return { afterInterrupt, afterLateResponse, methods: methods(transport) };
      }),
    );

    expect(result).toEqual({
      afterInterrupt: [mainSummary],
      afterLateResponse: [mainSummary],
      methods: ["initialize", "session/list", "session/list", "session/list"],
    });
  });

  it("closes the connection when interrupted-request tombstones are exhausted", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        let blockedWrites = 0;
        const writeStarted = yield* Queue.unbounded<void>();
        const harness = yield* fakeFactory([
          (request, transport) => {
            if (request.method !== "session/list") {
              return transport.send(standardResponse(request));
            }
            blockedWrites += 1;
            return Queue.offer(writeStarted, undefined).pipe(Effect.andThen(Effect.never));
          },
        ]);
        const client = yield* clientFor(harness.factory, {
          maxPendingRequests: 1,
          maxRequestTombstones: 1,
        });
        for (const _expected of [1, 2]) {
          const fiber = yield* Effect.forkScoped(client.listSessions);
          yield* Queue.take(writeStarted);
          yield* Fiber.interrupt(fiber);
        }
        yield* Effect.yieldNow;
        return { blockedWrites, closeCalls: harness.transports[0]?.closeCalls };
      }),
    );

    expect(result).toEqual({ blockedWrites: 2, closeCalls: 1 });
  });

  it("rejects invalid generated request ids before pending insertion or transport write", async () => {
    const oversized = "x".repeat(129);
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const oversizedHarness = yield* fakeFactory([standardHandler]);
        const oversizedClient = yield* clientFor(oversizedHarness.factory, {
          nextRequestId: () => oversized,
        });
        const oversizedError = yield* Effect.flip(oversizedClient.listSessions);

        const throwingHarness = yield* fakeFactory([standardHandler]);
        const throwingClient = yield* clientFor(throwingHarness.factory, {
          nextRequestId: () => decodeURIComponent("%"),
        });
        const generatorError = yield* Effect.flip(throwingClient.listSessions);
        return {
          oversizedError,
          oversizedWrites: oversizedHarness.transports[0]?.writes.length,
          generatorError,
          generatorWrites: throwingHarness.transports[0]?.writes.length,
        };
      }),
    );

    expect(result).toEqual({
      oversizedError: new AttachProtocolStateError({
        message: "Request id must contain 1-128 UTF-8 bytes",
      }),
      oversizedWrites: undefined,
      generatorError: new AttachProtocolStateError({ message: "Request id generator failed" }),
      generatorWrites: undefined,
    });
  });

  it("bounds active subscriptions and aggregate decoded event storage", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const subscriptionIds = new Map<string, string>();
        const harness = yield* fakeFactory([
          (request, transport) => {
            if (request.method !== "session/subscribe") {
              return transport.send(standardResponse(request));
            }
            const subscriptionId = `${request.params.sessionId}-subscription`;
            subscriptionIds.set(request.params.sessionId, subscriptionId);
            return transport.send({
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "session/subscribe",
              type: "success",
              result: { subscriptionId, replayThroughSeq: request.params.sinceSeq },
            });
          },
        ]);
        const client = yield* clientFor(harness.factory, {
          maxActiveSubscriptions: 2,
          maxBufferedEvents: 1,
          maxBufferedEventBytes: Math.max(
            Buffer.byteLength(JSON.stringify(envelope(1)), "utf8"),
            Buffer.byteLength(JSON.stringify(envelope(1, "research-turn", "research")), "utf8"),
          ),
        });
        const main = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const research = yield* client.subscribe("research", 0);
        const countError = yield* Effect.flip(client.subscribe("third", 0));
        const transport = harness.transports.at(0);
        const mainId = subscriptionIds.get(MAIN_SESSION_ID);
        const researchId = subscriptionIds.get("research");
        if (transport === undefined || mainId === undefined || researchId === undefined) {
          return yield* new AttachTransportClosedError();
        }
        yield* transport.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: mainId,
          event: envelope(1),
        });
        yield* transport.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: researchId,
          event: envelope(1, "research-turn", "research"),
        });
        yield* Effect.sleep("20 millis");
        const mainEvent = yield* main.next;
        const researchEvent = yield* research.next;
        yield* main.close;
        const replacement = yield* client.subscribe("third", 0);
        yield* replacement.close;
        return { countError, sequences: [mainEvent.seq, researchEvent.seq] };
      }),
    );

    expect(result).toEqual({
      countError: new AttachClientQueueOverflowError({ queue: "subscriptions", capacity: 2 }),
      sequences: [1, 1],
    });
  });

  it("backpressures independently on client-wide decoded frame and byte budgets", async () => {
    const researchEnvelope = envelope(1, "research-turn", "research");
    const byteCapacity = Math.max(
      Buffer.byteLength(JSON.stringify(envelope(1)), "utf8"),
      Buffer.byteLength(JSON.stringify(researchEnvelope), "utf8"),
    );
    const results = await runScopedEffect(
      Effect.gen(function* () {
        const probes: Array<{
          readonly settledBeforeRelease: boolean;
          readonly sequences: number[];
        }> = [];
        for (const limits of [
          { maxBufferedEvents: 1, maxBufferedEventBytes: byteCapacity * 4 },
          { maxBufferedEvents: 4, maxBufferedEventBytes: byteCapacity },
        ]) {
          const harness = yield* fakeFactory([
            (request, transport) =>
              request.method === "session/subscribe"
                ? transport.send({
                    schemaVersion: PROTOCOL_VERSION,
                    requestId: request.requestId,
                    method: "session/subscribe",
                    type: "success",
                    result: {
                      subscriptionId: `${request.params.sessionId}-subscription`,
                      replayThroughSeq: request.params.sinceSeq,
                    },
                  })
                : transport.send(standardResponse(request)),
          ]);
          const client = yield* clientFor(harness.factory, limits);
          const main = yield* client.subscribe(MAIN_SESSION_ID, 0);
          const research = yield* client.subscribe("research", 0);
          const transport = harness.transports.at(0);
          if (transport === undefined) return yield* new AttachTransportClosedError();
          yield* transport.send({
            schemaVersion: PROTOCOL_VERSION,
            type: "event",
            subscriptionId: "main-subscription",
            event: envelope(1),
          });
          yield* transport.send({
            schemaVersion: PROTOCOL_VERSION,
            type: "event",
            subscriptionId: "research-subscription",
            event: researchEnvelope,
          });
          const listed = yield* Effect.forkScoped(client.listSessions);
          yield* Effect.sleep("20 millis");
          const settledBeforeRelease = listed.pollUnsafe() !== undefined;
          const mainEvent = yield* main.next;
          const researchEvent = yield* research.next;
          yield* Fiber.join(listed);
          probes.push({
            settledBeforeRelease,
            sequences: [mainEvent.seq, researchEvent.seq],
          });
        }
        return probes;
      }),
    );

    expect(results).toEqual([
      { settledBeforeRelease: false, sequences: [1, 1] },
      { settledBeforeRelease: false, sequences: [1, 1] },
    ]);
  });

  it("releases subscription ownership on setup interruption", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const subscribeBlocked = yield* Deferred.make<void>();
        let subscribeWrites = 0;
        const setupHandler: WriteHandler = (request, transport) => {
          if (request.method !== "session/subscribe") {
            return transport.send(standardResponse(request));
          }
          subscribeWrites += 1;
          return Deferred.succeed(subscribeBlocked, undefined).pipe(Effect.andThen(Effect.never));
        };
        const harness = yield* fakeFactory([setupHandler, standardHandler]);
        const client = yield* clientFor(harness.factory, { maxActiveSubscriptions: 1 });
        const interrupted = yield* Effect.forkScoped(client.subscribe(MAIN_SESSION_ID, 0));
        yield* Deferred.await(subscribeBlocked);
        yield* Fiber.interrupt(interrupted);
        const replacement = yield* client.subscribe(MAIN_SESSION_ID, 0);
        yield* replacement.close;
        return {
          subscribeWrites,
          attempts: harness.attempts(),
          firstMethods: methods(harness.transports[0]),
          secondMethods: methods(harness.transports[1]),
        };
      }),
    );

    expect(result).toEqual({
      subscribeWrites: 1,
      attempts: 2,
      firstMethods: ["initialize", "session/subscribe"],
      secondMethods: ["initialize", "session/subscribe", "session/unsubscribe"],
    });
  });

  it("closes the acquired subscription when startMainTurn is rejected", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "turn/start"
              ? transport.send({
                  schemaVersion: PROTOCOL_VERSION,
                  requestId: request.requestId,
                  type: "error",
                  code: "overloaded",
                  message: "turn already active",
                })
              : transport.send(standardResponse(request)),
        ]);
        const client = yield* clientFor(harness.factory, { maxActiveSubscriptions: 1 });
        const error = yield* Effect.flip(client.startMainTurn("hello", 0));
        const replacement = yield* client.subscribe(MAIN_SESSION_ID, 0);
        yield* replacement.close;
        return { error, methods: methods(harness.transports[0]) };
      }),
    );

    expect(result).toEqual({
      error: new AttachProtocolRejectedError({
        code: "overloaded",
        message: "turn already active",
      }),
      methods: [
        "initialize",
        "session/ensure",
        "session/subscribe",
        "turn/start",
        "session/unsubscribe",
        "session/subscribe",
        "session/unsubscribe",
      ],
    });
  });

  it("retries setup once before a turn write and never exceeds the setup retry limit", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const successful = yield* fakeFactory(["fail-open", standardHandler]);
        const client = yield* clientFor(successful.factory);
        const accepted = yield* client.startMainTurn("hello", 0);

        const exhausted = yield* fakeFactory(["fail-open", "fail-open", standardHandler]);
        const failingClient = yield* clientFor(exhausted.factory);
        const failure = yield* Effect.flip(failingClient.startMainTurn("hello", 0));
        return {
          accepted: accepted.acceptance,
          successfulAttempts: successful.attempts(),
          successfulMethods: methods(successful.transports[0]),
          exhaustedAttempts: exhausted.attempts(),
          failure,
        };
      }),
    );

    expect(result).toEqual({
      accepted: { turnId: "turn-1", disposition: "started" },
      successfulAttempts: 2,
      successfulMethods: ["initialize", "session/ensure", "session/subscribe", "turn/start"],
      exhaustedAttempts: 2,
      failure: new AttachSetupRetryExhaustedError({ cause: new AttachTransportOpenError() }),
    });
  });

  it("retries a disconnected subscription setup before writing turn/start", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? transport
                  .disconnect()
                  .pipe(Effect.andThen(Effect.fail(new AttachTransportClosedError())))
              : transport.send(standardResponse(request)),
          standardHandler,
        ]);
        const client = yield* clientFor(harness.factory);
        const accepted = yield* client.startMainTurn("hello", 0);
        return {
          acceptance: accepted.acceptance,
          attempts: harness.attempts(),
          firstMethods: methods(harness.transports[0]),
          secondMethods: methods(harness.transports[1]),
        };
      }),
    );

    expect(result).toEqual({
      acceptance: { turnId: "turn-1", disposition: "started" },
      attempts: 2,
      firstMethods: ["initialize", "session/ensure", "session/subscribe"],
      secondMethods: ["initialize", "session/ensure", "session/subscribe", "turn/start"],
    });
  });

  it("does not resend a turn after a successful write followed by inbound disconnect", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const turnWriteCompleted = yield* Deferred.make<void>();
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "turn/start"
              ? Deferred.succeed(turnWriteCompleted, undefined).pipe(Effect.asVoid)
              : transport.send(standardResponse(request)),
          standardHandler,
        ]);
        const client = yield* clientFor(harness.factory);
        const turnFiber = yield* Effect.forkScoped(client.startMainTurn("hello", 0));
        yield* Deferred.await(turnWriteCompleted);
        const transport = harness.transports.at(0);
        if (transport === undefined) return yield* new AttachTransportClosedError();
        yield* transport.disconnect();
        const error = yield* Effect.flip(Fiber.join(turnFiber));
        return {
          error,
          attempts: harness.attempts(),
          turnWrites: harness.transports
            .flatMap((candidate) => candidate.writes)
            .filter((request) => request.method === "turn/start").length,
        };
      }),
    );

    expect(result.error).toEqual(new AttachOutcomeUnknownError({ sessionId: MAIN_SESSION_ID }));
    expect(result.attempts).toBe(1);
    expect(result.turnWrites).toBe(1);
  });

  it("reconnects from the last applied sequence without resending an accepted turn", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        let reconnectSinceSeq: number | undefined;
        const reconnectRequested = yield* Deferred.make<void>();
        const harness = yield* fakeFactory([
          standardHandler,
          (request, transport) => {
            if (request.method !== "session/subscribe") {
              return transport.send(standardResponse(request));
            }
            reconnectSinceSeq = request.params.sinceSeq;
            return Deferred.succeed(reconnectRequested, undefined).pipe(
              Effect.andThen(transport.send(standardResponse(request))),
              Effect.andThen(
                Effect.forEach([envelope(2), envelope(3)], (event) =>
                  transport.send({
                    schemaVersion: PROTOCOL_VERSION,
                    type: "event",
                    subscriptionId: "subscription-1",
                    event,
                  }),
                ),
              ),
            );
          },
        ]);
        const client = yield* clientFor(harness.factory);
        const accepted = yield* client.startMainTurn("hello", 0);
        const acceptedTransport = harness.transports.at(0);
        if (acceptedTransport === undefined) return yield* new AttachTransportClosedError();
        yield* acceptedTransport.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: "subscription-1",
          event: envelope(1),
        });
        const applied = yield* accepted.subscription.next;
        yield* acceptedTransport.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: "subscription-1",
          event: envelope(2),
        });
        const appliedBeforeDisconnect = yield* accepted.subscription.next;
        yield* acceptedTransport.disconnect();
        const connectionLost = yield* accepted.subscription.nextChange ?? Effect.never;
        const retryStarted = yield* accepted.subscription.nextChange ?? Effect.never;
        yield* Deferred.await(reconnectRequested);
        const replayStarted = yield* accepted.subscription.nextChange ?? Effect.never;
        const replayed = yield* accepted.subscription.next;
        return {
          changes: [connectionLost, retryStarted, replayStarted],
          appliedSeqs: [applied.seq, appliedBeforeDisconnect.seq],
          replayedSeqs: [replayed.seq],
          reconnectSinceSeq,
          attempts: harness.attempts(),
          turnWrites: harness.transports
            .flatMap((transport) => transport.writes)
            .filter((request) => request.method === "turn/start").length,
          reconnectMethods: methods(harness.transports[1]),
        };
      }),
    );

    expect(result).toEqual({
      changes: [
        { type: "connection-lost" },
        { type: "retry-started", attempt: 1 },
        { type: "replay-started", replayThroughSeq: 2 },
      ],
      appliedSeqs: [1, 2],
      replayedSeqs: [3],
      reconnectSinceSeq: 2,
      attempts: 2,
      turnWrites: 1,
      reconnectMethods: ["initialize", "session/subscribe"],
    });
  });

  it("replays every active subscription from its independently applied cursor", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const reconnectCursors = new Map<string, number>();
        const subscribeResponse = (
          request: Extract<ClientRequestFrame, { readonly method: "session/subscribe" }>,
          transport: FakeAttachTransport,
          suffix: string,
        ) =>
          transport.send({
            schemaVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            method: "session/subscribe",
            type: "success",
            result: {
              subscriptionId: `${request.params.sessionId}-${suffix}`,
              replayThroughSeq: request.params.sinceSeq,
            },
          });
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? subscribeResponse(request, transport, "initial")
              : transport.send(standardResponse(request)),
          (request, transport) => {
            if (request.method !== "session/subscribe") {
              return transport.send(standardResponse(request));
            }
            reconnectCursors.set(request.params.sessionId, request.params.sinceSeq);
            return subscribeResponse(request, transport, "reconnected");
          },
        ]);
        const client = yield* clientFor(harness.factory);
        const mainSubscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const otherSubscription = yield* client.subscribe("research", 5);
        const transport = harness.transports.at(0);
        if (transport === undefined) return yield* new AttachTransportClosedError();
        yield* transport.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: "main-initial",
          event: envelope(1),
        });
        yield* transport.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: "research-initial",
          event: envelope(6, "research-turn", "research"),
        });
        yield* mainSubscription.next;
        yield* otherSubscription.next;
        yield* transport.disconnect();
        const mainChanges = yield* Effect.all(
          [
            mainSubscription.nextChange ?? Effect.never,
            mainSubscription.nextChange ?? Effect.never,
            mainSubscription.nextChange ?? Effect.never,
          ],
          { concurrency: 1 },
        );
        const otherChanges = yield* Effect.all(
          [
            otherSubscription.nextChange ?? Effect.never,
            otherSubscription.nextChange ?? Effect.never,
            otherSubscription.nextChange ?? Effect.never,
          ],
          { concurrency: 1 },
        );
        return {
          cursors: Object.fromEntries(reconnectCursors),
          mainChanges,
          otherChanges,
          methods: methods(harness.transports[1]),
        };
      }),
    );

    expect(result).toEqual({
      cursors: { main: 1, research: 6 },
      mainChanges: [
        { type: "connection-lost" },
        { type: "retry-started", attempt: 1 },
        { type: "replay-started", replayThroughSeq: 1 },
      ],
      otherChanges: [
        { type: "connection-lost" },
        { type: "retry-started", attempt: 1 },
        { type: "replay-started", replayThroughSeq: 6 },
      ],
      methods: ["initialize", "session/subscribe", "session/subscribe"],
    });
  });

  it("discards staged replay when a later reconnect subscription fails", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const secondSubscribeBlocked =
          yield* Deferred.make<readonly [ClientRequestFrame, FakeAttachTransport]>();
        const releaseSecondSubscribe = yield* Deferred.make<void>();
        const subscribeResponse = (
          request: Extract<ClientRequestFrame, { readonly method: "session/subscribe" }>,
          transport: FakeAttachTransport,
          suffix: string,
        ) =>
          transport.send({
            schemaVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            method: "session/subscribe",
            type: "success",
            result: {
              subscriptionId: `${request.params.sessionId}-${suffix}`,
              replayThroughSeq: request.params.sinceSeq,
            },
          });
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? subscribeResponse(request, transport, "initial")
              : transport.send(standardResponse(request)),
          (request, transport) => {
            if (request.method !== "session/subscribe") {
              return transport.send(standardResponse(request));
            }
            if (request.params.sessionId === MAIN_SESSION_ID) {
              return subscribeResponse(request, transport, "candidate").pipe(
                Effect.andThen(
                  transport.send({
                    schemaVersion: PROTOCOL_VERSION,
                    type: "event",
                    subscriptionId: "main-candidate",
                    event: envelope(1),
                  }),
                ),
              );
            }
            return Deferred.succeed(secondSubscribeBlocked, [request, transport]).pipe(
              Effect.andThen(Deferred.await(releaseSecondSubscribe)),
              Effect.andThen(
                transport.send({
                  schemaVersion: PROTOCOL_VERSION,
                  requestId: request.requestId,
                  type: "error",
                  code: "invalid-params",
                  message: "research replay rejected",
                }),
              ),
            );
          },
        ]);
        const client = yield* clientFor(harness.factory);
        const main = yield* client.subscribe(MAIN_SESSION_ID, 0);
        yield* client.subscribe("research", 0);
        const nextMain = yield* Effect.forkScoped(main.next);
        const initial = harness.transports.at(0);
        if (initial === undefined) return yield* new AttachTransportClosedError();
        yield* initial.disconnect();
        yield* Deferred.await(secondSubscribeBlocked);
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(releaseSecondSubscribe, undefined);
        const error = yield* Effect.flip(Fiber.join(nextMain));
        return { error, candidateCloseCalls: harness.transports.at(1)?.closeCalls };
      }),
    );

    expect(result).toEqual({
      error: new AttachProtocolRejectedError({
        code: "invalid-params",
        message: "research replay rejected",
      }),
      candidateCloseCalls: 1,
    });
  });

  it("keeps a blocked reconnect candidate private and skips a concurrently closed subscription", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const replayBlocked = yield* Deferred.make<void>();
        const releaseReplay = yield* Deferred.make<void>();
        const subscribeResponse = (
          request: Extract<ClientRequestFrame, { readonly method: "session/subscribe" }>,
          transport: FakeAttachTransport,
          suffix: string,
        ) =>
          transport.send({
            schemaVersion: PROTOCOL_VERSION,
            requestId: request.requestId,
            method: "session/subscribe",
            type: "success",
            result: {
              subscriptionId: `${request.params.sessionId}-${suffix}`,
              replayThroughSeq: request.params.sinceSeq,
            },
          });
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/subscribe"
              ? subscribeResponse(request, transport, "initial")
              : transport.send(standardResponse(request)),
          (request, transport) => {
            if (request.method !== "session/subscribe") {
              return transport.send(standardResponse(request));
            }
            return Deferred.succeed(replayBlocked, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReplay)),
              Effect.andThen(subscribeResponse(request, transport, "reconnected")),
            );
          },
        ]);
        const client = yield* clientFor(harness.factory);
        const mainSubscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const closedSubscription = yield* client.subscribe("research", 0);
        const initial = harness.transports.at(0);
        if (initial === undefined) return yield* new AttachTransportClosedError();
        yield* initial.disconnect();
        yield* Deferred.await(replayBlocked);
        yield* closedSubscription.close;
        const concurrentRequest = yield* Effect.forkScoped(client.listSessions);
        yield* Effect.sleep("20 millis");
        const candidate = harness.transports.at(1);
        const methodsBeforeRelease = methods(candidate);
        yield* Deferred.succeed(releaseReplay, undefined);
        const listed = yield* Fiber.join(concurrentRequest);
        if (candidate === undefined) return yield* new AttachTransportClosedError();
        yield* candidate.send({
          schemaVersion: PROTOCOL_VERSION,
          type: "event",
          subscriptionId: "main-reconnected",
          event: envelope(1),
        });
        const live = yield* mainSubscription.next;
        return {
          methodsBeforeRelease,
          methodsAfterSuccess: methods(candidate),
          listed,
          liveSeq: live.seq,
          attempts: harness.attempts(),
          candidateCloseCalls: candidate.closeCalls,
        };
      }),
    );

    expect(result).toEqual({
      methodsBeforeRelease: ["initialize", "session/subscribe"],
      methodsAfterSuccess: ["initialize", "session/subscribe", "session/list"],
      listed: [mainSummary],
      liveSeq: 1,
      attempts: 2,
      candidateCloseCalls: 0,
    });
  });

  it("reports bounded reconnect progress and typed exhaustion", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          standardHandler,
          "fail-open",
          "fail-open",
          "fail-open",
          "fail-open",
          "fail-open",
        ]);
        const client = yield* clientFor(harness.factory);
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const transport = harness.transports.at(0);
        if (transport === undefined) return yield* new AttachTransportClosedError();
        yield* transport.disconnect();
        const changes = yield* Effect.all(
          [
            subscription.nextChange ?? Effect.never,
            subscription.nextChange ?? Effect.never,
            subscription.nextChange ?? Effect.never,
            subscription.nextChange ?? Effect.never,
            subscription.nextChange ?? Effect.never,
            subscription.nextChange ?? Effect.never,
          ],
          { concurrency: 1 },
        );
        const error = yield* Effect.flip(subscription.next);
        return { changes, error, attempts: harness.attempts(), closeCalls: transport.closeCalls };
      }),
    );

    expect(result).toEqual({
      changes: [
        { type: "connection-lost" },
        { type: "retry-started", attempt: 1 },
        { type: "retry-started", attempt: 2 },
        { type: "retry-started", attempt: 3 },
        { type: "retry-started", attempt: 4 },
        { type: "retry-started", attempt: 5 },
      ],
      error: new AttachReconnectExhaustedError({
        attempts: 5,
        lastCause: new AttachTransportOpenError(),
      }),
      attempts: 6,
      closeCalls: 1,
    });
  });

  it("does not retry a protocol rejection during replay", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([
          standardHandler,
          (request, transport) =>
            request.method === "session/subscribe"
              ? transport.send({
                  schemaVersion: PROTOCOL_VERSION,
                  requestId: request.requestId,
                  type: "error",
                  code: "invalid-params",
                  message: "replay rejected",
                })
              : transport.send(standardResponse(request)),
          standardHandler,
        ]);
        const client = yield* clientFor(harness.factory);
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const transport = harness.transports.at(0);
        if (transport === undefined) return yield* new AttachTransportClosedError();
        yield* transport.disconnect();
        const connectionLost = yield* subscription.nextChange ?? Effect.never;
        const retryStarted = yield* subscription.nextChange ?? Effect.never;
        const error = yield* Effect.flip(subscription.next);
        return { connectionLost, retryStarted, error, attempts: harness.attempts() };
      }),
    );

    expect(result).toEqual({
      connectionLost: { type: "connection-lost" },
      retryStarted: { type: "retry-started", attempt: 1 },
      error: new AttachProtocolRejectedError({
        code: "invalid-params",
        message: "replay rejected",
      }),
      attempts: 2,
    });
  });

  it("does not retry a transport write failure during replay", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const writeError = new AttachTransportWriteError();
        const harness = yield* fakeFactory([
          standardHandler,
          (request, transport) =>
            request.method === "session/subscribe"
              ? Effect.fail(writeError)
              : transport.send(standardResponse(request)),
          standardHandler,
        ]);
        const client = yield* clientFor(harness.factory);
        const subscription = yield* client.subscribe(MAIN_SESSION_ID, 0);
        const initial = harness.transports.at(0);
        if (initial === undefined) return yield* new AttachTransportClosedError();
        yield* initial.disconnect();
        const connectionLost = yield* subscription.nextChange ?? Effect.never;
        const retryStarted = yield* subscription.nextChange ?? Effect.never;
        const eventError = yield* Effect.flip(subscription.next);
        const changeError = yield* Effect.flip(subscription.nextChange ?? Effect.never);
        return {
          connectionLost,
          retryStarted,
          eventError,
          changeError,
          attempts: harness.attempts(),
          candidateCloseCalls: harness.transports.at(1)?.closeCalls,
        };
      }),
    );

    expect(result).toEqual({
      connectionLost: { type: "connection-lost" },
      retryStarted: { type: "retry-started", attempt: 1 },
      eventError: new AttachTransportWriteError(),
      changeError: new AttachTransportWriteError(),
      attempts: 2,
      candidateCloseCalls: 1,
    });
  });

  it("fails reconnect barrier waiters before Client scope finalization clears the barrier", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const replayBlocked = yield* Deferred.make<void>();
        const harness = yield* fakeFactory([
          standardHandler,
          (request, transport) =>
            request.method === "session/subscribe"
              ? Deferred.succeed(replayBlocked, undefined).pipe(Effect.andThen(Effect.never))
              : transport.send(standardResponse(request)),
        ]);
        const clientScope = yield* Scope.make();
        const client = yield* Scope.provide(clientFor(harness.factory), clientScope);
        yield* Scope.provide(client.subscribe(MAIN_SESSION_ID, 0), clientScope);
        const initial = harness.transports.at(0);
        if (initial === undefined) return yield* new AttachTransportClosedError();
        yield* initial.disconnect();
        yield* Deferred.await(replayBlocked);
        const waiter = yield* Effect.forkScoped(client.listSessions);
        yield* Effect.yieldNow;
        yield* Scope.close(clientScope, Exit.void);
        const error = yield* Effect.flip(Fiber.join(waiter));
        return {
          error,
          attempts: harness.attempts(),
          initialCloseCalls: initial.closeCalls,
          candidateCloseCalls: harness.transports.at(1)?.closeCalls,
        };
      }),
    );

    expect(result).toEqual({
      error: new AttachDisconnectedError({ phase: "setup" }),
      attempts: 2,
      initialCloseCalls: 1,
      candidateCloseCalls: 1,
    });
  });

  it("interrupts reconnect backoff when the Client scope closes", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const harness = yield* fakeFactory([standardHandler, "fail-open", standardHandler]);
        const clientScope = yield* Scope.make();
        const client = yield* Scope.provide(clientFor(harness.factory), clientScope);
        const subscription = yield* Scope.provide(
          client.subscribe(MAIN_SESSION_ID, 0),
          clientScope,
        );
        const transport = harness.transports.at(0);
        if (transport === undefined) return yield* new AttachTransportClosedError();
        yield* transport.disconnect();
        yield* subscription.nextChange ?? Effect.never;
        yield* subscription.nextChange ?? Effect.never;
        const attemptsBeforeClose = harness.attempts();
        yield* Scope.close(clientScope, Exit.void);
        yield* Effect.sleep("200 millis");
        return {
          attemptsBeforeClose,
          attemptsAfterClose: harness.attempts(),
          closeCalls: transport.closeCalls,
        };
      }),
    );

    expect(result).toEqual({ attemptsBeforeClose: 2, attemptsAfterClose: 2, closeCalls: 1 });
  });

  it("closes transport and structured fibers exactly once on interruption", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const harness = yield* fakeFactory([
          (request, transport) =>
            request.method === "session/list"
              ? Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.never))
              : transport.send(standardResponse(request)),
        ]);
        const client = yield* clientFor(harness.factory);
        const fiber = yield* Effect.forkScoped(client.listSessions);
        yield* Deferred.await(requestStarted);
        yield* Fiber.interrupt(fiber);
        return harness.transports;
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.closeCalls).toBe(1);
  });

  it("rejects protocol errors and missing stable-main support", async () => {
    const result = await runScopedEffect(
      Effect.gen(function* () {
        const rejected = yield* fakeFactory([
          (request, transport) =>
            transport.send({
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              type: "error",
              code: "version-mismatch",
              message: "protocol v2 required",
            }),
        ]);
        const rejectedClient = yield* clientFor(rejected.factory);
        const protocolError = yield* Effect.flip(rejectedClient.listSessions);

        const unsupported = yield* fakeFactory([
          (request, transport) => transport.send(standardResponse(request, ["sessionReplay"])),
        ]);
        const unsupportedClient = yield* clientFor(unsupported.factory);
        const featureError = yield* Effect.flip(unsupportedClient.listSessions);
        return { protocolError, featureError };
      }),
    );

    expect(result.protocolError).toEqual(
      new AttachProtocolRejectedError({
        code: "version-mismatch",
        message: "protocol v2 required",
      }),
    );
    expect(result.featureError).toEqual(
      new AttachProtocolCompatibilityError({
        protocolVersion: PROTOCOL_VERSION,
        missingFeature: "stableMainSession",
      }),
    );
  });
});
