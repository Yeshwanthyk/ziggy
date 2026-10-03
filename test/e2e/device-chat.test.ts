/**
 * Device chat through a real resident: a `@ziggy/device` sends text, the Profile answers in the
 * device's own session, and the turn streams back as `chat.*` notifications.
 */
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type ChatEvent,
  DeviceRpcError,
  ZdpErrorCode,
  ZiggyDevice,
} from "../../packages/device/src/index";
import { ziggy } from "../harness/cli";
import { eventually } from "../harness/eventually";
import { scratchProfile, type ScratchProfile } from "../harness/profile";
import {
  type ModelServer,
  fail,
  gate,
  held,
  lastUserContent,
  startModelServer,
  text,
} from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";

let server: ModelServer;

let profile: ScratchProfile;

let kitchen: ZiggyDevice;

let events: Array<ChatEvent>;

const turnEnd = (turn: string) =>
  eventually(`the end of ${turn}`, () =>
    events.find(
      (event) => event.turn === turn && (event.type === "done" || event.type === "error"),
    ),
  );

beforeEach(async () => {
  server = startModelServer();
  profile = await scratchProfile(server);
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

  const printed = await ziggy(profile, "devices", "pair", profile.path);

  events = [];
  kitchen = new ZiggyDevice({ name: "Kitchen", model: "pi-zero-2w" });
  kitchen.on("chat", (event) => events.push(event));
  await kitchen.pair(printed.stdout.split("\n")[0] ?? "");
});

afterEach(async () => {
  kitchen.stop();

  const codes = await stopResidents();

  server.stop();
  await profile.remove();
  expect(codes.every((code) => code === 0)).toBe(true);
});

test("T1, T2: a turn streams status, deltas and done, and the next one continues the session", async () => {
  server.push(text("hello from ziggy"), text("still here"));

  expect(await kitchen.send("hi")).toEqual({ turn: "t1" });
  expect(await turnEnd("t1")).toEqual({ type: "done", turn: "t1", text: "hello from ziggy" });

  const first = events.filter((event) => event.turn === "t1");

  expect(first[0]).toEqual({ type: "status", turn: "t1", state: "thinking" });
  expect(first.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("")).toBe(
    "hello from ziggy",
  );
  expect(first.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);

  const sessions = join(profile.path, "sessions", "device", "kitchen");

  expect((await readdir(sessions)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

  expect(await kitchen.send("and now?")).toEqual({ turn: "t2" });
  expect(await turnEnd("t2")).toMatchObject({ type: "done", text: "still here" });
  expect(lastUserContent(server.request(1))).toContain("and now?");
  expect(server.raw(1)).toContain("hello from ziggy");
  expect((await readdir(sessions)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
});

test("T3, T4: a second send while busy is refused, and abort ends the turn with an error", async () => {
  const slow = gate();

  server.push(held("partial", " rest", slow));

  expect(await kitchen.send("take your time")).toEqual({ turn: "t1" });
  await slow.started;

  const busy = await kitchen.send("me too").catch((error: DeviceRpcError) => error);

  expect(busy).toBeInstanceOf(DeviceRpcError);
  expect(busy).toMatchObject({ code: ZdpErrorCode.busy });

  await kitchen.abort();
  expect(await turnEnd("t1")).toEqual({
    type: "error",
    turn: "t1",
    message: "the turn was aborted",
  });
  slow.release();

  // The device can talk again, and the refused message never reached the model.
  server.push(text("back"));
  expect(await kitchen.send("again")).toEqual({ turn: "t2" });
  expect(await turnEnd("t2")).toMatchObject({ type: "done", text: "back" });
  expect(server.rawRequests.some((raw) => raw.includes("me too"))).toBe(false);
  expect(events.filter((event) => event.turn === "t1" && event.type === "done")).toEqual([]);
});

test("T5: a model failure reaches the device as chat.error", async () => {
  server.push(fail(400, "the harness model refused"));

  expect(await kitchen.send("hi")).toEqual({ turn: "t1" });

  // Provider details stay in the resident's log; the device gets the same text the UI does.
  expect(await turnEnd("t1")).toEqual({
    type: "error",
    turn: "t1",
    message: "provider request failed",
  });
  expect(events.some((event) => event.type === "done")).toBe(false);
});

test("V6: without speech.transcribe the hub refuses audio and keeps the link", async () => {
  const refused = await kitchen.sendAudio(new Uint8Array(32_000)).then(
    () => undefined,
    (error: DeviceRpcError) => ({ code: error.code, message: error.message }),
  );

  expect(refused).toEqual({
    code: ZdpErrorCode.notAllowed,
    message: "chat.send: this hub has no speech-to-text; set speech.transcribe in devices.json",
  });

  server.push(text("still listening"));
  expect(await kitchen.send("hi")).toEqual({ turn: "t1" });
  expect(await turnEnd("t1")).toMatchObject({ type: "done", text: "still listening" });
});
