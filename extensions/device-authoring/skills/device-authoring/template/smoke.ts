// Loads commands.ts against a recording device, checks it with Ziggy's rules (rules.ts) and calls
// the commands in CALLS. Run it on the machine that writes the module: `bun smoke.ts <device id>`.
import type { CommandHandler, CommandSpec, Device, JsonObject, ToolResult } from "./device";
import { checkCommands, toolName } from "./rules";
import register from "./commands";

/** Commands smoke calls, with their arguments. Only ones safe to run off the device. */
const CALLS: ReadonlyArray<{ readonly name: string; readonly args: JsonObject }> = [
  { name: "counter_add", args: { amount: 2 } },
  { name: "counter_read", args: {} },
];

/** Commands that need the device's hardware or change the world; smoke lists them only. */
const ON_DEVICE: ReadonlyArray<string> = [];

const deviceId = process.argv[2] ?? "example";

const commands = new Map<string, { spec: CommandSpec; run: CommandHandler }>();

/** Every registration in order, so a name defined twice is reported, not silently replaced. */
const registered: Array<CommandSpec & { readonly name: string }> = [];

const recorder: Device = {
  command(name, spec, run) {
    commands.set(name, { spec, run });
    registered.push({ name, ...spec });

    return recorder;
  },
};

const text = (result: string | ToolResult): string =>
  typeof result === "string"
    ? result
    : result.content
        .map((part) => (part.type === "text" ? part.text : `[${part.mimeType}]`))
        .join("\n");

let failed = false;

register(recorder);

for (const problem of checkCommands(deviceId, registered)) {
  console.error(`problem: ${problem}`);
  failed = true;
}

for (const name of [...CALLS.map((call) => call.name), ...ON_DEVICE])
  if (!commands.has(name)) {
    console.error(`problem: ${name} is listed in smoke.ts but commands.ts does not define it`);
    failed = true;
  }

for (const name of commands.keys())
  if (!CALLS.some((call) => call.name === name) && !ON_DEVICE.includes(name))
    console.error(`warning: ${name} is in neither CALLS nor ON_DEVICE; it went untested`);

for (const call of CALLS) {
  const command = commands.get(call.name);

  if (command === undefined) continue;

  try {
    const result = await command.run(call.args);

    if (typeof result !== "string" && result.isError === true) {
      console.error(`fail ${toolName(deviceId, call.name)}: ${text(result)}`);
      failed = true;
    } else console.log(`ok   ${toolName(deviceId, call.name)}: ${text(result)}`);
  } catch (error) {
    console.error(`fail ${toolName(deviceId, call.name)}: ${String(error)}`);
    failed = true;
  }
}

for (const name of ON_DEVICE) console.log(`skip ${toolName(deviceId, name)}: on the device only`);

process.exit(failed ? 1 : 0);
