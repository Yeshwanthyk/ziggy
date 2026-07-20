import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  decodeClientRequest,
  encodeServerFrame,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  type ClientRequestFrame,
  type ProtocolErrorCode,
  type ServerErrorFrame,
  type ServerFrame,
  type ServerSessionEventFrame,
  type SessionEnvelope,
} from "@ziggy/protocol";
import {
  ApprovalDecisionNotAllowedError,
  SessionRuntimeClosedError,
  StaleTurnError,
  type SessionSubscription,
} from "../agent/runtime.ts";
import type { DaemonKernel } from "./kernel.ts";
import type { RegisteredSessionRuntime } from "./registry.ts";

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_MAX_OUTBOUND_BYTES = 1024 * 1024;
const SOCKET_MODE = 0o600;

export interface CreateAttachServerOptions {
  readonly kernel: DaemonKernel;
  readonly nextSessionId?: () => string;
  readonly nextSubscriptionId?: () => string;
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxOutboundBytes?: number;
}

export interface AttachServer {
  readonly socketPath: string;
  close(): Promise<void>;
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

interface ConnectionState {
  readonly socket: Socket;
  readonly subscriptions: Map<string, ConnectionSubscription>;
  readonly outbound: OutboundFrame[];
  readonly drainWaiters: Set<ReturnType<typeof Promise.withResolvers<void>>>;
  inbound: Buffer;
  initializeState: InitializeState;
  pendingRequests: number;
  outboundBytes: number;
  deferredBytes: number;
  writeBlocked: boolean;
  endAfterDrain: boolean;
  accepting: boolean;
  closed: boolean;
}

class SessionNotFoundError extends Error {}
class InvalidRequestError extends Error {}
class ConnectionDeliveryError extends Error {}

export async function createAttachServer(
  options: CreateAttachServerOptions,
): Promise<AttachServer> {
  const maxFrameBytes = positiveLimit(
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    "maxFrameBytes",
  );
  const maxPendingRequests = positiveLimit(
    options.maxPendingRequests,
    DEFAULT_MAX_PENDING_REQUESTS,
    "maxPendingRequests",
  );
  const maxOutboundBytes = positiveLimit(
    options.maxOutboundBytes,
    DEFAULT_MAX_OUTBOUND_BYTES,
    "maxOutboundBytes",
  );
  const nextSessionId = options.nextSessionId ?? randomUUID;
  const nextSubscriptionId = options.nextSubscriptionId ?? randomUUID;
  const socketPath = join(options.kernel.profilePath, ".runtime", "ziggy.sock");
  const connections = new Set<ConnectionState>();
  const operations = new Set<Promise<void>>();
  let closing = false;
  let closingPromise: Promise<void> | undefined;

  await prepareSocketPath(socketPath);

  const server = createServer((socket) => {
    const state: ConnectionState = {
      socket,
      subscriptions: new Map(),
      outbound: [],
      drainWaiters: new Set(),
      inbound: Buffer.alloc(0),
      initializeState: "waiting",
      pendingRequests: 0,
      outboundBytes: 0,
      deferredBytes: 0,
      writeBlocked: false,
      endAfterDrain: false,
      accepting: true,
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
  });

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
    try {
      request = decodeClientRequest(frame);
    } catch (error) {
      if (error instanceof ProtocolDecodeError) {
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
          errorFrame(request.requestId, "already-initialized", "Connection is already initialized"),
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
          features: ["sessionReplay", "turnSteering", "turnInterrupt", "approvals"],
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
    if (state.pendingRequests >= maxPendingRequests) {
      sendFrame(
        state,
        errorFrame(request.requestId, "overloaded", "Connection is overloaded; retry later"),
      );
      return;
    }

    state.pendingRequests += 1;
    const operation = runRequest(state, request);
    operations.add(operation);
    const settle = (): void => {
      state.pendingRequests -= 1;
      operations.delete(operation);
    };
    void operation.then(settle, settle);
  }

  async function runRequest(state: ConnectionState, request: ClientRequestFrame): Promise<void> {
    try {
      await dispatchRequest(state, request);
    } catch (error) {
      if (!state.closed) sendRequestError(state, request.requestId, error);
    }
  }

  async function dispatchRequest(
    state: ConnectionState,
    request: ClientRequestFrame,
  ): Promise<void> {
    switch (request.method) {
      case "initialize":
        throw new Error("Initialize requests must be handled before dispatch");
      case "session/start": {
        const sessionId = nextSessionId();
        if ((await options.kernel.getSessionSummary(sessionId)) !== undefined) {
          throw new Error(`Session id source produced existing id ${sessionId}`);
        }
        await options.kernel.getOrCreateSession(sessionId);
        const session = await options.kernel.getSessionSummary(sessionId);
        if (session === undefined) throw new Error(`Started Session ${sessionId} is missing`);
        sendFrame(state, {
          schemaVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          method: "session/start",
          type: "success",
          result: { session },
        });
        return;
      }
      case "session/resume": {
        const runtime = await getExistingRuntime(request.params.sessionId);
        const session = await options.kernel.getSessionSummary(request.params.sessionId);
        if (session === undefined) throw new SessionNotFoundError();
        const subscriptionId = nextSubscriptionId();
        await subscribeConnection(state, runtime, subscriptionId, request.params.sinceSeq, (tail) =>
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
          result: { sessions: await options.kernel.listSessions() },
        });
        return;
      case "session/subscribe": {
        const runtime = await getExistingRuntime(request.params.sessionId);
        const subscriptionId = nextSubscriptionId();
        await subscribeConnection(state, runtime, subscriptionId, request.params.sinceSeq, (tail) =>
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
          unsubscribeConnection(state, subscription);
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
        if (request.params.message.length === 0) throw new InvalidRequestError();
        const runtime = await getExistingRuntime(request.params.sessionId);
        const result = await runtime.startTurn({ message: request.params.message });
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
        if (request.params.message.length === 0) throw new InvalidRequestError();
        const runtime = await getExistingRuntime(request.params.sessionId);
        const result = await runtime.steer({
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
        const runtime = await getExistingRuntime(request.params.sessionId);
        const result = await runtime.interrupt({ expectedTurnId: request.params.expectedTurnId });
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
        const runtime = await getExistingRuntime(request.params.sessionId);
        const result = await runtime.resolveApproval({
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
  }

  async function getExistingRuntime(sessionId: string): Promise<RegisteredSessionRuntime> {
    if ((await options.kernel.getSessionSummary(sessionId)) === undefined) {
      throw new SessionNotFoundError();
    }
    return options.kernel.getOrCreateSession(sessionId);
  }

  async function subscribeConnection(
    state: ConnectionState,
    runtime: RegisteredSessionRuntime,
    subscriptionId: string,
    sinceSeq: number,
    onReplayStart: (replayThroughSeq: number) => boolean,
  ): Promise<void> {
    if (state.subscriptions.has(subscriptionId)) {
      throw new Error(`Subscription id source produced existing id ${subscriptionId}`);
    }
    const connectionSubscription: ConnectionSubscription = {
      deferred: [],
      active: true,
      replaying: true,
      deferredBytes: 0,
      subscription: undefined,
    };
    state.subscriptions.set(subscriptionId, connectionSubscription);
    let replayCompletion: Promise<void> | undefined;
    try {
      const subscription = await runtime.subscribe({
        sinceSeq,
        onReplay(replay, replayThroughSeq) {
          if (!onReplayStart(replayThroughSeq)) throw new ConnectionDeliveryError();
          replayCompletion = deliverReplay(state, connectionSubscription, subscriptionId, replay);
          void replayCompletion.catch(() => {});
        },
        onEnvelope(envelope) {
          if (!connectionSubscription.active) throw new ConnectionDeliveryError();
          if (connectionSubscription.replaying) {
            if (!deferEnvelope(state, connectionSubscription, subscriptionId, envelope)) {
              throw new ConnectionDeliveryError();
            }
          } else if (!sendEnvelope(state, subscriptionId, envelope)) {
            throw new ConnectionDeliveryError();
          }
        },
      });
      connectionSubscription.subscription = subscription;
      if (!connectionSubscription.active || state.closed) {
        subscription.unsubscribe();
        state.subscriptions.delete(subscriptionId);
      }
      const replay = replayCompletion;
      if (replay === undefined) throw new Error("Session subscription did not provide replay");
      await replay;
    } catch (error) {
      unsubscribeConnection(state, connectionSubscription);
      state.subscriptions.delete(subscriptionId);
      throw error;
    }
  }

  async function deliverReplay(
    state: ConnectionState,
    connectionSubscription: ConnectionSubscription,
    subscriptionId: string,
    replay: ReadonlyArray<SessionEnvelope>,
  ): Promise<void> {
    for (const envelope of replay) {
      if (
        !connectionSubscription.active ||
        !(await sendEnvelopePaced(state, subscriptionId, envelope))
      ) {
        throw new ConnectionDeliveryError();
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
      if (!(await sendEncodedFramePaced(state, frame))) throw new ConnectionDeliveryError();
    }
    throw new ConnectionDeliveryError();
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

  async function sendEnvelopePaced(
    state: ConnectionState,
    subscriptionId: string,
    event: SessionEnvelope,
  ): Promise<boolean> {
    return sendEncodedFramePaced(state, encodeOutboundFrame(eventFrame(subscriptionId, event)));
  }

  function sendRequestError(state: ConnectionState, requestId: string, error: unknown): void {
    if (error instanceof SessionNotFoundError) {
      sendFrame(state, errorFrame(requestId, "session-not-found", "Session was not found"));
    } else if (error instanceof StaleTurnError) {
      sendFrame(state, errorFrame(requestId, "stale-turn", "Turn is no longer active"));
    } else if (error instanceof InvalidRequestError) {
      sendFrame(state, errorFrame(requestId, "invalid-params", "Turn message must be non-empty"));
    } else if (error instanceof ApprovalDecisionNotAllowedError) {
      sendFrame(state, errorFrame(requestId, "invalid-params", "Approval decision is not allowed"));
    } else if (error instanceof SessionRuntimeClosedError || closing) {
      sendFrame(state, errorFrame(requestId, "shutting-down", "Daemon is shutting down"));
    } else if (!(error instanceof ConnectionDeliveryError)) {
      sendFrame(state, errorFrame(requestId, "internal", "Internal daemon error"));
    }
  }

  function sendFrame(state: ConnectionState, frame: ServerFrame): boolean {
    return sendEncodedFrame(state, encodeOutboundFrame(frame));
  }

  function sendEncodedFrame(state: ConnectionState, frame: OutboundFrame): boolean {
    if (state.closed) return false;
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

  async function sendEncodedFramePaced(
    state: ConnectionState,
    frame: OutboundFrame,
  ): Promise<boolean> {
    if (!sendEncodedFrame(state, frame)) return false;
    if (state.writeBlocked) await waitForDrain(state);
    return !state.closed;
  }

  function fitsOutboundBudget(state: ConnectionState, bytes: number): boolean {
    return (
      bytes <= maxOutboundBytes &&
      state.socket.writableLength + state.outboundBytes + state.deferredBytes + bytes <=
        maxOutboundBytes
    );
  }

  function waitForDrain(state: ConnectionState): Promise<void> {
    if (state.closed) return Promise.reject(new ConnectionDeliveryError());
    if (!state.writeBlocked) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    state.drainWaiters.add(waiter);
    return waiter.promise;
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
      for (const waiter of state.drainWaiters) waiter.resolve();
      state.drainWaiters.clear();
    }
    if (!state.writeBlocked && state.outbound.length === 0 && state.endAfterDrain) {
      state.socket.end();
    }
  }

  function failConnection(state: ConnectionState, frame: ServerErrorFrame): void {
    if (state.closed) return;
    state.accepting = false;
    state.socket.pause();
    unsubscribeAll(state);
    if (!sendFrame(state, frame)) return;
    if (state.writeBlocked || state.outbound.length > 0) {
      state.endAfterDrain = true;
    } else {
      state.socket.end();
    }
  }

  function closeConnection(state: ConnectionState, destroy: boolean): void {
    if (state.closed) return;
    state.closed = true;
    state.accepting = false;
    state.inbound = Buffer.alloc(0);
    state.outbound.length = 0;
    state.outboundBytes = 0;
    for (const waiter of state.drainWaiters) waiter.reject(new ConnectionDeliveryError());
    state.drainWaiters.clear();
    unsubscribeAll(state);
    state.deferredBytes = 0;
    connections.delete(state);
    if (destroy && !state.socket.destroyed) state.socket.destroy();
  }

  function unsubscribeAll(state: ConnectionState): void {
    for (const subscription of state.subscriptions.values()) {
      unsubscribeConnection(state, subscription);
    }
    state.subscriptions.clear();
  }

  function unsubscribeConnection(
    state: ConnectionState,
    connectionSubscription: ConnectionSubscription,
  ): void {
    if (!connectionSubscription.active) return;
    connectionSubscription.active = false;
    state.deferredBytes -= connectionSubscription.deferredBytes;
    connectionSubscription.deferred.length = 0;
    connectionSubscription.deferredBytes = 0;
    connectionSubscription.subscription?.unsubscribe();
  }

  await listen(server, socketPath);
  try {
    await chmod(socketPath, SOCKET_MODE);
    const socket = await lstat(socketPath);
    if (!socket.isSocket() || (socket.mode & 0o777) !== SOCKET_MODE) {
      throw new Error("Attach socket is not a mode-0600 Unix socket");
    }
  } catch (error) {
    await stopServer(server, connections);
    await removeOwnedSocket(socketPath);
    throw error;
  }

  return {
    socketPath,
    close() {
      if (closingPromise !== undefined) return closingPromise;
      closing = true;
      closingPromise = (async () => {
        await stopServer(server, connections);
        await Promise.allSettled(operations);
        await removeOwnedSocket(socketPath);
      })();
      return closingPromise;
    },
  };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
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

async function prepareSocketPath(socketPath: string): Promise<void> {
  const runtimePath = dirname(socketPath);
  await mkdir(runtimePath, { recursive: true, mode: 0o700 });
  const runtime = await lstat(runtimePath);
  if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
    throw new Error("Profile .runtime path is not a safe directory");
  }
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error("Attach socket path contains a non-socket entry");
    }
    await rm(socketPath);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function stopServer(server: Server, connections: Set<ConnectionState>): Promise<void> {
  const stopped = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
  for (const state of connections) {
    if (!state.socket.destroyed) state.socket.destroy();
  }
  await stopped;
}

async function removeOwnedSocket(socketPath: string): Promise<void> {
  try {
    const existing = await lstat(socketPath);
    if (existing.isSocket()) await rm(socketPath);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
