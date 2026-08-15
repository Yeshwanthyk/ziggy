/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { initialSlackHealth } from "ziggy/domain/slack-health";
import { readSlackHealth, writeSlackHealth } from "ziggy/adapters/fs/slack-health";

const paths: Array<string> = [];

afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("Slack health filesystem projection", () => {
  test("atomically round-trips a strict content-free snapshot", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-slack-health-"));
    paths.push(profilePath);
    await writeFile(join(profilePath, "slack.json"), "{}\n", { mode: 0o600 });
    const snapshot = initialSlackHealth(100);

    await Effect.runPromise(writeSlackHealth(profilePath, snapshot));
    const projection = await Effect.runPromise(readSlackHealth(profilePath, 110));

    expect(projection).toEqual({ _tag: "observed", observedAtMs: 110, snapshot });
    expect(await readdir(join(profilePath, ".runtime"))).toEqual(["slack-health.json"]);
  });

  test("distinguishes unconfigured, unobserved, and malformed projection state", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-slack-health-state-"));
    paths.push(profilePath);
    expect(await Effect.runPromise(readSlackHealth(profilePath, 10))).toEqual({
      _tag: "not-configured",
    });

    await writeFile(join(profilePath, "slack.json"), "{}\n");
    expect(await Effect.runPromise(readSlackHealth(profilePath, 11))).toEqual({
      _tag: "not-observed",
    });

    await mkdir(join(profilePath, ".runtime"));
    await writeFile(join(profilePath, ".runtime", "slack-health.json"), '{"prompt":"secret"}\n');
    const malformed = await Effect.runPromise(readSlackHealth(profilePath, 12).pipe(Effect.result));
    expect(Result.isFailure(malformed) && malformed.failure.operation).toBe("read");
  });
});
