import { describe, expect, it } from "vitest";
import {
  addAutomationBroadcastTarget,
  parseDefinitionSource,
  removeAutomationBroadcastTarget,
  updateDefinitionSource,
} from "./definition-source";

describe("automation definition source", () => {
  it("updates known scalars while preserving unknown lines and order", () => {
    const source = [
      "---",
      "version: 1",
      "cron: 0 8 * * *",
      "timezone: America/Toronto",
      "x-note: preserved",
      "broadcast: none",
      "---",
      "",
      "Original task.",
      "",
    ].join("\n");
    const parsed = parseDefinitionSource(source);
    const updated = updateDefinitionSource(
      source,
      { ...parsed.fields, cron: "30 8 * * *", gate: "true" },
      "Updated task.",
    );

    expect(updated).toContain("cron: 30 8 * * *\n");
    expect(updated).toContain("x-note: preserved\n");
    expect(updated).toContain("broadcast: none\n");
    expect(updated).toContain("gate: true\n");
    expect(updated.endsWith("\nUpdated task.\n")).toBe(true);
  });

  it("requires valid frontmatter delimiters for structured editing", () => {
    const parsed = parseDefinitionSource("Task without frontmatter");
    expect(parsed.structured).toBe(false);
    expect(parsed.task).toBe("Task without frontmatter");
  });

  it("adds a conversation without replacing existing broadcast targets", () => {
    const source = [
      "---",
      "version: 1",
      "cron: 0 8 * * *",
      "timezone: UTC",
      "broadcast: slack:channel:C0123,origin",
      "---",
      "",
      "Post the update.",
      "",
    ].join("\n");

    const once = addAutomationBroadcastTarget(source, "conversation:session-123");
    const twice = addAutomationBroadcastTarget(once, "conversation:session-123");

    expect(twice).toContain("broadcast: slack:channel:C0123,origin,conversation:session-123\n");
    expect(twice.match(/conversation:session-123/gu)).toHaveLength(1);
  });

  it("removes one broadcast target and writes none after the final removal", () => {
    const source = [
      "---",
      "version: 1",
      "broadcast: origin,slack:channel:C012345678,conversation:session-123",
      "---",
      "",
      "Post the update.",
      "",
    ].join("\n");

    const mixed = removeAutomationBroadcastTarget(source, "slack:channel:C012345678");
    const one = removeAutomationBroadcastTarget(mixed, "origin");
    const none = removeAutomationBroadcastTarget(one, "conversation:session-123");

    expect(mixed).toContain("broadcast: origin,conversation:session-123\n");
    expect(one).toContain("broadcast: conversation:session-123\n");
    expect(none).toContain("broadcast: none\n");
  });
});
