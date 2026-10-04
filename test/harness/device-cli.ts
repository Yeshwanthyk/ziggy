/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- a harness executable is an approved Effect execution boundary */
/**
 * The harness device from a shell, for verify-ziggy-devices:
 *
 *   bun test/harness/device-cli.ts pair '<zdp://… URI>' <key-file> [name] [--hold <ms>]
 *   bun test/harness/device-cli.ts connect <port> <key-file> [--hold <ms>]
 *
 * The key file holds the device's private key (base64url) and is created on first use. Prints
 * one JSON line per event and the close code; exits 0 if hello succeeded.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { decodeZdpPairing } from "ziggy/devices/index";
import { generateNoiseKeyPair, noiseKeyPairFromPrivate } from "ziggy/platform/noise";
import { connectDevice } from "./device";

const [command, target = "", keyFile = "", ...rest] = process.argv.slice(2);

const holdIndex = rest.indexOf("--hold");

const holdMs = holdIndex === -1 ? 0 : Number(rest[holdIndex + 1]);

const name = (holdIndex === 0 ? undefined : rest[0]) ?? "Harness Device";

const log = (event: string, detail: string) =>
  console.log(`{"event":"${event}","detail":${detail}}`);

const keyPair = existsSync(keyFile)
  ? noiseKeyPairFromPrivate(
      new Uint8Array(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64url")),
    )
  : generateNoiseKeyPair();

if (!existsSync(keyFile))
  writeFileSync(keyFile, `${Buffer.from(keyPair.privateKey).toString("base64url")}\n`, {
    mode: 0o600,
  });

const pairing = command === "pair" ? Effect.runSync(decodeZdpPairing(target)) : undefined;

if (command !== "pair" && command !== "connect") {
  console.error("usage: device-cli.ts pair <uri> <key-file> [name] | connect <port> <key-file>");
  process.exit(2);
}

const device = await connectDevice({
  host: pairing?.host ?? "127.0.0.1",
  port: pairing?.port ?? Number(target),
  keyPair,
});

void device.closed.then((closed) => log("closed", JSON.stringify(closed)));

const hubKey = Buffer.from(device.hubKey).toString("base64url");

log(
  "handshake",
  JSON.stringify({
    hubKey,
    pinned:
      pairing === undefined ? null : hubKey === Buffer.from(pairing.key).toString("base64url"),
  }),
);

const step = async (method: string, params?: Parameters<typeof device.request>[1]) => {
  const reply = await device
    .request(method, params)
    .catch((error: Error) => ({ error: error.message }));

  log(method, JSON.stringify(reply));

  return reply;
};

if (pairing !== undefined)
  await step("device.pair", { code: pairing.code, name, model: "harness" });

const hello = await step("device.hello", {
  zdp: "1",
  name,
  model: "harness",
  firmware: "0.0.0",
  capabilities: { chat: {} },
});

await Bun.sleep(holdMs);

log("received", JSON.stringify(device.received));

device.close();

await Promise.race([device.closed, Bun.sleep(500)]);

process.exit("result" in hello ? 0 : 1);
