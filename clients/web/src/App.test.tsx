import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryEntry } from "./App";

afterEach(cleanup);

describe("HistoryEntry", () => {
  it("renders an automation result with its automation identity", () => {
    render(
      <HistoryEntry
        assistantName="Squarey"
        entry={{
          kind: "automation-result",
          automationId: "daily-report",
          runId: "run-1",
          text: "The report is ready.",
          timestamp: "2026-09-17T12:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Automation · daily-report")).not.toBeNull();
    expect(screen.getByText("The report is ready.")).not.toBeNull();
  });
});
