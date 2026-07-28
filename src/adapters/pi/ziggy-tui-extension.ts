import { basename } from "node:path";
import type {
  InlineExtension,
  SessionInfoChangedEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

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

type ZiggyTuiEvent = SessionStartEvent | SessionInfoChangedEvent;
type ZiggyTuiHandler = (event: ZiggyTuiEvent, context: ZiggyTuiContext) => void;

interface ZiggyTuiApi {
  on(event: "session_start" | "session_info_changed", handler: ZiggyTuiHandler): void;
}

const textComponent = (text: string) => ({
  invalidate: () => {},
  render: (_width: number): Array<string> => [text],
});

export const createZiggyTuiExtension = (profilePath: string) =>
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
    },
  }) satisfies InlineExtension;
