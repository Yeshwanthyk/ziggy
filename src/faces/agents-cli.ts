import type { ProfileAgentProjection, ProfileAgentValidation } from "../application/profile-agents";

const model = (agent: ProfileAgentProjection): string =>
  agent.provider === undefined || agent.model === undefined
    ? "inherit"
    : `${agent.provider}/${agent.model}`;

export const renderProfileAgent = (agent: ProfileAgentProjection): string =>
  [
    `id\t${agent.id}`,
    `description\t${agent.description}`,
    `path\t${agent.path}`,
    `model\t${model(agent)}`,
    `thinking\t${agent.thinking ?? "inherit"}`,
    `tools\t${agent.tools.length === 0 ? "none" : agent.tools.join(",")}`,
  ].join("\n");

export const renderProfileAgents = (agents: ReadonlyArray<ProfileAgentProjection>): string =>
  agents.length === 0
    ? "no Profile agents"
    : agents
        .map((agent) => `${agent.id}\t${agent.description}\t${model(agent)}\t${agent.path}`)
        .join("\n");

export const renderProfileAgentValidation = (
  validations: ReadonlyArray<ProfileAgentValidation>,
): string =>
  validations.length === 0
    ? "no Profile agents"
    : validations
        .map((validation) =>
          validation.valid
            ? `${validation.path}\tvalid`
            : `${validation.path}\tinvalid\t${validation.message}`,
        )
        .join("\n");
