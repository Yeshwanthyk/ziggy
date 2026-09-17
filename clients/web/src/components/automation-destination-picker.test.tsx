import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationDestinationPicker } from "./automation-destination-picker";
import type { AutomationDestinationOption } from "@/gateway";

const destinations: ReadonlyArray<AutomationDestinationOption> = [
  {
    target: "conversation:agent-old",
    kind: "conversation",
    label: "Older review",
    category: "agent",
    pinned: false,
    activityAt: "2026-09-15T12:00:00.000Z",
    agentId: "reviewer",
  },
  {
    target: "conversation:agent-new",
    kind: "conversation",
    label: "Current review",
    category: "agent",
    pinned: false,
    activityAt: "2026-09-17T12:00:00.000Z",
    agentId: "reviewer",
  },
  {
    target: "conversation:pinned",
    kind: "conversation",
    label: "Release room",
    category: "session",
    pinned: true,
    activityAt: "2026-09-16T12:00:00.000Z",
  },
  {
    target: "slack:channel:C012345678",
    kind: "slack",
    label: "Team updates",
    category: "slack",
    pinned: false,
  },
];

afterEach(cleanup);

describe("AutomationDestinationPicker", () => {
  it("groups pinned destinations first and sorts conversations by latest message activity", () => {
    render(
      <AutomationDestinationPicker
        destinations={destinations}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select a destination" }));

    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Pinned", "Agents", "Slack"]);
    const agentGroup = screen.getByRole("heading", { name: "Agents" }).closest("section");
    expect(agentGroup).not.toBeNull();
    expect(
      within(agentGroup!)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      expect.stringMatching(/^Current reviewAgent · reviewer · /u),
      expect.stringMatching(/^Older reviewAgent · reviewer · /u),
    ]);
    expect(agentGroup!.querySelector("time")?.getAttribute("title")).toBeTruthy();
  });

  it("filters and searches readable context before returning the selected destination", () => {
    const onSelect = vi.fn();
    render(
      <AutomationDestinationPicker
        destinations={destinations}
        disabled={false}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select a destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search destinations" }), {
      target: { value: "current reviewer" },
    });

    expect(screen.getByRole("button", { name: /Current review/u })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Older review/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Current review/u }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(destinations[1]);
    expect(screen.queryByRole("dialog", { name: "Choose a destination" })).toBeNull();
  });
});
