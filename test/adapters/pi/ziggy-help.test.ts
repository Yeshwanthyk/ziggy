import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { createZiggyHelpTool, ziggyHelpParameters } from "ziggy/adapters/pi/ziggy-help";
import { ziggyHelpTopics } from "ziggy/domain/cli-help";
import { renderHelp } from "ziggy/faces/cli";

const resultText = async (params: { readonly topic?: (typeof ziggyHelpTopics)[number] }) => {
  const result = await createZiggyHelpTool().execute(
    "help-1",
    params,
    undefined,
    undefined,
    Object.create(null),
  );
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text help result");
  return block.text;
};

describe("ziggy_help", () => {
  test("returns the same general and topic help as the CLI authority", async () => {
    expect(await resultText({})).toBe(renderHelp());
    for (const topic of ziggyHelpTopics) {
      expect(await resultText({ topic })).toBe(renderHelp(topic));
    }
  });

  test("accepts only current CLI help topics", () => {
    expect(Value.Check(ziggyHelpParameters, {})).toBe(true);
    expect(Value.Check(ziggyHelpParameters, { topic: "models" })).toBe(true);
    expect(Value.Check(ziggyHelpParameters, { topic: "made-up" })).toBe(false);
    expect(Value.Check(ziggyHelpParameters, { topic: "models", extra: true })).toBe(false);
  });
});
