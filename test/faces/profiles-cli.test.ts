import { expect, test } from "bun:test";
import { renderProfiles, renderProfilesJson } from "ziggy/faces/profiles-cli";

const profiles = [
  { name: "--help", path: "/Users/test/.ziggy/profiles/--help" },
  { name: "pal", path: "/Users/test/.ziggy/profiles/pal" },
];

test("renders profile listings as one JSON array", () => {
  expect(renderProfilesJson([{ name: "pal", path: "/profiles/pal" }])).toBe(
    JSON.stringify([{ name: "pal", path: "/profiles/pal" }]),
  );
});

test("preserves compact tab-separated output outside a pretty terminal", () => {
  expect(
    renderProfiles(profiles, {
      pretty: false,
      colors: false,
      columns: 80,
      homeDirectory: "/Users/test",
    }),
  ).toBe("--help\t/Users/test/.ziggy/profiles/--help\npal\t/Users/test/.ziggy/profiles/pal");
});

test("renders a branded Profile view with warnings and a next action", () => {
  expect(
    renderProfiles(profiles, {
      pretty: true,
      colors: false,
      columns: 72,
      homeDirectory: "/Users/test",
    }),
  ).toBe(
    [
      "╭──────────────────────────────────────────────────────────────────────╮",
      "│  ZIGGY  profiles                                          2 profiles │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│  !!  --help                                             invalid name │",
      "│      └ ~/.ziggy/profiles/--help                                      │",
      "│  PA  pal                                                             │",
      "│      └ ~/.ziggy/profiles/pal                                         │",
      "├──────────────────────────────────────────────────────────────────────┤",
      "│  OPEN  ziggy <profile>                                open a profile │",
      "╰──────────────────────────────────────────────────────────────────────╯",
    ].join("\n"),
  );
});

test("caps the pretty layout at a readable width", () => {
  const [header, rule] = renderProfiles(profiles, {
    pretty: true,
    colors: false,
    columns: 170,
    homeDirectory: "/Users/test",
  }).split("\n");

  expect(Bun.stringWidth(header ?? "")).toBe(76);
  expect(Bun.stringWidth(rule ?? "")).toBe(76);
});

test("renders an instructive pretty empty state", () => {
  expect(
    renderProfiles([], {
      pretty: true,
      colors: false,
      columns: 50,
      homeDirectory: "/Users/test",
    }),
  ).toBe(
    [
      "╭────────────────────────────────────────────────╮",
      "│  ZIGGY  profiles                    0 profiles │",
      "├────────────────────────────────────────────────┤",
      "│                                                │",
      "│ No profiles yet.                               │",
      "│ Create one with ziggy init <name>              │",
      "│                                                │",
      "╰────────────────────────────────────────────────╯",
    ].join("\n"),
  );
});
