/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
/* oxlint-disable ziggy-effect/no-effect-escape-hatch -- unreachable fake methods fail tests immediately */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- fixture cleanup requires finally */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import type { AuthApi } from "ziggy/application/auth";
import type { ExtensionArchiveClientApi } from "ziggy/adapters/github/extension-catalog";
import { makeProfileExtensionPreflight } from "ziggy/adapters/pi/profile-extension-preflight";
import { makeProfileExtensions } from "ziggy/application/profile-extensions";
import { makeDoctor } from "ziggy/application/doctor";
import type { ModelsApi } from "ziggy/application/models";
import { renderDoctor } from "ziggy/faces/doctor-cli";
import { ExtensionCatalogUnavailable } from "ziggy/domain/extension-catalog";
import type {
  ProfileExtensionMutationLockApi,
  ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";

const tree = async (root: string): Promise<ReadonlyArray<string>> => {
  const output: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        output.push(`${relative}/`);
        await visit(absolute);
      } else {
        output.push(`${relative}:${Buffer.from(await readFile(absolute)).toString("base64")}`);
      }
    }
  };
  await visit(root);
  return output;
};

const auth: AuthApi = {
  status: () =>
    Effect.succeed([
      {
        id: "anthropic",
        name: "Anthropic",
        supportsApiKeyLogin: true,
        ambientOnly: false,
        supportsOauth: true,
        configured: { type: "oauth" },
      },
    ]),
  readOnlyStatus: () =>
    Effect.succeed([
      {
        id: "anthropic",
        name: "Anthropic",
        supportsApiKeyLogin: true,
        ambientOnly: false,
        supportsOauth: true,
        configured: { type: "oauth" },
      },
    ]),
  login: () => Effect.die("not used"),
};

const models: ModelsApi = {
  status: () =>
    Effect.succeed({
      providerId: "anthropic",
      modelId: "claude",
      thinking: "high",
      authConfigured: true,
    }),
  readOnlyStatus: () =>
    Effect.succeed({
      providerId: "anthropic",
      modelId: "claude",
      thinking: "high",
      authConfigured: true,
    }),
  list: () =>
    Effect.succeed([
      {
        providerId: "anthropic",
        modelId: "claude",
        name: "Claude",
        thinkingLevels: ["off", "high"],
      },
    ]),
  available: () =>
    Effect.succeed([
      {
        providerId: "anthropic",
        modelId: "claude",
        name: "Claude",
        thinkingLevels: ["off", "high"],
      },
    ]),
  set: () => Effect.die("not used"),
};

const profileExtensions: ProfileExtensionsApi = {
  list: () => Effect.die("unused"),
  show: () => Effect.die("unused"),
  listForProfile: () => Effect.die("unused"),
  add: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
  setSelected: () => Effect.die("unused"),
  validate: () =>
    Effect.succeed({
      selected: [],
      preflight: { extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 },
    }),
  prepareRuntime: () => Effect.die("unused"),
  activateRuntime: () => Effect.die("unused"),
};

const noDownload: ExtensionArchiveClientApi = {
  download: () =>
    Effect.fail(
      new ExtensionCatalogUnavailable({
        operation: "doctor test download",
        message: "doctor read-only proof must not download",
        cause: undefined,
      }),
    ),
};

const noLock: ProfileExtensionMutationLockApi = {
  withLock: <A, E, R>(_profilePath: string, use: Effect.Effect<A, E, R>) => use,
};

test("doctor is read-only and renders checks in stable owning-validator order", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await mkdir(path.join(profilePath, "agents"));
    await mkdir(path.join(profilePath, "automations"));
    const before = await tree(profilePath);

    const report = await Effect.runPromise(
      makeDoctor(auth, models, profileExtensions).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );
    const rendered = renderDoctor(report);

    expect(report.checks.map((check) => check.id)).toEqual([
      "ziggy",
      "profile",
      "model",
      "auth",
      "agents",
      "automations",
      "memory",
      "resources",
      "pi_docs",
      "gateways",
      "discord-runtime",
      "slack-runtime",
      "sessions",
      "runtime",
    ]);
    expect(report.checks.map((check) => check.severity)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(rendered.exitCode).toBe(0);
    expect(report.checks.find((check) => check.id === "ziggy")?.message).toBe("Ziggy 0.2.5");
    expect(report.checks.find((check) => check.id === "pi_docs")?.message).toMatch(
      /^@earendil-works\/pi-coding-agent@0\.84\.1 fingerprint=[0-9a-f]{64} count=\d+$/u,
    );
    expect(
      rendered.text.split("\n").map((line) => line.split("\t").slice(0, 2).join("\t")),
    ).toEqual([
      "OK\tziggy",
      "OK\tprofile",
      "OK\tmodel",
      "OK\tauth",
      "OK\tagents",
      "OK\tautomations",
      "OK\tmemory",
      "OK\tresources",
      "OK\tpi_docs",
      "OK\tgateways",
      "OK\tdiscord-runtime",
      "OK\tslack-runtime",
      "OK\tsessions",
      "OK\truntime",
    ]);
    expect(await tree(profilePath)).toEqual(before);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("doctor uses the ProfileExtensions service without publishing or activating resources", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-profile-extensions-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    const before = await tree(profilePath);
    const service = makeProfileExtensions(noDownload, makeProfileExtensionPreflight(), noLock);

    const report = await Effect.runPromise(
      makeDoctor(auth, models, service).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );

    expect(report.checks.find((check) => check.id === "resources")).toEqual({
      id: "resources",
      severity: "ok",
      message: "3 bundled factories, 0 Profile extension entrypoints, and 3 skill roots selected",
    });
    expect(await tree(profilePath)).toEqual(before);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("doctor excludes the format README from memory size checks", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-memory-readme-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await mkdir(path.join(profilePath, "memory"));
    await writeFile(path.join(profilePath, "memory", "README.md"), "x".repeat(10_000));
    const report = await Effect.runPromise(
      makeDoctor(auth, models, profileExtensions).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );
    expect(report.checks.find((check) => check.id === "memory")).toEqual({
      id: "memory",
      severity: "ok",
      message: "0 memory files within size caps",
    });
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("doctor uses the session projection for broken parent links", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-lineage-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await mkdir(path.join(profilePath, "sessions"));
    await writeFile(
      path.join(profilePath, "sessions", "child.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "child-id",
        timestamp: "2026-08-08T10:00:00.000Z",
        cwd: profilePath,
        parentSession: path.join(profilePath, "sessions", "missing-parent.jsonl"),
      })}\n`,
    );
    const before = await tree(profilePath);

    const report = await Effect.runPromise(
      makeDoctor(auth, models, profileExtensions).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );

    expect(report.checks.find((check) => check.id === "sessions")).toEqual({
      id: "sessions",
      severity: "warn",
      message: "1 readable Pi session file; 1 broken parent link",
    });
    expect(await tree(profilePath)).toEqual(before);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("doctor warns when configured Slack has no runtime observation", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-slack-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await writeFile(
      path.join(profilePath, "slack.json"),
      JSON.stringify({ botToken: "bot", appToken: "app", ownerUserId: "owner" }),
    );
    const before = await tree(profilePath);

    const report = await Effect.runPromise(
      makeDoctor(auth, models, profileExtensions).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );

    expect(report.checks.find((check) => check.id === "slack-runtime")).toEqual({
      id: "slack-runtime",
      severity: "warn",
      message: "Slack is configured but has no runtime observation",
    });
    expect(await tree(profilePath)).toEqual(before);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("doctor continues independent checks after malformed session metadata", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-error-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await mkdir(path.join(profilePath, "sessions"));
    await writeFile(path.join(profilePath, "sessions", "bad.jsonl"), "secret transcript text\n");

    const report = await Effect.runPromise(
      makeDoctor(auth, models, profileExtensions).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );
    const rendered = renderDoctor(report);

    expect(report.checks.find((check) => check.id === "sessions")?.severity).toBe("error");
    expect(report.checks.at(-1)?.id).toBe("runtime");
    expect(rendered.exitCode).toBe(1);
    expect(rendered.text).not.toContain("secret transcript text");
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});
