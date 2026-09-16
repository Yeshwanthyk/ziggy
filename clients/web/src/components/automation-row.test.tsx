import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRow } from "./automation-row";

afterEach(cleanup);

const actions = {
  busy: false,
  onInspect: vi.fn(),
  onRun: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
};

describe("AutomationRow status", () => {
  it("distinguishes enabled schedules from the pause action", () => {
    render(
      <AutomationRow
        {...actions}
        automation={{ id: "morning-weather", lifecycle: "active", schedule: "0 9 * * *" }}
      />,
    );
    expect(screen.getByText("Enabled · Daily at 9 AM")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Pause morning-weather" })).not.toBeNull();
  });

  it("preserves complex schedules and labels paused state explicitly", () => {
    render(
      <AutomationRow
        {...actions}
        automation={{ id: "digest", lifecycle: "paused", schedule: "0 9 * * 1-5" }}
      />,
    );
    expect(screen.getByText("Paused · 0 9 * * 1-5")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Resume digest" })).not.toBeNull();
  });

  it("prioritizes invalid definitions over enabled status", () => {
    const { container } = render(
      <AutomationRow
        {...actions}
        automation={{ id: "weather", lifecycle: "active", message: "Invalid target" }}
      />,
    );
    expect(screen.getByText("Needs attention")).not.toBeNull();
    expect(container.querySelector(".automation-status.is-active")).toBeNull();
    expect(screen.getByRole("button", { name: /Weather Needs attention/u }).title).toContain(
      "Invalid target",
    );
  });
});
