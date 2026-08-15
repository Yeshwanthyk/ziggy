import { expect, test } from "bun:test";
import {
  renderProfileAgent,
  renderProfileAgents,
  renderProfileAgentValidation,
} from "ziggy/faces/agents-cli";

const agent = {
  id: "reviewer",
  description: "Review changes",
  tools: ["read"],
  path: "agents/reviewer.md",
} as const;

test("renders agent metadata and relative path without an instruction body", () => {
  expect(renderProfileAgent(agent)).toBe(
    "id\treviewer\ndescription\tReview changes\npath\tagents/reviewer.md\nmodel\tinherit\nthinking\tinherit\ntools\tread",
  );
  expect(renderProfileAgents([agent])).toBe(
    "reviewer\tReview changes\tinherit\tagents/reviewer.md",
  );
});

test("renders every validation result", () => {
  expect(
    renderProfileAgentValidation([
      { id: "alpha", path: "agents/alpha.md", valid: true },
      { id: "broken", path: "agents/broken.md", valid: false, message: "bad metadata" },
    ]),
  ).toBe("agents/alpha.md\tvalid\nagents/broken.md\tinvalid\tbad metadata");
});
