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

export type SpecialistUsage = Usage;
export type SpecialistRunResult = Omit<Static<typeof specialistResultSchema>, "usage"> & {
  readonly usage: Usage;
};
export type SpecialistToolDetails = Static<typeof specialistToolDetailsSchema>;

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
  readonly session: Pick<AgentSession, "model" | "thinkingLevel" | "getAllTools">;
  readonly services: {
    readonly modelRuntime: {
      readonly getProvider: (providerId: string) => unknown;
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

export interface SpecialistChildRuntime {
  readonly session: {
    readonly model: Model<Api> | undefined;
    readonly thinkingLevel: ThinkingLevel;
    readonly getActiveToolNames: () => ReadonlyArray<string>;
    readonly messages: ReadonlyArray<AgentMessage>;
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

const addUsage = (total: Usage, usage: Usage): Usage => {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
  if (usage.cacheWrite1h !== undefined)
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  return total;
};

/** Aggregate only public Pi message usage; tool-result usage is intentionally included. */
export const usageFromMessages = (messages: ReadonlyArray<AgentMessage>): Usage => {
  const usage = zeroUsage();
  for (const message of messages) {
    if (!("role" in message)) continue;
    if (message.role === "assistant") addUsage(usage, message.usage);
    else if (message.role === "toolResult" && message.usage !== undefined)
      addUsage(usage, message.usage);
  }
  return usage;
};

const blockedSpecialistTool = (name: string): boolean =>
  name === "memory_write" ||
  name === "agent_run" ||
  name === "discussion" ||
  name.startsWith("discussion_") ||
  name.startsWith("discussion-");

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
): AgentToolResult<SpecialistToolDetails> => ({
  content: [{ type: "text" as const, text }],
  details,
  ...(usage === undefined ? {} : { usage }),
});

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
    `usage: ${specialist.usage.input} in · ${specialist.usage.output} out · ${compactUsage(specialist.usage)}`,
    "",
    specialist.answer,
  ].join("\n");
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

export const specialistThinkingLevels = thinkingLevels;
