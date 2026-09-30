import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  SpecialistAgentNotFound,
  SpecialistRunFailed,
  type ProfileSpecialistError,
  type SessionReference,
} from "../domain/agent";
import { checkSessionModel, type ProfileTarget } from "../profile";
import type { ChatHandle, OpenSessionRequest } from "../session";
import { discoverProfileAgents } from "./files";
import { agentModel, agentPersona } from "./policy";

/** How agents open sessions: the core `openSession` with composition's dependencies. */
export type OpenAgentSession = (
  request: OpenSessionRequest,
) => Effect.Effect<ChatHandle, ProfileSpecialistError>;

/** One finished Profile agent turn and where its transcript is. */
export interface AgentRunResult {
  readonly answer: string;
  readonly session: SessionReference;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly tools: ReadonlyArray<string>;
  readonly usage: Usage;
}

/** Where the agent's transcript goes, and the parent transcript it belongs to, if any. */
export interface AgentRunPlace {
  readonly directory: string;
  readonly parentSession?: string;
}

export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Add Pi usage without mutating either value; optional counters appear once either has them. */
export const addUsage = (left: Usage, right: Usage): Usage => {
  const cacheWrite1h =
    left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) };

  const reasoning =
    left.reasoning === undefined && right.reasoning === undefined
      ? {}
      : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) };

  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
    ...cacheWrite1h,
    ...reasoning,
  };
};

/** Assistant usage plus the usage tool results report for their own nested calls. */
export const usageFromMessages = (messages: ReadonlyArray<AgentMessage>): Usage =>
  messages.reduce((usage, message) => {
    if (!("role" in message)) return usage;

    if (message.role === "assistant") return addUsage(usage, message.usage);

    return message.role === "toolResult" && message.usage !== undefined
      ? addUsage(usage, message.usage)
      : usage;
  }, zeroUsage());

const transcriptUsage = (file: string): Usage => {
  const messages = SessionManager.open(file)
    .getEntries()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  return usageFromMessages(messages);
};

const runFailed = (profilePath: string, operation: string, message: string, cause?: unknown) =>
  new SpecialistRunFailed({ profilePath, operation, message, cause });

/**
 * Run one task as a Profile agent in a new transcript. The agent's model is checked against the
 * Profile before anything is created; `narrow` can only remove declared tools.
 */
export const runAgent = (
  open: OpenAgentSession,
  target: ProfileTarget,
  agentId: string,
  task: string,
  place: AgentRunPlace,
  narrow?: ReadonlyArray<string>,
): Effect.Effect<AgentRunResult, ProfileSpecialistError> =>
  Effect.gen(function* () {
    const profilePath = target.path;
    const agents = yield* discoverProfileAgents(profilePath);
    const agent = agents.find((candidate) => candidate.id === agentId);

    if (agent === undefined) {
      return yield* new SpecialistAgentNotFound({
        profilePath,
        agentId,
        message: `unknown Profile agent: ${agentId}`,
      });
    }

    const model = agentModel(agent);
    yield* checkSessionModel(profilePath, model);
    const persona = yield* Effect.fromResult(agentPersona(profilePath, agent, narrow));

    const request: OpenSessionRequest = {
      target,
      context: { kind: "local" },
      directory: place.directory,
      session: "new",
      persona,
      model,
      name: `Agent · ${agent.id}`,
    };

    return yield* Effect.acquireUseRelease(
      open(
        place.parentSession === undefined
          ? request
          : { ...request, parentSession: place.parentSession },
      ),
      (handle) =>
        Effect.gen(function* () {
          const answer = yield* handle.prompt(task);
          const session = yield* handle.currentSession;
          const state = yield* handle.modelState;

          if (session === undefined) {
            return yield* runFailed(
              profilePath,
              "read child session",
              "the Profile agent session was not saved",
            );
          }

          const usage = yield* Effect.try({
            try: () => transcriptUsage(session.file),
            catch: (cause) =>
              runFailed(profilePath, "read child usage", `could not read ${session.file}`, cause),
          });

          return {
            answer,
            session,
            agent: agent.id,
            provider: state.providerId ?? "",
            model: state.modelId ?? "",
            thinking: state.thinking,
            tools: persona.tools,
            usage,
          };
        }),
      (handle) =>
        handle.dispose.pipe(
          Effect.catch((failure) => Effect.logWarning("Profile agent cleanup failed", { failure })),
        ),
    );
  });
