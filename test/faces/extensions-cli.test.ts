import { expect, test } from "bun:test";
import {
  ProfileExtensionLockFailed,
  ProfileExtensionPreflightFailed,
  ProfileExtensionRollbackFailed,
} from "ziggy/domain/profile-extension";
import {
  renderExtension,
  renderExtensionManagerResult,
  renderExtensionMutation,
  renderExtensions,
  renderExtensionJson,
  renderExtensionsJson,
  renderProfileExtensionFailure,
} from "ziggy/faces/extensions-cli";

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
        id: "required-remote-extension-with-a-long-name",
        required: true,
        source: "remote-approved",
      },
    ],
    {
      pretty: true,
      colors: false,
      columns: 36,
    },
  );

  expect(rendered).toContain("remote-approved · required");
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

test("projects bounded preflight diagnostics without exposing the cause", () => {
  const source = `${"s".repeat(160)}-source-secret`;
  const reason = `${"r".repeat(360)}-reason-secret`;
  const rendered = renderProfileExtensionFailure(
    new ProfileExtensionPreflightFailed({
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

test("projects lock operation and bounded reason without exposing the cause", () => {
  const reason = `${"l".repeat(360)}-lock-secret`;
  const rendered = renderProfileExtensionFailure(
    new ProfileExtensionLockFailed({
      profilePath: "/private/profile",
      operation: "acquire",
      message: reason,
      cause: { secret: "lock-cause-secret" },
    }),
  );

  expect(rendered).toContain("operation=acquire");
  expect(rendered).toContain(`reason=${"l".repeat(360)}`);
  expect(rendered).not.toContain("lock-secret");
  expect(rendered).not.toContain("lock-cause-secret");
});

test("projects rollback operation, bounded path, and reason without raw failures", () => {
  const rollbackPath = "p".repeat(240);
  const rollbackReason = "b".repeat(360);
  const rendered = renderProfileExtensionFailure(
    new ProfileExtensionRollbackFailed({
      profilePath: "/private/profile",
      operation: "set-selected",
      message: "Profile extension mutation failed and state may have changed",
      originalFailure: { secret: "original-cause-secret" },
      rollbackFailures: [
        {
          operation: "restore extensions.json",
          path: rollbackPath,
          message: rollbackReason,
        },
      ],
      cause: { secret: "rollback-cause-secret" },
    }),
  );

  expect(rendered).toContain("operation=set-selected");
  expect(rendered).toContain("rollback operation=restore extensions.json");
  expect(rendered).toContain(`path=${"p".repeat(240)}`);
  expect(rendered).toContain(`reason=${"b".repeat(360)}`);
  expect(rendered).not.toContain("original-cause-secret");
  expect(rendered).not.toContain("rollback-cause-secret");
});
