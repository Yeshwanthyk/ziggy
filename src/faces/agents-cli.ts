import { Schema } from "effect";
import type { ProfileAgentProjection, ProfileAgentValidation } from "../application/profile-agents";

export const ProfileAgentProjectionJson = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  tools: Schema.Array(Schema.String),
  path: Schema.String,
});
export type ProfileAgentProjectionJson = typeof ProfileAgentProjectionJson.Type;

export const ProfileAgentsJson = Schema.Array(ProfileAgentProjectionJson);
export type ProfileAgentsJson = typeof ProfileAgentsJson.Type;
const encodeProfileAgents = Schema.encodeSync(ProfileAgentsJson);
const encodeProfileAgent = Schema.encodeSync(ProfileAgentProjectionJson);

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

export const renderProfileAgentsJson = (
  agents: ReadonlyArray<ProfileAgentProjectionJson>,
): string => JSON.stringify(encodeProfileAgents(agents));

export const renderProfileAgentJson = (agent: ProfileAgentProjectionJson): string =>
  JSON.stringify(encodeProfileAgent(agent));

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
