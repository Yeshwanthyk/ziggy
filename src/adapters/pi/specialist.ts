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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
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
} from "../../domain/agent";
import type { ProfileAgent } from "../../domain/profile";
import { promptForAssistantText } from "./pi-agent";
import type { PiResources } from "./resources";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const agentRunParameters = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(thinkingSchema),
    tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export type AgentRunInput = Static<typeof agentRunParameters>;

const specialistUsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  total: Type.Number(),
  cost: Type.Number(),
});

const specialistResultSchema = Type.Object({
  answer: Type.String(),
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

export type SpecialistUsage = Static<typeof specialistUsageSchema>;
export type SpecialistRunResult = Static<typeof specialistResultSchema>;
export type SpecialistToolDetails = Static<typeof specialistToolDetailsSchema>;

export type SpecialistRunnerError =
  | SpecialistAgentNotFound
  | SpecialistProviderUnsupported
  | SpecialistModelUnsupported
  | SpecialistAuthUnavailable
  | SpecialistThinkingUnsupported
  | SpecialistRunFailed
  | ProviderConfigError
  | ProviderCallError;

export interface SpecialistRunner {
  readonly run: (
    input: AgentRunInput,
    signal?: AbortSignal,
  ) => Effect.Effect<SpecialistRunResult, SpecialistRunnerError>;
}

export interface SpecialistParent {
  readonly session: Pick<AgentSession, "model" | "thinkingLevel" | "getAllTools">;
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

const childRuntime = (
  options: MakeSpecialistRunnerOptions,
  parent: SpecialistParent,
  agent: ProfileAgent,
  model: Model<Api>,
  thinking: ThinkingLevel,
  tools: ReadonlyArray<string>,
): Effect.Effect<AgentSessionRuntime, SpecialistRunFailed> =>
  Effect.tryPromise({
    try: () =>
      createAgentSessionRuntime(
        async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime: parent.services.modelRuntime,
            resourceLoaderOptions: {
              systemPrompt: agent.body,
              noExtensions: true,
              noSkills: true,
              ...(parent.resources.extensionPaths.length === 0
                ? {}
                : { additionalExtensionPaths: [...parent.resources.extensionPaths] }),
              ...(parent.resources.skillPaths.length === 0
                ? {}
                : { additionalSkillPaths: [...parent.resources.skillPaths] }),
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
            },
          });
          const created = await createAgentSessionFromServices({
            services,
            sessionManager: runtimeSessionManager,
            ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
            model,
            thinkingLevel: thinking,
            tools: [...tools],
            noTools: "all",
          });
          return {
            ...created,
            services,
            diagnostics: services.diagnostics,
          };
        },
        {
          cwd: options.profilePath,
          agentDir: options.profilePath,
          sessionManager: SessionManager.inMemory(options.profilePath),
        },
      ),
    catch: (cause) => specialistFailure(options.profilePath, "create child runtime", cause),
  });

const disposeChild = (
  profilePath: string,
  runtime: AgentSessionRuntime,
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

const usageFromStats = (stats: ReturnType<AgentSession["getSessionStats"]>): SpecialistUsage => ({
  input: stats.tokens.input,
  output: stats.tokens.output,
  cacheRead: stats.tokens.cacheRead,
  cacheWrite: stats.tokens.cacheWrite,
  total: stats.tokens.total,
  cost: stats.cost,
});

const selectSpecialist = (
  options: MakeSpecialistRunnerOptions,
  input: AgentRunInput,
  parent: SpecialistParent,
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
> =>
  Effect.gen(function* () {
    const agent = options.agents.find((candidate) => candidate.id === input.agent);
    if (agent === undefined) {
      return yield* new SpecialistAgentNotFound({
        profilePath: options.profilePath,
        agentId: input.agent,
        message: `unknown Profile agent: ${input.agent}`,
      });
    }

    const parentModel = parent.session.model;
    const providerId = input.provider ?? agent.provider ?? parentModel?.provider;
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

    const modelId = input.model ?? agent.model ?? parentModel?.id;
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

    const thinking = input.thinking ?? agent.thinking ?? parent.session.thinkingLevel;
    const supportsThinking =
      thinking === "off" ||
      (model.reasoning === true && model.thinkingLevelMap?.[thinking] !== null);
    if (!supportsThinking) {
      return yield* new SpecialistThinkingUnsupported({
        profilePath: options.profilePath,
        providerId,
        modelId,
        thinking,
        message: `thinking level is not supported by ${providerId}/${modelId}: ${thinking}`,
      });
    }

    const availableTools = new Set(
      parent.session
        .getAllTools()
        .map((tool) => tool.name)
        .filter((name) => name !== "memory_write" && name !== "agent_run"),
    );
    const declaredTools = input.tools ?? agent.tools ?? [];
    const agentTools = agent.tools === undefined ? undefined : new Set(agent.tools);
    const tools = declaredTools.filter(
      (name) => availableTools.has(name) && (agentTools === undefined || agentTools.has(name)),
    );

    return { agent, model, thinking, tools };
  });

export const makeSpecialistRunner = (options: MakeSpecialistRunnerOptions): SpecialistRunner => ({
  run: (input, _signal) => {
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
      const selected = yield* selectSpecialist(options, input, parent);
      const runtime = yield* childRuntime(
        options,
        parent,
        selected.agent,
        selected.model,
        selected.thinking,
        selected.tools,
      );
      return yield* Effect.acquireUseRelease(
        Effect.succeed(runtime),
        (child) =>
          promptForAssistantText(options.profilePath, child.session, input.prompt).pipe(
            Effect.map((answer) => ({
              answer,
              agent: selected.agent.id,
              provider: child.session.model?.provider ?? selected.model.provider,
              model: child.session.model?.id ?? selected.model.id,
              thinking: child.session.thinkingLevel,
              tools: child.session
                .getActiveToolNames()
                .filter((name) => name !== "memory_write" && name !== "agent_run"),
              usage: usageFromStats(child.session.getSessionStats()),
            })),
          ),
        (child) => disposeChild(options.profilePath, child),
      );
    });
  },
});

const textResult = (
  text: string,
  details: SpecialistToolDetails,
): AgentToolResult<SpecialistToolDetails> => ({
  content: [{ type: "text" as const, text }],
  details,
});

const compactPrompt = (prompt: string): string => {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}...` : singleLine;
};

const compactUsage = (usage: SpecialistUsage): string =>
  `${usage.total} tok${usage.cost === 0 ? "" : ` · $${usage.cost.toFixed(4)}`}`;

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
    `usage: ${specialist.usage.input} in · ${specialist.usage.output} out · ${compactUsage(specialist.usage)}`,
    "",
    specialist.answer,
  ].join("\\n");
};

export type AgentRunTool = Omit<ToolDefinition, "execute"> & {
  execute(
    toolCallId: string,
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
    "Run one named Profile specialist in an isolated in-memory child session. The specialist cannot use memory_write or agent_run. Use only for focused delegation; the child answer is returned here.",
  promptSnippet:
    "agent_run(agent, prompt, provider?, model?, thinking?, tools?) — delegate one focused task",
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
        onSuccess: (result) => textResult(result.answer, { result }),
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

export const specialistThinkingLevels = thinkingLevels;
