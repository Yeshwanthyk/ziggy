/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved execution boundaries */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { initialDiscordHealth } from "../../domain/discord-health";
import { readDiscordHealth, writeDiscordHealth } from "./discord-health";

describe("Discord health projection filesystem boundary", () => {
  test("writes an atomic content-free snapshot and reads it back", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-discord-health-"));
    await writeFile(join(profilePath, "discord.json"), "{}\n");
    const snapshot = initialDiscordHealth(100);

    await Effect.runPromise(writeDiscordHealth(profilePath, snapshot));

    expect(await Effect.runPromise(readDiscordHealth(profilePath, 110))).toEqual({
      _tag: "observed",
      observedAtMs: 110,
      snapshot,
    });
    expect(await readdir(join(profilePath, ".runtime"))).toEqual(["discord-health.json"]);
  });

  test("distinguishes missing configuration, missing observation, and malformed state", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-discord-health-state-"));
    expect(await Effect.runPromise(readDiscordHealth(profilePath, 10))).toEqual({
      _tag: "not-configured",
    });

    await writeFile(join(profilePath, "discord.json"), "{}\n");
    expect(await Effect.runPromise(readDiscordHealth(profilePath, 11))).toEqual({
      _tag: "not-observed",
    });

    await Effect.runPromise(writeDiscordHealth(profilePath, initialDiscordHealth(12)));
    await writeFile(join(profilePath, ".runtime", "discord-health.json"), '{"prompt":"secret"}\n');
    const malformed = await Effect.runPromise(
      readDiscordHealth(profilePath, 13).pipe(Effect.result),
    );
    expect(Result.isFailure(malformed)).toBe(true);
  });
});
