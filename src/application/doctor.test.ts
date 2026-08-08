/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixture setup owns disposable filesystem promises */
/* oxlint-disable ziggy-effect/no-effect-escape-hatch -- unreachable fake methods fail tests immediately */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- fixture cleanup requires finally */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import type { AuthShape } from "./auth";
import { makeDoctor } from "./doctor";
import type { ModelsShape } from "./models";
import { renderDoctor } from "../faces/doctor-cli";

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

const auth: AuthShape = {
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
  login: () => Effect.die("not used"),
};

const models: ModelsShape = {
  status: () =>
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
  set: () => Effect.die("not used"),
};

test("doctor is read-only and renders checks in stable owning-validator order", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await mkdir(path.join(profilePath, "agents"));
    await mkdir(path.join(profilePath, "automations"));
    const before = await tree(profilePath);

    const report = await Effect.runPromise(
      makeDoctor(auth, models).check(
        { path: profilePath, name: "Test" },
        path.resolve(import.meta.dir, "../.."),
      ),
    );
    const rendered = renderDoctor(report);

    expect(report.checks.map((check) => check.id)).toEqual([
      "profile",
      "model",
      "auth",
      "agents",
      "automations",
      "memory",
      "resources",
      "gateways",
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
    ]);
    expect(rendered.exitCode).toBe(0);
    expect(
      rendered.text.split("\n").map((line) => line.split("\t").slice(0, 2).join("\t")),
    ).toEqual([
      "OK\tprofile",
      "OK\tmodel",
      "OK\tauth",
      "OK\tagents",
      "OK\tautomations",
      "OK\tmemory",
      "OK\tresources",
      "OK\tgateways",
      "OK\tsessions",
      "OK\truntime",
    ]);
    expect(await tree(profilePath)).toEqual(before);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("doctor continues independent checks after malformed session headers", async () => {
  const profilePath = await mkdtemp(path.join(tmpdir(), "ziggy-doctor-error-"));
  try {
    await writeFile(path.join(profilePath, "SOUL.md"), "# Test\n");
    await mkdir(path.join(profilePath, "sessions"));
    await writeFile(path.join(profilePath, "sessions", "bad.jsonl"), "secret transcript text\n");

    const report = await Effect.runPromise(
      makeDoctor(auth, models).check(
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
