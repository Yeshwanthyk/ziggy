import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  ApprovalOverlay,
  ConnectionState,
  SessionPickerOverlay,
  TranscriptItem,
  TuiState,
} from "./model.ts";

export interface TerminalViewport {
  readonly columns: number;
  readonly rows: number;
}

export interface ZiggyTheme {
  readonly brand: (text: string) => string;
  readonly label: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly error: (text: string) => string;
  readonly focus: (text: string) => string;
}

const identity = (text: string): string => text;

export const residentConsoleTheme: ZiggyTheme = {
  brand: identity,
  label: identity,
  muted: identity,
  error: identity,
  focus: identity,
};

export function renderedWidth(line: string): number {
  return visibleWidth(line);
}

export function renderTui(
  state: TuiState,
  viewport: TerminalViewport,
  theme: ZiggyTheme = residentConsoleTheme,
): ReadonlyArray<string> {
  const width = Math.max(1, viewport.columns);
  const rows = Math.max(1, viewport.rows);
  const header = renderHeader(state, width, theme);
  const error = state.error === null ? [] : [theme.error(`[ERROR] ${state.error}`)];
  const composer = renderComposer(state, width, theme);
  const footer = renderFooter(state, width, theme);
  const fixedCount = header.length + error.length + composer.length + footer.length;
  const bodyRows = Math.max(0, rows - fixedCount);
  const body =
    state.overlay.kind === "none"
      ? clipBody(renderTranscript(state, width, theme), bodyRows, theme)
      : renderOverlay(state, width, bodyRows, theme);
  const clippedBody = body;
  const lines = [...header, ...clippedBody, ...error, ...composer, ...footer];
  return lines.slice(0, rows).map((line) => safeLine(line, width));
}

function renderHeader(state: TuiState, width: number, theme: ZiggyTheme): ReadonlyArray<string> {
  const session =
    state.displayed.kind === "loaded" ? state.displayed.projection.summary.sessionId : "no Session";
  const active =
    state.displayed.kind === "loaded" && state.displayed.projection.turn.kind === "active";
  const primary = active ? "WORKING" : "READY";
  const diagnostics = diagnosticLabel(state);
  const context = diagnostics === undefined ? primary : `${primary} · ${diagnostics}`;
  if (width < 64) {
    return [theme.brand(`ZIGGY / ${session}`), theme.label(context), rule(width)];
  }
  return [joinEdges(theme.brand(`ZIGGY / ${session}`), theme.label(context), width), rule(width)];
}

function renderTranscript(
  state: TuiState,
  width: number,
  theme: ZiggyTheme,
): ReadonlyArray<string> {
  if (state.displayed.kind === "empty") {
    return ["", theme.muted("No Session loaded. Reconnecting will restore protocol history.")];
  }
  if (state.displayed.projection.transcript.length === 0) {
    const message =
      state.connection.kind === "replaying"
        ? `Replaying through sequence ${state.connection.throughSeq}...`
        : "No messages yet. Type below and press Enter to start.";
    return ["", theme.muted(message)];
  }
  const lines: string[] = [];
  for (const item of state.displayed.projection.transcript) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderTranscriptItem(item, width, theme));
  }
  return lines;
}

function renderTranscriptItem(
  item: TranscriptItem,
  width: number,
  theme: ZiggyTheme,
): ReadonlyArray<string> {
  if (item.kind === "activity") {
    const marker = item.tone === "error" ? "[!]" : "[-]";
    const style = item.tone === "error" ? theme.error : theme.muted;
    return wrap(`${marker} ${item.text}`, width).map(style);
  }
  const mode = item.kind === "user" && item.mode !== "message" ? ` / ${item.mode}` : "";
  const label =
    item.kind === "user" ? `YOU${mode}` : item.streaming ? "ZIGGY / STREAMING" : "ZIGGY";
  const text = item.kind === "assistant" && item.text.length === 0 ? "..." : item.text;
  return [theme.label(label), ...wrap(text, width)];
}

function renderComposer(state: TuiState, width: number, theme: ZiggyTheme): ReadonlyArray<string> {
  const active =
    state.displayed.kind === "loaded" && state.displayed.projection.turn.kind === "active";
  const focus =
    state.overlay.kind === "none"
      ? "FOCUS: COMPOSER"
      : `FOCUS: ${state.overlay.kind.toUpperCase()}`;
  const behavior = composerBehavior(state, active);
  return [
    rule(width),
    theme.focus(`[${focus}] [${behavior}]`),
    safeLine(`> ${state.composer}${state.overlay.kind === "none" ? "_" : ""}`, width),
  ];
}

function renderFooter(state: TuiState, width: number, theme: ZiggyTheme): ReadonlyArray<string> {
  const controls =
    state.overlay.kind === "sessions"
      ? "↑/↓ move | Enter resume | Esc dismiss | ^C detach"
      : state.overlay.kind === "approval"
        ? "A approve | D deny | Enter resolve | Esc dismiss | ^C detach"
        : state.connection.kind !== "live"
          ? "^P Sessions | ^C detach"
          : state.displayed.kind === "loaded" && state.displayed.projection.turn.kind === "active"
            ? width >= 76
              ? "Enter steer | Alt+Enter/F2 queue | ^X interrupt | ^P Sessions | ^C detach"
              : "Enter steer | F2 queue | ^X stop | ^P Sessions | ^C detach"
            : width >= 76
              ? "Enter start | ^P Sessions | ^C detach"
              : "Enter start | ^P Sessions | ^C detach";
  return [theme.muted(controls)];
}

function renderOverlay(
  state: TuiState,
  width: number,
  rows: number,
  theme: ZiggyTheme,
): ReadonlyArray<string> {
  if (rows === 0) return [];
  if (state.overlay.kind === "sessions")
    return renderSessionPicker(state, state.overlay, width, rows, theme);
  if (state.overlay.kind === "approval") {
    const rendered = renderApproval(state.overlay, width, theme);
    return rendered.length <= rows ? rendered : rendered.slice(0, rows);
  }
  return [];
}

function renderSessionPicker(
  state: TuiState,
  overlay: SessionPickerOverlay,
  width: number,
  rows: number,
  theme: ZiggyTheme,
): ReadonlyArray<string> {
  const currentId =
    state.displayed.kind === "loaded" ? state.displayed.projection.summary.sessionId : undefined;
  const entryCapacity = Math.max(1, rows - 4);
  const start = Math.max(
    0,
    Math.min(
      state.sessions.length - entryCapacity,
      overlay.selectedIndex - Math.floor(entryCapacity / 2),
    ),
  );
  const visible = state.sessions.slice(start, start + entryCapacity);
  const entries = visible.map((session, offset) => {
    const index = start + offset;
    const selected = index === overlay.selectedIndex ? ">" : " ";
    const current = session.sessionId === currentId ? " [current]" : "";
    const active = session.activeTurnId === undefined ? "idle" : `active ${session.activeTurnId}`;
    return `${selected} ${session.sessionId}${current}  ${active}  #${session.lastSeq}`;
  });
  if (entries.length === 0) entries.push(theme.muted("No Sessions found."));
  const position =
    state.sessions.length > visible.length
      ? ` · ${overlay.selectedIndex + 1}/${state.sessions.length}`
      : "";
  return frame(
    [
      theme.focus(`[SESSIONS] All persisted Sessions${position}`),
      ...entries,
      theme.muted("Up/Down move · Enter resume · Escape dismiss"),
    ],
    width,
  ).slice(0, rows);
}

function renderApproval(
  overlay: ApprovalOverlay,
  width: number,
  theme: ZiggyTheme,
): ReadonlyArray<string> {
  const choices = overlay.choices
    .map((choice) => `${choice === overlay.selected ? ">" : " "} ${choice.toUpperCase()}`)
    .join("   ");
  return frame(
    [
      theme.focus("[APPROVAL REQUIRED]"),
      ...wrap(overlay.prompt, Math.max(1, width - 4)),
      choices,
      theme.muted("A approve · D deny · Enter selected · Escape dismiss"),
    ],
    width,
  );
}

function frame(lines: ReadonlyArray<string>, width: number): ReadonlyArray<string> {
  if (width < 8) return lines;
  const innerWidth = Math.max(1, width - 4);
  const horizontal = `+${"-".repeat(Math.max(0, width - 2))}+`;
  const framed = lines.flatMap((line) =>
    wrap(line, innerWidth).map((part) => `| ${padRight(part, innerWidth)} |`),
  );
  return [horizontal, ...framed, horizontal];
}

function clipBody(
  lines: ReadonlyArray<string>,
  rows: number,
  theme: ZiggyTheme,
): ReadonlyArray<string> {
  if (rows === 0) return [];
  if (lines.length <= rows) return lines;
  if (rows === 1) return [theme.muted("... earlier transcript ...")];
  return [theme.muted("... earlier transcript ..."), ...lines.slice(-(rows - 1))];
}

function diagnosticLabel(state: TuiState): string | undefined {
  const connection = connectionLabel(state.connection);
  if (state.connection.kind === "live") return undefined;
  const seq = state.displayed.kind === "loaded" ? state.displayed.projection.lastAppliedSeq : 0;
  return `${connection} · #${seq}`;
}

function composerBehavior(state: TuiState, active: boolean): string {
  if (state.overlay.kind !== "none") return "ENTER SELECTS";
  if (state.connection.kind !== "live") return "READ ONLY";
  return active ? "ENTER STEERS" : "ENTER STARTS";
}

function connectionLabel(connection: ConnectionState): string {
  switch (connection.kind) {
    case "connecting":
      return "CONNECTING";
    case "replaying":
      return `REPLAY -> #${connection.throughSeq}`;
    case "live":
      return "LIVE";
    case "disconnected":
      return "DISCONNECTED";
    case "retrying":
      return `RETRY ${connection.attempt}`;
    case "outcome-unknown":
      return "OUTCOME UNKNOWN";
  }
}

function wrap(text: string, width: number): ReadonlyArray<string> {
  const lines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  return lines.length === 0 ? [""] : lines;
}

function joinEdges(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return safeLine(`${left}${" ".repeat(gap)}${right}`, width);
}

function padRight(text: string, width: number): string {
  const clipped = safeLine(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function safeLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  const truncated = truncateToWidth(line, width);
  return line.includes("\u001b") ? truncated : truncated.replaceAll("\u001b[0m", "");
}

function rule(width: number): string {
  return "-".repeat(width);
}
