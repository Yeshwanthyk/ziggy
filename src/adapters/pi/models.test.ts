import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, Exit } from "effect";
import { makePiModels, type KnownModel } from "./models";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

const profile = async (): Promise<string> => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-models-"));
  temporaryPaths.push(profilePath);
  await writeFile(join(profilePath, "SOUL.md"), "# Test\n");
  return profilePath;
};

const knownModels: ReadonlyArray<KnownModel> = [
  {
    providerId: "openrouter",
    modelId: "anthropic/claude",
    name: "Claude",
    thinkingLevels: ["off", "low", "high"],
  },
  {
    providerId: "anthropic",
    modelId: "claude",
    name: "Claude",
    thinkingLevels: ["off", "high"],
  },
];

const fakeSession = (events: string[] = []) => ({
  status: async () => ({
    providerId: "anthropic",
    modelId: "claude",
    thinking: "high",
    authConfigured: true,
  }),
  hasProvider: (providerId: string) => ["anthropic", "openrouter"].includes(providerId),
  list: (providerId?: string) =>
    providerId === undefined
      ? knownModels
      : knownModels.filter((model) => model.providerId === providerId),
  select: (providerId: string, modelId: string, thinking?: string) => {
    events.push(`select:${providerId}/${modelId}:${thinking ?? "unchanged"}`);
    return { providerId, modelId, thinking };
  },
  flush: async () => {
    events.push("flush");
  },
  drainSettingsError: () => undefined,
});

describe("Pi-backed model operations", () => {
  test("reports the Pi-resolved effective status", async () => {
    const profilePath = await profile();
    const models = makePiModels(async () => fakeSession());

    await expect(Effect.runPromise(models.status(profilePath))).resolves.toEqual({
      providerId: "anthropic",
      modelId: "claude",
      thinking: "high",
      authConfigured: true,
    });
  });

  test("lists Pi-known models in stable order and filters by provider", async () => {
    const profilePath = await profile();
    const models = makePiModels(async () => fakeSession());

    const all = await Effect.runPromise(models.list(profilePath));
    expect(all.map((model) => `${model.providerId}/${model.modelId}`)).toEqual([
      "anthropic/claude",
      "openrouter/anthropic/claude",
    ]);
    const filtered = await Effect.runPromise(models.list(profilePath, "openrouter"));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.modelId).toBe("anthropic/claude");
  });

  test("validates through Pi model metadata and flushes after selection", async () => {
    const profilePath = await profile();
    const events: string[] = [];
    const models = makePiModels(async () => fakeSession(events));

    await expect(
      Effect.runPromise(models.set(profilePath, "openrouter", "anthropic/claude", "high")),
    ).resolves.toEqual({
      providerId: "openrouter",
      modelId: "anthropic/claude",
      thinking: "high",
    });
    expect(events).toEqual(["select:openrouter/anthropic/claude:high", "flush"]);
  });

  test("rejects unknown models and unsupported thinking before writing", async () => {
    const profilePath = await profile();
    const events: string[] = [];
    const models = makePiModels(async () => fakeSession(events));

    const unknown = await Effect.runPromiseExit(models.set(profilePath, "anthropic", "missing"));
    expect(Exit.isFailure(unknown)).toBeTrue();
    const unsupported = await Effect.runPromiseExit(
      models.set(profilePath, "anthropic", "claude", "max"),
    );
    expect(Exit.isFailure(unsupported)).toBeTrue();
    expect(events).toEqual([]);
  });

  test("writes and reloads Profile-local settings through the real Pi SDK", async () => {
    const profilePath = await profile();
    const models = makePiModels();
    const listed = await Effect.runPromise(models.list(profilePath, "anthropic"));
    const selected = listed[0];
    expect(selected).toBeDefined();
    if (selected === undefined) return;

    const thinking = selected.thinkingLevels[0];
    expect(thinking).toBeDefined();
    if (thinking === undefined) return;
    await Effect.runPromise(
      models.set(profilePath, selected.providerId, selected.modelId, thinking),
    );
    const reloaded = SettingsManager.create(profilePath, profilePath);
    expect(reloaded.getDefaultProvider()).toBe(selected.providerId);
    expect(reloaded.getDefaultModel()).toBe(selected.modelId);
    expect(String(reloaded.getDefaultThinkingLevel())).toBe(thinking);
    expect(reloaded.drainErrors()).toEqual([]);
  });

  test("fails when SettingsManager reports a queued write error after flush", async () => {
    const profilePath = await profile();
    let drains = 0;
    const session = fakeSession();
    const models = makePiModels(async () => ({
      ...session,
      drainSettingsError: () => (++drains === 1 ? undefined : new Error("write failed")),
    }));

    const exit = await Effect.runPromiseExit(models.set(profilePath, "anthropic", "claude"));
    expect(Exit.isFailure(exit)).toBeTrue();
  });
});
