#!/usr/bin/env bun
/**
 * `ziggy-device`: run a Ziggy device from a shell, e.g. on a Raspberry Pi.
 *
 *   ziggy-device pair '<zdp://… URI>' --state device.json [--name Kitchen] [--model pi]
 *   ziggy-device run --state device.json [--commands ./commands.ts] [--screen 320x240]
 *                    [--formats rgb565,jpeg] [--display-dir ./shown]
 *
 * The state file holds the device's private key; it is written 0600. A commands module's default
 * export is called with the device before it connects, to add commands. `--screen` declares a
 * screen taking `--formats` (default rgb565), so `display.show` text arrives as `display …` lines,
 * and each image is saved in `--display-dir` as `display-<n>.png` (or `.jpg`) when given.
 *
 * While running, each line on stdin is sent to the Profile as a chat message, and `/abort` stops
 * the running turn. `/audio <file.wav>` sends a recording instead (16 kHz mono 16-bit PCM WAV, as
 * `say -o x.wav --data-format=LEI16@16000` writes); the hub's transcript is logged as
 * `chat <turn> transcript …`. The reply is logged as `chat <turn> …` lines.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  type DeviceIdentity,
  type ScreenCapability,
  ZiggyDevice,
  type ZiggyDeviceOptions,
} from "../src/index";

const USAGE = `usage:
  ziggy-device pair <uri> --state <file> [--name <name>] [--model <model>]
  ziggy-device run --state <file> [--commands <module>] [--screen <width>x<height>]
                   [--formats rgb565,jpeg] [--display-dir <dir>]`;

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

const isFormat = (format: string): format is "rgb565" | "jpeg" =>
  format === "rgb565" || format === "jpeg";

const parseScreen = (value: string, formats = "rgb565"): ScreenCapability => {
  const match = /^(\d+)x(\d+)$/.exec(value) ?? fail("--screen must be <width>x<height>");

  const listed = formats.split(",").map((format) => format.trim());

  const valid = listed.filter(isFormat);

  const [first, ...others] = valid;

  if (first === undefined || valid.length !== listed.length)
    return fail("--formats lists rgb565 and/or jpeg");

  return { width: Number(match[1]), height: Number(match[2]), formats: [first, ...others] };
};

const deviceOptions = (
  identity: DeviceIdentity,
  screen?: string,
  formats?: string,
): ZiggyDeviceOptions => {
  const options: ZiggyDeviceOptions = { name: identity.name, model: identity.model, identity };

  return screen === undefined ? options : { ...options, screen: parseScreen(screen, formats) };
};

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;

  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;

  return crc >>> 0;
});

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;

  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array) => {
  const chunk = Buffer.alloc(12 + data.length);

  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);

  return chunk;
};

/** An rgb565 frame (little-endian) as an 8-bit RGB PNG, to look at what the hub sent. */
const rgb565Png = (width: number, height: number, data: Uint8Array) => {
  const rows = Buffer.alloc(height * (1 + width * 3));

  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const value = (data[(y * width + x) * 2] ?? 0) | ((data[(y * width + x) * 2 + 1] ?? 0) << 8);

      const at = y * (1 + width * 3) + 1 + x * 3;

      rows[at] = ((value >> 11) & 0x1f) * 8.226;
      rows[at + 1] = ((value >> 5) & 0x3f) * 4.048;
      rows[at + 2] = (value & 0x1f) * 8.226;
    }

  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ]);
};

let shown = 0;

const saveImage = async (
  directory: string,
  image: { format: string; width: number; height: number; data: Uint8Array },
) => {
  shown += 1;

  const path = join(directory, `display-${shown}.${image.format === "jpeg" ? "jpg" : "png"}`);

  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    image.format === "rgb565" ? rgb565Png(image.width, image.height, image.data) : image.data,
  );

  return path;
};

const watch = (device: ZiggyDevice, displayDir?: string) => {
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
  device.on("display", (event) => {
    if ("text" in event) return log(`display ${event.text}`);

    const { format, width, height, data } = event.image;

    const line = `display image ${width}x${height} ${format} ${data.length} bytes`;

    if (displayDir === undefined) return log(line);

    saveImage(displayDir, event.image).then(
      (path) => log(`${line} saved ${path}`),
      (error: Error) => log(`${line} not saved: ${error.message}`),
    );
  });
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

    const sent =
      text === "/abort"
        ? device.abort()
        : text.startsWith("/audio ")
          ? readWav(text.slice("/audio ".length).trim()).then((pcm) => device.sendAudio(pcm))
          : device.send(text);

    sent.catch((error: Error) => log(`chat refused: ${error.message}`));
  });
};

/** The samples of a 16 kHz mono 16-bit PCM WAV file. */
const readWav = async (path: string) => {
  const bytes = new Uint8Array(await readFile(path));

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const tag = (offset: number) => new TextDecoder().decode(bytes.subarray(offset, offset + 4));

  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new Error(`${path} is not a WAV file`);

  let format: { channels: number; rate: number; bits: number; pcm: boolean } | undefined;

  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);

    if (tag(offset) === "fmt ")
      format = {
        pcm: view.getUint16(offset + 8, true) === 1,
        channels: view.getUint16(offset + 10, true),
        rate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      };
    else if (tag(offset) === "data") {
      if (
        format === undefined ||
        !format.pcm ||
        format.channels !== 1 ||
        format.rate !== 16_000 ||
        format.bits !== 16
      )
        throw new Error(`${path} must be 16 kHz mono 16-bit PCM`);

      return bytes.subarray(offset + 8, offset + 8 + size);
    }

    offset += 8 + size + (size % 2);
  }

  throw new Error(`${path} has no audio`);
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
  const device = new ZiggyDevice(
    deviceOptions(await readIdentity(statePath), flags.get("screen"), flags.get("formats")),
  );

  const commands = flags.get("commands");

  if (commands !== undefined) await loadCommands(device, commands);

  watch(device, flags.get("display-dir"));
  chat(device);

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => device.stop());

  device.on("state", (state, closed) => {
    if (state === "stopped") process.exit(closed?.code === 1000 ? 0 : 1);
  });

  await device.start().catch(() => undefined);
} else {
  fail(USAGE);
}
