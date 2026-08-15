/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute resolver Effects */
import { expect, test } from "bun:test";
import { Effect, Predicate, Result, Schema } from "effect";
import {
  parseLeadingProfileAgentMention,
  prepareProfileAgentPrompt,
  ProfileAgent,
} from "ziggy/domain/profile";

const decodeProfileAgent = Schema.decodeUnknownEffect(ProfileAgent);

test("leading Profile agent mentions require the same literal leading position", () => {
  expect(parseLeadingProfileAgentMention("@research-helper\n  do the work  ")).toEqual({
    kind: "tagged",
    agentId: "research-helper",
    task: "do the work",
  });
  expect(parseLeadingProfileAgentMention("  @research-helper do the work")).toEqual({
    kind: "untagged",
  });
  expect(parseLeadingProfileAgentMention("help @research-helper do the work")).toEqual({
    kind: "untagged",
  });
});

test("leading Profile agent preparation is shared and rejects malformed or unknown ids", () => {
  const agents = [
    {
      id: "research-helper",
      version: 1 as const,
      description: "Researches carefully",
      body: "Use primary sources.",
    },
  ];
  expect(prepareProfileAgentPrompt("plain prompt", agents)).toEqual({
    ok: true,
    text: "plain prompt",
  });
  expect(prepareProfileAgentPrompt("@research-helper do the work", agents)).toMatchObject({
    ok: true,
    text: expect.stringContaining('call agent_run for the named agent "research-helper"'),
  });
  expect(prepareProfileAgentPrompt("@missing do the work", agents)).toEqual({
    ok: false,
    message: "unknown Profile agent: missing",
  });
  expect(prepareProfileAgentPrompt("@Missing do the work", agents)).toEqual({
    ok: false,
    message: "a leading Profile agent mention must use lowercase kebab-case @agent-id",
  });
});

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
