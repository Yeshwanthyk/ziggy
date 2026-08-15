import { expect, test } from "bun:test";
import { renderExtensionJson, renderExtensionsJson } from "ziggy/faces/extensions-cli";

const extension = {
  id: "weather",
  version: "1.0.0",
  description: "Weather lookup",
  kind: "skill" as const,
  required: false,
  source: "bundled" as const,
  installed: true,
  packagePath: "extensions/weather",
  skills: [{ name: "weather", description: "Look up weather" }],
  extensionPaths: ["extensions/weather/index.ts"],
};

test("renders extension list and show metadata as JSON", () => {
  expect(renderExtensionsJson([extension])).toBe(JSON.stringify([extension]));
  expect(renderExtensionJson(extension)).toBe(JSON.stringify(extension));
});
