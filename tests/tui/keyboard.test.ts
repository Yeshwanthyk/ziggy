import { describe, expect, test } from "bun:test";
import { ZiggyTuiComponent, intentFromInput } from "../../packages/tui/src/index.ts";
import { loadedState } from "./fixtures.ts";

describe("TUI keyboard intents", () => {
  test("maps the locked control surface exactly", () => {
    expect([
      intentFromInput("\r"),
      intentFromInput("\x1b\r"),
      intentFromInput("\x1bOQ"),
      intentFromInput("\x18"),
      intentFromInput("\x10"),
      intentFromInput("\x1b"),
      intentFromInput("\x03"),
    ]).toEqual(["enter", "follow-up", "follow-up", "interrupt", "sessions", "dismiss", "detach"]);
  });

  test("keeps ordinary text in the local composer and emits detach for Ctrl+C and quit", () => {
    const commands: unknown[] = [];
    const component = new ZiggyTuiComponent({
      state: loadedState(),
      emit: (command) => commands.push(command),
    });

    component.handleInput("quiet");
    expect(component.currentState.composer).toBe("quiet");
    expect(commands).toEqual([]);

    component.handleInput("\x03");
    component.requestQuit();
    expect(commands).toEqual([{ type: "detach" }, { type: "detach" }]);
  });

  test("Escape dismisses overlays without detaching or mutating the daemon", () => {
    const commands: unknown[] = [];
    const component = new ZiggyTuiComponent({
      state: { ...loadedState(), overlay: { kind: "sessions", selectedIndex: 0 } },
      emit: (command) => commands.push(command),
    });

    component.handleInput("\x1b");

    expect(component.currentState.overlay).toEqual({ kind: "none" });
    expect(commands).toEqual([]);
  });
});
