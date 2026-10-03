/**
 * Device voice through a real resident: a device streams PCM, the hub runs the Profile's
 * `speech.transcribe` command on it as a WAV, and the transcript starts a turn like typed text.
 * The command here is a script that names the size of the WAV it was given.
 */
import { access, readFile, writeFile } from "node:fs/promises";
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
import { type ModelServer, lastUserContent, startModelServer, text } from "../harness/provider";
import { startResident, stopResidents } from "../harness/resident";

// 16000 bytes of audio (0.5 s) is heard as silence; 16002 makes the program fail.
const TRANSCRIBE = `#!/bin/sh
bytes=$(( $(wc -c < "$1") - 44 ))
case $bytes in
  16000) exit 0 ;;
  16002) echo "the microphone model is missing" >&2; exit 3 ;;
esac
printf '  turn on the kitchen light (%s bytes)\\n' "$bytes"
`;

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

const refusal = (pcm: Uint8Array) =>
  kitchen.sendAudio(pcm).then(
    () => undefined,
    (error: DeviceRpcError) => ({ code: error.code, message: error.message }),
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

  const script = join(profile.path, "transcribe.sh");

  await writeFile(script, TRANSCRIBE);

  const config = join(profile.path, "devices.json");

  await writeFile(
    config,
    JSON.stringify({
      ...JSON.parse(await readFile(config, "utf8")),
      speech: { transcribe: { command: ["/bin/sh", script, "{wav}"] } },
    }),
  );
  await startResident(profile);
  await eventually("device hub", () =>
    access(join(profile.path, ".runtime", "device-hub.json")).then(
      () => true,
      () => false,
    ),
  );

  const printed = await ziggy(profile, "devices", "pair", profile.path);

  events = [];
  kitchen = new ZiggyDevice({ name: "Kitchen", model: "box-3" });
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

test("V1, V2, V3: speech becomes a turn: reply, then transcript, then the answer", async () => {
  server.push(text("the kitchen light is on"));

  // 1.5 s of audio, more than one 16 KiB chunk.
  expect(await kitchen.sendAudio(new Uint8Array(48_000))).toEqual({ turn: "t1" });
  expect(await turnEnd("t1")).toEqual({
    type: "done",
    turn: "t1",
    text: "the kitchen light is on",
  });
  expect(events[0]).toEqual({
    type: "transcript",
    turn: "t1",
    text: "turn on the kitchen light (48000 bytes)",
  });
  expect(lastUserContent(server.request(0))).toContain("turn on the kitchen light (48000 bytes)");
});

test("V5: too short, too long, silent and failed recordings are refused without a turn", async () => {
  expect(await refusal(new Uint8Array(9_598))).toEqual({
    code: ZdpErrorCode.invalidParams,
    message: "chat.send: a recording must last at least 0.3 seconds",
  });
  expect(await refusal(new Uint8Array(640_002))).toEqual({
    code: ZdpErrorCode.invalidParams,
    message: "chat.send: a recording may last at most 20 seconds",
  });
  expect(await refusal(new Uint8Array(16_000))).toEqual({
    code: ZdpErrorCode.invalidParams,
    message: "chat.send: no speech was heard",
  });
  expect(await refusal(new Uint8Array(16_002))).toEqual({
    code: ZdpErrorCode.internal,
    message: expect.stringMatching(
      /^chat\.send: speech-to-text failed: .*exited 3: the microphone model is missing$/,
    ),
  });
  expect(server.rawRequests).toEqual([]);

  // The device can still talk, and the turn numbers were not spent.
  server.push(text("yes?"));
  expect(await kitchen.sendAudio(new Uint8Array(32_000))).toEqual({ turn: "t1" });
  expect(await turnEnd("t1")).toMatchObject({ type: "done", text: "yes?" });
});
