/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute resolver Effects */
import { expect, test } from "bun:test";
import { Effect, Predicate, Result, Schema } from "effect";
import { ProfileAgent } from "./profile";

const decodeProfileAgent = Schema.decodeUnknownEffect(ProfileAgent);

test("Profile agent contract derives the specialist shape and requires provider/model together", () => {
  const valid = Effect.runSync(
    decodeProfileAgent({
      id: "research-helper",
      version: 1,
      description: "Researches carefully",
      provider: "anthropic",
      model: "claude-sonnet",
      thinking: "high",
      tools: ["read", "bash"],
      body: "Use primary sources.",
    }),
  );

  expect(valid).toEqual({
    id: "research-helper",
    version: 1,
    description: "Researches carefully",
    provider: "anthropic",
    model: "claude-sonnet",
    thinking: "high",
    tools: ["read", "bash"],
    body: "Use primary sources.",
  });

  const invalid = Effect.runSync(
    decodeProfileAgent({
      id: "research-helper",
      version: 1,
      description: "Researches carefully",
      provider: "anthropic",
      body: "Use primary sources.",
    }).pipe(Effect.result),
  );

  expect(
    Result.match(invalid, {
      onFailure: Predicate.isTagged("SchemaError"),
      onSuccess: () => false,
    }),
  ).toBe(true);
});
