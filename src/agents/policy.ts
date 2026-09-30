import { Result } from "effect";
import { SpecialistToolUnsupported, type ChatModelOverride } from "../domain/agent";
import type { ProfileAgent } from "../domain/profile";
import type { SessionPersona } from "../session";

/**
 * Tools a Profile agent may never declare: writing memory, delegating again, and managing
 * extensions belong to the Profile session that called it.
 */
const childForbidden = (name: string): boolean =>
  name === "memory_write" ||
  name === "agent_run" ||
  name === "agent_discuss" ||
  name === "profile_extensions" ||
  name === "discussion" ||
  name.startsWith("discussion_") ||
  name.startsWith("discussion-");

/** The agent's model choice; omitted parts come from the Profile default. */
export const agentModel = ({ provider, model, thinking }: ProfileAgent): ChatModelOverride => {
  const override: { -readonly [K in keyof ChatModelOverride]: ChatModelOverride[K] } = {};

  if (provider !== undefined) override.provider = provider;

  if (model !== undefined) override.model = model;

  if (thinking !== undefined) override.thinking = thinking;

  return override;
};

/**
 * The persona a session runs as. The whole declaration is checked even when an internal caller
 * narrows it, and narrowing can only remove tools.
 */
export const agentPersona = (
  profilePath: string,
  agent: ProfileAgent,
  narrow?: ReadonlyArray<string>,
): Result.Result<SessionPersona, SpecialistToolUnsupported> => {
  const declared = agent.tools ?? [];

  const refuse = (toolName: string, message: string) =>
    Result.fail(
      new SpecialistToolUnsupported({ profilePath, agentId: agent.id, toolName, message }),
    );

  const forbidden = declared.find(childForbidden);

  if (forbidden !== undefined) {
    return refuse(forbidden, `tool is unavailable to Profile agent ${agent.id}: ${forbidden}`);
  }

  const outside = narrow?.find((name) => !declared.includes(name));

  if (outside !== undefined) {
    return refuse(outside, `tool is outside the Profile agent allowlist: ${outside}`);
  }

  return Result.succeed({
    id: agent.id,
    body: agent.body,
    tools: [...new Set(narrow ?? declared)],
  });
};
