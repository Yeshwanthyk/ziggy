/**
 * A connected device's commands as Profile tools: `device__<id>__<cmd>`, one per command the device
 * listed, calling it over the hub's link, plus `device_show` to put text on a device's screen.
 * Only a process whose hub is running offers them.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { runCallback } from "../platform/callback";
import type { SessionTools } from "../session";
import type { DeviceLinksApi, DeviceToolArguments } from "./links";
import type { DeviceTool, ToolResult } from "./protocol";
import { type DeviceRecord, listDevices } from "./registry";

/** Providers refuse longer tool names. */
const MAX_TOOL_NAME = 64;

export const deviceToolName = (deviceId: string, command: string): string =>
  `device__${deviceId}__${command}`;

const piContent = (result: ToolResult) =>
  result.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, data: part.data, mimeType: part.mimeType },
  );

const resultText = (result: ToolResult): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const defineDeviceTool = (
  links: DeviceLinksApi,
  profilePath: string,
  device: DeviceRecord,
  command: DeviceTool,
): ToolDefinition => {
  const name = deviceToolName(device.id, command.name);

  return {
    name,
    label: name,
    description: `${device.name} (${device.model}): ${command.description ?? command.name}`,
    parameters: Type.Unsafe<DeviceToolArguments>(command.inputSchema),
    execute(_toolCallId, params: DeviceToolArguments, signal) {
      const program = links.call(profilePath, device.id, command.name, params).pipe(
        Effect.match({
          onFailure: (failure) => ({ ok: false as const, message: failure.message }),
          onSuccess: (result) =>
            result.isError === true
              ? { ok: false as const, message: resultText(result) || `${name} failed` }
              : { ok: true as const, result },
        }),
      );

      // Pi marks a tool call failed when `execute` rejects.
      return runCallback(program, signal).then((outcome) => {
        if (!outcome.ok) throw new Error(outcome.message);

        return { content: piContent(outcome.result), details: undefined };
      });
    },
  };
};

interface DeviceShowArguments {
  readonly device: string;
  readonly text: string;
}

/** Puts text on a paired device's screen; a device without one, or offline, fails the call. */
const defineDeviceShow = (
  links: DeviceLinksApi,
  profilePath: string,
  devices: ReadonlyArray<DeviceRecord>,
): ToolDefinition => ({
  name: "device_show",
  label: "device_show",
  description: `Show text on a device's screen. Devices: ${devices
    .map((device) => `${device.id} (${device.name})`)
    .join(", ")}.`,
  parameters: Type.Object({
    device: Type.Union(devices.map((device) => Type.Literal(device.id))),
    text: Type.String({ minLength: 1 }),
  }),
  execute(_toolCallId, params: DeviceShowArguments, signal) {
    const program = links
      .push(profilePath, params.device, { method: "display.show", text: params.text })
      .pipe(
        Effect.match({
          onFailure: (failure) => ({ ok: false as const, message: failure.message }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );

    return runCallback(program, signal).then((outcome) => {
      if (!outcome.ok) throw new Error(outcome.message);

      return {
        content: [{ type: "text" as const, text: `shown on ${params.device}` }],
        details: undefined,
      };
    });
  },
});

/** Contributes the commands of this Profile's devices while its hub runs in this process. */
export const deviceTools =
  (links: DeviceLinksApi): SessionTools =>
  ({ profilePath }) =>
    !links.serving(profilePath)
      ? Effect.succeed([])
      : listDevices(profilePath).pipe(
          Effect.flatMap((devices) =>
            Effect.forEach(
              devices.flatMap((device) =>
                (device.tools ?? []).map((command) => ({ device, command })),
              ),
              ({ device, command }) =>
                deviceToolName(device.id, command.name).length > MAX_TOOL_NAME
                  ? Effect.logWarning(
                      `device tool ${deviceToolName(device.id, command.name)} is longer than ${MAX_TOOL_NAME} characters; skipped`,
                    ).pipe(Effect.as([]))
                  : Effect.succeed([defineDeviceTool(links, profilePath, device, command)]),
            ).pipe(Effect.map((tools) => ({ devices, tools }))),
          ),
          Effect.map(({ devices, tools }) =>
            devices.length === 0
              ? tools.flat()
              : [...tools.flat(), defineDeviceShow(links, profilePath, devices)],
          ),
          Effect.catch((failure) =>
            Effect.logWarning(`device tools unavailable: ${failure.message}`).pipe(Effect.as([])),
          ),
        );
