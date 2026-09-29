import { turnHealthCounts } from "./chat-health";
import { Schema } from "effect";

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DiscordHealthState = Schema.Literals([
  "starting",
  "connected",
  "reconnecting",
  "failed",
  "stopped",
]);

export type DiscordHealthState = typeof DiscordHealthState.Type;

export const DiscordHealthFailure = Schema.Literals([
  "authentication",
  "connection",
  "queue-overflow",
  "socket",
  "thread",
  "turn",
]);

export type DiscordHealthFailure = typeof DiscordHealthFailure.Type;

export const DiscordHealthSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  state: DiscordHealthState,
  updatedAtMs: NonNegativeInteger,
  startedAtMs: NonNegativeInteger,
  lastConnectedAtMs: Schema.NullOr(NonNegativeInteger),
  lastInboundAtMs: Schema.NullOr(NonNegativeInteger),
  lastTurnCompletedAtMs: Schema.NullOr(NonNegativeInteger),
  activeTurnCount: NonNegativeInteger,
  queuedTurnCount: NonNegativeInteger,
  acceptedTurnCount: NonNegativeInteger,
  completedTurnCount: NonNegativeInteger,
  cancelledTurnCount: NonNegativeInteger,
  failedTurnCount: NonNegativeInteger,
  lastFailure: Schema.NullOr(DiscordHealthFailure),
});

export type DiscordHealthSnapshot = typeof DiscordHealthSnapshot.Type;

export type DiscordHealthProjection =
  | { readonly _tag: "not-configured" }
  | { readonly _tag: "not-observed" }
  | {
      readonly _tag: "observed";
      readonly observedAtMs: number;
      readonly snapshot: DiscordHealthSnapshot;
    };

export type DiscordHealthEvent =
  | { readonly _tag: "heartbeat"; readonly atMs: number }
  | { readonly _tag: "connected"; readonly atMs: number }
  | {
      readonly _tag: "reconnecting";
      readonly atMs: number;
      readonly failure: "connection" | "queue-overflow" | "socket";
    }
  | { readonly _tag: "failed"; readonly atMs: number; readonly failure: DiscordHealthFailure }
  | {
      readonly _tag: "boundary-failed";
      readonly atMs: number;
      readonly failure: "thread" | "turn";
    }
  | { readonly _tag: "inbound"; readonly atMs: number }
  | { readonly _tag: "accepted"; readonly atMs: number; readonly queued: boolean }
  | { readonly _tag: "started"; readonly atMs: number; readonly wasQueued: boolean }
  | { readonly _tag: "completed"; readonly atMs: number; readonly succeeded: boolean }
  | { readonly _tag: "cancelled"; readonly atMs: number; readonly wasQueued: boolean }
  | { readonly _tag: "stopped"; readonly atMs: number };

export const initialDiscordHealth = (atMs: number): DiscordHealthSnapshot => ({
  version: 1,
  state: "starting",
  updatedAtMs: atMs,
  startedAtMs: atMs,
  lastConnectedAtMs: null,
  lastInboundAtMs: null,
  lastTurnCompletedAtMs: null,
  activeTurnCount: 0,
  queuedTurnCount: 0,
  acceptedTurnCount: 0,
  completedTurnCount: 0,
  cancelledTurnCount: 0,
  failedTurnCount: 0,
  lastFailure: null,
});

export const evolveDiscordHealth = (
  current: DiscordHealthSnapshot,
  event: DiscordHealthEvent,
): DiscordHealthSnapshot => {
  const base = { ...current, updatedAtMs: event.atMs };

  switch (event._tag) {
    case "heartbeat":
      return base;
    case "connected":
      return { ...base, state: "connected", lastConnectedAtMs: event.atMs, lastFailure: null };
    case "reconnecting":
      return { ...base, state: "reconnecting", lastFailure: event.failure };
    case "failed":
      return { ...base, state: "failed", lastFailure: event.failure };
    case "boundary-failed":
      return { ...base, lastFailure: event.failure };
    case "inbound":
      return { ...base, lastInboundAtMs: event.atMs };
    case "accepted":
      return {
        ...base,
        ...turnHealthCounts(current, event),
        updatedAtMs: event.atMs,
      };
    case "started":
      return {
        ...base,
        ...turnHealthCounts(current, event),
        updatedAtMs: event.atMs,
      };
    case "completed":
      return {
        ...base,
        ...turnHealthCounts(current, event),
        updatedAtMs: event.atMs,
        lastTurnCompletedAtMs: event.atMs,
        lastFailure: event.succeeded ? current.lastFailure : "turn",
      };
    case "cancelled":
      return {
        ...base,
        ...turnHealthCounts(current, event),
        updatedAtMs: event.atMs,
        lastTurnCompletedAtMs: event.atMs,
      };
    case "stopped":
      return {
        ...base,
        ...turnHealthCounts(current, event),
        updatedAtMs: event.atMs,
        state: "stopped",
      };
  }
};

export class DiscordHealthProjectionError extends Schema.TaggedErrorClass<DiscordHealthProjectionError>()(
  "DiscordHealthProjectionError",
  {
    operation: Schema.Literals(["read", "write"]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
