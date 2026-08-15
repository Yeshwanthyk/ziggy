/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  PROFILE_AGENTS_NAME_TOKEN,
  composeProfileSystemPrompt,
  fillProfileAgentsPrompt,
  loadProfileSystemPrompt,
} from "ziggy/adapters/pi/profile-prompt";

const temporaryPaths: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

test("AGENTS.md is inlined before SOUL.md and names the Profile directory", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-profile-prompt-"));
  temporaryPaths.push(profilePath);
  const soulPath = join(profilePath, "SOUL.md");
  await writeFile(soulPath, "# Squarey\nYou are Squarey.\n");

  const prompt = await Effect.runPromise(loadProfileSystemPrompt(profilePath, soulPath));
  const name = basename(profilePath);

  expect(prompt.startsWith("You are an AI assistant.")).toBe(true);
  expect(prompt).toContain(`This Profile is named ${name}.`);
  expect(prompt).not.toContain(PROFILE_AGENTS_NAME_TOKEN);
  expect(prompt).toContain("read extension-authoring");
  expect(prompt).toContain("read pi-packages");
  expect(prompt).toContain("Run serve, gateway, or automations: read ziggy-operations.");
  expect(prompt).toContain("# Squarey");
  expect(prompt.indexOf("You are an AI assistant.")).toBeLessThan(prompt.indexOf("# Squarey"));
});

test("compose keeps AGENTS.md ahead of soul text", () => {
  expect(
    composeProfileSystemPrompt(
      fillProfileAgentsPrompt(
        `You are an AI assistant.\nThis Profile is named ${PROFILE_AGENTS_NAME_TOKEN}.`,
        "squarey",
      ),
      "# Soul\n",
    ),
  ).toBe("You are an AI assistant.\nThis Profile is named squarey.\n\n# Soul\n");
});
