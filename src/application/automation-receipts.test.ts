/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup exercises the Node filesystem adapter */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { AutomationRunReceipt } from "../domain/automation-run";
import type { ProfileTarget } from "../domain/profile";
import {
  claimAutomationReceipt,
  latestAutomationReceipt,
  listAutomationReceipts,
  recoverAllRunningAutomationReceipts,
  writeAutomationReceipt,
} from "./automation-receipts";

const paths: Array<string> = [];

const makeProfile = async (): Promise<ProfileTarget> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-receipts-"));
  paths.push(path);
  return { path, name: "Test" };
};

const makeReceipt = (
  index: number,
  status: AutomationRunReceipt["status"] = "succeeded",
): AutomationRunReceipt => ({
  version: 1,
  runId: `run-${String(index).padStart(3, "0")}`,
  automationId: "daily-note",
  trigger: "manual",
  status,
  claimedAt: new Date(Date.UTC(2026, 6, 30, 12, 0, index)).toISOString(),
  startedAt: new Date(Date.UTC(2026, 6, 30, 12, 0, index)).toISOString(),
  ...(status === "running"
    ? {}
    : { finishedAt: new Date(Date.UTC(2026, 6, 30, 12, 1, index)).toISOString() }),
  sessionPath: `/profile/sessions/automations/daily-note/run-${index}`,
  deliveries: [],
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Profile automation receipt store", () => {
  test("atomically writes mode 0600 and returns latest first", async () => {
    const target = await makeProfile();
    await Effect.runPromise(writeAutomationReceipt(target, makeReceipt(1)));
    await Effect.runPromise(writeAutomationReceipt(target, makeReceipt(2)));

    expect((await Effect.runPromise(latestAutomationReceipt(target, "daily-note")))?.runId).toBe(
      "run-002",
    );
    const path = join(target.path, ".runtime", "automations", "runs", "daily-note", "run-002.md");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("claims a run exactly once without overwriting the first receipt", async () => {
    const target = await makeProfile();
    const original = makeReceipt(1, "running");
    await Effect.runPromise(claimAutomationReceipt(target, original));
    const outcome = await Effect.runPromise(
      claimAutomationReceipt(target, { ...original, sessionPath: "/replacement" }).pipe(
        Effect.as("claimed"),
        Effect.catchTag("AutomationReceiptAlreadyClaimed", () => Effect.succeed("already-claimed")),
      ),
    );

    expect(outcome).toBe("already-claimed");
    expect(
      (await Effect.runPromise(latestAutomationReceipt(target, "daily-note")))?.sessionPath,
    ).toBe(original.sessionPath);
  });

  test("keeps only the latest 50 receipts per automation", async () => {
    const target = await makeProfile();
    for (let index = 0; index < 52; index += 1) {
      await Effect.runPromise(writeAutomationReceipt(target, makeReceipt(index)));
    }
    const receipts = await Effect.runPromise(listAutomationReceipts(target, "daily-note"));
    expect(receipts).toHaveLength(50);
    expect(receipts.at(-1)?.runId).toBe("run-002");
  });

  test("recovers running receipts without retrying or changing terminal receipts", async () => {
    const target = await makeProfile();
    await Effect.runPromise(writeAutomationReceipt(target, makeReceipt(1, "running")));
    await Effect.runPromise(writeAutomationReceipt(target, makeReceipt(2)));

    const recovered = await Effect.runPromise(
      recoverAllRunningAutomationReceipts(target, "2026-07-30T13:00:00.000Z"),
    );
    expect(recovered.map((receipt) => receipt.runId)).toEqual(["run-001"]);
    expect(recovered[0]?.status).toBe("interrupted");
    expect(recovered[0]?.finishedAt).toBe("2026-07-30T13:00:00.000Z");
    expect(await readdir(join(target.path, ".runtime", "automations", "runs"))).toEqual([
      "daily-note",
    ]);
    expect((await Effect.runPromise(latestAutomationReceipt(target, "daily-note")))?.status).toBe(
      "succeeded",
    );
  });
});
