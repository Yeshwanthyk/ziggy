import { Schema } from "effect";
import {
  ProfileAgentThinking,
  type ProfileAgentThinking as ProfileAgentThinkingValue,
} from "../../domain/profile";
import { boundedText } from "./errors";

const isProfileAgentThinking = Schema.is(ProfileAgentThinking);

interface ProfileAgentWireProjection {
  id: string;
  description: string;
  provider?: string;
  model?: string;
  thinking?: ProfileAgentThinkingValue;
  tools: ReadonlyArray<string>;
}

interface ProfileAgentValidationWireProjection {
  id: string;
  valid: boolean;
  message?: string;
}

export const profileAgentProjection = <
  Agent extends {
    readonly id: string;
    readonly description: string;
    readonly provider?: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly tools: ReadonlyArray<string>;
  },
>(
  agent: Agent,
) => {
  const projection: ProfileAgentWireProjection = {
    id: agent.id,
    description: boundedText(agent.description, 512, "Specialist agent"),
    tools: agent.tools.slice(0, 8).map((tool) => boundedText(tool, 128, "tool")),
  };

  if (agent.provider !== undefined)
    projection.provider = boundedText(agent.provider, 128, "provider");

  if (agent.model !== undefined) projection.model = boundedText(agent.model, 256, "model");

  if (agent.thinking !== undefined && isProfileAgentThinking(agent.thinking))
    projection.thinking = agent.thinking;

  return projection;
};

export const profileAgentValidationProjection = (validation: {
  readonly id: string;
  readonly valid: boolean;
  readonly message?: string;
}) => {
  const projection: ProfileAgentValidationWireProjection = {
    id: validation.id,
    valid: validation.valid,
  };

  if (validation.message !== undefined) projection.message = boundedText(validation.message);

  return projection;
};
