import { expect, test } from "bun:test";
import { slackTaskTitle, slackToolStatus } from "ziggy/application/slack-tool-progress";

test("semantic command titles describe common work without interpreting arbitrary shell text", () => {
  for (const [command, title] of [
    ["bun test test/domain/slack.test.ts", "Running tests"],
    ["npm run test -- --watch", "Running tests"],
    ["bun run typecheck", "Checking code"],
    ["pnpm build", "Building the project"],
    ["git diff --stat", "Inspecting Git changes"],
    ["rg -n needle src", "Searching files"],
    ["ls src", "Exploring files"],
    ["echo 'bun test'", "Running a command"],
  ] as const)
    expect(slackTaskTitle("bash", command)).toBe(title);
});

test("active status retains bounded details and unknown tools remain visible", () => {
  expect(slackToolStatus({ toolName: "read", detail: "src/main.ts" })).toBe(
    "Reading a file: src/main.ts…",
  );
  expect(slackToolStatus({ toolName: "bash", detail: "bun run lint" })).toBe(
    "Checking code: bun run lint…",
  );
  expect(slackToolStatus({ toolName: "custom_tool" })).toBe("Using custom_tool…");
  expect(slackTaskTitle("agent_run")).toBe("Consulting a specialist");
  expect(slackToolStatus({ toolName: "read", detail: "😀".repeat(150) })).toBe(
    `Reading a file: ${"😀".repeat(120)}…`,
  );
});
