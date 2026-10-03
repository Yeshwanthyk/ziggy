/**
 * Pushing to devices through a real resident: an automation broadcast to `device:<id>` arrives as a
 * `notify`, and the model's `device_show` tool puts text on a device's screen.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type ChatEvent,
  type DisplayEvent,
  type ScreenCapability,
  ZiggyDevice,
} from "../../packages/device/src/index";
import { ziggy } from "../harness/cli";
import { eventually } from "../harness/eventually";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer, text, tools } from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";

let server: ModelServer;

let profile: ScratchProfile;

let resident: Awaited<ReturnType<typeof startResident>>;

interface Heard {
  readonly chat: Array<ChatEvent>;
  readonly notices: Array<{ readonly title?: string; readonly text: string }>;
  readonly shown: Array<DisplayEvent>;
}

const devices: Array<ZiggyDevice> = [];

const heard = new Map<ZiggyDevice, Heard>();

const pairDevice = async (name: string, screen?: ScreenCapability) => {
  const printed = await ziggy(profile, "devices", "pair", profile.path);

  const device = new ZiggyDevice(
    screen === undefined
      ? { name, model: "pi-zero-2w" }
      : { name, model: "esp32-s3-box-3", screen },
  );

  const events: Heard = { chat: [], notices: [], shown: [] };

  heard.set(device, events);
  device.on("chat", (event) => events.chat.push(event));
  device.on("notify", (notice) => events.notices.push(notice));
  device.on("display", (event) => events.shown.push(event));
  devices.push(device);
  await device.pair(printed.stdout.split("\n")[0] ?? "");

  return { device, events };
};

const decodeListed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ online: Schema.NullOr(Schema.String) }))),
);

const writeAutomation = async (broadcast: string) => {
  await mkdir(join(profile.path, "automations"), { recursive: true });
  await writeFile(
    join(profile.path, "automations", "coffee.md"),
    `---\nversion: 1\ncron: 0 9 * * *\ntimezone: UTC\nbroadcast: ${broadcast}\n---\n\nRemind me about coffee.\n`,
    "utf8",
  );
};

const turnEnd = (events: Heard, turn: string) =>
  eventually(`the end of ${turn}`, () =>
    events.chat.find(
      (event) => event.turn === turn && (event.type === "done" || event.type === "error"),
    ),
  );

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
  heard.clear();
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
  resident = await startResident(profile);
  await eventually("device hub", () =>
    access(join(profile.path, ".runtime", "device-hub.json")).then(
      () => true,
      () => false,
    ),
  );
});

afterEach(async () => {
  for (const device of devices.splice(0)) device.stop();

  const codes = await stopResidents();

  server.stop();
  await profile.remove();
  expect(codes.every((code) => code === 0)).toBe(true);
});

test("U1: an automation broadcast to device:<id> arrives as a notify", async () => {
  const { events } = await pairDevice("Kitchen");

  await writeAutomation("device:kitchen");
  server.push(text("Coffee time."));

  const woke = await ziggy(profile, "wake", profile.path, "coffee");

  expect(woke.stderr).toContain("wake delivered: device:kitchen");
  expect(woke.exitCode).toBe(0);
  expect(await eventually("the notice", () => events.notices[0])).toEqual({
    title: "Harness",
    text: "Coffee time.",
  });
});

test("U2: an offline device fails as retriable transport; an unpaired one as missing", async () => {
  const { device } = await pairDevice("Kitchen");

  device.stop();
  await writeAutomation("device:kitchen,device:attic");
  await eventually("kitchen offline", async () =>
    decodeListed((await ziggy(profile, "devices", "list", profile.path, "--json")).stdout)[0]
      ?.online === null
      ? true
      : undefined,
  );
  server.push(text("Coffee time."));

  const woke = await ziggy(profile, "wake", profile.path, "coffee");

  expect(woke.exitCode).toBe(1);
  expect(woke.stderr).toContain("wake delivery failed: device:kitchen (transport, retriable)");
  expect(woke.stderr).toContain(
    "wake delivery failed: device:attic (destination-missing, not retriable)",
  );
});

test("U3: device_show puts text on a screen and fails on a device without one; a device that chats is a destination", async () => {
  const box = await pairDevice("Box", { width: 320, height: 240, formats: ["rgb565"] });

  await pairDevice("Speaker");
  server.push(
    tools({ name: "device_show", arguments: { device: "box", text: "Timer: 5 min" } }),
    tools({ name: "device_show", arguments: { device: "speaker", text: "hello" } }),
    text("shown"),
  );
  expect(await box.device.send("show my timer")).toEqual({ turn: "t1" });
  expect(await turnEnd(box.events, "t1")).toMatchObject({ type: "done", text: "shown" });

  expect(box.events.shown).toEqual([{ text: "Timer: 5 min" }]);
  expect(server.toolResults(1)).toContain("shown on box");
  expect(server.toolResults(2)).toContain("speaker has no screen");

  const client = await resident.connect();

  expect((await client.gateway.listDestinations(client.profileId)).entries).toContainEqual(
    expect.objectContaining({ target: "device:box", kind: "device", label: "Box" }),
  );
});

test("U5: device_show sends a Profile image fitted to each screen, in a format the device takes", async () => {
  const box = await pairDevice("Box", { width: 320, height: 240, formats: ["rgb565", "jpeg"] });

  const frame = await pairDevice("Frame", { width: 64, height: 48, formats: ["jpeg"] });

  await mkdir(join(profile.path, "pictures"), { recursive: true });
  await writeFile(
    join(profile.path, "pictures", "chart.png"),
    await Bun.file(join(import.meta.dir, "..", "devices", "images", "rgb8.png")).bytes(),
  );
  await writeFile(join(profile.path, "notes.txt"), "not a picture", "utf8");
  server.push(
    tools({ name: "device_show", arguments: { device: "box", image: "pictures/chart.png" } }),
    tools({ name: "device_show", arguments: { device: "frame", image: "pictures/chart.png" } }),
    tools({ name: "device_show", arguments: { device: "box", image: "notes.txt" } }),
    tools({ name: "device_show", arguments: { device: "box", image: "../outside.png" } }),
    text("shown"),
  );
  expect(await box.device.send("show the chart")).toEqual({ turn: "t1" });
  expect(await turnEnd(box.events, "t1")).toMatchObject({ type: "done", text: "shown" });

  const [boxImage] = box.events.shown.flatMap((event) => ("image" in event ? [event.image] : []));

  const [frameImage] = frame.events.shown.flatMap((event) =>
    "image" in event ? [event.image] : [],
  );

  expect(boxImage).toMatchObject({ format: "rgb565", width: 320, height: 240 });
  expect(boxImage?.data.length).toBe(320 * 240 * 2);
  // Letterboxed: black at the corner, the 9×7 picture at the centre.
  expect([...(boxImage?.data.subarray(0, 2) ?? [])]).toEqual([0, 0]);
  expect([
    ...(boxImage?.data.subarray((120 * 320 + 160) * 2, (120 * 320 + 160) * 2 + 2) ?? []),
  ]).not.toEqual([0, 0]);
  expect(frameImage).toMatchObject({ format: "jpeg", width: 64, height: 48 });
  expect([...(frameImage?.data.subarray(0, 2) ?? [])]).toEqual([0xff, 0xd8]);
  expect(server.toolResults(1)).toContain("shown on box");
  expect(server.toolResults(2)).toContain("shown on frame");
  expect(server.toolResults(3)).toContain("only PNG and JPEG images can be shown");
  expect(server.toolResults(4)).toContain("outside the Profile");
});
