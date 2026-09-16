import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { groupCompletedActivity, ToolActivity } from "./tool-activity";

afterEach(cleanup);

it("never groups across messages, failures, or running calls", () => {
  const entries = ["done", "done", "message", "done", "failed", "working", "done", "done"];
  const groups = groupCompletedActivity(entries, (entry) => entry === "done");
  expect(groups).toEqual([
    ["done", "done"],
    ["message"],
    ["done"],
    ["failed"],
    ["working"],
    ["done", "done"],
  ]);
  expect(groups.flat()).toEqual(entries);
});

it("retains completed activity inside a collapsed native disclosure", () => {
  const { container } = render(
    <ToolActivity count={3}>
      <span>read finished</span>
    </ToolActivity>,
  );
  expect(screen.getByText("3 tool calls completed")).not.toBeNull();
  expect(container.querySelector("details")?.open).toBe(false);
  expect(screen.getByText("read finished")).not.toBeNull();
});
