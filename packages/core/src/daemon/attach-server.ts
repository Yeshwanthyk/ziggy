import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Deferred, Effect, Exit, FiberSet, Option, Predicate, Ref, Schema, Scope } from "effect";
import {
  decodeClientRequest,
  encodeServerFrame,
  MAIN_SESSION_ID,
  negotiateServerFeatures,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  type ClientRequestFrame,
  type ProtocolErrorCode,
  type ServerAuthFrame,
  type ServerErrorFrame,
  type ServerFrame,
  type ServerSessionEventFrame,
  type SessionEnvelope,
} from "@ziggy/protocol";
import { type SessionSubscription } from "../agent/runtime.ts";
import type { DaemonAuthService } from "../provider-runtime.ts";
import type { DaemonKernel } from "./kernel.ts";
import type { RegisteredSessionRuntime } from "./registry.ts";

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_MAX_OUTBOUND_BYTES = 1024 * 1024;
const SOCKET_MODE = 0o600;

export interface CreateAttachServerOptions<RuntimeError = never> {
  readonly kernel: DaemonKernel<RuntimeError>;
  readonly auth?: DaemonAuthService;
  readonly nextSessionId?: () => string;
  readonly nextAuthId?: () => string;
  readonly nextAuthPromptId?: () => string;
  readonly nextSubscriptionId?: () => string;
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxOutboundBytes?: number;
  readonly faultInjection?: {
    readonly dropTurnStartResponseAfterAcceptance?: (
      request: Extract<ClientRequestFrame, { readonly method: "turn/start" }>,
    ) => boolean;
  };
}

export interface AttachServer {
  readonly socketPath: string;
  readonly close: Effect.Effect<void, AttachServerError>;
}

type InitializeState = "waiting" | "initialized";

interface OutboundFrame {
  readonly encoded: string;
  readonly bytes: number;
}

interface ConnectionSubscription {
  readonly deferred: OutboundFrame[];
  active: boolean;
  replaying: boolean;
  deferredBytes: number;
  subscription: SessionSubscription | undefined;
}

interface PendingAuthPrompt {
  readonly completion: Deferred.Deferred<string, AttachServerError>;
}
interface PendingAuthLogin {
  readonly controller: AbortController;
  readonly prompts: Map<string, PendingAuthPrompt>;
  readonly promptIds: Set<string>;
}
interface ConnectionState {
  readonly socket: Socket;
  readonly subscriptions: Map<string, ConnectionSubscription>;
  readonly authLogins: Map<string, PendingAuthLogin>;
  readonly outbound: OutboundFrame[];
  readonly drainWaiters: Set<Deferred.Deferred<void, ConnectionDeliveryError>>;
  readonly inFlightRequestIds: Set<string>;
  inbound: Buffer;
  initializeState: InitializeState;
  outboundBytes: number;
  deferredBytes: number;
  writeBlocked: boolean;
  endAfterDrain: boolean;
  accepting: boolean;
  resourcesCleaned: boolean;
  terminal: boolean;
  closed: boolean;
}

export class AttachServerError extends Schema.TaggedErrorClass<AttachServerError>(
  "@ziggy/core/daemon/AttachServerError",
)("AttachServerError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  {},
) {}
class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  {},
) {}
class ConnectionDeliveryError extends Schema.TaggedErrorClass<ConnectionDeliveryError>()(
  "ConnectionDeliveryError",
  {},
) {}

export function createAttachServer<RuntimeError>(
  options: CreateAttachServerOptions<RuntimeError>,
): Effect.Effect<AttachServer, AttachServerError> {
  return Effect.gen(function* () {
    const maxFrameBytes = yield* positiveLimit(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    const maxPendingRequests = yield* positiveLimit(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      "maxPendingRequests",
    );
    const maxOutboundBytes = yield* positiveLimit(
      options.maxOutboundBytes,
      DEFAULT_MAX_OUTBOUND_BYTES,
      "maxOutboundBytes",
    );
    const nextSessionId = options.nextSessionId ?? randomUUID;
    const nextSubscriptionId = options.nextSubscriptionId ?? randomUUID;
    const nextAuthId = options.nextAuthId ?? randomUUID;
    const nextAuthPromptId = options.nextAuthPromptId ?? randomUUID;
    const socketPath = join(options.kernel.profilePath, ".runtime", "ziggy.sock");
    const connections = new Set<ConnectionState>();
    yield* prepareSocketPath(socketPath);
    const resources = yield* Scope.make();
    const fibers = yield* FiberSet.make().pipe(Effect.provideService(Scope.Scope, resources));
    const runHostEffect = yield* FiberSet.runtime(fibers)<never>();
    const runAuthPromptPromise = yield* FiberSet.runtimePromise(fibers)<never>();
    let closing = false;

    const server = yield* Effect.try({
      try: () =>
        createServer((socket) => {
          const state: ConnectionState = {
            socket,
            subscriptions: new Map(),
            authLogins: new Map(),
            outbound: [],
            drainWaiters: new Set(),
            inFlightRequestIds: new Set(),
            inbound: Buffer.alloc(0),
            initializeState: "waiting",
            outboundBytes: 0,
            deferredBytes: 0,
            writeBlocked: false,
            endAfterDrain: false,
            accepting: true,
            resourcesCleaned: false,
            terminal: false,
            closed: false,
          };
          connections.add(state);

          socket.on("data", (chunk) => {
            if (!state.accepting || state.closed) return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            state.inbound = Buffer.concat([state.inbound, bytes]);
            consumeInput(state);
          });
          socket.on("drain", () => flushOutbound(state));
          socket.on("close", () => closeConnection(state, false));
          socket.on("error", () => closeConnection(state, true));
        }),
      catch: (cause) =>
        new AttachServerError({
          operation: "create-server",
          message: "Failed to create attach server",
          cause,
        }),
    }).pipe(Effect.onError(() => Scope.close(resources, Exit.void)));

    function consumeInput(state: ConnectionState): void {
      while (state.accepting && !state.closed) {
        const newline = state.inbound.indexOf(0x0a);
        if (newline < 0) {
          if (state.inbound.byteLength > maxFrameBytes) {
            failConnection(state, errorFrame(null, "malformed-frame", "Client frame is too large"));
          }
          return;
        }
        const frameLength = newline + 1;
        if (frameLength > maxFrameBytes) {
          failConnection(state, errorFrame(null, "malformed-frame", "Client frame is too large"));
          return;
        }
        const frameBytes = state.inbound.subarray(0, frameLength);
        state.inbound = Buffer.from(state.inbound.subarray(frameLength));
        let frame: string;
        // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- boundary: fatal TextDecoder failure becomes a stable protocol envelope
        try {
          frame = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes);
        } catch {
          failConnection(state, errorFrame(null, "malformed-frame", "Client frame is not UTF-8"));
          return;
        }
        acceptFrame(state, frame);
      }
    }

    function acceptFrame(state: ConnectionState, frame: string): void {
      let request: ClientRequestFrame;
      // oxlint-disable-next-line ziggy-effect/no-try-catch-or-throw -- boundary: protocol decoder failure becomes a stable protocol envelope
      try {
        request = decodeClientRequest(frame);
      } catch (error) {
        // oxlint-disable-next-line ziggy-effect/no-instanceof-tagged-error -- boundary: protocol package exposes a native Error subclass
        if (error instanceof ProtocolDecodeError) {
          // oxlint-disable-next-line ziggy-effect/no-unknown-error-message -- boundary: ProtocolDecodeError.message is stable protocol copy
          sendFrame(state, errorFrame(error.requestId, error.code, error.message));
        } else {
          sendFrame(state, errorFrame(null, "malformed-frame", "Malformed client frame"));
        }
        return;
      }

      if (request.method === "initialize") {
        if (state.initializeState === "initialized") {
          sendFrame(
            state,
            errorFrame(
              request.requestId,
              "already-initialized",
              "Connection is already initialized",
            ),
          );
          return;
        }
        state.initializeState = "initialized";
        sendFrame(state, {
          schemaVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          method: "initialize",
          type: "success",
          result: {
            protocolVersion: PROTOCOL_VERSION,
            features: negotiateServerFeatures(options.auth !== undefined),
          },
        });
        return;
      }

      if (state.initializeState !== "initialized") {
        sendFrame(
          state,
          errorFrame(request.requestId, "not-initialized", "Initialize this connection first"),
        );
        return;
      }
      if (closing) {
        sendFrame(state, errorFrame(request.requestId, "shutting-down", "Daemon is shutting down"));
        return;
      }
      if (state.inFlightRequestIds.has(request.requestId)) {
        failConnection(
          state,
          errorFrame(
            request.requestId,
            "invalid-params",
            "Request id is already in flight on this connection",
          ),
        );
        return;
      }
      if (state.inFlightRequestIds.size >= maxPendingRequests) {
        sendFrame(
          state,
          errorFrame(request.requestId, "overloaded", "Connection is overloaded; retry later"),
        );
        return;
      }

      state.inFlightRequestIds.add(request.requestId);
      runHostEffect(
        runRequest(state, request).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.inFlightRequestIds.delete(request.requestId);
            }),
          ),
        ),
      );
    }

    function runRequest(state: ConnectionState, request: ClientRequestFrame): Effect.Effect<void> {
      return dispatchRequest(state, request).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!state.closed) sendRequestError(state, request.requestId, error);
          }),
        ),
      );
    }

    function dispatchRequest(state: ConnectionState, request: ClientRequestFrame) {
      return Effect.gen(function* () {
        switch (request.method) {
          case "initialize":
            return yield* new AttachServerError({
              operation: "dispatch-initialize",
              message: "Initialize requests must be handled before dispatch",
            });
          case "auth/login": {
            if (options.auth === undefined) {
              return yield* new AttachServerError({
                operation: "auth-login",
                message: "Provider auth is unavailable",
              });
            }
            const loginId = nextAuthId();
            if (state.authLogins.has(loginId)) {
              return yield* new AttachServerError({
                operation: "auth-login",
                message: "Auth id source produced an existing id",
              });
            }
            const login: PendingAuthLogin = {
              controller: new AbortController(),
              prompts: new Map(),
              promptIds: new Set(),
            };
            state.authLogins.set(loginId, login);
            const status = yield* options.auth
              .login(request.params.providerId, request.params.type, {
                signal: login.controller.signal,
                notify: (event) => {
                  sendFrame(state, authNotifyFrame(request.requestId, loginId, event));
                },
                prompt: (prompt) =>
                  runAuthPromptPromise(
                    promptForAuth(
                      request.requestId,
                      loginId,
                      login,
                      prompt,
                      nextAuthPromptId,
                      (frame) => sendFrame(state, frame),
                      runHostEffect,
                    ),
                  ),
              })
              .pipe(Effect.ensuring(cleanupAuthLogin(state, loginId, login, "Auth login ended")));
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "auth/login",
              type: "success",
              result: { status },
            });
            return;
          }
          case "auth/respond": {
            const login = state.authLogins.get(request.params.loginId);
            const prompt = login?.prompts.get(request.params.promptId);
            if (login === undefined || prompt === undefined) {
              return yield* new InvalidRequestError();
            }
            login.prompts.delete(request.params.promptId);
            yield* Deferred.succeed(prompt.completion, request.params.value);
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "auth/respond",
              type: "success",
              result: { accepted: true },
            });
            return;
          }
          case "auth/status": {
            if (options.auth === undefined) {
              return yield* new AttachServerError({
                operation: "auth-status",
                message: "Provider auth is unavailable",
              });
            }
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "auth/status",
              type: "success",
              result: { providers: yield* options.auth.status(request.params.providerId) },
            });
            return;
          }
          case "session/start": {
            const sessionId = nextSessionId();
            if (sessionId === MAIN_SESSION_ID) {
              return yield* new AttachServerError({
                operation: "session-start",
                message: `Session id ${MAIN_SESSION_ID} is reserved`,
              });
            }
            yield* options.kernel.createSession(sessionId);
            const session = yield* options.kernel.getSessionSummary(sessionId);
            if (session === undefined) {
              return yield* new AttachServerError({
                operation: "session-start",
                message: `Started Session ${sessionId} is missing`,
              });
            }
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "session/start",
              type: "success",
              result: { session },
            });
            return;
          }
          case "session/ensure": {
            const session = yield* options.kernel.ensureMainSession();
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "session/ensure",
              type: "success",
              result: { session },
            });
            return;
          }
          case "session/resume": {
            const runtime = yield* getExistingRuntime(request.params.sessionId);
            const session = yield* options.kernel.getSessionSummary(request.params.sessionId);
            if (session === undefined) return yield* new SessionNotFoundError();
            const subscriptionId = nextSubscriptionId();
            yield* subscribeConnection(
              state,
              runtime,
              subscriptionId,
              request.params.sinceSeq,
              (tail) =>
                sendFrame(state, {
                  schemaVersion: PROTOCOL_VERSION,
                  requestId: request.requestId,
                  method: "session/resume",
                  type: "success",
                  result: { session, subscriptionId, replayThroughSeq: tail },
                }),
            );
            return;
          }
          case "session/list":
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "session/list",
              type: "success",
              result: { sessions: yield* options.kernel.listSessions },
            });
            return;
          case "session/subscribe": {
            const runtime = yield* getExistingRuntime(request.params.sessionId);
            const subscriptionId = nextSubscriptionId();
            yield* subscribeConnection(
              state,
              runtime,
              subscriptionId,
              request.params.sinceSeq,
              (tail) =>
                sendFrame(state, {
                  schemaVersion: PROTOCOL_VERSION,
                  requestId: request.requestId,
                  method: "session/subscribe",
                  type: "success",
                  result: { subscriptionId, replayThroughSeq: tail },
                }),
            );
            return;
          }
          case "session/unsubscribe": {
            const subscription = state.subscriptions.get(request.params.subscriptionId);
            if (subscription !== undefined) {
              yield* unsubscribeConnection(state, subscription);
              state.subscriptions.delete(request.params.subscriptionId);
            }
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "session/unsubscribe",
              type: "success",
              result: { unsubscribed: subscription !== undefined },
            });
            return;
          }
          case "turn/start": {
            if (request.params.message.length === 0) return yield* new InvalidRequestError();
            const runtime = yield* getExistingRuntime(request.params.sessionId);
            const result = yield* runtime.startTurn({ message: request.params.message });
            if (options.faultInjection?.dropTurnStartResponseAfterAcceptance?.(request) === true) {
              closeConnection(state, true);
              return;
            }
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "turn/start",
              type: "success",
              result,
            });
            return;
          }
          case "turn/steer": {
            if (request.params.message.length === 0) return yield* new InvalidRequestError();
            const runtime = yield* getExistingRuntime(request.params.sessionId);
            const result = yield* runtime.steer({
              expectedTurnId: request.params.expectedTurnId,
              message: request.params.message,
            });
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "turn/steer",
              type: "success",
              result,
            });
            return;
          }
          case "turn/interrupt": {
            const runtime = yield* getExistingRuntime(request.params.sessionId);
            const result = yield* runtime.interrupt({
              expectedTurnId: request.params.expectedTurnId,
            });
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "turn/interrupt",
              type: "success",
              result,
            });
            return;
          }
          case "approval/resolve": {
            const runtime = yield* getExistingRuntime(request.params.sessionId);
            const result = yield* runtime.resolveApproval({
              approvalId: request.params.approvalId,
              decision: request.params.decision,
            });
            sendFrame(state, {
              schemaVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              method: "approval/resolve",
              type: "success",
              result,
            });
            return;
          }
        }
      });
    }

    function getExistingRuntime(sessionId: string) {
      return Effect.gen(function* () {
        if ((yield* options.kernel.getSessionSummary(sessionId)) === undefined) {
          return yield* new SessionNotFoundError();
        }
        return yield* options.kernel.getOrCreateSession(sessionId);
      });
    }

    function subscribeConnection(
      state: ConnectionState,
      runtime: RegisteredSessionRuntime,
      subscriptionId: string,
      sinceSeq: number,
      onReplayStart: (replayThroughSeq: number) => boolean,
    ) {
      return Effect.gen(function* () {
        if (state.subscriptions.has(subscriptionId)) {
          return yield* new AttachServerError({
            operation: "session-subscribe",
            message: `Subscription id source produced existing id ${subscriptionId}`,
          });
        }
        const connectionSubscription: ConnectionSubscription = {
          deferred: [],
          active: true,
          replaying: true,
          deferredBytes: 0,
          subscription: undefined,
        };
        state.subscriptions.set(subscriptionId, connectionSubscription);
        const replayCompletion = yield* Deferred.make<void, ConnectionDeliveryError>();
        let replayStarted = false;
        const subscriptionEffect = Effect.gen(function* () {
          const subscription = yield* runtime.subscribe({
            sinceSeq,
            onReplay(replay, replayThroughSeq) {
              replayStarted = true;
              if (!onReplayStart(replayThroughSeq)) {
                connectionSubscription.active = false;
                runHostEffect(Deferred.fail(replayCompletion, new ConnectionDeliveryError()));
                return;
              }
              runHostEffect(
                deliverReplay(state, connectionSubscription, subscriptionId, replay).pipe(
                  Deferred.into(replayCompletion),
                ),
              );
            },
            onEnvelope(envelope) {
              if (!connectionSubscription.active) return;
              if (connectionSubscription.replaying) {
                deferEnvelope(state, connectionSubscription, subscriptionId, envelope);
              } else {
                sendEnvelope(state, subscriptionId, envelope);
              }
            },
          });
          connectionSubscription.subscription = subscription;
          if (!connectionSubscription.active || state.closed) {
            yield* subscription.unsubscribe;
            state.subscriptions.delete(subscriptionId);
          }
          if (!replayStarted) {
            return yield* new AttachServerError({
              operation: "session-subscribe",
              message: "Session subscription did not provide replay",
            });
          }
          yield* Deferred.await(replayCompletion);
        });
        return yield* subscriptionEffect.pipe(
          Effect.onError(() =>
            unsubscribeConnection(state, connectionSubscription).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  state.subscriptions.delete(subscriptionId);
                }),
              ),
            ),
          ),
        );
      });
    }

    function deliverReplay(
      state: ConnectionState,
      connectionSubscription: ConnectionSubscription,
      subscriptionId: string,
      replay: ReadonlyArray<SessionEnvelope>,
    ): Effect.Effect<void, ConnectionDeliveryError> {
      return Effect.gen(function* () {
        for (const envelope of replay) {
          if (
            !connectionSubscription.active ||
            !(yield* sendEnvelopePaced(state, subscriptionId, envelope))
          ) {
            return yield* new ConnectionDeliveryError();
          }
        }
        while (connectionSubscription.active) {
          const frame = connectionSubscription.deferred.shift();
          if (frame === undefined) {
            connectionSubscription.replaying = false;
            return;
          }
          connectionSubscription.deferredBytes -= frame.bytes;
          state.deferredBytes -= frame.bytes;
          if (!(yield* sendEncodedFramePaced(state, frame))) {
            return yield* new ConnectionDeliveryError();
          }
        }
        return yield* new ConnectionDeliveryError();
      });
    }

    function deferEnvelope(
      state: ConnectionState,
      connectionSubscription: ConnectionSubscription,
      subscriptionId: string,
      event: SessionEnvelope,
    ): boolean {
      const frame = encodeOutboundFrame(eventFrame(subscriptionId, event));
      if (!fitsOutboundBudget(state, frame.bytes)) {
        closeConnection(state, true);
        return false;
      }
      connectionSubscription.deferred.push(frame);
      connectionSubscription.deferredBytes += frame.bytes;
      state.deferredBytes += frame.bytes;
      return true;
    }

    function sendEnvelope(
      state: ConnectionState,
      subscriptionId: string,
      event: SessionEnvelope,
    ): boolean {
      return sendFrame(state, eventFrame(subscriptionId, event));
    }

    function sendEnvelopePaced(
      state: ConnectionState,
      subscriptionId: string,
      event: SessionEnvelope,
    ): Effect.Effect<boolean, ConnectionDeliveryError> {
      return sendEncodedFramePaced(state, encodeOutboundFrame(eventFrame(subscriptionId, event)));
    }

    function sendRequestError(state: ConnectionState, requestId: string, error: unknown): void {
      if (Predicate.isTagged(error, "SessionNotFoundError")) {
        sendFrame(state, errorFrame(requestId, "session-not-found", "Session was not found"));
      } else if (Predicate.isTagged(error, "StaleTurnError")) {
        sendFrame(state, errorFrame(requestId, "stale-turn", "Turn is no longer active"));
      } else if (Predicate.isTagged(error, "InvalidRequestError")) {
        sendFrame(state, errorFrame(requestId, "invalid-params", "Request parameters are invalid"));
      } else if (Predicate.isTagged(error, "ApprovalDecisionNotAllowedError")) {
        sendFrame(
          state,
          errorFrame(requestId, "invalid-params", "Approval decision is not allowed"),
        );
      } else if (Predicate.isTagged(error, "SinceSeqBeyondTailError")) {
        sendFrame(
          state,
          errorFrame(requestId, "unsafe-sequence", "sinceSeq exceeds the durable Session tail"),
        );
      } else if (Predicate.isTagged(error, "SessionRuntimeOverloadedError")) {
        sendFrame(state, errorFrame(requestId, "overloaded", "Session runtime is overloaded"));
      } else if (Predicate.isTagged(error, "SessionRuntimeClosedError") || closing) {
        sendFrame(state, errorFrame(requestId, "shutting-down", "Daemon is shutting down"));
      } else if (!Predicate.isTagged(error, "ConnectionDeliveryError")) {
        sendFrame(state, errorFrame(requestId, "internal", "Internal daemon error"));
      }
    }

    function sendFrame(state: ConnectionState, frame: ServerFrame): boolean {
      if (state.terminal) return false;
      return sendEncodedFrame(state, encodeOutboundFrame(frame));
    }

    function sendEncodedFrame(state: ConnectionState, frame: OutboundFrame): boolean {
      if (state.closed || state.terminal) return false;
      if (!fitsOutboundBudget(state, frame.bytes)) {
        closeConnection(state, true);
        return false;
      }
      if (state.writeBlocked || state.outbound.length > 0) {
        state.outbound.push(frame);
        state.outboundBytes += frame.bytes;
        return true;
      }
      if (!state.socket.write(frame.encoded)) state.writeBlocked = true;
      return true;
    }

    function sendEncodedFramePaced(
      state: ConnectionState,
      frame: OutboundFrame,
    ): Effect.Effect<boolean, ConnectionDeliveryError> {
      return Effect.gen(function* () {
        if (!sendEncodedFrame(state, frame)) return false;
        if (state.writeBlocked) yield* waitForDrain(state);
        return !state.closed;
      });
    }

    function fitsOutboundBudget(state: ConnectionState, bytes: number): boolean {
      return (
        bytes <= maxOutboundBytes &&
        state.socket.writableLength + state.outboundBytes + state.deferredBytes + bytes <=
          maxOutboundBytes
      );
    }

    function waitForDrain(state: ConnectionState): Effect.Effect<void, ConnectionDeliveryError> {
      return Effect.gen(function* () {
        if (state.closed) return yield* new ConnectionDeliveryError();
        if (!state.writeBlocked) return;
        const waiter = yield* Deferred.make<void, ConnectionDeliveryError>();
        state.drainWaiters.add(waiter);
        return yield* Deferred.await(waiter).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.drainWaiters.delete(waiter);
            }),
          ),
        );
      });
    }

    function flushOutbound(state: ConnectionState): void {
      if (state.closed) return;
      state.writeBlocked = false;
      while (!state.writeBlocked) {
        const frame = state.outbound.shift();
        if (frame === undefined) break;
        state.outboundBytes -= frame.bytes;
        if (!state.socket.write(frame.encoded)) state.writeBlocked = true;
      }
      if (!state.writeBlocked) {
        const waiters = [...state.drainWaiters];
        state.drainWaiters.clear();
        runHostEffect(Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined)));
      }
      if (!state.writeBlocked && state.outbound.length === 0 && state.endAfterDrain) {
        endAndDestroy(state);
      }
    }

    function failConnection(state: ConnectionState, frame: ServerErrorFrame): void {
      if (state.closed || state.terminal) return;
      state.terminal = true;
      state.socket.pause();
      runHostEffect(cleanupConnectionResources(state));
      state.outbound.length = 0;
      state.outboundBytes = 0;
      state.writeBlocked = false;
      const terminalFrame = encodeOutboundFrame(frame);
      if (!fitsOutboundBudget(state, terminalFrame.bytes)) {
        closeConnection(state, true);
        return;
      }
      if (!state.socket.write(terminalFrame.encoded)) {
        state.writeBlocked = true;
        state.endAfterDrain = true;
      } else {
        endAndDestroy(state);
      }
    }

    function closeConnection(state: ConnectionState, destroy: boolean): void {
      if (state.closed) return;
      state.closed = true;
      runHostEffect(cleanupConnectionResources(state));
      state.outbound.length = 0;
      state.outboundBytes = 0;
      state.deferredBytes = 0;
      const waiters = [...state.drainWaiters];
      state.drainWaiters.clear();
      runHostEffect(
        Effect.forEach(waiters, (waiter) => Deferred.fail(waiter, new ConnectionDeliveryError())),
      );
      connections.delete(state);
      if (destroy && !state.socket.destroyed) state.socket.destroy();
    }

    function cleanupConnectionResources(state: ConnectionState): Effect.Effect<void> {
      if (state.resourcesCleaned) return Effect.void;
      state.resourcesCleaned = true;
      state.accepting = false;
      state.inbound = Buffer.alloc(0);
      const logins = [...state.authLogins.entries()];
      state.authLogins.clear();
      return unsubscribeAll(state).pipe(
        Effect.andThen(
          Effect.forEach(logins, ([loginId, login]) =>
            cleanupAuthLogin(state, loginId, login, "Client disconnected"),
          ),
        ),
      );
    }

    function endAndDestroy(state: ConnectionState): void {
      state.endAfterDrain = false;
      state.socket.end(() => {
        if (!state.socket.destroyed) state.socket.destroy();
      });
    }

    function unsubscribeAll(state: ConnectionState): Effect.Effect<void> {
      const subscriptions = [...state.subscriptions.values()];
      state.subscriptions.clear();
      return Effect.forEach(subscriptions, (subscription) =>
        unsubscribeConnection(state, subscription),
      ).pipe(Effect.asVoid);
    }

    function unsubscribeConnection(
      state: ConnectionState,
      connectionSubscription: ConnectionSubscription,
    ): Effect.Effect<void> {
      if (!connectionSubscription.active) return Effect.void;
      connectionSubscription.active = false;
      state.deferredBytes -= connectionSubscription.deferredBytes;
      connectionSubscription.deferred.length = 0;
      connectionSubscription.deferredBytes = 0;
      return connectionSubscription.subscription?.unsubscribe ?? Effect.void;
    }

    const verifySocket = Effect.gen(function* () {
      yield* listen(server, socketPath);
      yield* filesystemOperation("chmod-socket", "Failed to secure attach socket", () =>
        chmod(socketPath, SOCKET_MODE),
      );
      const socket = yield* filesystemOperation(
        "inspect-socket",
        "Failed to inspect attach socket",
        () => lstat(socketPath),
      );
      if (!socket.isSocket() || (socket.mode & 0o777) !== SOCKET_MODE) {
        return yield* new AttachServerError({
          operation: "verify-socket",
          message: "Attach socket is not a mode-0600 Unix socket",
        });
      }
    });
    yield* verifySocket.pipe(
      Effect.onError(() =>
        Effect.exit(
          stopServer(server, connections).pipe(
            Effect.andThen(Scope.close(resources, Exit.void)),
            Effect.andThen(removeOwnedSocket(socketPath)),
          ),
        ).pipe(Effect.asVoid),
      ),
    );

    const close = yield* memoizeClose(
      Effect.gen(function* () {
        closing = true;
        yield* stopServer(server, connections);
        yield* FiberSet.awaitEmpty(fibers);
        yield* Scope.close(resources, Exit.void);
        yield* removeOwnedSocket(socketPath);
      }),
    );

    return { socketPath, close };
  });
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): Effect.Effect<number, AttachServerError> {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    return Effect.fail(
      new AttachServerError({
        operation: "validate-options",
        message: `${name} must be a positive safe integer`,
      }),
    );
  }
  return Effect.succeed(resolved);
}

function promptForAuth(
  requestId: string,
  loginId: string,
  login: PendingAuthLogin,
  prompt: AuthPrompt,
  nextPromptId: () => string,
  deliver: (frame: ServerAuthFrame) => boolean,
  runHostEffect: (effect: Effect.Effect<void>) => void,
): Effect.Effect<string, AttachServerError> {
  if (prompt.signal?.aborted) {
    return Effect.fail(
      new AttachServerError({
        operation: "auth-prompt",
        message: "Auth prompt was cancelled",
      }),
    );
  }
  const promptId = nextPromptId();
  if (login.promptIds.has(promptId)) {
    return Effect.fail(
      new AttachServerError({
        operation: "auth-prompt",
        message: "Auth prompt id source produced an existing id",
      }),
    );
  }
  login.promptIds.add(promptId);
  return Effect.gen(function* () {
    const completion = yield* Deferred.make<string, AttachServerError>();
    login.prompts.set(promptId, { completion });
    const event: ServerAuthFrame["event"] =
      prompt.type === "select"
        ? { kind: "select", promptId, message: prompt.message, options: prompt.options }
        : {
            kind: prompt.type,
            promptId,
            message: prompt.message,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
          };
    const delivered = deliver({
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId,
      loginId,
      event,
    });
    if (!delivered) {
      return yield* new AttachServerError({
        operation: "auth-prompt",
        message: "Auth prompt delivery failed",
      });
    }
    const abort = (): void => {
      deliver({
        schemaVersion: PROTOCOL_VERSION,
        type: "auth",
        requestId,
        loginId,
        event: { kind: "prompt_cancelled", promptId },
      });
      runHostEffect(
        Deferred.fail(
          completion,
          new AttachServerError({
            operation: "auth-prompt",
            message: "Auth prompt was cancelled",
          }),
        ).pipe(Effect.asVoid),
      );
    };
    prompt.signal?.addEventListener("abort", abort, { once: true });
    return yield* Deferred.await(completion).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          prompt.signal?.removeEventListener("abort", abort);
          login.prompts.delete(promptId);
        }),
      ),
    );
  });
}

function authNotifyFrame(requestId: string, loginId: string, event: AuthEvent): ServerAuthFrame {
  if (event.type === "info" || event.type === "progress") {
    return {
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId,
      loginId,
      event: { kind: event.type, message: event.message },
    };
  }
  if (event.type === "auth_url") {
    return {
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId,
      loginId,
      event: {
        kind: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      },
    };
  }
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "auth",
    requestId,
    loginId,
    event: {
      kind: "device_code",
      userCode: event.userCode,
      verificationUri: event.verificationUri,
    },
  };
}

function errorFrame(
  requestId: string | null,
  code: ProtocolErrorCode,
  message: string,
): ServerErrorFrame {
  return { schemaVersion: PROTOCOL_VERSION, requestId, type: "error", code, message };
}

function eventFrame(subscriptionId: string, event: SessionEnvelope): ServerSessionEventFrame {
  return { schemaVersion: PROTOCOL_VERSION, type: "event", subscriptionId, event };
}

function encodeOutboundFrame(frame: ServerFrame): OutboundFrame {
  const encoded = encodeServerFrame(frame);
  return { encoded, bytes: Buffer.byteLength(encoded) };
}

function cleanupAuthLogin(
  state: ConnectionState,
  loginId: string,
  login: PendingAuthLogin,
  message: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    login.controller.abort();
    const prompts = [...login.prompts.values()];
    login.prompts.clear();
    state.authLogins.delete(loginId);
    yield* Effect.forEach(prompts, (prompt) =>
      Deferred.fail(
        prompt.completion,
        new AttachServerError({ operation: "auth-prompt", message }),
      ),
    );
  });
}

function prepareSocketPath(socketPath: string): Effect.Effect<void, AttachServerError> {
  const runtimePath = dirname(socketPath);
  return Effect.gen(function* () {
    yield* filesystemOperation("prepare-runtime", "Failed to prepare Profile runtime path", () =>
      mkdir(runtimePath, { recursive: true, mode: 0o700 }),
    );
    const runtime = yield* filesystemOperation(
      "inspect-runtime",
      "Failed to inspect Profile runtime path",
      () => lstat(runtimePath),
    );
    if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
      return yield* new AttachServerError({
        operation: "inspect-runtime",
        message: "Profile .runtime path is not a safe directory",
      });
    }
    const existing = yield* lstatOptional(socketPath);
    if (Option.isNone(existing)) return;
    if (!existing.value.isSocket()) {
      return yield* new AttachServerError({
        operation: "prepare-socket",
        message: "Attach socket path contains a non-socket entry",
      });
    }
    yield* filesystemOperation("remove-stale-socket", "Failed to remove stale attach socket", () =>
      rm(socketPath),
    );
  });
}

function listen(server: Server, socketPath: string): Effect.Effect<void, AttachServerError> {
  return Effect.callback<void, AttachServerError>((resume) => {
    const onError = (cause: Error): void =>
      resume(
        Effect.fail(
          new AttachServerError({
            operation: "listen",
            message: "Failed to listen on attach socket",
            cause,
          }),
        ),
      );
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
    return Effect.sync(() => {
      server.off("error", onError);
    });
  });
}

function stopServer(
  server: Server,
  connections: Set<ConnectionState>,
): Effect.Effect<void, AttachServerError> {
  return Effect.callback<void, AttachServerError>((resume) => {
    server.close((cause) => {
      resume(
        cause === undefined
          ? Effect.void
          : Effect.fail(
              new AttachServerError({
                operation: "close-server",
                message: "Failed to close attach server",
                cause,
              }),
            ),
      );
    });
    for (const state of connections) {
      if (!state.socket.destroyed) state.socket.destroy();
    }
  });
}

function removeOwnedSocket(socketPath: string): Effect.Effect<void, AttachServerError> {
  return Effect.gen(function* () {
    const existing = yield* lstatOptional(socketPath);
    if (Option.isSome(existing) && existing.value.isSocket()) {
      yield* filesystemOperation("remove-socket", "Failed to remove attach socket", () =>
        rm(socketPath),
      );
    }
  });
}

function lstatOptional(
  path: string,
): Effect.Effect<Option.Option<Awaited<ReturnType<typeof lstat>>>, AttachServerError> {
  return filesystemOperation("inspect-path", "Failed to inspect attach path", () =>
    lstat(path),
  ).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      error.cause !== undefined && isMissingPath(error.cause)
        ? Effect.succeed(Option.none())
        : Effect.fail(error),
    ),
  );
}

function filesystemOperation<A>(
  operation: string,
  message: string,
  run: () => PromiseLike<A>,
): Effect.Effect<A, AttachServerError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new AttachServerError({ operation, message, cause }),
  });
}

function memoizeClose<E>(cleanup: Effect.Effect<void, E>): Effect.Effect<Effect.Effect<void, E>> {
  return Effect.gen(function* () {
    const result = yield* Deferred.make<void, E>();
    const started = yield* Ref.make(false);
    return yield* Effect.succeed(
      Effect.uninterruptible(
        Ref.modify(started, (current) => {
          const update: readonly [boolean, boolean] = [current, true];
          return update;
        }).pipe(
          Effect.flatMap((alreadyStarted) =>
            alreadyStarted
              ? Deferred.await(result)
              : Deferred.complete(result, cleanup).pipe(Effect.andThen(Deferred.await(result))),
          ),
        ),
      ),
    );
  });
}

const isErrnoException = Schema.is(Schema.Struct({ code: Schema.String }));

function isMissingPath(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}
