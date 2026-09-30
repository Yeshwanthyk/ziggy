import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Result } from "effect";
import { selectSessionModel } from "ziggy/profile/index";

const candidate = fc.oneof(
  fc.constantFrom("default", "ready"),
  fc.string({ minLength: 1, maxLength: 24 }),
);

describe("session model selection", () => {
  test("an explicit selection requires a registered provider, known model, auth, and supported thinking", () => {
    fc.assert(
      fc.property(
        candidate,
        candidate,
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("low", "max"),
        (provider, model, registered, authenticated, thinking) => {
          const services = {
            settingsManager: {
              getDefaultProvider: () => "default",
              getDefaultModel: () => "ready",
              getDefaultThinkingLevel: () => "low",
            },
            modelRuntime: {
              getProvider: (id: string) => (id === provider && registered ? {} : undefined),
              getModel: (id: string, name: string) =>
                id === "default" && name === "ready" ? { id, name } : undefined,
              hasConfiguredAuth: (id: string) => id === provider && authenticated,
              supportedThinkingLevels: () => ["low"],
            },
          };

          const result = selectSessionModel("/profile", services, { provider, model, thinking });

          const valid =
            registered &&
            authenticated &&
            provider === "default" &&
            model === "ready" &&
            thinking === "low";

          expect(Result.isSuccess(result)).toBe(valid);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("partial overrides fail even when the Profile default could fill the missing half", () => {
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

    expect(
      Result.isFailure(selectSessionModel("/profile", services, { provider: "default" })),
    ).toBe(true);
    expect(Result.isFailure(selectSessionModel("/profile", services, { model: "ready" }))).toBe(
      true,
    );
    expect(selectSessionModel("/profile", services, undefined)).toEqual(
      Result.succeed({ model: { id: "default", name: "ready" }, thinking: "low" }),
    );
  });
});
