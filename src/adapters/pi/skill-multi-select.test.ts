import { describe, expect, test } from "bun:test";
import {
  SkillMultiSelectComponent,
  type SkillSelectionStyle,
} from "./skill-multi-select";

const plainStyle: SkillSelectionStyle = {
  accent: (text) => text,
  bold: (text) => text,
  dim: (text) => text,
  success: (text) => text,
};

describe("Profile skill multi-select", () => {
  test("shows installed state and returns every Space-selected skill on Enter", () => {
    const results: Array<ReadonlyArray<string> | undefined> = [];
    let renders = 0;
    const component = new SkillMultiSelectComponent(
      [
        { id: "alpha", installed: true },
        { id: "beta", installed: false },
        { id: "gamma", installed: false },
      ],
      () => {
        renders += 1;
      },
      (result) => results.push(result),
      plainStyle,
    );

    expect(component.render(80)).toEqual([
      "Profile skills",
      "1 installed · 2 available · 0 selected",
      "",
      "  [✓] alpha installed",
      "› [ ] beta",
      "  [ ] gamma",
      "",
      "↑/↓ move · Space toggle · Enter install · Esc cancel",
    ]);

    component.handleInput(" ");
    component.handleInput("\u001b[B");
    component.handleInput(" ");

    expect(component.render(80)).toEqual([
      "Profile skills",
      "1 installed · 2 available · 2 selected",
      "",
      "  [✓] alpha installed",
      "  [x] beta",
      "› [x] gamma",
      "",
      "↑/↓ move · Space toggle · Enter install · Esc cancel",
    ]);

    component.handleInput("\r");

    expect(renders).toBe(3);
    expect(results).toEqual([["beta", "gamma"]]);
  });

  test("Esc cancels without returning a selection", () => {
    const results: Array<ReadonlyArray<string> | undefined> = [];
    const component = new SkillMultiSelectComponent(
      [{ id: "alpha", installed: false }],
      () => {},
      (result) => results.push(result),
      plainStyle,
    );

    component.handleInput("\u001b");

    expect(results).toEqual([undefined]);
  });
});
