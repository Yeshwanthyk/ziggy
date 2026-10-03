/**
 * What the hub needs to let a device talk to the Profile. The resident implements it with a live
 * session per device; the hub only turns its events into `chat.*` notifications.
 */
import { type Effect, Schema } from "effect";
import type { DeviceRecord } from "./registry";

/** One step of a turn, in order; exactly one `done` or `error` ends it. */
export type DeviceChatEvent =
  | { readonly kind: "thinking" }
  | { readonly kind: "tool"; readonly tool: string }
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export class DeviceChatRefused extends Schema.TaggedErrorClass<DeviceChatRefused>()(
  "DeviceChatRefused",
  {
    /** `busy`: a turn is already running for this device. */
    reason: Schema.Literals(["busy", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface DeviceChat {
  /** Starts a turn and returns once it runs; its events then arrive through `emit`. */
  readonly start: (
    device: DeviceRecord,
    text: string,
    emit: (event: DeviceChatEvent) => void,
  ) => Effect.Effect<void, DeviceChatRefused>;
  /** Stops the device's running turn, which then ends with `error`. Nothing running is fine. */
  readonly abort: (device: DeviceRecord) => Effect.Effect<void>;
}
