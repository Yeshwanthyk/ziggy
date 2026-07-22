import { Input, type Component, type Focusable } from "@earendil-works/pi-tui";
import { intentFromInput } from "./keys.ts";
import type { TuiAction, TuiCommand, TuiState } from "./model.ts";
import { reduceTui } from "./reducer.ts";
import { renderTui, residentConsoleTheme, type ZiggyTheme } from "./render.ts";

export interface ZiggyTuiOptions {
  readonly state: TuiState;
  readonly rows?: number;
  readonly theme?: ZiggyTheme;
  readonly emit: (command: TuiCommand) => void;
}

export class ZiggyTuiComponent implements Component, Focusable {
  private state: TuiState;
  private rows: number;
  private readonly theme: ZiggyTheme;
  private readonly emit: (command: TuiCommand) => void;
  private readonly input = new Input();
  private _focused = false;

  constructor(options: ZiggyTuiOptions) {
    this.state = options.state;
    this.rows = options.rows ?? 24;
    this.theme = options.theme ?? residentConsoleTheme;
    this.emit = options.emit;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.state.overlay.kind === "none";
  }

  get currentState(): TuiState {
    return this.state;
  }

  setRows(rows: number): void {
    this.rows = Math.max(1, rows);
  }

  dispatch(action: TuiAction): void {
    const transition = reduceTui(this.state, action);
    this.state = transition.state;
    this.input.setValue(this.state.composer);
    this.input.focused = this._focused && this.state.overlay.kind === "none";
    transition.commands.forEach(this.emit);
  }

  requestQuit(): void {
    this.dispatch({ type: "intent", intent: "detach" });
  }

  handleInput(data: string): void {
    const intent = intentFromInput(data);
    if (intent !== undefined && this.intentApplies(intent)) {
      this.dispatch({ type: "intent", intent });
      return;
    }
    if (this.state.overlay.kind !== "none") return;
    this.input.handleInput(data);
    this.dispatch({ type: "composer-changed", value: this.input.getValue() });
  }

  render(width: number): string[] {
    return [...renderTui(this.state, { columns: width, rows: this.rows }, this.theme)];
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private intentApplies(intent: ReturnType<typeof intentFromInput>): boolean {
    if (intent === undefined) return false;
    if (intent === "approve" || intent === "deny") return this.state.overlay.kind === "approval";
    if (intent === "move-up" || intent === "move-down") {
      return this.state.overlay.kind === "sessions";
    }
    return true;
  }
}
