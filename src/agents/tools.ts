import { basename, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { SpecialistRunFailed, type ProfileSpecialistError } from "../domain/agent";
import {
  prepareProfileAgentPrompt,
  ProfileAgentMentionInvalid,
  parseLeadingProfileAgentMention,
  type ProfileAgent,
} from "../domain/profile";
import { runCallback } from "../platform/callback";
import type { SessionPrepare, SessionPrompt, SessionToolContext, SessionTools } from "../session";
import { discoverProfileAgents } from "./files";
import { addUsage, runAgent, zeroUsage, type AgentRunResult, type OpenAgentSession } from "./run";

export const DISCUSSION_MIN_AGENTS = 2;

export const DISCUSSION_MAX_AGENTS = 4;

const DISCUSSION_TOPIC_MAX_CODE_POINTS = 2_000;

const DISCUSSION_ANSWER_MAX_CODE_POINTS = 2_000;

const DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS = 8_000;

const DISCUSSION_PROMPT_MAX_CODE_POINTS = 12_000;

/** The child answer `agent_run` hands back to the parent model; the full answer stays in the child file. */
const AGENT_RUN_ANSWER_MAX_CODE_POINTS = 3_000;

const agentRunParameters = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const agentDiscussParameters = Type.Object(
  {
    topic: Type.String({ minLength: 1 }),
    agents: Type.Array(Type.String({ minLength: 1 }), {
      minItems: DISCUSSION_MIN_AGENTS,
      maxItems: DISCUSSION_MAX_AGENTS,
    }),
    rounds: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
  },
  { additionalProperties: false },
);

type RunMetadata = Omit<AgentRunResult, "answer">;

interface AgentToolDetails {
  readonly result?: RunMetadata | { readonly rounds: ReadonlyArray<ReadonlyArray<RunMetadata>> };
  readonly error?: string;
}

const toolResult = (
  text: string,
  details: AgentToolDetails,
  usage?: Usage,
): AgentToolResult<AgentToolDetails> =>
  usage === undefined
    ? { content: [{ type: "text", text }], details }
    : { content: [{ type: "text", text }], details, usage };

/** Truncate by Unicode code point so bounded prompts never split a surrogate pair. */
export const truncateCodePoints = (text: string, maxCodePoints: number): string => {
  const codePoints = Array.from(text);

  if (maxCodePoints <= 0) return "";

  if (codePoints.length <= maxCodePoints) return text;

  if (maxCodePoints <= 3) return ".".repeat(maxCodePoints);

  return `${codePoints.slice(0, maxCodePoints - 3).join("")}...`;
};

const boundedAnswer = (answer: string, childFile: string): string => {
  if (Array.from(answer).length <= AGENT_RUN_ANSWER_MAX_CODE_POINTS) return answer;
  const note = `\n\n[answer truncated; the full answer is in the child session ${childFile}]`;

  return `${truncateCodePoints(answer, AGENT_RUN_ANSWER_MAX_CODE_POINTS - Array.from(note).length)}${note}`;
};

const ordinal = (position: number): string =>
  `${position + 1}${position === 0 ? "st" : position === 1 ? "nd" : position === 2 ? "rd" : "th"}`;

const discussionRoundPrompt = (
  topic: string,
  agent: string,
  position: number,
  totalAgents: number,
  priorOutputs: string | undefined,
): string =>
  truncateCodePoints(
    [
      "We need a bounded multi-view discussion.",
      `Topic: ${topic}`,
      `Role: you are the ${ordinal(position)} participant, the ${agent} specialist, in a group discussion of ${totalAgents} Profile agents. Reason only from the topic and any bounded peer answers below; do not use tools or claim to have performed research or edits.`,
      "Give a concise answer for the core model to synthesize. Identify disagreements or uncertainty when useful.",
      priorOutputs === undefined
        ? ""
        : `\n\nBounded first-round answers from the group:\n${priorOutputs}`,
    ].join("\n\n"),
    DISCUSSION_PROMPT_MAX_CODE_POINTS,
  );

const boundedPriorOutputs = (answers: ReadonlyArray<AgentRunResult>): string =>
  truncateCodePoints(
    answers.map((answer) => `[${answer.agent}]\n${answer.answer}`).join("\n\n"),
    DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS,
  );

const discussionSynthesisInstruction =
  "Synthesize the final answer to the user's topic from this transcript. Do not call another discussion or specialist provider.";

const discussionOutput = (rounds: ReadonlyArray<ReadonlyArray<AgentRunResult>>): string => {
  const transcript = rounds
    .flatMap((round, index) => [
      `Round ${index + 1}`,
      ...round.flatMap((answer) => [
        `${answer.agent} — ${answer.provider}/${answer.model} (${answer.thinking})`,
        answer.answer,
        "",
      ]),
    ])
    .join("\n");

  const prefix = "Bounded specialist discussion transcript:";
  const fixed = Array.from(`${prefix}\n\n\n${discussionSynthesisInstruction}`).length;

  return [
    prefix,
    truncateCodePoints(transcript, Math.max(0, DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS - fixed)),
    "",
    discussionSynthesisInstruction,
  ].join("\n");
};

const profileTarget = (profilePath: string) => ({ path: profilePath, name: basename(profilePath) });

const metadata = ({ answer: _answer, ...rest }: AgentRunResult): RunMetadata => rest;

/** Children of a parent transcript live under `sessions/agents/<parent id>/`. */
const childPlace = (
  profilePath: string,
  context: SessionToolContext,
): Effect.Effect<
  { readonly directory: string; readonly parentSession: string },
  SpecialistRunFailed
> => {
  const manager = context.session()?.sessionManager;
  const parentSession = manager?.getSessionFile();

  return manager === undefined || !manager.isPersisted() || parentSession === undefined
    ? Effect.fail(
        new SpecialistRunFailed({
          profilePath,
          operation: "create child session",
          message: "the calling Profile session is not saved, so it cannot run Profile agents",
          cause: undefined,
        }),
      )
    : Effect.succeed({
        directory: join(profilePath, "sessions", "agents", manager.getSessionId()),
        parentSession,
      });
};

const agentRunTool = (
  open: OpenAgentSession,
  context: SessionToolContext,
): ToolDefinition<typeof agentRunParameters> => ({
  name: "agent_run",
  label: "agent_run",
  description:
    "Run one named Profile specialist in an isolated saved child session. The specialist cannot use memory_write, agent_run, or agent_discuss. Use only for focused delegation; the child answer and session reference are returned here.",
  promptSnippet: "agent_run(agent, prompt) — delegate one focused task",
  parameters: agentRunParameters,
  executionMode: "sequential",
  execute(_toolCallId, input, signal) {
    const { profilePath } = context;

    const program = childPlace(profilePath, context).pipe(
      Effect.flatMap((place) =>
        runAgent(open, profileTarget(profilePath), input.agent, input.prompt, place),
      ),
      Effect.match({
        onFailure: (failure) => toolResult(`ERROR: ${failure.message}`, { error: failure.message }),
        onSuccess: (result) => {
          context.voice(result.agent, result.answer);

          return toolResult(
            boundedAnswer(result.answer, result.session.file),
            { result: metadata(result) },
            result.usage,
          );
        },
      }),
    );

    return runCallback(program, signal);
  },
});

const agentDiscussTool = (
  open: OpenAgentSession,
  context: SessionToolContext,
): ToolDefinition<typeof agentDiscussParameters> => ({
  name: "agent_discuss",
  label: "agent_discuss",
  description:
    "Run a bounded 1-2 round discussion among 2-4 named Profile specialists. Discussion children have no tools and only reason over the topic and bounded prior answers. Synthesize a short wrap; do not paste the full child answers again (faces already posted them).",
  promptSnippet: "agent_discuss(topic, agents, rounds) — compare multiple specialists",
  parameters: agentDiscussParameters,
  executionMode: "sequential",
  execute(_toolCallId, input, signal) {
    const { profilePath } = context;

    if (new Set(input.agents).size !== input.agents.length) {
      return Promise.resolve(
        toolResult("ERROR: agent_discuss requires unique Profile agent ids", {
          error: "agent ids must be unique",
        }),
      );
    }

    if (input.topic.trim().length === 0) {
      return Promise.resolve(
        toolResult("ERROR: agent_discuss topic must contain non-whitespace characters", {
          error: "topic must contain non-whitespace characters",
        }),
      );
    }

    // Usage of the children that finished is reported even when a later child fails.
    let usage = zeroUsage();
    const agents = input.agents.toSorted();
    const topic = truncateCodePoints(input.topic, DISCUSSION_TOPIC_MAX_CODE_POINTS);

    const discussion = Effect.gen(function* () {
      const place = yield* childPlace(profilePath, context);
      const rounds: Array<ReadonlyArray<AgentRunResult>> = [];

      for (let round = 0; round < (input.rounds ?? 1); round++) {
        const prior = rounds[0] === undefined ? undefined : boundedPriorOutputs(rounds[0]);
        const answers: Array<AgentRunResult> = [];

        for (const [position, agent] of agents.entries()) {
          const prompt = discussionRoundPrompt(topic, agent, position, agents.length, prior);

          const result = yield* runAgent(
            open,
            profileTarget(profilePath),
            agent,
            prompt,
            place,
            [],
          );

          const answer = truncateCodePoints(result.answer, DISCUSSION_ANSWER_MAX_CODE_POINTS);

          usage = addUsage(usage, result.usage);
          answers.push({ ...result, answer });
          context.voice(result.agent, answer);
        }

        rounds.push(answers);
      }

      return rounds;
    });

    const program = discussion.pipe(
      Effect.match({
        onFailure: (failure: ProfileSpecialistError) =>
          toolResult(`ERROR: ${failure.message}`, { error: failure.message }, usage),
        onSuccess: (rounds) =>
          toolResult(
            discussionOutput(rounds),
            { result: { rounds: rounds.map((round) => round.map(metadata)) } },
            usage,
          ),
      }),
    );

    return runCallback(program, signal);
  },
});

/** Contributes `agent_run` and `agent_discuss` when the Profile has agents. */
export const agentTools =
  (open: OpenAgentSession): SessionTools =>
  (context) =>
    discoverProfileAgents(context.profilePath).pipe(
      Effect.map((agents) =>
        agents.length === 0 ? [] : [agentRunTool(open, context), agentDiscussTool(open, context)],
      ),
    );

const guidance = (agents: ReadonlyArray<ProfileAgent>): string =>
  [
    "Profile specialist dispatch (model-guided):",
    "Use agent_run when one specialist clearly matches the user's task; use agent_discuss for a real multi-view question needing 2-4 perspectives; otherwise answer normally without delegation.",
    "Match the user's ask to a listed specialist and agent_run it; do not wait for @.",
    "agent_discuss is bounded and reasoning-only: use it for discussion, not research or edits. Research or edits remain separate single-agent agent_run work.",
    "A leading @agent-id is a selection hint, not a bypass of the core model: call agent_run for that named agent, then use its result to answer.",
    "Available agents:",
    ...agents.map((agent) => `- ${agent.id}: ${agent.description}`),
  ].join("\n");

/** Lists the Profile's agents before every turn; a Profile without agents adds nothing. */
export const agentPrompt: SessionPrompt = ({ profilePath }) =>
  discoverProfileAgents(profilePath).pipe(
    Effect.map((agents) => (agents.length === 0 ? undefined : guidance(agents))),
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** A leading `@agent-id` must name an agent; it becomes a dispatch hint for the model. */
export const prepareAgentMention: SessionPrepare = (profilePath, text) =>
  parseLeadingProfileAgentMention(text).kind === "untagged"
    ? Effect.succeed(text)
    : discoverProfileAgents(profilePath).pipe(
        Effect.flatMap((agents) => {
          const prepared = prepareProfileAgentPrompt(text, agents);

          return prepared.ok
            ? Effect.succeed(prepared.text)
            : Effect.fail(
                new ProfileAgentMentionInvalid({ profilePath, message: prepared.message }),
              );
        }),
      );
