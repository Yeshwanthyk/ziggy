import { basename } from "node:path";
import type {
  AutocompleteProviderFactory,
  BeforeAgentStartEvent,
  InlineExtension,
  InputEvent,
  SessionInfoChangedEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { ProfileAgent } from "../../domain/profile";

interface TextComponent {
  invalidate(): void;
  render(width: number): Array<string>;
}

type TextComponentFactory = () => TextComponent;

interface ZiggyTuiContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    setTitle(title: string): void;
    setHeader(factory: TextComponentFactory): void;
    setFooter(factory: TextComponentFactory): void;
    addAutocompleteProvider(factory: AutocompleteProviderFactory): void;
  };
}

interface AutocompleteItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface AutocompleteProvider {
  readonly triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { readonly signal: AbortSignal; readonly force?: boolean },
  ): Promise<{ readonly items: AutocompleteItem[]; readonly prefix: string } | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}

interface ZiggyTuiCommandContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

interface ZiggyInputContext extends ZiggyTuiCommandContext {}

type ZiggyTuiEvent = SessionStartEvent | SessionInfoChangedEvent;
type ZiggyTuiHandler = (event: ZiggyTuiEvent, context: ZiggyTuiContext) => void;
type InputEventResult =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly text: string }
  | { readonly action: "handled" };

interface ZiggyTuiApi {
  on(event: "session_start" | "session_info_changed", handler: ZiggyTuiHandler): void;
  on(
    event: "input",
    handler: (event: InputEvent, context: ZiggyInputContext) => InputEventResult,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, context: ZiggyInputContext) => { systemPrompt: string },
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, context: ZiggyTuiCommandContext): Promise<void>;
    },
  ): void;
}

const textComponent = (text: string) => ({
  invalidate: () => {},
  render: (_width: number): Array<string> => [text],
});

const renderAgents = (agents: ReadonlyArray<ProfileAgent>): string =>
  agents.length === 0
    ? "No Profile agents found."
    : ["Profile agents:", ...agents.map((agent) => `- ${agent.id} — ${agent.description}`)].join(
        "\n",
      );

const leadingAgent = (text: string): string | undefined => /^@(\S+)(?:\s|$)/.exec(text)?.[1];

const agentPromptGuidance = (agents: ReadonlyArray<ProfileAgent>): string =>
  agents.length === 0
    ? "No Profile specialists are available. Do not attempt to call agent_run."
    : [
        "Profile specialist dispatch (model-guided):",
        "Use agent_run when one specialist clearly matches the user's task; otherwise answer normally without delegation.",
        "A leading @agent-id is a selection hint, not a bypass of the core model: call agent_run for that named agent, then use its result to answer.",
        "Available agents:",
        ...agents.map((agent) => `- ${agent.id}: ${agent.description}`),
      ].join("\n");

const createAgentAutocomplete = (
  agents: ReadonlyArray<ProfileAgent>,
  current: AutocompleteProvider,
): AutocompleteProvider => ({
  triggerCharacters: ["@"],
  async getSuggestions(lines, cursorLine, cursorCol, options) {
    const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);
    const match = /^(@[a-z0-9-]*)$/.exec(beforeCursor);
    if (match === null) return base;
    const prefix = match[1] ?? "@";
    return {
      prefix,
      items: agents
        .filter((agent) => `@${agent.id}`.startsWith(prefix))
        .map((agent) => ({
          value: `@${agent.id}`,
          label: `@${agent.id}`,
          description: agent.description,
        })),
    };
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const nextLines = [...lines];
    const line = nextLines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    nextLines[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
    return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
  },
});

export const createZiggyTuiExtension = (
  profilePath: string,
  agents: ReadonlyArray<ProfileAgent> = [],
  enableSpecialists = true,
) =>
  ({
    name: "ziggy-tui",
    hidden: true,
    factory: (pi: ZiggyTuiApi) => {
      const profileName = basename(profilePath);
      const setTitle = (context: ZiggyTuiContext) => {
        // Pi restores its built-in title after session lifecycle handlers return.
        setTimeout(() => context.ui.setTitle(`Ziggy — ${profileName}`), 0);
      };

      pi.on("session_start", (_event, context) => {
        if (context.mode !== "tui") {
          return;
        }

        context.ui.setHeader(() => textComponent(`Ziggy · ${profileName}`));
        context.ui.setFooter(() => textComponent(`Profile · ${profilePath}`));
        if (enableSpecialists) {
          context.ui.addAutocompleteProvider((current) => createAgentAutocomplete(agents, current));
        }
        setTitle(context);
      });

      pi.on("session_info_changed", (_event, context) => {
        if (context.mode === "tui") {
          setTitle(context);
        }
      });

      pi.on("input", (event, context) => {
        if (!enableSpecialists || context.mode !== "tui" || event.source !== "interactive") {
          return { action: "continue" };
        }
        const agentId = leadingAgent(event.text);
        if (agentId === undefined) return { action: "continue" };
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent === undefined) {
          context.ui.notify(
            `Unknown Profile agent "${agentId}". Use /agents to see available agents.`,
            "error",
          );
          return { action: "handled" };
        }
        return {
          action: "transform",
          text: `${event.text}\n\n[Ziggy dispatch guidance: call agent_run for the named agent "${agent.id}" with the user's task, then use the result to answer. This is model-guided; @ syntax does not bypass the core model.]`,
        };
      });

      pi.on("before_agent_start", (event, context) =>
        context.mode === "tui" && enableSpecialists
          ? { systemPrompt: `${event.systemPrompt}\n\n${agentPromptGuidance(agents)}` }
          : { systemPrompt: event.systemPrompt },
      );

      if (enableSpecialists) {
        pi.registerCommand("agents", {
          description: "List the specialists owned by this Profile",
          handler: async (_args, context) => {
            if (context.mode === "tui") {
              context.ui.notify(renderAgents(agents));
            }
          },
        });
      }
    },
  }) satisfies InlineExtension;

export { renderAgents as renderProfileAgents };
