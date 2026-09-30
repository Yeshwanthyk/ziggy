import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ExtensionLoadFailed,
  ExtensionLockFailed,
  ExtensionUpdateError,
} from "ziggy/extensions/index";
import {
  renderExtension,
  renderExtensionManagerResult,
  renderExtensionMutation,
  renderExtensions,
  renderExtensionJson,
  renderProfileExtensionJson,
  renderExtensionsJson,
  renderProfileExtensionFailure,
  renderProfileExtensions,
  ProfileExtensionsJson,
} from "ziggy/faces/extensions-cli";

const decodeProfileExtensions = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProfileExtensionsJson),
);

const extension = {
  id: "weather",
  version: "1.0.0",
  description: "Weather lookup",
  kind: "skill" as const,
  required: false,
  source: "bundled" as const,
  packagePath: "extensions/weather",
  skills: [{ name: "weather", description: "Look up weather" }],
  extensionPaths: ["extensions/weather/index.ts"],
};

test("renders extension list and show metadata as JSON", () => {
  expect(renderExtensionsJson([extension])).toBe(JSON.stringify([extension]));
  expect(renderExtensionJson(extension)).toBe(JSON.stringify(extension));
});

test("renders extensions as a framed interactive catalogue", () => {
  const rendered = renderExtensions([extension], {
    pretty: true,
    colors: false,
    columns: 76,
  });

  expect(rendered).toContain("│  ZIGGY  extensions");
  expect(rendered).toContain(" SK  weather");
  expect(rendered).toContain("bundled · optional");
  expect(rendered).toContain(" MANAGE  ziggy extensions manage <profile>");
});

test("keeps the management action readable in a narrow terminal", () => {
  const rendered = renderExtensions(
    [
      {
        ...extension,
        id: "required-profile-extension-with-a-long-name",
        required: true,
        source: "profile",
      },
    ],
    {
      pretty: true,
      colors: false,
      columns: 36,
    },
  );

  expect(rendered).toContain("profile · required");
  expect(rendered).toContain(" MANAGE  ziggy extensions manage");
  expect(rendered).toContain("<profile>");
  expect(rendered).toContain("choose extensions");
  expect(rendered.split("\n").every((line) => Bun.stringWidth(line) === 36)).toBeTrue();
});

test("bounds long extension detail and result values in a narrow terminal", () => {
  const options = {
    pretty: true,
    colors: false,
    columns: 36,
  };

  const longValue = "extension-value-".repeat(12);

  const detail = renderExtension(
    {
      ...extension,
      id: longValue,
      version: longValue,
      packagePath: `/tmp/${longValue}`,
      skills: [{ name: longValue, description: longValue }],
      extensionPaths: [`/tmp/${longValue}/index.ts`],
    },
    options,
  );

  const managerResult = renderExtensionManagerResult(
    {
      status: "changed",
      profile: { name: longValue, path: `/tmp/${longValue}` },
      selected: [longValue],
      added: [longValue],
      removed: [longValue],
    },
    options,
  );

  const mutation = renderExtensionMutation(
    {
      id: longValue,
      profilePath: `/tmp/${longValue}`,
      changed: true,
      selected: true,
      automations: [],
    },
    options,
  );

  for (const rendered of [detail, managerResult, mutation]) {
    expect(rendered).toContain("…");
    expect(rendered.split("\n").every((line) => Bun.stringWidth(line) === 36)).toBeTrue();
  }
});

test("preserves extension metadata in the pretty detail view", () => {
  const rendered = renderExtension(extension, {
    pretty: true,
    colors: false,
    columns: 76,
  });

  expect(rendered).toContain(" SKILL  weather");
  expect(rendered).toContain(" CODE  extensions/weather/index.ts");
  expect(rendered).toContain("path");
  expect(rendered).toContain("extensions/weather");
});

test("names the Profile whose selection a listing describes", () => {
  const options = { pretty: false, colors: false, columns: 76 };
  expect(renderExtension(extension, options)).not.toContain("selected in");
  expect(
    renderExtension(extension, options, { path: "/profiles/buddy", selected: false }),
  ).toContain("selected in /profiles/buddy\tno");

  const required: ReadonlyArray<string> = [];

  const listing = {
    available: [
      {
        id: "weather",
        kind: "skill" as const,
        source: "bundled" as const,
        description: "Weather lookup",
      },
    ],
    selected: ["weather"],
    required,
  };

  expect(renderProfileExtensions(listing, "/profiles/buddy", false)).toContain("weather\tselected");
  expect(
    decodeProfileExtensions(renderProfileExtensions(listing, "/profiles/buddy", true)),
  ).toEqual({ profile: "/profiles/buddy", ...listing });
  expect(renderProfileExtensionJson(extension, { path: "/profiles/buddy", selected: true })).toBe(
    JSON.stringify({ ...extension, profile: "/profiles/buddy", selected: true }),
  );
  expect(
    renderProfileExtensionJson(
      { ...extension, source: "profile", version: "profile-local" },
      { path: "/profiles/buddy", selected: true },
    ),
  ).toContain('"source":"profile"');
  expect(
    renderProfileExtensions(
      { ...listing, selected: ["weather", "lost"], required: ["core"] },
      "/profiles/buddy",
      false,
    ),
  ).toContain("lost\tselected\tmissing");
  expect(
    renderProfileExtensions({ ...listing, required: ["core"] }, "/profiles/buddy", false),
  ).toContain("core\tselected\trequired");
});

test("projects bounded preflight diagnostics without exposing the cause", () => {
  const source = `${"s".repeat(160)}-source-secret`;
  const reason = `${"r".repeat(360)}-reason-secret`;

  const rendered = renderProfileExtensionFailure(
    new ExtensionLoadFailed({
      profilePath: "/private/profile",
      stage: "skills",
      message: "Pi resource preflight found diagnostics",
      diagnostics: [{ source, message: reason }],
      cause: { secret: "preflight-cause-secret" },
    }),
  );

  expect(rendered).toContain("stage=skills");
  expect(rendered).toContain(`diagnostic source=${"s".repeat(160)}`);
  expect(rendered).toContain(`reason=${"r".repeat(360)}`);
  expect(rendered).not.toContain("source-secret");
  expect(rendered).not.toContain("reason-secret");
  expect(rendered).not.toContain("preflight-cause-secret");
});

test("projects lock and update refusals with bounded reasons and no cause", () => {
  const reason = `${"l".repeat(360)}-lock-secret`;

  const lock = renderProfileExtensionFailure(
    new ExtensionLockFailed({
      profilePath: "/private/profile",
      message: reason,
      cause: { secret: "lock-cause-secret" },
    }),
  );

  expect(lock).toContain(`Profile extension lock failed: ${"l".repeat(360)}`);
  expect(lock).not.toContain("lock-secret");
  expect(lock).not.toContain("lock-cause-secret");

  const update = renderProfileExtensionFailure(
    new ExtensionUpdateError({
      profilePath: "/private/profile",
      id: "weather",
      reason: "modified",
      message: "Installed extension has local changes.",
      cause: { secret: "update-cause-secret" },
    }),
  );

  expect(update).toContain("id=weather; reason=modified");
  expect(update).not.toContain("update-cause-secret");
});
