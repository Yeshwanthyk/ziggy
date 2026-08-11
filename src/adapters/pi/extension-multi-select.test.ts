import { expect, test } from "bun:test";
import {
  ExtensionMultiSelect,
  type ExtensionMultiSelectResult,
  type ExtensionMultiSelectTheme,
} from "./extension-multi-select";

const theme: ExtensionMultiSelectTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test("the extension checklist toggles entries and returns one complete set", () => {
  let result: ExtensionMultiSelectResult;
  let changes = 0;
  const component = new ExtensionMultiSelect(
    [
      { id: "alpha", description: "Alpha extension", kind: "skill", source: "bundled" },
      {
        id: "beta",
        description: "Beta extension",
        kind: "skill+code",
        source: "remote-approved",
      },
    ],
    ["alpha"],
    theme,
    () => void (changes += 1),
    (selection) => void (result = selection),
  );

  component.handleInput("\u001b[B");
  component.handleInput(" ");
  component.handleInput("\u001b[A");
  component.handleInput(" ");
  component.handleInput("\r");

  expect(result).toEqual(["beta"]);
  expect(changes).toBe(4);
  expect(component.render(80).join("\n")).toContain("[x] beta");
  expect(component.render(80).join("\n")).toContain("[ ] alpha");
});
