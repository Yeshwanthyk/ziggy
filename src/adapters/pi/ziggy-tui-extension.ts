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
import type {
  AutomationTuiDefinition,
  AutomationTuiDispatch,
  AutomationTuiResponse,
} from "./automation-tui";
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
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    editor(title: string, prefilled: string): Promise<string | undefined>;
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

const automationLabel = (definition: AutomationTuiDefinition): string =>
  `${definition.id} — ${definition.lifecycle} · ${
    definition.valid
      ? `${definition.schedule ?? "schedule unknown"} · ${definition.timezone ?? "timezone unknown"}`
      : "invalid"
  }`;

const renderAutomationDetails = (definition: AutomationTuiDefinition): string =>
  [
    `Automation: ${definition.id}`,
    `Lifecycle: ${definition.lifecycle}`,
    `Definition: ${definition.valid ? "valid" : "invalid"}`,
    `Schedule: ${definition.schedule ?? "-"}`,
    `Timezone: ${definition.timezone ?? "-"}`,
    `Gate: ${definition.gateState ?? "-"}`,
    `File: ${definition.path}`,
    ...(definition.message === undefined ? [] : [`Error: ${definition.message}`]),
  ].join("\n");

const notifyAutomationFailure = (
  context: ZiggyTuiCommandContext,
  response: Extract<AutomationTuiResponse, { readonly kind: "failure" }>,
) => context.ui.notify(response.message, "error");

const editAutomation = async (
  definition: AutomationTuiDefinition,
  dispatch: AutomationTuiDispatch,
  context: ZiggyTuiCommandContext,
): Promise<void> => {
  const loaded = await dispatch({ kind: "document", id: definition.id });
  if (loaded.kind === "failure") {
    notifyAutomationFailure(context, loaded);
    return;
  }
  if (loaded.kind !== "document") {
    context.ui.notify("automation editor received an unexpected response", "error");
    return;
  }

  let draft = loaded.source;
  while (true) {
    const edited = await context.ui.editor(`Edit ${loaded.id} · ${loaded.path}`, draft);
    if (edited === undefined) return;
    if (edited === loaded.source) {
      context.ui.notify(`No changes to ${loaded.id}.`);
      return;
    }
    const confirmed = await context.ui.confirm(
      `Save ${loaded.id}?`,
      `Validate and replace ${loaded.path}?`,
    );
    if (!confirmed) return;

    const saved = await dispatch({
      kind: "save",
      id: loaded.id,
      expectedSource: loaded.source,
      source: edited,
    });
    if (saved.kind === "saved") {
      context.ui.notify(`Saved ${saved.id} at ${saved.path}.`);
      return;
    }
    if (saved.kind !== "failure") {
      context.ui.notify("automation editor received an unexpected response", "error");
      return;
    }
    notifyAutomationFailure(context, saved);
    if (saved.category !== "invalid") return;
    draft = edited;
  }
};

const manageAutomation = async (
  definition: AutomationTuiDefinition,
  dispatch: AutomationTuiDispatch,
  context: ZiggyTuiCommandContext,
): Promise<void> => {
  while (true) {
    const lifecycleAction =
      definition.lifecycle === "active"
        ? "Pause automation"
        : definition.lifecycle === "paused"
          ? "Resume automation"
          : undefined;
    const action = await context.ui.select(`Automation · ${definition.id}`, [
      "View details",
      "Edit Markdown",
      "Run history",
      ...(lifecycleAction === undefined ? [] : [lifecycleAction]),
      "Back",
    ]);
    if (action === undefined || action === "Back") return;

    if (action === "View details") {
      context.ui.notify(renderAutomationDetails(definition));
      continue;
    }
    if (action === "Edit Markdown") {
      await editAutomation(definition, dispatch, context);
      return;
    }
    if (action === "Run history") {
      const runs = await dispatch({ kind: "runs", id: definition.id });
      if (runs.kind === "failure") notifyAutomationFailure(context, runs);
      else if (runs.kind === "runs") context.ui.notify(runs.text);
      else context.ui.notify("automation history received an unexpected response", "error");
      continue;
    }
    if (action === lifecycleAction) {
      const verb = definition.lifecycle === "active" ? "pause" : "resume";
      const confirmed = await context.ui.confirm(
        `${verb === "pause" ? "Pause" : "Resume"} ${definition.id}?`,
        verb === "pause"
          ? "Future scheduler admission will stop; an already running occurrence may finish."
          : "Scheduling restarts from the next future occurrence.",
      );
      if (!confirmed) continue;
      const transitioned = await dispatch({ kind: verb, id: definition.id });
      if (transitioned.kind === "failure") notifyAutomationFailure(context, transitioned);
      else if (transitioned.kind === "transitioned")
        context.ui.notify(
          `${transitioned.lifecycle === "paused" ? "Paused" : "Resumed"} ${transitioned.id} at ${transitioned.path}.`,
        );
      else context.ui.notify("automation lifecycle received an unexpected response", "error");
      return;
    }
  }
};

const openAutomations = async (
  requestedId: string,
  dispatch: AutomationTuiDispatch,
  context: ZiggyTuiCommandContext,
): Promise<void> => {
  let selectId = requestedId.trim();
  while (true) {
    const overview = await dispatch({ kind: "overview" });
    if (overview.kind === "failure") {
      notifyAutomationFailure(context, overview);
      return;
    }
    if (overview.kind !== "overview") {
      context.ui.notify("automation manager received an unexpected response", "error");
      return;
    }

    let selected: AutomationTuiDefinition | undefined;
    if (selectId.length > 0) {
      selected = overview.definitions.find((definition) => definition.id === selectId);
      if (selected === undefined) {
        context.ui.notify(`No automation named ${selectId}.`, "error");
        return;
      }
      selectId = "";
    } else {
      const statusOption = "Scheduler overview";
      const labels = new Map(
        overview.definitions.map((definition) => [automationLabel(definition), definition]),
      );
      const choice = await context.ui.select("Profile automations", [
        statusOption,
        ...labels.keys(),
      ]);
      if (choice === undefined) return;
      if (choice === statusOption) {
        context.ui.notify(overview.statusText);
        continue;
      }
      selected = labels.get(choice);
      if (selected === undefined) {
        context.ui.notify("automation selection is no longer available", "error");
        continue;
      }
    }

    await manageAutomation(selected, dispatch, context);
  }
};

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
  automationDispatch?: AutomationTuiDispatch,
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

      if (automationDispatch !== undefined) {
        pi.registerCommand("automations", {
          description: "Inspect and manage this Profile's automations",
          handler: async (args, context) => {
            if (context.mode === "tui") {
              await openAutomations(args, automationDispatch, context);
            }
          },
        });
      }

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
