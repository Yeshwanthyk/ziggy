// Stub MCP Apps host for `bun run shots` (bundled by shots.ts, runs in headless Chrome). It loads
// one view the way Ziggy does, opens it with a recorded tool result and answers every call the
// view makes with that same result, so the view renders real data shapes with no server.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

interface Scenario {
  readonly mode: "data" | "error" | "loading";
  readonly result?: { content?: unknown[]; isError?: boolean };
}

// Ziggy's web UI theme as it reaches a view (clients/web: app-view.tsx maps styles.css tokens to
// these names), so contrast is checked against a real host, not only the kit's fallbacks.
const shared = {
  "--color-border-danger": "oklch(0.58 0.2 27)",
  "--color-border-success": "oklch(0.63 0.15 150)",
  "--color-border-warning": "oklch(0.72 0.15 75)",
  "--color-ring-danger": "oklch(0.58 0.2 27)",
  "--color-ring-success": "oklch(0.63 0.15 150)",
  "--color-ring-warning": "oklch(0.72 0.15 75)",
  "--font-sans": 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--font-mono": 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "12px",
  "--border-radius-full": "999px",
};
const HOST_VARIABLES = {
  light: {
    ...shared,
    "--color-background-primary": "oklch(1 0 0)",
    "--color-background-secondary": "oklch(0.967 0.001 286)",
    "--color-background-tertiary": "oklch(0.955 0.002 286)",
    "--color-background-inverse": "oklch(0.21 0.006 286)",
    "--color-background-danger": "oklch(0.97 0.02 25)",
    "--color-background-success": "oklch(0.97 0.03 150)",
    "--color-background-warning": "oklch(0.98 0.04 85)",
    "--color-text-primary": "oklch(0.21 0.006 286)",
    "--color-text-secondary": "oklch(0.52 0.014 286)",
    "--color-text-tertiary": "oklch(0.6 0.012 286)",
    "--color-text-inverse": "oklch(0.985 0 0)",
    "--color-text-info": "oklch(0.5 0.16 255)",
    "--color-text-danger": "oklch(0.47 0.17 27)",
    "--color-text-success": "oklch(0.42 0.11 150)",
    "--color-text-warning": "oklch(0.47 0.11 65)",
    "--color-border-primary": "oklch(0.92 0.004 286)",
    "--color-border-secondary": "oklch(0.9 0.004 286)",
    "--color-ring-primary": "oklch(0.62 0.14 255)",
  },
  dark: {
    ...shared,
    "--color-background-primary": "oklch(0.17 0.004 286)",
    "--color-background-secondary": "oklch(0.22 0.005 286)",
    "--color-background-tertiary": "oklch(0.23 0.005 286)",
    "--color-background-inverse": "oklch(0.96 0.002 286)",
    "--color-background-danger": "oklch(0.58 0.2 27 / 0.16)",
    "--color-background-success": "oklch(0.63 0.15 150 / 0.14)",
    "--color-background-warning": "oklch(0.72 0.15 75 / 0.14)",
    "--color-text-primary": "oklch(0.96 0.002 286)",
    "--color-text-secondary": "oklch(0.68 0.01 286)",
    "--color-text-tertiary": "oklch(0.56 0.01 286)",
    "--color-text-inverse": "oklch(0.17 0.004 286)",
    "--color-text-info": "oklch(0.74 0.12 255)",
    "--color-text-danger": "oklch(0.76 0.14 27)",
    "--color-text-success": "oklch(0.78 0.13 150)",
    "--color-text-warning": "oklch(0.82 0.12 80)",
    "--color-border-primary": "oklch(1 0 0 / 0.08)",
    "--color-border-secondary": "oklch(1 0 0 / 0.12)",
    "--color-ring-primary": "oklch(0.68 0.13 255)",
  },
};

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const scenario = (await (await fetch(`/scenario?${params}`)).json()) as Scenario;
const failed = {
  content: [{ type: "text", text: "Stub host: the server did not answer." }],
  isError: true,
};
const answer = () =>
  scenario.mode === "loading"
    ? new Promise<never>(() => undefined)
    : Promise.resolve(scenario.mode === "error" ? failed : scenario.result);

document.documentElement.style.colorScheme = theme;
document.body.style.cssText = `margin:0;background:${HOST_VARIABLES[theme]["--color-background-primary"]}`;
const frame = document.createElement("iframe");
frame.title = "View";
frame.style.cssText = "display:block;border:0;width:100%;height:80px";
document.body.append(frame);

const bridge = new AppBridge(
  null,
  { name: "shots", version: "1" },
  { serverTools: {}, serverResources: {} },
  {
    hostContext: {
      theme,
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      platform: "web",
      styles: { variables: HOST_VARIABLES[theme] as never },
      containerDimensions: { maxWidth: innerWidth, maxHeight: 560 },
    },
  },
);
bridge.oncalltool = (async () => answer()) as typeof bridge.oncalltool;
bridge.onsizechange = ({ height }) => {
  if (typeof height === "number") frame.style.height = `${Math.ceil(height)}px`;
};
bridge.oninitialized = () => {
  void bridge.sendToolInput({ arguments: {} });
  if (scenario.mode !== "loading")
    void answer().then((result) => bridge.sendToolResult(result as never));
  // shots.ts then waits for the view's own signal (the kit's `data-kit-state`).
  (window as { ready?: boolean }).ready = true;
};
// Connect before the view starts, so its ui/initialize finds the bridge listening.
const target = frame.contentWindow!;
await bridge.connect(new PostMessageTransport(target, target));
frame.src = `/view.html?${params}`;
