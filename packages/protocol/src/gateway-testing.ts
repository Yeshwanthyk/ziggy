import { decodeEnvelopeValue } from "./client.ts";
import {
  decodeGatewaySessionResolveRequest,
  decodeGatewayStreamRequest,
  type GatewayResumeHandle,
  type GatewaySessionResolveRequest,
  type GatewaySessionResolveResponse,
  type GatewayStreamHandle,
  type GatewayStreamRequest,
  type GatewayStreamResponse,
} from "./gateway.ts";
import type { SessionEnvelope } from "./types.ts";

/**
 * Dependency-free specification peer for leaf Gateway contract tests. It models atomic
 * resume-route resolution and ordered replay, but deliberately does not model daemon persistence.
 */
export class FakeGatewayAttachPeer {
  readonly #routes = new Map<string, string>();
  readonly #events = new Map<string, ReadonlyArray<SessionEnvelope>>();
  #nextSession = 1;

  get sessionCount(): number {
    return this.#events.size;
  }

  resolveSession(request: GatewaySessionResolveRequest): GatewaySessionResolveResponse {
    const decoded = decodeGatewaySessionResolveRequest(request);
    const key = resumeKey(decoded.resumeHandle);
    const existing = this.#routes.get(key);
    if (existing !== undefined) {
      return { disposition: "resumed", streamHandle: streamHandle(existing) };
    }

    const sessionId = `gateway-fixture-${this.#nextSession}`;
    this.#nextSession += 1;
    this.#routes.set(key, sessionId);
    this.#events.set(sessionId, []);
    return { disposition: "started", streamHandle: streamHandle(sessionId) };
  }

  append(stream: GatewayStreamHandle, envelopes: ReadonlyArray<SessionEnvelope>): void {
    const request = decodeGatewayStreamRequest({ streamHandle: stream, sinceSeq: 0 });
    const existing = this.#events.get(request.streamHandle.sessionId);
    if (existing === undefined) throw new TypeError("Unknown Gateway stream handle");

    const appended = [...existing];
    let previousSeq = appended.at(-1)?.seq ?? 0;
    for (const envelope of envelopes) {
      const decoded = decodeEnvelopeValue(envelope);
      if (decoded.event.sessionId !== request.streamHandle.sessionId) {
        throw new TypeError("Gateway stream event belongs to a different Session");
      }
      if (decoded.seq !== previousSeq + 1) {
        throw new TypeError("Gateway stream events must have contiguous increasing sequences");
      }
      appended.push(decoded);
      previousSeq = decoded.seq;
    }
    this.#events.set(request.streamHandle.sessionId, appended);
  }

  stream(request: GatewayStreamRequest): GatewayStreamResponse {
    const decoded = decodeGatewayStreamRequest(request);
    const events = this.#events.get(decoded.streamHandle.sessionId);
    if (events === undefined) throw new TypeError("Unknown Gateway stream handle");
    return {
      replayThroughSeq: events.at(-1)?.seq ?? 0,
      events: events.filter((event) => event.seq > decoded.sinceSeq),
    };
  }
}

function resumeKey(handle: GatewayResumeHandle): string {
  return JSON.stringify(handle);
}

function streamHandle(sessionId: string): GatewayStreamHandle {
  return { type: "session-stream", sessionId };
}
