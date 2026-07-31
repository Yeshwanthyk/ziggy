/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test functions are native Promise boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type AutomationRunReceipt,
  parseAutomationRunReceipt,
  renderAutomationRunReceipt,
} from "./automation-run";

const receipt: AutomationRunReceipt = {
  version: 1,
  runId: "run-1",
  automationId: "daily-note",
  trigger: "manual",
  status: "succeeded",
  claimedAt: "2026-07-30T12:00:00.000Z",
  startedAt: "2026-07-30T12:00:01.000Z",
  finishedAt: "2026-07-30T12:00:02.000Z",
  sessionPath: "/profile/sessions/automations/daily-note/run-1",
  localOutput: "# Result\n\nIt worked.",
  deliveries: [
    {
      target: "telegram:42",
      status: "succeeded",
      finishedAt: "2026-07-30T12:00:03.000Z",
    },
  ],
};

describe("automation run receipt Markdown", () => {
  test("round trips deterministic Markdown with lossless local output", async () => {
    const rendered = renderAutomationRunReceipt(receipt);
    expect(rendered).toContain('deliveries: [{"target":"telegram:42"');
    expect(rendered).toEndWith("# Result\n\nIt worked.\n");
    expect(await Effect.runPromise(parseAutomationRunReceipt("receipt.md", rendered))).toEqual(
      receipt,
    );
  });

  test("requires scheduled identity only for scheduled triggers", async () => {
    const invalid = renderAutomationRunReceipt(receipt).replace(
      "trigger: manual",
      "trigger: scheduled",
    );
    const result = await Effect.runPromise(
      parseAutomationRunReceipt("receipt.md", invalid).pipe(
        Effect.as("valid"),
        Effect.catchTag("AutomationRunInvalid", () => Effect.succeed("invalid")),
      ),
    );
    expect(result).toBe("invalid");
  });
});
