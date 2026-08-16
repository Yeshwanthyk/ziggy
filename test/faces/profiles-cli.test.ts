import { expect, test } from "bun:test";
import { renderProfilesJson } from "ziggy/faces/profiles-cli";

test("renders profile listings as one JSON array", () => {
  expect(renderProfilesJson([{ name: "pal", path: "/profiles/pal" }])).toBe(
    JSON.stringify([{ name: "pal", path: "/profiles/pal" }]),
  );
});
