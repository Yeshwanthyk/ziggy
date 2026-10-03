#!/usr/bin/env bun
/**
 * `ziggy-device`: run a Ziggy device from a shell, e.g. on a Raspberry Pi.
 *
 *   ziggy-device pair '<zdp://… URI>' --state device.json [--name Kitchen] [--model pi]
 *   ziggy-device run --state device.json [--commands ./commands.ts] [--screen 320x240]
 *
 * The state file holds the device's private key; it is written 0600. A commands module's default
 * export is called with the device before it connects, to add commands. `--screen` declares a
 * screen, so `display.show` text arrives as `display …` lines.
 *
 * While running, each line on stdin is sent to the Profile as a chat message, and `/abort` stops
 * the running turn. The reply is logged as `chat <turn> …` lines.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { type DeviceIdentity, ZiggyDevice, type ZiggyDeviceOptions } from "../src/index";

const USAGE = `usage:
  ziggy-device pair <uri> --state <file> [--name <name>] [--model <model>]
  ziggy-device run --state <file> [--commands <module>] [--screen <width>x<height>]`;

const log = (line: string) => console.log(`[ziggy-device] ${line}`);

const fail = (message: string): never => {
  console.error(`ziggy-device: ${message}`);
  process.exit(1);
};

const parse = (argv: ReadonlyArray<string>) => {
  const flags = new Map<string, string>();

  const words: Array<string> = [];

  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";

    if (!word.startsWith("--")) {
      words.push(word);
      continue;
    }

    const value = argv[index + 1];

    if (value === undefined) fail(`${word} needs a value`);

    flags.set(word.slice(2), value ?? "");
    index += 1;
  }

  return { words, flags };
};

const isIdentity = (value: DeviceIdentity | null | undefined | string | number | boolean) =>
  typeof value === "object" &&
  value !== null &&
  value.version === 1 &&
  typeof value.id === "string" &&
  typeof value.privateKey === "string" &&
  typeof value.hub.key === "string";

const readIdentity = async (path: string): Promise<DeviceIdentity> => {
  const text = await readFile(path, "utf8").catch(() =>
    fail(`no device state at ${path}; pair first`),
  );

  // SAFETY: checked by isIdentity before use.
  const value = JSON.parse(text) as DeviceIdentity;

  return isIdentity(value) ? value : fail(`${path} is not a device state file`);
};

const parseScreen = (value: string) => {
  const match = /^(\d+)x(\d+)$/.exec(value) ?? fail("--screen must be <width>x<height>");

  return { width: Number(match[1]), height: Number(match[2]), formats: ["rgb565" as const] };
};

const deviceOptions = (identity: DeviceIdentity, screen?: string): ZiggyDeviceOptions => {
  const options: ZiggyDeviceOptions = { name: identity.name, model: identity.model, identity };

  return screen === undefined ? options : { ...options, screen: parseScreen(screen) };
};

const watch = (device: ZiggyDevice) => {
  device.on("state", (state, closed) =>
    log(
      closed === undefined
        ? state
        : `${state} (${closed.code}${closed.reason ? ` ${closed.reason}` : ""})`,
    ),
  );
  device.on("notify", (notice) =>
    log(`notify ${notice.title ?? ""} ${notice.text}`.replaceAll("  ", " ")),
  );
  device.on("display", (event) =>
    log(
      "text" in event
        ? `display ${event.text}`
        : `display image ${event.image.width}x${event.image.height}`,
    ),
  );
};

const chat = (device: ZiggyDevice) => {
  device.on("chat", (event) => {
    if (event.type === "status")
      log(`chat ${event.turn} ${event.state}${event.tool === undefined ? "" : ` ${event.tool}`}`);
    else if (event.type === "error") log(`chat ${event.turn} error ${event.message}`);
    else log(`chat ${event.turn} ${event.type} ${event.text}`);
  });

  createInterface({ input: process.stdin }).on("line", (line) => {
    const text = line.trim();

    if (text.length === 0) return;

    const sent = text === "/abort" ? device.abort() : device.send(text);

    sent.catch((error: Error) => log(`chat refused: ${error.message}`));
  });
};

const loadCommands = async (device: ZiggyDevice, path: string) => {
  const module: { readonly default?: (device: ZiggyDevice) => void | Promise<void> } = await import(
    pathToFileURL(resolve(path)).href
  );

  if (typeof module.default !== "function") fail(`${path} must export a default function`);

  await module.default?.(device);
};

const [command, ...rest] = process.argv.slice(2);

const { words, flags } = parse(rest);

const statePath = flags.get("state") ?? fail(USAGE);

if (command === "pair") {
  const uri = words[0] ?? fail(USAGE);

  const device = new ZiggyDevice({
    name: flags.get("name") ?? hostname().split(".")[0] ?? "device",
    model: flags.get("model") ?? `${process.platform}-${process.arch}`,
  });

  const identity = await device.pair(uri).catch((error: Error) => fail(error.message));

  await writeFile(statePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  log(`paired as ${identity.id} with ${identity.profile}; state in ${statePath}`);
  device.stop();
} else if (command === "run") {
  const device = new ZiggyDevice(deviceOptions(await readIdentity(statePath), flags.get("screen")));

  const commands = flags.get("commands");

  if (commands !== undefined) await loadCommands(device, commands);

  watch(device);
  chat(device);

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => device.stop());

  device.on("state", (state, closed) => {
    if (state === "stopped") process.exit(closed?.code === 1000 ? 0 : 1);
  });

  await device.start().catch(() => undefined);
} else {
  fail(USAGE);
}
