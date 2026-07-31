/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises Node filesystem */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { schedulerHealthStatus } from "./automation-health";

test("a stopped scheduler is offline even while its heartbeat is fresh", async () => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-scheduler-health-"));
  const target = { path, name: "Test" };
  const directory = join(path, ".runtime", "automations");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "scheduler-health.json"),
    '{"heartbeatAt":"2026-07-31T04:00:00.000Z","stoppedAt":"2026-07-31T04:00:00.000Z"}\n',
  );

  expect(
    await Effect.runPromise(
      schedulerHealthStatus(target, new Date("2026-07-31T04:00:01.000Z")),
    ),
  ).toEqual({
    fresh: false,
    heartbeatAt: "2026-07-31T04:00:00.000Z",
  });
  await rm(path, { recursive: true });
});
