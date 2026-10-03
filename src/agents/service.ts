import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { Context, Effect, Layer, Result, Schema } from "effect";
import type { ProfileAgentRunResult, ProfileSpecialistError } from "../domain/agent";
import {
  ProfileAgentId,
  ProfileAgentEditConflict,
  ProfileAgentInvalid,
  type ProfileAgent,
} from "../domain/profile";
import {
  type ProfileFileSystemError,
  type ProfileTarget,
  Models,
  type ModelsError,
  type ModelsApi,
} from "../profile";
import { ZiggyAgent, type ZiggyAgentApi } from "../session";
import {
  createProfileAgentFile,
  discoverProfileAgents,
  inspectProfileAgentFiles,
  readProfileAgent,
  replaceProfileAgentFile,
} from "./files";
import { agentModel, agentPersona } from "./policy";

const decodeAgentId = Schema.decodeUnknownEffect(ProfileAgentId);

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

export interface ProfileAgentDocument {
  readonly id: string;
  readonly source: string;
}

export type ProfileAgentsError =
  | ProfileAgentEditConflict
  | ProfileAgentInvalid
  | ProfileFileSystemError
  | ModelsError
  | ProfileSpecialistError;

export interface ProfileAgentsApi {
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
  readonly document: (
    target: ProfileTarget,
    id: string,
  ) => Effect.Effect<ProfileAgentDocument, ProfileAgentInvalid | ProfileFileSystemError>;
  readonly save: (
    target: ProfileTarget,
    id: string,
    expectedSource: string,
    source: string,
  ) => Effect.Effect<
    ProfileAgentDocument,
    ProfileAgentEditConflict | ProfileAgentInvalid | ProfileFileSystemError
  >;
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

export class ProfileAgents extends Context.Service<ProfileAgents, ProfileAgentsApi>()(
  "ziggy/ProfileAgents",
) {}

const projection = (profilePath: string, agent: ProfileAgent): ProfileAgentProjection => ({
  id: agent.id,
  description: agent.description,
  tools: agent.tools ?? [],
  path: relative(profilePath, join(profilePath, "agents", `${agent.id}.md`)),
  ...Object.fromEntries(
    [
      agent.provider !== undefined ? (["provider", agent.provider] as const) : undefined,
      agent.model !== undefined ? (["model", agent.model] as const) : undefined,
      agent.thinking !== undefined ? (["thinking", agent.thinking] as const) : undefined,
    ].flatMap((entry) => (entry === undefined ? [] : [entry])),
  ),
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

export const makeProfileAgents = (
  agentRuntime: ZiggyAgentApi,
  modelsRuntime: ModelsApi,
): ProfileAgentsApi => ({
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
  document: (target, idSource) =>
    Effect.gen(function* () {
      const id = yield* validAgentId(idSource);
      const loaded = yield* readProfileAgent(target.path, id);

      return { id, source: loaded.source };
    }),
  save: (target, idSource, expectedSource, source) =>
    Effect.gen(function* () {
      const id = yield* validAgentId(idSource);
      const saved = yield* replaceProfileAgentFile(target.path, id, expectedSource, source);

      return { id, source: saved.source };
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

      return yield* Effect.forEach(selected, (observation) =>
        Effect.gen(function* () {
          const path = relative(target.path, observation.path);
          const loaded = observation.agent;

          if (loaded === undefined) {
            return {
              id: observation.id,
              path,
              valid: false,
              message:
                observation.error?.message ?? `Profile agent ${observation.id} could not be read`,
            };
          }

          // The same checks a run makes before it opens a session.
          const persona = agentPersona(target.path, loaded);

          const failure = Result.isFailure(persona)
            ? persona.failure.message
            : yield* modelsRuntime.check(target, agentModel(loaded)).pipe(
                Effect.match({
                  onFailure: (error) => error.message,
                  onSuccess: () => undefined,
                }),
              );

          return failure === undefined
            ? { id: observation.id, path, valid: true }
            : { id: observation.id, path, valid: false, message: failure };
        }),
      );
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
