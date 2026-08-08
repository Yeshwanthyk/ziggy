import { basename } from "node:path";
import type {
  AutocompleteProviderFactory,
  BeforeAgentStartEvent,
  InlineExtension,
  InputEvent,
  SessionInfoChangedEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { prepareProfileAgentPrompt, type ProfileAgent } from "../../domain/profile";
import { ExtensionMultiSelect } from "./extension-multi-select";
import type { ProfileExtensionSelectionRunner } from "./profile-extension-selection";

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

interface ExtensionSelectionTui {
  requestRender(): void;
}

interface ExtensionSelectionTheme {
  fg(color: "accent" | "muted" | "text" | "dim", text: string): string;
  bold(text: string): string;
}

interface ZiggyTuiCommandContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom?<Result>(
      factory: (
        tui: ExtensionSelectionTui,
        theme: ExtensionSelectionTheme,
        keybindings: unknown,
        done: (result: Result) => void,
      ) => TextComponent,
    ): Promise<Result>;
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

const agentPromptGuidance = (agents: ReadonlyArray<ProfileAgent>): string =>
  agents.length === 0
    ? "No Profile specialists are available. Do not attempt to call agent_run."
    : [
        "Profile specialist dispatch (model-guided):",
        "Use agent_run when one specialist clearly matches the user's task; use agent_discuss for a real multi-view question needing 2-4 perspectives; otherwise answer normally without delegation.",
        "agent_discuss is bounded and reasoning-only: use it for discussion, not research or edits. Research or edits remain separate single-agent agent_run work.",
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

export const createProfileAgentGuidanceExtension = (agents: ReadonlyArray<ProfileAgent>) =>
  ({
    name: "ziggy-profile-agents",
    hidden: true,
    factory: (pi: ZiggyTuiApi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${agentPromptGuidance(agents)}`,
      }));
    },
  }) satisfies InlineExtension;

const extensionSelectionError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "The extension selection could not be saved";

export const createZiggyTuiExtension = (
  profilePath: string,
  agents: ReadonlyArray<ProfileAgent> = [],
  extensionSelection?: ProfileExtensionSelectionRunner,
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
        if (agents.length > 0) {
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
        if (context.mode !== "tui" || event.source !== "interactive") {
          return { action: "continue" };
        }
        const prepared = prepareProfileAgentPrompt(event.text, agents);
        if (!prepared.ok) {
          context.ui.notify(
            `Invalid Profile agent mention: ${prepared.message}. Use /agents to see available agents.`,
            "error",
          );
          return { action: "handled" };
        }
        return prepared.text === event.text
          ? { action: "continue" }
          : { action: "transform", text: prepared.text };
      });

      pi.registerCommand("agents", {
        description: "List the specialists owned by this Profile",
        handler: async (_args, context) => {
          if (context.mode === "tui") {
            context.ui.notify(renderAgents(agents));
          }
        },
      });

      if (extensionSelection !== undefined) {
        pi.registerCommand("extensions", {
          description: "Choose the complete optional extension set for this Profile",
          handler: async (_args, context) => {
            if (context.mode !== "tui" || context.ui.custom === undefined) {
              return;
            }
            try {
              const listing = await extensionSelection.list();
              const selected = await context.ui.custom<ReadonlyArray<string> | undefined>(
                (tui, theme, _keybindings, done) =>
                  new ExtensionMultiSelect(
                    listing.available,
                    listing.selected,
                    theme,
                    () => tui.requestRender(),
                    done,
                  ),
              );
              if (selected === undefined) {
                return;
              }

              const result = await extensionSelection.setSelected(selected);
              if (!result.changed) {
                context.ui.notify("Extension selection is already up to date", "info");
                return;
              }
              context.ui.notify(
                result.selected.length === 0
                  ? "Removed all optional extensions. Reopen this Profile to apply the change."
                  : `Saved ${result.selected.length} optional extension${result.selected.length === 1 ? "" : "s"}. Reopen this Profile to apply the change.`,
                "info",
              );
            } catch (cause: unknown) {
              context.ui.notify(extensionSelectionError(cause), "error");
            }
          },
        });
      }
    },
  }) satisfies InlineExtension;

export { renderAgents as renderProfileAgents };
