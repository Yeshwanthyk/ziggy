import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Result } from "effect";
import { selectSessionModel } from "ziggy/application/models";

const services = {
  settingsManager: {
    getDefaultProvider: () => "default",
    getDefaultModel: () => "ready",
    getDefaultThinkingLevel: () => "low",
  },
  modelRuntime: {
    getProvider: () => ({}),
    getModel: (id: string, name: string) =>
      id === "default" && name === "ready" ? { id, name } : undefined,
    hasConfiguredAuth: () => true,
    supportedThinkingLevels: () => ["low"],
  },
};

describe("session model selection", () => {
  test("an explicit missing model cannot silently fall back to the Profile default", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.string({ minLength: 1, maxLength: 24 }),
        (provider, model) => {
          const result = selectSessionModel("/profile", services, { provider, model });
          expect(Result.isSuccess(result)).toBe(provider === "default" && model === "ready");
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Profile defaults resolve when no override is supplied", () => {
    expect(selectSessionModel("/profile", services, undefined)).toEqual(
      Result.succeed({ model: { id: "default", name: "ready" }, thinking: "low" }),
    );
  });
});
