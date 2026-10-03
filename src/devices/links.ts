/**
 * The devices online in this process. The hub attaches each connected device; device tools call
 * through here, so a session reaches a device only while this process's hub holds its link.
 */
import { Context, Effect, Layer, Schema, type Scope } from "effect";
import type { ToolResult } from "./protocol";

export class DeviceToolFailed extends Schema.TaggedErrorClass<DeviceToolFailed>()(
  "DeviceToolFailed",
  {
    deviceId: Schema.String,
    message: Schema.String,
  },
) {}

export type DeviceToolArguments = { readonly [key: string]: Schema.Json };

/**
 * What the hub may push to a device unasked. `display.image` carries a PNG or JPEG file's bytes;
 * the hub fits it to the device's screen and sends it as `display.show` with an image stream.
 */
export type DevicePush =
  | { readonly method: "notify"; readonly title?: string; readonly text: string }
  | { readonly method: "display.show"; readonly text: string }
  | { readonly method: "display.image"; readonly image: Uint8Array };

/** One connected device, as the hub serves it. */
export interface DeviceLink {
  readonly call: (
    name: string,
    args: DeviceToolArguments,
  ) => Effect.Effect<ToolResult, DeviceToolFailed>;
  /** Queues a push; `display.*` fails for a device without a screen or with a bad image. */
  readonly push: (message: DevicePush) => Effect.Effect<void, DeviceToolFailed>;
}

const linkKey = (profilePath: string, deviceId: string) => `${profilePath}\u0000${deviceId}`;

export class DeviceLinks extends Context.Service<DeviceLinks>()("ziggy/DeviceLinks", {
  make: Effect.sync(() => {
    const hubs = new Map<string, number>();

    const links = new Map<string, DeviceLink>();

    const linked = (profilePath: string, deviceId: string) =>
      Effect.suspend(() => {
        const link = links.get(linkKey(profilePath, deviceId));

        return link === undefined
          ? Effect.fail(new DeviceToolFailed({ deviceId, message: `${deviceId} is offline` }))
          : Effect.succeed(link);
      });

    return {
      /** A hub for this Profile runs in this process. */
      serving: (profilePath: string): boolean => (hubs.get(profilePath) ?? 0) > 0,
      /** Marks this Profile's hub as running for the scope. */
      serve: (profilePath: string): Effect.Effect<void, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.sync(() => void hubs.set(profilePath, (hubs.get(profilePath) ?? 0) + 1)),
          () => Effect.sync(() => void hubs.set(profilePath, (hubs.get(profilePath) ?? 1) - 1)),
        ),
      /** Routes calls for the device to `link` for the scope; a newer link replaces it. */
      attach: (
        profilePath: string,
        deviceId: string,
        link: DeviceLink,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.sync(() => void links.set(linkKey(profilePath, deviceId), link)),
          () =>
            Effect.sync(() => {
              if (links.get(linkKey(profilePath, deviceId)) === link)
                links.delete(linkKey(profilePath, deviceId));
            }),
        ),
      /** Calls a command; a device that is not connected fails at once. */
      call: (
        profilePath: string,
        deviceId: string,
        name: string,
        args: DeviceToolArguments,
      ): Effect.Effect<ToolResult, DeviceToolFailed> =>
        linked(profilePath, deviceId).pipe(Effect.flatMap((link) => link.call(name, args))),
      /** Pushes to a device; one that is not connected fails at once. */
      push: (
        profilePath: string,
        deviceId: string,
        message: DevicePush,
      ): Effect.Effect<void, DeviceToolFailed> =>
        linked(profilePath, deviceId).pipe(Effect.flatMap((link) => link.push(message))),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export type DeviceLinksApi = (typeof DeviceLinks)["Service"];
