import { join } from "node:path";
import { Effect } from "effect";
import { SpecialistAgentNotFound, type ProfileSpecialistError } from "../domain/agent";
import {
  openSession,
  runOnce,
  type ChatHandle,
  type OpenSession,
  type OpenSessionRequest,
  type SessionDependencies,
  type ZiggyAgentApi,
} from "../session";
import { checkSessionModel } from "../profile";
import { discoverProfileAgents } from "./files";
import { agentModel, agentPersona } from "./policy";
import { runAgent } from "./run";
import { agentPrompt, agentTools, prepareAgentMention } from "./tools";

export { discoverProfileAgents } from "./files";

export {
  makeProfileAgents,
  ProfileAgents,
  ProfileAgentsLive,
  type ProfileAgentDocument,
  type ProfileAgentProjection,
  type ProfileAgentsApi,
  type ProfileAgentsError,
  type ProfileAgentValidation,
} from "./service";

/** Where a local rail with one Profile agent keeps its transcripts. */
export const localSpecialistSessionDirectory = (profilePath: string, agentId: string): string =>
  join(profilePath, "sessions", "local", "agents", agentId);

/**
 * The Pi-backed `ZiggyAgent`: the core session with Profile agents plugged into its seams —
 * `agent_run` and `agent_discuss`, the agent list in the prompt, and `@agent-id` checks.
 */
export const makeZiggyAgent = (deps: SessionDependencies): ZiggyAgentApi => {
  const open = (request: OpenSessionRequest): Effect.Effect<ChatHandle, ProfileSpecialistError> =>
    openSession(request, withAgents);

  const withAgents: SessionDependencies = {
    ...deps,
    tools: [...(deps.tools ?? []), agentTools(open)],
    prompts: [...(deps.prompts ?? []), agentPrompt],
    prepare: prepareAgentMention,
  };

  /** A session as one Profile agent, checked the way `agent_run` checks it. */
  const openAgent = ({ agent: _agent, model: _model, ...request }: OpenSession, id: string) =>
    Effect.gen(function* () {
      const profilePath = request.target.path;
      const agent = (yield* discoverProfileAgents(profilePath)).find((each) => each.id === id);

      if (agent === undefined) {
        return yield* new SpecialistAgentNotFound({
          profilePath,
          agentId: id,
          message: `unknown Profile agent: ${id}`,
        });
      }

      const model = agentModel(agent);
      yield* checkSessionModel(profilePath, model);
      const persona = yield* Effect.fromResult(agentPersona(profilePath, agent));

      return yield* open({ ...request, persona, model, name: request.name ?? `Agent · ${id}` });
    });

  return {
    open: (request) =>
      request.agent === undefined ? open(request) : openAgent(request, request.agent),
    runOnce: (target, prompt, continueSession, context, options) =>
      runOnce(target, prompt, continueSession, context, options, withAgents),
    runSpecialist: (target, agentId, task, context) =>
      runAgent(open, target, agentId, task, { directory: context.sessionDirectory }).pipe(
        Effect.map(({ answer, session }) => ({ answer, session })),
      ),
  };
};
