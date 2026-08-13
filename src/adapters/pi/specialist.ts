import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionRuntime,
  type AgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { Value } from "typebox/value";
import { type Static, Type } from "typebox";
import {
  ProviderCallError,
  ProviderConfigError,
  SpecialistAgentNotFound,
  SpecialistAuthUnavailable,
  SpecialistModelUnsupported,
  SpecialistProviderUnsupported,
  SpecialistRunFailed,
  SpecialistThinkingUnsupported,
  SpecialistToolUnsupported,
  type SessionReference,
} from "../../domain/agent";
import type { ProfileAgent } from "../../domain/profile";
import { promptForAssistantText } from "./pi-agent";
import { createPiDocsExtension } from "./pi-docs";
import type { PiResources } from "./resources";
import { createProfileAgentChildSession } from "./session-lineage";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const DISCUSSION_MIN_AGENTS = 2;
export const DISCUSSION_MAX_AGENTS = 4;
export const DISCUSSION_MAX_ROUNDS = 2;
export const DISCUSSION_TOPIC_MAX_CODE_POINTS = 2_000;
export const DISCUSSION_ANSWER_MAX_CODE_POINTS = 2_000;
export const DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS = 8_000;
export const DISCUSSION_PROMPT_MAX_CODE_POINTS = 12_000;

const thinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

/** The public tool deliberately exposes no policy controls. */
export const agentRunParameters = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type AgentRunInput = Static<typeof agentRunParameters>;

/** Internal callers can only reduce the Profile agent's declared tool set. */
export type SpecialistRunRequest = AgentRunInput & {
  readonly allowedTools?: ReadonlyArray<string>;
};

const specialistUsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});

const sessionReferenceSchema = Type.Object({
  id: Type.String(),
  file: Type.String(),
});

const specialistResultSchema = Type.Object({
  answer: Type.String(),
  session: sessionReferenceSchema,
  agent: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  thinking: thinkingSchema,
  tools: Type.Array(Type.String()),
  usage: specialistUsageSchema,
});

const specialistToolDetailsSchema = Type.Object({
  result: Type.Optional(specialistResultSchema),
  error: Type.Optional(Type.String()),
});

export type SpecialistUsage = Usage;
export type SpecialistRunResult = Omit<Static<typeof specialistResultSchema>, "usage"> & {
  readonly usage: Usage;
};
export type SpecialistToolDetails = Static<typeof specialistToolDetailsSchema>;

export const discussionParameters = Type.Object(
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

export const agentDiscussParameters = discussionParameters;

const discussionParticipantSchema = Type.Object({
  agent: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  thinking: thinkingSchema,
  tools: Type.Array(Type.String()),
  answer: Type.String(),
  session: sessionReferenceSchema,
  usage: specialistUsageSchema,
});

const discussionRoundSchema = Type.Object({
  round: Type.Union([Type.Literal(1), Type.Literal(2)]),
  participants: Type.Array(discussionParticipantSchema),
});

const discussionResultSchema = Type.Object({
  topic: Type.String(),
  rounds: Type.Array(discussionRoundSchema),
  usage: specialistUsageSchema,
});

export const discussionToolDetailsSchema = Type.Object({
  result: Type.Optional(discussionResultSchema),
  error: Type.Optional(Type.String()),
});

export type AgentDiscussionInput = Static<typeof discussionParameters>;
export type AgentDiscussionParticipant = Omit<
  Static<typeof discussionParticipantSchema>,
  "usage"
> & { readonly usage: Usage };
export type AgentDiscussionResult = Omit<Static<typeof discussionResultSchema>, "usage"> & {
  readonly usage: Usage;
};
export type AgentDiscussionToolDetails = Static<typeof discussionToolDetailsSchema>;

export type SpecialistRunnerError =
  | SpecialistAgentNotFound
  | SpecialistProviderUnsupported
  | SpecialistModelUnsupported
  | SpecialistAuthUnavailable
  | SpecialistThinkingUnsupported
  | SpecialistToolUnsupported
  | SpecialistRunFailed
  | ProviderConfigError
  | ProviderCallError;

export interface SpecialistRunner {
  readonly run: (
    request: SpecialistRunRequest,
    signal?: AbortSignal,
  ) => Effect.Effect<SpecialistRunResult, SpecialistRunnerError>;
}

export interface SpecialistSelectionParent {
  readonly session: Pick<
    AgentSession,
    "model" | "thinkingLevel" | "getAllTools" | "sessionManager"
  >;
  readonly services: {
    readonly modelRuntime: {
      readonly getProvider: (providerId: string) => { readonly id: string } | undefined;
      readonly getModel: (providerId: string, modelId: string) => Model<Api> | undefined;
      readonly hasConfiguredAuth: (providerId: string) => boolean;
    };
  };
}

export interface SpecialistParent extends SpecialistSelectionParent {
  readonly services: AgentSessionServices;
  readonly resources: PiResources;
}

export interface MakeSpecialistRunnerOptions {
  readonly profilePath: string;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly parent: () => SpecialistParent | undefined;
}

const specialistFailure = (
  profilePath: string,
  operation: string,
  cause: unknown,
): SpecialistRunFailed =>
  new SpecialistRunFailed({
    profilePath,
    operation,
    message: `specialist ${operation} failed`,
    cause,
  });

interface SpecialistResourceLoaderOptions {
  systemPrompt: string;
  noExtensions: true;
  noSkills: true;
  noPromptTemplates: true;
  noThemes: true;
  noContextFiles: true;
  extensionFactories?: InlineExtension[];
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
}

export interface SpecialistExecutionEnvironment {
  readonly services: AgentSessionServices;
  readonly resources: PiResources;
}

export const specialistRuntime = (
  profilePath: string,
  environment: SpecialistExecutionEnvironment,
  agent: ProfileAgent,
  model: Model<Api>,
  thinking: ThinkingLevel,
  tools: ReadonlyArray<string>,
  sessionManager: SessionManager,
): Effect.Effect<AgentSessionRuntime, SpecialistRunFailed> =>
  Effect.tryPromise({
    try: () =>
      createAgentSessionRuntime(
        async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime: environment.services.modelRuntime,
            resourceLoaderOptions: (() => {
              const options: SpecialistResourceLoaderOptions = {
                systemPrompt: agent.body,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                extensionFactories: [
                  createPiDocsExtension(),
                  ...environment.resources.extensionFactories,
                ],
              };
              if (environment.resources.extensionPaths.length > 0) {
                options.additionalExtensionPaths = [...environment.resources.extensionPaths];
              }
              if (environment.resources.skillPaths.length > 0) {
                options.additionalSkillPaths = [...environment.resources.skillPaths];
              }
              return options;
            })(),
          });
          const created = await createAgentSessionFromServices(
            sessionStartEvent === undefined
              ? {
                  services,
                  sessionManager: runtimeSessionManager,
                  model,
                  thinkingLevel: thinking,
                  tools: [...tools],
                  noTools: "all" as const,
                }
              : {
                  services,
                  sessionManager: runtimeSessionManager,
                  sessionStartEvent,
                  model,
                  thinkingLevel: thinking,
                  tools: [...tools],
                  noTools: "all" as const,
                },
          );
          return { ...created, services, diagnostics: services.diagnostics };
        },
        { cwd: profilePath, agentDir: profilePath, sessionManager },
      ),
    catch: (cause) => specialistFailure(profilePath, "create specialist runtime", cause),
  });

const childRuntime = (
  options: MakeSpecialistRunnerOptions,
  parent: SpecialistParent,
  agent: ProfileAgent,
  model: Model<Api>,
  thinking: ThinkingLevel,
  tools: ReadonlyArray<string>,
): Effect.Effect<SpecialistChildRuntime, SpecialistRunFailed> =>
  Effect.gen(function* () {
    const child = createProfileAgentChildSession(
      options.profilePath,
      parent.session.sessionManager,
    );
    if (child === undefined) {
      return yield* specialistFailure(
        options.profilePath,
        "create child session",
        new Error("specialist parent session is not persistent"),
      );
    }
    const runtime = yield* specialistRuntime(
      options.profilePath,
      parent,
      agent,
      model,
      thinking,
      tools,
      child.manager,
    );
    return {
      session: runtime.session,
      reference: child.reference,
      dispose: () => runtime.dispose(),
    };
  });

export interface SpecialistChildRuntime {
  readonly reference: SessionReference;
  readonly session: {
    readonly model: Model<Api> | undefined;
    readonly thinkingLevel: ThinkingLevel;
    readonly getActiveToolNames: () => ReadonlyArray<string>;
    readonly messages: ReadonlyArray<AgentMessage>;
    readonly abort: () => Promise<void>;
    readonly isIdle: boolean;
    readonly prompt: AgentSession["prompt"];
    readonly subscribe: AgentSession["subscribe"];
  };
  readonly dispose: () => Promise<void>;
}

const disposeChild = (
  profilePath: string,
  runtime: SpecialistChildRuntime,
): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => runtime.dispose(),
    catch: (cause) => specialistFailure(profilePath, "dispose child runtime", cause),
  }).pipe(
    Effect.catch((failure) =>
      Effect.logWarning("Pi specialist cleanup failed", {
        operation: failure.operation,
        cause: failure.cause,
      }),
    ),
  );

export const useSpecialistChild = <Runtime extends SpecialistChildRuntime, E>(
  profilePath: string,
  acquire: Effect.Effect<Runtime, E>,
  selected: {
    readonly agent: ProfileAgent;
    readonly model: Model<Api>;
  },
  answer: (runtime: Runtime) => Effect.Effect<string, ProviderConfigError | ProviderCallError>,
): Effect.Effect<SpecialistRunResult, E | ProviderConfigError | ProviderCallError> =>
  Effect.acquireUseRelease(
    acquire,
    (child) =>
      answer(child).pipe(
        Effect.map((text) => ({
          answer: text,
          session: child.reference,
          agent: selected.agent.id,
          provider: child.session.model?.provider ?? selected.model.provider,
          model: child.session.model?.id ?? selected.model.id,
          thinking: child.session.thinkingLevel,
          tools: [...child.session.getActiveToolNames()],
          usage: usageFromMessages(child.session.messages),
        })),
      ),
    (child) => disposeChild(profilePath, child),
  );

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

/** Add Pi usage without mutating either caller-owned value. */
export const addUsage = (left: Usage, right: Usage): Usage => {
  const combined = {
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
  };
  if (left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined) {
    if (left.reasoning !== undefined || right.reasoning !== undefined) {
      return {
        ...combined,
        cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
        reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
      };
    }
    return { ...combined, cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) };
  }
  if (left.reasoning !== undefined || right.reasoning !== undefined) {
    return { ...combined, reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) };
  }
  return combined;
};

/** Aggregate only public Pi message usage; tool-result usage is intentionally included. */
export const usageFromMessages = (messages: ReadonlyArray<AgentMessage>): Usage => {
  let usage = zeroUsage();
  for (const message of messages) {
    if (!("role" in message)) continue;
    if (message.role === "assistant") usage = addUsage(usage, message.usage);
    else if (message.role === "toolResult" && message.usage !== undefined)
      usage = addUsage(usage, message.usage);
  }
  return usage;
};

const blockedSpecialistTool = (name: string): boolean =>
  name === "memory_write" ||
  name === "agent_run" ||
  name === "agent_discuss" ||
  name === "discussion" ||
  name.startsWith("discussion_") ||
  name.startsWith("discussion-");

/** Truncate by Unicode code point so bounded prompts never split a surrogate pair. */
export const truncateDiscussionText = (text: string, maxCodePoints: number): string => {
  const codePoints = Array.from(text);
  if (maxCodePoints <= 0) return "";
  if (codePoints.length <= maxCodePoints) return text;
  if (maxCodePoints <= 3) return ".".repeat(maxCodePoints);
  return `${codePoints.slice(0, maxCodePoints - 3).join("")}...`;
};

const compareDiscussionAgents = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compactDiscussionTopic = (topic: string): string =>
  truncateDiscussionText(topic.replace(/\s+/g, " ").trim(), 72);

const discussionRoundPrompt = (
  topic: string,
  agent: string,
  position: number,
  totalAgents: number,
  priorOutputs?: string,
): string => {
  const role = `Role: you are the ${position + 1}${position === 0 ? "st" : position === 1 ? "nd" : position === 2 ? "rd" : "th"} participant, the ${agent} specialist, in a group discussion of ${totalAgents} Profile agents. Reason only from the topic and any bounded peer answers below; do not use tools or claim to have performed research or edits.`;
  const prior =
    priorOutputs === undefined
      ? ""
      : `\n\nBounded first-round answers from the group:\n${priorOutputs}`;
  return truncateDiscussionText(
    [
      "We need a bounded multi-view discussion.",
      `Topic: ${truncateDiscussionText(topic, DISCUSSION_TOPIC_MAX_CODE_POINTS)}`,
      role,
      "Give a concise answer for the core model to synthesize. Identify disagreements or uncertainty when useful.",
      prior,
    ].join("\n\n"),
    DISCUSSION_PROMPT_MAX_CODE_POINTS,
  );
};

const boundedPriorOutputs = (participants: ReadonlyArray<AgentDiscussionParticipant>): string =>
  truncateDiscussionText(
    participants
      .map(
        (participant) =>
          `[${participant.agent}]\n${truncateDiscussionText(participant.answer, DISCUSSION_ANSWER_MAX_CODE_POINTS)}`,
      )
      .join("\n\n"),
    DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS,
  );

const discussionParticipant = (result: SpecialistRunResult): AgentDiscussionParticipant => ({
  agent: result.agent,
  session: result.session,
  provider: result.provider,
  model: result.model,
  thinking: result.thinking,
  tools: [...result.tools],
  answer: truncateDiscussionText(result.answer, DISCUSSION_ANSWER_MAX_CODE_POINTS),
  usage: result.usage,
});

interface DiscussionRun {
  readonly usage: () => Usage;
  readonly effect: Effect.Effect<AgentDiscussionResult, SpecialistRunnerError>;
}

const runDiscussion = (
  runner: SpecialistRunner,
  input: AgentDiscussionInput,
  signal?: AbortSignal,
): DiscussionRun => {
  // Keep this per-invocation accumulator outside the Effect so a typed failure can
  // still publish usage for children that completed before the failing child.
  let combinedUsage = zeroUsage();
  const effect = Effect.gen(function* () {
    const agents = [...input.agents].sort(compareDiscussionAgents);
    const topic = truncateDiscussionText(input.topic, DISCUSSION_TOPIC_MAX_CODE_POINTS);
    const roundCount = input.rounds ?? 1;
    const rounds: Array<Static<typeof discussionRoundSchema>> = [];
    let priorOutputs: string | undefined;

    const roundOrder: ReadonlyArray<1 | 2> = roundCount === 1 ? [1] : [1, 2];
    for (const round of roundOrder) {
      const participants: AgentDiscussionParticipant[] = [];
      for (const [position, agent] of agents.entries()) {
        const result = yield* runner.run(
          {
            agent,
            prompt: discussionRoundPrompt(topic, agent, position, agents.length, priorOutputs),
            allowedTools: [],
          },
          signal,
        );
        const participant = discussionParticipant(result);
        participants.push(participant);
        combinedUsage = addUsage(combinedUsage, participant.usage);
      }
      rounds.push({ round, participants });
      if (round === 1 && roundCount === 2) priorOutputs = boundedPriorOutputs(participants);
    }

    return { topic, rounds, usage: combinedUsage };
  });
  return { usage: () => combinedUsage, effect };
};

const discussionTranscript = (result: AgentDiscussionResult): string =>
  result.rounds
    .flatMap((round) => [
      `Round ${round.round}`,
      ...round.participants.flatMap((participant) => [
        `${participant.agent} — ${participant.provider}/${participant.model} (${participant.thinking})`,
        participant.answer,
        "",
      ]),
    ])
    .join("\n");

export const selectSpecialist = (
  options: Pick<MakeSpecialistRunnerOptions, "profilePath" | "agents">,
  request: SpecialistRunRequest,
  parent: SpecialistSelectionParent,
): Effect.Effect<
  {
    readonly agent: ProfileAgent;
    readonly model: Model<Api>;
    readonly thinking: ThinkingLevel;
    readonly tools: ReadonlyArray<string>;
  },
  | SpecialistAgentNotFound
  | SpecialistProviderUnsupported
  | SpecialistModelUnsupported
  | SpecialistAuthUnavailable
  | SpecialistThinkingUnsupported
  | SpecialistToolUnsupported
> =>
  Effect.gen(function* () {
    const agent = options.agents.find((candidate) => candidate.id === request.agent);
    if (agent === undefined) {
      return yield* new SpecialistAgentNotFound({
        profilePath: options.profilePath,
        agentId: request.agent,
        message: `unknown Profile agent: ${request.agent}`,
      });
    }

    const parentModel = parent.session.model;
    // Profile metadata is authoritative when present; the parent is only a fallback.
    const providerId = agent.provider ?? parentModel?.provider;
    if (providerId === undefined) {
      return yield* new SpecialistProviderUnsupported({
        profilePath: options.profilePath,
        providerId: "",
        message: `Profile agent ${agent.id} has no provider and the active session has no model`,
      });
    }
    const provider = parent.services.modelRuntime.getProvider(providerId);
    if (provider === undefined) {
      return yield* new SpecialistProviderUnsupported({
        profilePath: options.profilePath,
        providerId,
        message: `provider is not configured in the Profile model registry: ${providerId}`,
      });
    }

    const modelId = agent.model ?? parentModel?.id;
    if (modelId === undefined) {
      return yield* new SpecialistModelUnsupported({
        profilePath: options.profilePath,
        providerId,
        modelId: "",
        message: `Profile agent ${agent.id} has no model and the active session has no model`,
      });
    }
    const model = parent.services.modelRuntime.getModel(providerId, modelId);
    if (model === undefined) {
      return yield* new SpecialistModelUnsupported({
        profilePath: options.profilePath,
        providerId,
        modelId,
        message: `model is not configured in the Profile model registry: ${providerId}/${modelId}`,
      });
    }
    if (!parent.services.modelRuntime.hasConfiguredAuth(providerId)) {
      return yield* new SpecialistAuthUnavailable({
        profilePath: options.profilePath,
        providerId,
        message: `provider auth is not configured in the Profile: ${providerId}`,
      });
    }

    const thinking = agent.thinking ?? parent.session.thinkingLevel;
    if (!getSupportedThinkingLevels(model).includes(thinking)) {
      return yield* new SpecialistThinkingUnsupported({
        profilePath: options.profilePath,
        providerId,
        modelId,
        thinking,
        message: `thinking level is not supported by ${providerId}/${modelId}: ${thinking}`,
      });
    }

    const availableTools = new Set(parent.session.getAllTools().map((tool) => tool.name));
    const declaredTools = agent.tools ?? [];
    const validateTool = (name: string): Effect.Effect<string, SpecialistToolUnsupported> => {
      const supported = availableTools.has(name) && !blockedSpecialistTool(name);
      return supported
        ? Effect.succeed(name)
        : Effect.fail(
            new SpecialistToolUnsupported({
              profilePath: options.profilePath,
              agentId: agent.id,
              toolName: name,
              message: `tool is unavailable to Profile agent ${agent.id}: ${name}`,
            }),
          );
    };
    // Validate the file's whole declaration even when an internal caller narrows it.
    for (const name of declaredTools) yield* validateTool(name);
    const tools = request.allowedTools === undefined ? declaredTools : request.allowedTools;
    for (const name of tools) {
      yield* validateTool(name);
      if (!declaredTools.includes(name)) {
        return yield* new SpecialistToolUnsupported({
          profilePath: options.profilePath,
          agentId: agent.id,
          toolName: name,
          message: `tool is outside the Profile agent allowlist: ${name}`,
        });
      }
    }

    return { agent, model, thinking, tools: [...new Set(tools)] };
  });

export const makeSpecialistRunner = (options: MakeSpecialistRunnerOptions): SpecialistRunner => ({
  run: (request, _signal) => {
    const parent = options.parent();
    if (parent === undefined) {
      return Effect.fail(
        new SpecialistRunFailed({
          profilePath: options.profilePath,
          operation: "start",
          message: "specialist parent session is unavailable",
          cause: undefined,
        }),
      );
    }

    return Effect.gen(function* () {
      const selected = yield* selectSpecialist(options, request, parent);
      return yield* useSpecialistChild(
        options.profilePath,
        childRuntime(
          options,
          parent,
          selected.agent,
          selected.model,
          selected.thinking,
          selected.tools,
        ),
        selected,
        (runtime) => promptForAssistantText(options.profilePath, runtime.session, request.prompt),
      );
    });
  },
});

const textResult = (
  text: string,
  details: SpecialistToolDetails,
  usage?: Usage,
): AgentToolResult<SpecialistToolDetails> => {
  const result: AgentToolResult<SpecialistToolDetails> = {
    content: [{ type: "text" as const, text }],
    details,
  };
  if (usage !== undefined) {
    result.usage = usage;
  }
  return result;
};

const compactPrompt = (prompt: string): string => {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}...` : singleLine;
};

const compactUsage = (usage: SpecialistUsage): string =>
  `${usage.totalTokens} tok${usage.cost.total === 0 ? "" : ` · $${usage.cost.total.toFixed(4)}`}`;

export const renderAgentRunCall = (input: Pick<AgentRunInput, "agent" | "prompt">): string =>
  `agent_run → ${input.agent}: ${compactPrompt(input.prompt)}`;

export const renderAgentRunResult = (details: SpecialistToolDetails, expanded: boolean): string => {
  if (details.error !== undefined) return `agent_run ✕ ${details.error}`;
  const specialist = details.result;
  if (specialist === undefined) return "agent_run ✕ no result";
  if (!expanded) {
    return `agent_run ← ${specialist.agent} · ${specialist.provider}/${specialist.model} · ${specialist.thinking} · ${compactUsage(specialist.usage)}`;
  }
  return [
    `agent_run ← ${specialist.agent}`,
    `model: ${specialist.provider}/${specialist.model}`,
    `thinking: ${specialist.thinking}`,
    `tools: ${specialist.tools.length === 0 ? "(none)" : specialist.tools.join(", ")}`,
    `child session: ${specialist.session.id}`,
    `usage: ${specialist.usage.input} in · ${specialist.usage.output} out · ${compactUsage(specialist.usage)}`,
    "",
    specialist.answer,
  ].join("\n");
};

export type AgentRunTool = Omit<ToolDefinition, "execute"> & {
  execute(
    toolCallId: string,
    // oxlint-disable-next-line ziggy/no-unknown-parameters -- Pi ToolDefinition requires untyped execute input at the SDK boundary.
    input: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    context?: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
};

export const createAgentRunTool = (runner: SpecialistRunner): AgentRunTool => ({
  name: "agent_run",
  label: "agent_run",
  description:
    "Run one named Profile specialist in an isolated saved child session. The specialist cannot use memory_write, agent_run, or agent_discuss. Use only for focused delegation; the child answer and session reference are returned here.",
  promptSnippet: "agent_run(agent, prompt) — delegate one focused task",
  parameters: agentRunParameters,
  executionMode: "sequential",
  execute(_toolCallId, rawInput, signal) {
    if (!Value.Check(agentRunParameters, rawInput)) {
      return Promise.resolve(
        textResult("ERROR: invalid agent_run input", { error: "invalid input" }),
      );
    }
    const program = runner.run(rawInput, signal).pipe(
      Effect.match({
        onFailure: (failure) => textResult(`ERROR: ${failure.message}`, { error: failure.message }),
        onSuccess: (result) => textResult(result.answer, { result }, result.usage),
      }),
    );
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning tool callback; this is the TUI adapter bridge.
    return Effect.runPromise(program, { signal });
  },
  renderCall: (rawInput) => {
    if (!Value.Check(agentRunParameters, rawInput))
      return new Text("agent_run (invalid input)", 0, 0);
    return new Text(renderAgentRunCall(rawInput), 0, 0);
  },
  renderResult: (result, options) => {
    if (!Value.Check(specialistToolDetailsSchema, result.details)) {
      return new Text("agent_run ✕ invalid result", 0, 0);
    }
    return new Text(renderAgentRunResult(result.details, options.expanded), 0, 0);
  },
});

const discussionTextResult = (
  text: string,
  details: AgentDiscussionToolDetails,
  usage?: Usage,
): AgentToolResult<AgentDiscussionToolDetails> => {
  const result: AgentToolResult<AgentDiscussionToolDetails> = {
    content: [{ type: "text" as const, text }],
    details,
  };
  if (usage !== undefined) {
    result.usage = usage;
  }
  return result;
};

const discussionSynthesisInstruction =
  "Synthesize the final answer to the user's topic from this transcript. Do not call another discussion or specialist provider.";

const boundedDiscussionOutput = (transcript: string): string => {
  const prefix = "Bounded specialist discussion transcript:";
  const fixed = Array.from(`${prefix}\n\n\n${discussionSynthesisInstruction}`).length;
  const transcriptBudget = Math.max(0, DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS - fixed);
  return [
    prefix,
    truncateDiscussionText(transcript, transcriptBudget),
    "",
    discussionSynthesisInstruction,
  ].join("\n");
};

const discussionCallRounds = (input: AgentDiscussionInput): 1 | 2 => input.rounds ?? 1;

export const renderAgentDiscussCall = (input: AgentDiscussionInput): string =>
  `agent_discuss → ${[...input.agents].sort(compareDiscussionAgents).join(", ")} · ${discussionCallRounds(input)} round${discussionCallRounds(input) === 1 ? "" : "s"}: ${compactDiscussionTopic(input.topic)}`;

export const renderAgentDiscussResult = (
  details: AgentDiscussionToolDetails,
  expanded: boolean,
): string => {
  if (details.error !== undefined) return `agent_discuss ✕ ${details.error}`;
  const discussion = details.result;
  if (discussion === undefined) return "agent_discuss ✕ no result";
  const participants = [
    ...new Set(discussion.rounds.flatMap((round) => round.participants.map((p) => p.agent))),
  ];
  const calls = discussion.rounds.reduce((count, round) => count + round.participants.length, 0);
  if (!expanded) {
    return `agent_discuss ← ${participants.join(", ")} · ${discussion.rounds.length} round${discussion.rounds.length === 1 ? "" : "s"} · ${calls} model calls · ${compactUsage(discussion.usage)}`;
  }
  return truncateDiscussionText(
    [
      `agent_discuss ← ${participants.join(", ")}`,
      `rounds: ${discussion.rounds.length}`,
      `model calls: ${calls}`,
      `child sessions: ${discussion.rounds.flatMap((round) => round.participants.map((participant) => participant.session.id)).join(", ")}`,
      `usage: ${discussion.usage.input} in · ${discussion.usage.output} out · ${compactUsage(discussion.usage)}`,
      "",
      discussionTranscript(discussion),
    ].join("\n"),
    DISCUSSION_TRANSCRIPT_MAX_CODE_POINTS,
  );
};

export type AgentDiscussTool = Omit<ToolDefinition, "execute"> & {
  execute(
    toolCallId: string,
    // oxlint-disable-next-line ziggy/no-unknown-parameters -- Pi ToolDefinition requires untyped execute input at the SDK boundary.
    input: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    context?: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
};

export const createAgentDiscussTool = (runner: SpecialistRunner): AgentDiscussTool => ({
  name: "agent_discuss",
  label: "agent_discuss",
  description:
    "Run a bounded 1-2 round discussion among 2-4 named Profile specialists. Discussion children have no tools and only reason over the topic and bounded prior answers; synthesize the final answer yourself.",
  promptSnippet: "agent_discuss(topic, agents, rounds) — compare multiple specialists",
  parameters: discussionParameters,
  executionMode: "sequential",
  execute(_toolCallId, rawInput, signal) {
    if (!Value.Check(discussionParameters, rawInput)) {
      return Promise.resolve(
        discussionTextResult("ERROR: invalid agent_discuss input", { error: "invalid input" }),
      );
    }
    if (new Set(rawInput.agents).size !== rawInput.agents.length) {
      return Promise.resolve(
        discussionTextResult("ERROR: agent_discuss requires unique Profile agent ids", {
          error: "agent ids must be unique",
        }),
      );
    }
    if (rawInput.topic.trim().length === 0) {
      return Promise.resolve(
        discussionTextResult("ERROR: agent_discuss topic must contain non-whitespace characters", {
          error: "topic must contain non-whitespace characters",
        }),
      );
    }
    const discussion = runDiscussion(runner, rawInput, signal);
    const program = discussion.effect.pipe(
      Effect.match({
        onFailure: (failure) =>
          discussionTextResult(
            `ERROR: ${failure.message}`,
            { error: failure.message },
            discussion.usage(),
          ),
        onSuccess: (result) =>
          discussionTextResult(
            boundedDiscussionOutput(discussionTranscript(result)),
            { result },
            result.usage,
          ),
      }),
    );
    // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning tool callback; this is the TUI adapter bridge.
    return Effect.runPromise(program, { signal });
  },
  renderCall: (rawInput) => {
    if (!Value.Check(discussionParameters, rawInput))
      return new Text("agent_discuss (invalid input)", 0, 0);
    return new Text(renderAgentDiscussCall(rawInput), 0, 0);
  },
  renderResult: (result, options) => {
    if (!Value.Check(discussionToolDetailsSchema, result.details)) {
      return new Text("agent_discuss ✕ invalid result", 0, 0);
    }
    return new Text(renderAgentDiscussResult(result.details, options.expanded), 0, 0);
  },
});

export const specialistThinkingLevels = thinkingLevels;
