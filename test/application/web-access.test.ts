/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Fixture owns a temporary Profile. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { issueWebPairing } from "ziggy/application/web-access";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("pairing without a resident never issues a port-zero URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-web-pair-"));
  roots.push(root);
  const exit = await Effect.runPromiseExit(issueWebPairing({ name: "fixture", path: root }));

  expect(Exit.isFailure(exit)).toBe(true);
  expect(String(exit)).toContain("resident must be running");
});
