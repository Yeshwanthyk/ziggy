import { describe, expect, test } from "bun:test";
import { renderAutomationOutcome } from "./automation-cli";

describe("automation CLI outcome", () => {
  test("renders decline and no-target success", () => {
    expect(renderAutomationOutcome({ kind: "declined", reason: "gate-nonzero", exitCode: 4 })).toEqual({
      exitCode: 0, stderr: ["wake declined: gate exited 4"],
    });
    expect(renderAutomationOutcome({ kind: "executed", delivery: { kind: "resolved", targets: [] } })).toEqual({ exitCode: 0, stderr: ["wake delivery resolved: 0 targets"] });
  });

  test("renders full delivery success", () => {
    expect(renderAutomationOutcome({ kind: "executed", delivery: { kind: "resolved", targets: [
      { target: "telegram:chat:1", status: "delivered" },
      { target: "discord:channel:2", status: "delivered" },
    ] } })).toEqual({ exitCode: 0, stderr: [
      "wake delivery resolved: 2 targets", "wake delivered: telegram:chat:1", "wake delivered: discord:channel:2",
    ] });
  });

  test("renders resolution and partial target failures safely", () => {
    expect(renderAutomationOutcome({ kind: "executed", delivery: { kind: "resolution-failed", category: "all-empty" } })).toEqual({
      exitCode: 1, stderr: ["wake delivery resolution failed: all-empty"],
    });
    expect(renderAutomationOutcome({ kind: "executed", delivery: { kind: "resolved", targets: [
      { target: "slack:channel:C0123ABCDE", status: "failed", category: "authentication", retriable: false },
      { target: "telegram:chat:1", status: "delivered" },
    ] } })).toEqual({ exitCode: 1, stderr: [
      "wake delivery resolved: 2 targets",
      "wake delivery failed: slack:channel:C0123ABCDE (authentication, not retriable)",
      "wake delivered: telegram:chat:1",
    ] });
  });
});
