import { describe, expect, test } from "bun:test";
import type { SessionMetadata } from "ziggy/domain/session";
import {
  renderSession,
  renderSessionJson,
  renderSessionList,
  renderSessionListJson,
} from "ziggy/faces/sessions-cli";

const metadata: SessionMetadata = {
  path: "agents/child.jsonl",
  id: "child-id",
  kind: "child",
  createdAt: "2026-08-08T10:00:00.000Z",
  entryCount: 4,
  parent: { id: "root-id", path: "local/root.jsonl" },
  parentUnknown: false,
  children: [{ id: "grandchild-id", path: "agents/grandchild.jsonl" }],
  modelChanges: [{ at: "2026-08-08T10:00:01.000Z", provider: "openai", model: "gpt-test" }],
  thinkingChanges: [{ at: "2026-08-08T10:00:02.000Z", level: "high" }],
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    reasoning: 3,
    totalTokens: 18,
    cost: 0.25,
  },
  terminalState: "completed",
};

describe("session CLI rendering", () => {
  test("renders no-session and bounded list metadata", () => {
    expect(renderSessionList([])).toBe("no sessions");
    expect(renderSessionList([metadata])).toBe(
      "agents/child.jsonl\tchild-id\tchild\t2026-08-08T10:00:00.000Z\t4 entries\tparent root-id\t1 children\tcompleted",
    );
  });

  test("renders links, changes, usage and state without transcript fields", () => {
    const rendered = renderSession(metadata);
    expect(rendered).toContain("parent-path\tlocal/root.jsonl");
    expect(rendered).toContain("child\tgrandchild-id\tagents/grandchild.jsonl");
    expect(rendered).toContain("model\t2026-08-08T10:00:01.000Z\topenai/gpt-test");
    expect(rendered).toContain("thinking\t2026-08-08T10:00:02.000Z\thigh");
    expect(rendered).toContain("usage\t10 input · 5 output");
    expect(rendered).toContain("state\tcompleted");
    expect(rendered).not.toMatch(/prompt|reply|thinking content|tool output/i);
  });

  test("renders metadata-only JSON for lists and shows", () => {
    expect(renderSessionListJson([metadata])).toBe(JSON.stringify([metadata]));
    expect(renderSessionJson(metadata)).toBe(JSON.stringify(metadata));
    expect(renderSessionJson(metadata)).not.toMatch(/prompt|reply|thinking content|tool output/i);
  });
});
