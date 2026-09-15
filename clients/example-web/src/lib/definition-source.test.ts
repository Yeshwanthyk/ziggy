import { describe, expect, it } from "vitest";
import { parseDefinitionSource, updateDefinitionSource } from "./definition-source";

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
});
