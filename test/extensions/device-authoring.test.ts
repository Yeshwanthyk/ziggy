/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests drive Ziggy through the Effect boundary. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
// The device template's rules.ts is a dependency-free copy of what `@ziggy/device` and Ziggy's
// hub enforce, so smoke.ts can run from any Profile. These cases keep the copy in agreement.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "bun:test";
import { DeviceLinks, deviceToolName, deviceTools } from "ziggy/devices/index";
import { ZiggyDevice } from "../../packages/device/src/index";
import {
  COMMAND_NAME,
  checkCommands,
  toolName,
} from "../../extensions/device-authoring/skills/device-authoring/template/rules";

const profiles: Array<string> = [];

afterEach(async () => {
  for (const profile of profiles.splice(0)) await rm(profile, { recursive: true, force: true });
});

const valid = ["light", "light_set", "a", "x".repeat(48)];

const invalid = ["x".repeat(49), "Light", "light-set", ""];

test("command names: rules.ts accepts exactly what ZiggyDevice.command accepts", () => {
  const device = new ZiggyDevice({ name: "Kitchen", model: "test" });

  expect(valid.filter((name) => COMMAND_NAME.test(name))).toEqual(valid);
  expect(invalid.filter((name) => COMMAND_NAME.test(name))).toEqual([]);

  for (const name of valid) expect(() => device.command(name, {}, () => "ok")).not.toThrow();

  for (const name of invalid) expect(() => device.command(name, {}, () => "ok")).toThrow();
});

test("tool names: rules.ts flags exactly the commands the Profile skips", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-device-authoring-"));

  profiles.push(profile);
  await mkdir(join(profile, "devices"), { recursive: true });

  const id = "kitchen-counter-top-sensor-board";

  const commands = ["light", "a".repeat(22), "b".repeat(23)];

  await writeFile(
    join(profile, "devices", `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      name: "Kitchen",
      model: "test",
      publicKey: "A".repeat(43),
      pairedAt: "2026-10-03T00:00:00.000Z",
      tools: commands.map((name) => ({
        name,
        description: "A command.",
        inputSchema: { type: "object" },
      })),
    }),
  );

  const offered = await Effect.runPromise(
    Effect.gen(function* () {
      const links = yield* DeviceLinks.make;

      yield* links.serve(profile);

      return yield* deviceTools(links)({
        profilePath: profile,
        context: { kind: "user", userId: "owner" },
        session: () => undefined,
        voice: () => {},
      });
    }).pipe(Effect.scoped),
  );

  const flagged = new Set(
    checkCommands(
      id,
      commands.map((name) => ({
        name,
        description: "A command.",
        inputSchema: { type: "object" },
      })),
    ),
  );

  for (const name of commands) {
    expect(toolName(id, name)).toBe(deviceToolName(id, name));

    const skipped = !offered.some((tool) => tool.name === deviceToolName(id, name));

    expect({ name, flagged: [...flagged].some((problem) => problem.includes(name)) }).toEqual({
      name,
      flagged: skipped,
    });
  }
});
