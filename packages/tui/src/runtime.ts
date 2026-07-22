import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { ZiggyTuiComponent } from "./component.ts";
import type { TuiAction, TuiCommand, TuiState } from "./model.ts";

export interface ZiggyTuiHost {
  readonly dispatch: (action: TuiAction) => void;
  readonly stop: () => void;
}

export function startZiggyTuiHost(options: {
  readonly state: TuiState;
  readonly emit: (command: TuiCommand) => void;
}): ZiggyTuiHost {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const component = new ZiggyTuiComponent({
    state: options.state,
    rows: terminal.rows,
    emit: options.emit,
  });
  tui.addChild(component);
  tui.setFocus(component);
  tui.start();
  return {
    dispatch: (action) => {
      component.setRows(terminal.rows);
      component.dispatch(action);
      tui.requestRender();
    },
    stop: () => tui.stop(),
  };
}
