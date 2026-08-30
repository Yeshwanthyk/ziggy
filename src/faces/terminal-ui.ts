import pc from "picocolors";

export interface TerminalRenderOptions {
  readonly pretty: boolean;
  readonly colors: boolean;
  readonly columns: number;
}

export type TerminalColors = ReturnType<typeof pc.createColors>;

export const createTerminalColors = (enabled: boolean): TerminalColors => pc.createColors(enabled);

export const terminalPanelWidth = (columns: number): number => Math.min(76, Math.max(36, columns));

export const truncateMiddle = (value: string, maximumWidth: number): string => {
  if (Bun.stringWidth(value) <= maximumWidth) return value;
  const available = Math.max(2, maximumWidth - 1);
  const leftWidth = Math.ceil(available * 0.62);
  const rightWidth = available - leftWidth;
  const totalWidth = Bun.stringWidth(value);
  return `${Bun.sliceAnsi(value, 0, leftWidth)}…${Bun.sliceAnsi(value, totalWidth - rightWidth, totalWidth)}`;
};

export const truncateEnd = (value: string, maximumWidth: number): string =>
  Bun.stringWidth(value) <= maximumWidth
    ? value
    : `${Bun.sliceAnsi(value, 0, Math.max(1, maximumWidth - 1))}…`;

export const alignEdges = (left: string, right: string, width: number): string => {
  if (right.length === 0) return left;
  const gap = Math.max(2, width - Bun.stringWidth(left) - Bun.stringWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
};

export const panelRule = (
  color: TerminalColors,
  left: string,
  fill: string,
  right: string,
  width: number,
): string => color.dim(`${left}${fill.repeat(width - 2)}${right}`);

export const panelLine = (color: TerminalColors, content: string, width: number): string => {
  const innerWidth = width - 4;
  const padding = " ".repeat(Math.max(0, innerWidth - Bun.stringWidth(content)));
  return `${color.dim("│")} ${content}${padding} ${color.dim("│")}`;
};

export const ziggyBadge = (color: TerminalColors): string =>
  color.bgMagenta(color.black(color.bold(" ZIGGY ")));

export const actionBadge = (color: TerminalColors, label: string): string =>
  color.bgMagenta(color.black(color.bold(` ${label} `)));
