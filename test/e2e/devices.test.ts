/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/**
 * The device hub through a real resident: pairing with `ziggy devices pair`, reconnecting,
 * replacing, version refusal and revocation. Liveness runs an in-process hub with short timings.
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigProvider, Effect, Exit, Schema, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DeviceHubProjection,
  ZdpClose,
  ZdpErrorCode,
  decodeZdpPairing,
  issuePairingCode,
  runDeviceHub,
} from "ziggy/devices/index";
import { ziggy } from "../harness/cli";
import { connectDevice, type DeviceClient } from "../harness/device";
import { eventually } from "../harness/eventually";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer } from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";

const decodeHubProjection = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceHubProjection));

let server: ModelServer;

let profile: ScratchProfile;

const devices: Array<DeviceClient> = [];

const hubProjection = (path: string) =>
  readFile(join(path, ".runtime", "device-hub.json"), "utf8").then(
    (text) => Effect.runSync(decodeHubProjection(text)),
    () => undefined,
  );

const connect = async (port: number, keyPair?: DeviceClient["keyPair"]) => {
  const device = await connectDevice(keyPair === undefined ? { port } : { port, keyPair });

  devices.push(device);

  return device;
};

const hello = {
  zdp: "1",
  name: "Kitchen",
  model: "esp32-s3-box-3",
  firmware: "0.1.0",
  capabilities: { chat: {} },
};

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
});

afterEach(async () => {
  for (const device of devices.splice(0)) device.close();

  const codes = await stopResidents();

  server.stop();
  await profile.remove();
  expect(codes.every((code) => code === 0)).toBe(true);
});

test("without devices.json the resident opens no device port", async () => {
  await startResident(profile);

  expect(await hubProjection(profile.path)).toBeUndefined();
  expect((await ziggy(profile, "devices", "pair", profile.path)).stderr).toContain(
    "devices are off for this Profile",
  );
});

describe("with devices on", () => {
  let port: number;

  beforeEach(async () => {
    expect(
      (
        await ziggy(
          profile,
          "devices",
          "configure",
          profile.path,
          "--host",
          "127.0.0.1",
          "--port",
          "0",
        )
      ).exitCode,
    ).toBe(0);
    await startResident(profile);
    port = (await eventually("device hub", () => hubProjection(profile.path))).port;
  });

  const pair = async () => {
    const printed = await ziggy(profile, "devices", "pair", profile.path);

    expect(printed.exitCode).toBe(0);

    const uri = printed.stdout.split("\n")[0] ?? "";

    return Effect.runSync(decodeZdpPairing(uri));
  };

  test("a device pairs with the printed code, pins the hub key, and is listed online", async () => {
    const pairing = await pair();

    const device = await connect(pairing.port);

    expect(device.hubKey).toEqual(pairing.key);
    expect(
      await device.request("device.pair", {
        code: pairing.code.toLowerCase(),
        name: "Kitchen",
        model: "esp32-s3-box-3",
      }),
    ).toEqual({ result: { id: "kitchen", profile: "Harness" } });
    expect(await device.request("device.hello", hello)).toEqual({
      result: { id: "kitchen", profile: "Harness", zdp: "1" },
    });

    const listed = await ziggy(profile, "devices", "list", profile.path, "--json");

    expect(JSON.parse(listed.stdout)).toMatchObject([
      { id: "kitchen", name: "Kitchen", model: "esp32-s3-box-3", online: expect.any(String) },
    ]);

    // The code is spent: with another code open, it is refused; with none open, the key is dropped.
    await pair();

    const other = await connect(pairing.port);

    expect(
      await other.request("device.pair", { code: pairing.code, name: "Hall", model: "pi" }),
    ).toEqual({
      error: { code: ZdpErrorCode.notAllowed, message: "the pairing code is wrong or expired" },
    });
    expect((await other.closed).code).toBe(ZdpClose.unpaired);
    expect(await access(join(profile.path, "devices", "hall.json")).catch(() => "absent")).toBe(
      "absent",
    );
  });

  test("an unknown key is dropped unless a code is open", async () => {
    const device = await connect(port);

    expect((await device.closed).code).toBe(ZdpClose.unpaired);
  });

  test("a paired device reconnects with hello; a newer link replaces the older", async () => {
    const pairing = await pair();

    const first = await connect(port);

    await first.request("device.pair", { code: pairing.code, name: "Kitchen", model: "box" });

    expect(await first.request("ping")).toEqual({
      error: { code: ZdpErrorCode.notAllowed, message: "send device.hello first" },
    });
    await first.request("device.hello", hello);
    expect(await first.request("ping")).toEqual({ result: {} });

    const second = await connect(port, first.keyPair);

    expect(await second.request("device.hello", hello)).toEqual({
      result: { id: "kitchen", profile: "Harness", zdp: "1" },
    });
    expect((await first.closed).code).toBe(ZdpClose.replaced);
    expect(await second.request("tools/list")).toMatchObject({
      error: { code: ZdpErrorCode.methodNotFound },
    });
  });

  test("another zdp version is refused, and revoking drops the live link", async () => {
    const pairing = await pair();

    const device = await connect(port);

    await device.request("device.pair", { code: pairing.code, name: "Kitchen", model: "box" });
    expect(await device.request("device.hello", { ...hello, zdp: "2" })).toMatchObject({
      error: { code: ZdpErrorCode.version },
    });
    expect((await device.closed).code).toBe(ZdpClose.version);

    const again = await connect(port, device.keyPair);

    await again.request("device.hello", hello);
    expect((await ziggy(profile, "devices", "revoke", profile.path, "kitchen")).exitCode).toBe(0);
    expect((await again.closed).code).toBe(ZdpClose.unpaired);
    expect((await (await connect(port, device.keyPair)).closed).code).toBe(ZdpClose.unpaired);
  });
});

test("the hub pings an idle device and drops a silent one", async () => {
  const scope = Effect.runSync(Scope.make());

  const hub = await Effect.runPromise(
    runDeviceHub({
      profilePath: profile.path,
      profileName: "harness",
      hostname: "127.0.0.1",
      port: 0,
      timing: { handshakeMs: 1_000, idlePingMs: 100, deadMs: 600, sweepMs: 100 },
      log: () => Effect.void,
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ZIGGY_DEVICE_KEYSTORE: "file" }),
      ),
    ),
  );

  try {
    const { code } = await Effect.runPromise(issuePairingCode(profile.path, Date.now()));

    const device = await connect(hub.port);

    await device.request("device.pair", { code, name: "Kitchen", model: "box" });
    await device.request("device.hello", hello);
    await eventually("a ping", () =>
      device.received.some((message) => "method" in message && message.method === "ping"),
    );

    // Answering pings keeps it alive past the dead time; silence ends it.
    await Bun.sleep(700);
    expect(device.received.filter((message) => "method" in message).length).toBeGreaterThan(1);

    device.mute();

    const started = Date.now();

    expect((await device.closed).code).toBe(ZdpClose.timeout);
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
