/**
 * Device commands as Profile tools through a real resident: a `@ziggy/device` declares commands,
 * the hub lists them, and the model calls them as `device__<id>__<cmd>` over the device's link.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChatEvent, ZiggyDevice } from "../../packages/device/src/index";
import { ziggy } from "../harness/cli";
import { eventually } from "../harness/eventually";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import { type ModelServer, startModelServer, text, tools } from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";

let server: ModelServer;

let profile: ScratchProfile;

const devices: Array<ZiggyDevice> = [];

const events = new Map<ZiggyDevice, Array<ChatEvent>>();

const toolNames = (index: number): ReadonlyArray<string> =>
  (server.request(index).tools ?? []).map((tool) => tool.function.name);

const deviceToolNames = (index: number) =>
  toolNames(index)
    .filter((name) => name.startsWith("device__"))
    .toSorted();

const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
);

const decodeListed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ online: Schema.NullOr(Schema.String) }))),
);

const storedTools = (id: string) =>
  readFile(join(profile.path, "devices", `${id}.json`), "utf8").then(
    (json) => decodeStored(json).tools?.map((tool) => tool.name) ?? [],
  );

const turnEnd = (device: ZiggyDevice, turn: string) =>
  eventually(`the end of ${turn}`, () =>
    events
      .get(device)
      ?.find((event) => event.turn === turn && (event.type === "done" || event.type === "error")),
  );

/** Pairs a new device; `setup` adds its commands before it connects. */
const pairDevice = async (name: string, setup: (device: ZiggyDevice) => void = () => {}) => {
  const printed = await ziggy(profile, "devices", "pair", profile.path);

  const device = new ZiggyDevice({ name, model: "pi-zero-2w" });

  const heard: Array<ChatEvent> = [];

  setup(device);
  events.set(device, heard);
  device.on("chat", (event) => heard.push(event));
  devices.push(device);
  await device.pair(printed.stdout.split("\n")[0] ?? "");

  return device;
};

const kitchenCommands = (lights: Array<string>) => (device: ZiggyDevice) =>
  device.command(
    "light",
    {
      description: "Turn the kitchen light on or off.",
      inputSchema: {
        type: "object",
        properties: { on: { type: "boolean" } },
        required: ["on"],
      },
    },
    ({ on }) => {
      lights.push(on === true ? "on" : "off");

      return on === true ? "the light is on" : "the light is off";
    },
  );

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
  events.clear();
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

test("K1, K2: a device's command is a tool the model calls, and its result reaches the model", async () => {
  const lights: Array<string> = [];

  const kitchen = await pairDevice("Kitchen", kitchenCommands(lights));

  await eventually("kitchen's tools", async () =>
    (await storedTools("kitchen")).includes("light") ? true : undefined,
  );

  server.push(
    tools({ name: "device__kitchen__light", arguments: { on: true } }),
    text("done, it is on"),
  );
  expect(await kitchen.send("light please")).toEqual({ turn: "t1" });
  expect(await turnEnd(kitchen, "t1")).toMatchObject({ type: "done", text: "done, it is on" });

  expect(deviceToolNames(0)).toEqual(["device__kitchen__light"]);
  expect(server.raw(0)).toContain("Turn the kitchen light on or off.");
  expect(lights).toEqual(["on"]);
  expect(server.toolResults(1)).toContain("the light is on");
  expect(
    (events.get(kitchen) ?? []).some(
      (event) =>
        event.type === "status" &&
        event.state === "tool" &&
        event.tool === "device__kitchen__light",
    ),
  ).toBe(true);

  // A process without the hub offers no device tools.
  server.push(text("no devices here"));
  expect((await ziggy(profile, "run", profile.path, "hi")).exitCode).toBe(0);
  expect(deviceToolNames(server.requests.length - 1)).toEqual([]);
});

test("K3: calling an offline device fails at once with a clear error", async () => {
  const kitchen = await pairDevice("Kitchen", kitchenCommands([]));

  await eventually("kitchen's tools", async () =>
    (await storedTools("kitchen")).includes("light") ? true : undefined,
  );
  kitchen.stop();
  await eventually("kitchen offline", async () => {
    const listed = await ziggy(profile, "devices", "list", profile.path, "--json");

    return decodeListed(listed.stdout)[0]?.online === null ? true : undefined;
  });

  const hall = await pairDevice("Hall");

  server.push(
    tools({ name: "device__kitchen__light", arguments: { on: true } }),
    text("kitchen is away"),
  );

  const started = Date.now();

  expect(await hall.send("kitchen light")).toEqual({ turn: "t1" });
  expect(await turnEnd(hall, "t1")).toMatchObject({ type: "done", text: "kitchen is away" });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(deviceToolNames(0)).toEqual(["device__kitchen__light"]);
  expect(server.toolResults(1)).toContain("kitchen is offline");
});

test("K4: a specialist without the device tool in its allowlist never sees it", async () => {
  const kitchen = await pairDevice("Kitchen", kitchenCommands([]));

  await eventually("kitchen's tools", async () =>
    (await storedTools("kitchen")).includes("light") ? true : undefined,
  );
  await mkdir(join(profile.path, "agents"), { recursive: true });
  await writeFile(
    join(profile.path, "agents", "researcher.md"),
    "---\nversion: 1\ndescription: Looks things up.\ntools: read\n---\n\nResearch carefully.\n",
    "utf8",
  );
  server.push(
    tools({ name: "agent_run", arguments: { agent: "researcher", prompt: "look around" } }),
    text("nothing to see"),
    text("all done"),
  );

  expect(await kitchen.send("delegate")).toEqual({ turn: "t1" });
  expect(await turnEnd(kitchen, "t1")).toMatchObject({ type: "done", text: "all done" });
  expect(deviceToolNames(0)).toEqual(["device__kitchen__light"]);
  expect(toolNames(1)).toEqual(["read"]);
});

test("K5: a command added while online reaches sessions opened after it", async () => {
  const kitchen = await pairDevice("Kitchen", kitchenCommands([]));

  await eventually("kitchen's tools", async () =>
    (await storedTools("kitchen")).includes("light") ? true : undefined,
  );
  kitchen.command("timer", { description: "Start a kitchen timer." }, () => "timer started");
  await eventually("the timer tool", async () =>
    (await storedTools("kitchen")).includes("timer") ? true : undefined,
  );

  const hall = await pairDevice("Hall");

  server.push(text("hi from the hall"));
  expect(await hall.send("what can kitchen do?")).toEqual({ turn: "t1" });
  expect(await turnEnd(hall, "t1")).toMatchObject({ type: "done" });
  expect(deviceToolNames(0)).toEqual(["device__kitchen__light", "device__kitchen__timer"]);
});
