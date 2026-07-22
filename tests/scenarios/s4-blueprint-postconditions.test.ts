import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
} from "../testkit/verification-observations.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const marker = "<!-- ziggy-blueprint: hyperframes@1 -->";
const scripts = {
  "hyperframes:doctor": "npx --yes hyperframes doctor",
  "hyperframes:init": "npx --yes hyperframes init video --non-interactive",
  "hyperframes:lint": "npx --yes hyperframes lint",
  "hyperframes:preview": "npx --yes hyperframes preview",
  "hyperframes:render": "npx --yes hyperframes render --strict",
};
const instructions = `${marker}
# HyperFrames

- Composition directory: \`video/\`
- Render output: \`video/renders/\`
- Workflow: doctor, init, author HTML, lint, preview, render.

<!-- /ziggy-blueprint: hyperframes@1 -->
`;

test("HyperFrames Blueprint has exact idempotent fixture postconditions without execution", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-hyperframes-blueprint-"));
  try {
    await cp(join(repositoryRoot, "tests/fixtures/s4/hyperframes-profile"), profile, {
      recursive: true,
    });
    const readmeBefore = await readFile(join(profile, "README.md"), "utf8");
    const blueprint = await readFile(join(repositoryRoot, "blueprints/hyperframes.md"), "utf8");
    expect(blueprint).toContain("name: hyperframes");
    expect(blueprint).toContain("version: 1");
    expect(blueprint).toContain(marker);
    expect(blueprint).toContain("Don't execute this Markdown");

    await simulateAgentApplication(profile);
    const firstPackage = await readFile(join(profile, "package.json"), "utf8");
    const firstInstructions = await readFile(join(profile, "HYPERFRAMES.md"), "utf8");
    await simulateAgentApplication(profile);

    expect(await readdir(profile)).toEqual(["HYPERFRAMES.md", "README.md", "package.json"]);
    expect(await readFile(join(profile, "README.md"), "utf8")).toBe(readmeBefore);
    expect(await readFile(join(profile, "package.json"), "utf8")).toBe(firstPackage);
    expect(await readFile(join(profile, "HYPERFRAMES.md"), "utf8")).toBe(firstInstructions);
    expect(firstInstructions).toBe(instructions);
    expect(firstInstructions.split(marker)).toHaveLength(2);
    expect(JSON.parse(firstPackage)).toEqual({
      name: "hyperframes-fixture-profile",
      private: true,
      scripts: { test: "bun test", ...scripts },
    });

    emitVerificationObservation("s4.blueprint-postconditions", {
      ...emptyRuntimeObservations(),
      filesystemDiffs: [
        {
          path: "HYPERFRAMES.md",
          change: "created",
          beforeDigest: null,
          afterDigest: fixtureDigest(firstInstructions),
        },
        {
          path: "README.md",
          change: "unchanged",
          beforeDigest: fixtureDigest(readmeBefore),
          afterDigest: fixtureDigest(readmeBefore),
        },
        {
          path: "package.json",
          change: "modified",
          beforeDigest: fixtureDigest(
            await readFile(
              join(repositoryRoot, "tests/fixtures/s4/hyperframes-profile/package.json"),
              "utf8",
            ),
          ),
          afterDigest: fixtureDigest(firstPackage),
        },
      ],
      metrics: [
        { name: "blueprint-applications", value: 2 },
        { name: "processes-launched", value: 0 },
      ],
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

async function simulateAgentApplication(profile: string): Promise<void> {
  const source: unknown = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
  const packageJson = requireRecord(source);
  const existingScripts = requireRecord(packageJson.scripts);
  await writeFile(
    join(profile, "package.json"),
    `${JSON.stringify({ ...packageJson, scripts: { ...existingScripts, ...scripts } }, null, 2)}\n`,
  );
  await writeFile(join(profile, "HYPERFRAMES.md"), instructions);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("fixture value must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}
