import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext, McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/core";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type {
  ZiggyJsonValue,
  ZiggySessionRef,
  ZiggyToolApp,
} from "../../../../packages/ui-sdk/src/index";
import {
  appHtml,
  appSrcdoc,
  contentText,
  makeLinkGate,
  modelContextText,
  safeLink,
  type AppHtml,
} from "./app-html";

type CallToolResult = ReturnType<typeof CallToolResultSchema.parse>;

/**
 * What a view reaches through the host; every call is scoped to the view's own server and the
 * conversation it mounted in. The host refuses a call once another conversation is selected.
 */
export interface AppHost {
  readonly readResource: (
    ref: ZiggySessionRef,
    server: string,
    uri: string,
  ) => Promise<ZiggyJsonValue>;
  readonly callTool: (
    ref: ZiggySessionRef,
    server: string,
    resourceUri: string,
    tool: string,
    args: { readonly [key: string]: ZiggyJsonValue },
  ) => Promise<ZiggyJsonValue>;
  /** `ui/update-model-context`: the text joins the next prompt; empty text removes it. */
  readonly setContext: (ref: ZiggySessionRef, server: string, text: string) => void;
  /** `ui/message`: the text goes into the composer for the person to send or edit. */
  readonly draftMessage: (ref: ZiggySessionRef, text: string) => void;
}

const INLINE_MIN_HEIGHT = 80;
const INLINE_MAX_HEIGHT = 560;
const INLINE_DEFAULT_HEIGHT = 240;

const HOST_STYLE_VARIABLES: ReadonlyArray<readonly [keyof McpUiStyles, string]> = [
  ["--color-background-primary", "--background"],
  ["--color-background-secondary", "--muted"],
  ["--color-background-tertiary", "--hover"],
  ["--color-background-inverse", "--primary"],
  ["--color-background-danger", "--danger-surface"],
  ["--color-background-success", "--success-surface"],
  ["--color-background-warning", "--warning-surface"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-text-tertiary", "--placeholder"],
  ["--color-text-inverse", "--primary-foreground"],
  ["--color-text-info", "--link"],
  ["--color-text-danger", "--danger-foreground"],
  ["--color-text-success", "--success-foreground"],
  ["--color-text-warning", "--warning-foreground"],
  ["--color-border-primary", "--border"],
  ["--color-border-secondary", "--input"],
  ["--color-ring-primary", "--ring"],
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],
  ["--border-radius-sm", "--radius-sm"],
  ["--border-radius-md", "--radius-md"],
  ["--border-radius-lg", "--radius-lg"],
  ["--border-radius-full", "--radius-full"],
  ["--shadow-sm", "--shadow-sm"],
  ["--shadow-md", "--shadow-md"],
  ["--shadow-lg", "--shadow-lg"],
];

const prefersDark = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** The host's theme as MCP Apps style variables, read from the page's own tokens. */
const hostStyles = (): McpUiStyles => {
  const computed = getComputedStyle(document.documentElement);
  const variables: Partial<Record<keyof McpUiStyles, string>> = {};
  for (const [key, token] of HOST_STYLE_VARIABLES) {
    const value = computed.getPropertyValue(token).trim();
    if (value !== "") variables[key] = value;
  }
  // `McpUiStyles` names every key; the view falls back to its own value for the missing ones.
  return variables as McpUiStyles;
};

const hostContext = (expanded: boolean): McpUiHostContext => ({
  theme: prefersDark() ? "dark" : "light",
  styles: { variables: hostStyles() },
  displayMode: expanded ? "fullscreen" : "inline",
  availableDisplayModes: ["inline", "fullscreen"],
  platform: "web",
  locale: navigator.language,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  containerDimensions: expanded
    ? { width: window.innerWidth, height: window.innerHeight }
    : { maxHeight: INLINE_MAX_HEIGHT, maxWidth: 760 },
});

const placeholderResult = (app: ZiggyToolApp): CallToolResult => {
  const parsed = CallToolResultSchema.safeParse(app.result);
  if (parsed.success) return parsed.data;
  return {
    content: [
      {
        type: "text",
        text: app.truncated
          ? "The result was too large to keep with the conversation. Refresh the view to load it again."
          : "No result is available for this view.",
      },
    ],
  };
};

const failedResult = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: AppHtml }
  | { readonly kind: "failed"; readonly message: string };

/**
 * An MCP Apps view for one tool call. The view runs in a `srcdoc` iframe with
 * `sandbox="allow-scripts"` (an opaque origin, no access to this page or its cookies) under the
 * CSP its resource declares. Expanding restyles the same iframe as an overlay, side panel or
 * phone sheet; it is never moved in the DOM, so the view keeps its state.
 */
export function AppView({
  app,
  host,
  sessionRef,
  title,
}: {
  readonly app: ZiggyToolApp;
  readonly host: AppHost;
  /** The conversation the view mounted in; it stays bound to it for its whole life. */
  readonly sessionRef: ZiggySessionRef;
  readonly title: string;
}) {
  const [boundRef] = useState(sessionRef);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  // History reloads hand over equal records; the bridge lives as long as the iframe.
  const appRef = useRef(app);
  appRef.current = app;
  const bridgeRef = useRef<AppBridge | undefined>(undefined);
  // One gate for the view's whole life, so a decline outlives bridge reconnects.
  const [mayOpen] = useState(() =>
    makeLinkGate((url) => window.confirm(`A view wants to open ${url}. Open it in a new tab?`)),
  );
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [height, setHeight] = useState(INLINE_DEFAULT_HEIGHT);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    let current = true;
    hostRef.current
      .readResource(boundRef, app.server, app.resourceUri)
      .then((result) => {
        if (!current) return;
        const view = appHtml(result, app.resourceUri);
        setLoad(
          view === undefined
            ? { kind: "failed", message: "This view did not return an MCP Apps page." }
            : { kind: "ready", view },
        );
      })
      .catch((cause: unknown) => {
        if (current)
          setLoad({
            kind: "failed",
            message: cause instanceof Error ? cause.message : "The view could not be loaded.",
          });
      });
    return () => {
      current = false;
    };
  }, [boundRef, app.server, app.resourceUri]);

  // The bridge connects before the iframe's document starts, so the view's `ui/initialize`
  // always finds it listening.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const target = frame?.contentWindow;
    if (load.kind !== "ready" || frame === null || target === null || target === undefined) return;
    const bridge = new AppBridge(
      null,
      { name: "Ziggy", version: "1" },
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        updateModelContext: { text: {} },
        message: { text: {} },
      },
      { hostContext: hostContext(expandedRef.current) },
    );
    bridge.oncalltool = async (params) => {
      try {
        const result = await hostRef.current.callTool(
          boundRef,
          app.server,
          app.resourceUri,
          params.name,
          (params.arguments ?? {}) as { readonly [key: string]: ZiggyJsonValue },
        );
        const parsed = CallToolResultSchema.safeParse(result);
        return parsed.success ? parsed.data : failedResult("The tool returned an invalid result.");
      } catch (cause) {
        return failedResult(cause instanceof Error ? cause.message : "The tool call failed.");
      }
    };
    bridge.onreadresource = async (params) => {
      const result = ReadResourceResultSchema.parse(
        await hostRef.current.readResource(boundRef, app.server, params.uri),
      );
      return result;
    };
    bridge.onlistresources = async () => ({ resources: [] });
    bridge.onmessage = async (params) => {
      const text = contentText(params.content).trim();
      if (text === "") return { isError: true };
      hostRef.current.draftMessage(boundRef, text);
      return {};
    };
    bridge.onopenlink = async (params) => {
      const url = safeLink(params.url);
      // A gesture counts only when it was inside this view: typing in the composer must not let a
      // view that was declined open a tab.
      const gesture =
        navigator.userActivation?.isActive === true &&
        document.activeElement !== null &&
        document.activeElement === frameRef.current;
      if (url === undefined || !mayOpen(url, gesture)) return { isError: true };
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.onupdatemodelcontext = async (params) => {
      hostRef.current.setContext(
        boundRef,
        app.server,
        modelContextText(params.content, params.structuredContent),
      );
      return {};
    };
    bridge.onrequestdisplaymode = async (params) => {
      const next = params.mode === "fullscreen";
      setExpanded(next);
      return { mode: next ? "fullscreen" : "inline" };
    };
    bridge.onsizechange = (params) => {
      if (typeof params.height === "number" && Number.isFinite(params.height))
        setHeight(
          Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, Math.ceil(params.height))),
        );
    };
    bridge.oninitialized = () => {
      const app = appRef.current;
      if (app.input !== undefined && typeof app.input === "object" && !Array.isArray(app.input))
        void bridge.sendToolInput({ arguments: app.input as Record<string, unknown> });
      else void bridge.sendToolInput({ arguments: {} });
      void bridge.sendToolResult(placeholderResult(app));
    };

    // A view that navigates away from its srcdoc to a real origin loses the bridge. Only this
    // frame's current window is checked; a data: or blob: page keeps origin "null" and passes.
    const guard = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.origin === "null") return;
      event.stopImmediatePropagation();
      void bridge.close();
      setLoad({ kind: "failed", message: "The view navigated away and was closed." });
    };
    window.addEventListener("message", guard, { capture: true });
    void bridge.connect(new PostMessageTransport(target, target));
    bridgeRef.current = bridge;
    return () => {
      window.removeEventListener("message", guard, { capture: true });
      bridgeRef.current = undefined;
      void bridge
        .teardownResource({})
        .catch(() => undefined)
        .finally(() => void bridge.close());
    };
  }, [load, boundRef, app.server, app.resourceUri]);

  useEffect(() => {
    bridgeRef.current?.setHostContext(hostContext(expanded));
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => bridgeRef.current?.setHostContext(hostContext(expandedRef.current));
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (load.kind === "failed")
    return (
      <div className="app-view is-failed" role="note">
        <span className="tool-dot is-error" />
        <span>{title}</span>
        <span>{load.message}</span>
      </div>
    );

  return (
    <div
      className={`app-view${expanded ? " is-expanded" : ""}${load.kind === "ready" && load.view.prefersBorder ? " has-border" : ""}`}
      style={{ "--app-height": `${height}px` } as CSSProperties}
    >
      {expanded ? (
        <button
          aria-label="Close expanded view"
          className="app-view-backdrop"
          onClick={() => setExpanded(false)}
          type="button"
        />
      ) : null}
      <div className="app-view-frame">
        <div className="app-view-header">
          <span className="app-view-title">{title}</span>
          <button
            aria-label={expanded ? "Collapse view" : "Expand view"}
            className="app-view-toggle"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
        {load.kind === "ready" ? (
          <iframe
            className="app-view-iframe"
            ref={frameRef}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts"
            srcDoc={appSrcdoc(load.view)}
            title={title}
          />
        ) : (
          <div className="app-view-loading" role="status">
            Loading view…
          </div>
        )}
      </div>
    </div>
  );
}
