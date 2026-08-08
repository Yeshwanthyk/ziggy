import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  createProfileAgentFile,
  discoverProfileAgents,
  inspectProfileAgentFiles,
  readProfileAgent,
} from "../adapters/fs/profile-agents";
import type { ProfileAgentRunResult, ProfileSpecialistError } from "../domain/agent";
import {
  ProfileAgentId,
  ProfileAgentInvalid,
  type ProfileAgent,
  type ProfileFileSystemError,
  type ProfileTarget,
} from "../domain/profile";
import { ZiggyAgent, type ZiggyAgentShape } from "./agent";
import { Models, type ModelsError, type ModelsShape } from "./models";

const decodeAgentId = Schema.decodeUnknownEffect(ProfileAgentId);
const blockedTools = new Set(["memory_write", "agent_run", "agent_discuss"]);

export interface ProfileAgentProjection {
  readonly id: string;
  readonly description: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly tools: ReadonlyArray<string>;
  readonly path: string;
}

export interface ProfileAgentValidation {
  readonly id: string;
  readonly path: string;
  readonly valid: boolean;
  readonly message?: string;
}

export type ProfileAgentsError =
  | ProfileAgentInvalid
  | ProfileFileSystemError
  | ModelsError
  | ProfileSpecialistError;

export interface ProfileAgentsShape {
  readonly create: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<ProfileAgentProjection, ProfileAgentInvalid | ProfileFileSystemError>;
  readonly list: (
    target: ProfileTarget,
  ) => Effect.Effect<
    ReadonlyArray<ProfileAgentProjection>,
    ProfileAgentInvalid | ProfileFileSystemError
  >;
  readonly show: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<ProfileAgentProjection, ProfileAgentInvalid | ProfileFileSystemError>;
  readonly validate: (
    target: ProfileTarget,
    id?: string,
  ) => Effect.Effect<ReadonlyArray<ProfileAgentValidation>, ProfileAgentsError>;
  readonly run: (
    target: ProfileTarget,
    id: string,
    prompt: string,
  ) => Effect.Effect<ProfileAgentRunResult, ProfileSpecialistError>;
}

export class ProfileAgents extends Context.Service<ProfileAgents, ProfileAgentsShape>()(
  "ziggy/ProfileAgents",
) {}

const projection = (profilePath: string, agent: ProfileAgent): ProfileAgentProjection => ({
  id: agent.id,
  description: agent.description,
  ...(agent.provider === undefined ? {} : { provider: agent.provider }),
  ...(agent.model === undefined ? {} : { model: agent.model }),
  ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
  tools: agent.tools ?? [],
  path: relative(profilePath, join(profilePath, "agents", `${agent.id}.md`)),
});

const validAgentId = (id: string): Effect.Effect<string, ProfileAgentInvalid> =>
  decodeAgentId(id).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileAgentInvalid({
          path: id,
          message: `invalid Profile agent id ${id}: use lowercase kebab-case`,
          cause,
        }),
    ),
  );

const runtimePolicyError = (
  agent: ProfileAgent,
  models: ReadonlyArray<{
    readonly providerId: string;
    readonly modelId: string;
    readonly thinkingLevels: ReadonlyArray<string>;
  }>,
  defaults: {
    readonly providerId: string | undefined;
    readonly modelId: string | undefined;
    readonly thinking: string;
    readonly authConfigured: boolean;
  },
): string | undefined => {
  const providerId = agent.provider ?? defaults.providerId;
  const modelId = agent.model ?? defaults.modelId;
  if (providerId === undefined || modelId === undefined) {
    return `Profile agent ${agent.id} has no effective provider/model`;
  }
  const model = models.find(
    (candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
  );
  if (model === undefined) return `unknown model ${providerId}/${modelId}`;
  const thinking = agent.thinking ?? defaults.thinking;
  if (!model.thinkingLevels.includes(thinking)) {
    return `thinking level ${thinking} is not supported by ${providerId}/${modelId}`;
  }
  const blocked = (agent.tools ?? []).find((tool) => blockedTools.has(tool));
  if (blocked !== undefined) return `tool is unavailable to Profile agent ${agent.id}: ${blocked}`;
  if (agent.provider === undefined && !defaults.authConfigured) {
    return `provider auth is not configured for the inherited model ${providerId}/${modelId}`;
  }
  return undefined;
};

export const makeProfileAgents = (
  agentRuntime: ZiggyAgentShape,
  modelsRuntime: ModelsShape,
): ProfileAgentsShape => ({
  create: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validAgentId(idSource);
      const created = yield* createProfileAgentFile(target.path, id);
      return projection(target.path, created.agent);
    }),
  list: (target) =>
    discoverProfileAgents(target.path).pipe(
      Effect.map((agents) => agents.map((agent) => projection(target.path, agent))),
    ),
  show: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validAgentId(idSource);
      const loaded = yield* readProfileAgent(target.path, id);
      return projection(target.path, loaded.agent);
    }),
  validate: (target, selectedId) =>
    Effect.gen(function* () {
      const id = selectedId === undefined ? undefined : yield* validAgentId(selectedId);
      const observations = yield* inspectProfileAgentFiles(target.path);
      const selected =
        id === undefined
          ? observations
          : observations.filter((observation) => observation.id === id);
      if (id !== undefined && selected.length === 0) {
        return yield* new ProfileAgentInvalid({
          path: join(target.path, "agents", `${id}.md`),
          message: `unknown Profile agent: ${id}`,
          cause: undefined,
        });
      }
      const parsed = selected.filter(
        (observation): observation is typeof observation & { readonly agent: ProfileAgent } =>
          observation.agent !== undefined,
      );
      const defaults =
        parsed.length === 0 ? undefined : yield* modelsRuntime.readOnlyStatus(target);
      const models = parsed.length === 0 ? [] : yield* modelsRuntime.list(target);
      return selected.map((observation): ProfileAgentValidation => {
        const path = relative(target.path, observation.path);
        if (observation.error !== undefined) {
          return { id: observation.id, path, valid: false, message: observation.error.message };
        }
        const loaded = observation.agent;
        if (loaded === undefined || defaults === undefined) {
          return {
            id: observation.id,
            path,
            valid: false,
            message: `Profile agent ${observation.id} could not be validated`,
          };
        }
        const policyError = runtimePolicyError(loaded, models, defaults);
        return policyError === undefined
          ? { id: observation.id, path, valid: true }
          : { id: observation.id, path, valid: false, message: policyError };
      });
    }),
  run: (target, idSource, prompt) =>
    Effect.gen(function* () {
      const id = yield* validAgentId(idSource);
      return yield* agentRuntime.runSpecialist(target, id, prompt, {
        sessionDirectory: join(target.path, "sessions", "agents", id, randomUUID()),
      });
    }),
});

export const ProfileAgentsLive = Layer.effect(
  ProfileAgents,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    const models = yield* Models;
    return makeProfileAgents(agent, models);
  }),
);
