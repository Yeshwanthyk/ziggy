/**
 * ZDP/1 conformance for `@ziggy/device` against a real resident's hub: pair and pin, hello,
 * reconnect after the hub restarts, and the closes that end a device for good. The firmware SDK
 * (S7) runs the same scenarios.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DeviceStoppedError,
  type DeviceClosed,
  type DeviceIdentity,
  type DeviceState,
  NoiseError,
  ZdpClose,
  ZiggyDevice,
  type ZiggyDeviceOptions,
  generateKeyPair,
} from "../../packages/device/src/index";
import { ziggy } from "../harness/cli";
import { eventually } from "../harness/eventually";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer } from "../harness/provider";
import { type Resident, startResident, stopResidents } from "../harness/resident";

let server: ModelServer;

let profile: ScratchProfile;

let port: number;

const devices: Array<ZiggyDevice> = [];

/** A port free right now, so the hub comes back on the same one after a restart. */
const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });

  const free = probe.port ?? 0;

  void probe.stop(true);

  return free;
};

const startHub = async (): Promise<Resident> => {
  const resident = await startResident(profile);

  await eventually("device hub", () =>
    access(join(profile.path, ".runtime", "device-hub.json")).then(
      () => true,
      () => false,
    ),
  );

  return resident;
};

interface Watched {
  readonly device: ZiggyDevice;
  readonly states: Array<{ readonly state: DeviceState; readonly closed?: DeviceClosed }>;
}

const device = (options: Partial<ZiggyDeviceOptions> = {}): Watched => {
  const made = new ZiggyDevice({
    name: "Kitchen",
    model: "pi-zero-2w",
    timing: { backoffMinMs: 50, backoffMaxMs: 200 },
    ...options,
  });

  const states: Watched["states"] = [];

  made.on("state", (state, closed) =>
    states.push(closed === undefined ? { state } : { state, closed }),
  );
  devices.push(made);

  return { device: made, states };
};

const pairingUri = async () => {
  const printed = await ziggy(profile, "devices", "pair", profile.path);

  expect(printed.exitCode).toBe(0);

  return printed.stdout.split("\n")[0] ?? "";
};

const paired = async (): Promise<DeviceIdentity> => {
  const { device: first } = device();

  const identity = await first.pair(await pairingUri());

  first.stop();

  return identity;
};

const listed = async () =>
  JSON.parse((await ziggy(profile, "devices", "list", profile.path, "--json")).stdout);

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
  port = freePort();
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
        String(port),
      )
    ).exitCode,
  ).toBe(0);
});

afterEach(async () => {
  for (const made of devices.splice(0)) made.stop();

  const codes = await stopResidents();

  server.stop();
  await profile.remove();
  expect(codes.every((code) => code === 0)).toBe(true);
});

test("pair: the device pins the hub key, gets an id, and comes online", async () => {
  await startHub();

  const { device: kitchen, states } = device();

  const identity = await kitchen.pair(await pairingUri());

  expect(identity).toMatchObject({
    version: 1,
    id: "kitchen",
    profile: "Harness",
    name: "Kitchen",
    hub: { host: "127.0.0.1", port },
  });
  expect(kitchen.state).toBe("online");
  expect(states.map(({ state }) => state)).toEqual(["connecting", "online"]);
  expect(await listed()).toMatchObject([{ id: "kitchen", online: expect.any(String) }]);
});

test("pair: a hub proving another key is refused before the code is sent", async () => {
  await startHub();

  const uri = await pairingUri();

  const forged = uri.replace(
    /key=[^&]+/,
    `key=${Buffer.from(generateKeyPair().publicKey).toString("base64url")}`,
  );

  const { device: kitchen } = device();

  await expect(kitchen.pair(forged)).rejects.toBeInstanceOf(NoiseError);
  await eventually("the refusal", () => kitchen.state === "stopped");
  expect(await listed()).toEqual([]);

  // The code was never spent, so the real URI still pairs.
  expect((await device().device.pair(uri)).id).toBe("kitchen");
});

test("start: a paired device says hello and reconnects when the hub restarts", async () => {
  const hub = await startHub();

  const identity = await paired();

  const { device: kitchen, states } = device({ identity });

  await kitchen.start();
  expect(await hub.stop()).toBe(0);
  await eventually("offline", () => states.some(({ state }) => state === "offline"));

  await startHub();
  await eventually("online again", () => kitchen.state === "online", 8_000);
  const seen = states.map(({ state }) => state);

  // Offline between the two onlines, retrying with backoff, and never stopped.
  expect(seen[0]).toBe("connecting");
  expect(seen.indexOf("offline")).toBeGreaterThan(seen.indexOf("online"));
  expect(seen.at(-1)).toBe("online");
  expect(seen).not.toContain("stopped");
  expect(await listed()).toMatchObject([{ id: "kitchen", online: expect.any(String) }]);
});

test("revoke: the device stops for good with 4401 and does not retry", async () => {
  await startHub();

  const identity = await paired();

  const { device: kitchen, states } = device({ identity });

  await kitchen.start();
  expect((await ziggy(profile, "devices", "revoke", profile.path, "kitchen")).exitCode).toBe(0);
  await eventually("stopped", () => kitchen.state === "stopped");
  expect(states.at(-1)?.closed?.code).toBe(ZdpClose.unpaired);

  await Bun.sleep(300);
  expect(states.at(-1)?.state).toBe("stopped");

  const { device: again } = device({ identity });

  await expect(again.start()).rejects.toBeInstanceOf(DeviceStoppedError);
});

test("replace: a second instance with the same identity ends the first with 4409", async () => {
  await startHub();

  const identity = await paired();

  const { device: first, states } = device({ identity });

  await first.start();

  const { device: second } = device({ identity });

  await second.start();
  await eventually("first stopped", () => first.state === "stopped");
  expect(states.at(-1)?.closed?.code).toBe(ZdpClose.replaced);
  expect(second.state).toBe("online");
});
