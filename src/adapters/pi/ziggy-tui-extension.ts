import { basename } from "node:path";
import type {
  InlineExtension,
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
  };
}

interface ZiggyTuiCommandContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

type ZiggyTuiEvent = SessionStartEvent | SessionInfoChangedEvent;
type ZiggyTuiHandler = (event: ZiggyTuiEvent, context: ZiggyTuiContext) => void;

interface ZiggyTuiApi {
  on(event: "session_start" | "session_info_changed", handler: ZiggyTuiHandler): void;
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
        setTitle(context);
      });

      pi.on("session_info_changed", (_event, context) => {
        if (context.mode === "tui") {
          setTitle(context);
        }
      });

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
