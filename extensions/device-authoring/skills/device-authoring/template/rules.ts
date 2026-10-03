// The rules Ziggy and `@ziggy/device` apply to a device's commands, so smoke.ts can fail where
// the device would refuse a command or the Profile would skip its tool. A test in Ziggy's
// repository keeps them in agreement. No dependencies. You should not need to edit it.

/** `ZiggyDevice.command` throws for any other name. */
export const COMMAND_NAME = /^[a-z0-9_]{1,48}$/;

/** A device id as `ziggy devices pair` gives it. */
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Providers refuse longer tool names, so Ziggy skips the tool with a warning. */
export const MAX_TOOL_NAME = 64;

export const toolName = (deviceId: string, command: string): string =>
  `device__${deviceId}__${command}`;

export interface Command {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Each problem makes the device refuse the command or the Profile skip or misuse the tool. */
export const checkCommands = (
  deviceId: string,
  commands: ReadonlyArray<Command>,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];

  if (!DEVICE_ID.test(deviceId)) problems.push(`device id ${deviceId} must match ${DEVICE_ID}`);

  const seen = new Set<string>();

  for (const command of commands) {
    if (!COMMAND_NAME.test(command.name))
      problems.push(`${command.name}: command names must match ${COMMAND_NAME}`);
    else if (toolName(deviceId, command.name).length > MAX_TOOL_NAME)
      problems.push(
        `${toolName(deviceId, command.name)} is longer than ${MAX_TOOL_NAME} characters; Ziggy skips it`,
      );

    if (seen.has(command.name)) problems.push(`${command.name}: defined twice; the last one wins`);

    seen.add(command.name);

    if (command.description === undefined || command.description.trim().length === 0)
      problems.push(`${command.name}: add a description; it is all the model knows of it`);

    if (command.inputSchema !== undefined) {
      if (!isRecord(command.inputSchema) || command.inputSchema.type !== "object")
        problems.push(`${command.name}: inputSchema must be a JSON Schema with type "object"`);
    }
  }

  return problems;
};
