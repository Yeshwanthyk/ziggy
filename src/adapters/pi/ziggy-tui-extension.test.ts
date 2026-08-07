import { describe, expect, test } from "bun:test";
import type { SessionInfoChangedEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createZiggyTuiExtension } from "./ziggy-tui-extension";

type Extension = ReturnType<typeof createZiggyTuiExtension>;
type ExtensionApi = Parameters<Extension["factory"]>[0];
type SessionStartHandler = Parameters<ExtensionApi["on"]>[1];
type Ui = Parameters<SessionStartHandler>[1]["ui"];

const sessionStartEvent: SessionStartEvent = {
  type: "session_start",
  reason: "startup",
};
const sessionInfoChangedEvent: SessionInfoChangedEvent = {
  type: "session_info_changed",
  name: "renamed",
};

const createHarness = () => {
  type HeaderFactory = Parameters<Ui["setHeader"]>[0];
  type FooterFactory = Parameters<Ui["setFooter"]>[0];

  const titles: Array<string> = [];
  const headers: Array<HeaderFactory> = [];
  const footers: Array<FooterFactory> = [];
  type RegisterCommand = ExtensionApi["registerCommand"];
  type CommandOptions = Parameters<RegisterCommand>[1];
  const notifications: Array<string> = [];
  const commands: Array<{ readonly name: string; readonly options: CommandOptions }> = [];

  const ui: Ui = {
    setTitle: (title) => titles.push(title),
    setHeader: (factory) => headers.push(factory),
    setFooter: (factory) => footers.push(factory),
  };

  return { commands, footers, headers, notifications, titles, ui };
};

describe("Ziggy TUI extension", () => {
  test("applies the profile title, header, and footer in TUI mode", async () => {
    const profilePath = "/profiles/ziggy-dev";
    const extension = createZiggyTuiExtension(profilePath);
    const harness = createHarness();
    let sessionStart: Parameters<Parameters<typeof extension.factory>[0]["on"]>[1] | undefined;
    let sessionInfoChanged:
      | Parameters<Parameters<typeof extension.factory>[0]["on"]>[1]
      | undefined;

    extension.factory({
      on: (event, registeredHandler) => {
        if (event === "session_start") {
          sessionStart = registeredHandler;
        } else {
          sessionInfoChanged = registeredHandler;
        }
      },
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });

    if (sessionStart === undefined || sessionInfoChanged === undefined) {
      throw new Error("session_start handler was not registered");
    }

    sessionStart(sessionStartEvent, { mode: "tui", ui: harness.ui });
    await Bun.sleep(1);

    expect(harness.titles).toEqual(["Ziggy — ziggy-dev"]);
    expect(harness.headers).toHaveLength(1);
    expect(harness.footers).toHaveLength(1);
    expect(harness.headers[0]?.().render(80)).toEqual(["Ziggy · ziggy-dev"]);
    expect(harness.footers[0]?.().render(80)).toEqual([`Profile · ${profilePath}`]);
    expect(harness.commands.map((command) => command.name)).toEqual(["agents"]);

    await harness.commands[0]?.options.handler("", {
      mode: "tui",
      ui: { notify: (message) => harness.notifications.push(message) },
    });
    expect(harness.notifications).toEqual(["No Profile agents found."]);

    sessionInfoChanged(sessionInfoChangedEvent, { mode: "tui", ui: harness.ui });
    await Bun.sleep(1);
    expect(harness.titles).toEqual(["Ziggy — ziggy-dev", "Ziggy — ziggy-dev"]);
  });

  test("does nothing outside TUI mode", async () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev");
    const harness = createHarness();
    const handlers: Array<Parameters<Parameters<typeof extension.factory>[0]["on"]>[1]> = [];

    extension.factory({
      on: (_event, registeredHandler) => {
        handlers.push(registeredHandler);
      },
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });

    if (handlers.length !== 2) {
      throw new Error("TUI lifecycle handlers were not registered");
    }

    handlers[0]?.(sessionStartEvent, { mode: "print", ui: harness.ui });
    handlers[1]?.(sessionInfoChangedEvent, { mode: "print", ui: harness.ui });
    await Bun.sleep(1);

    await harness.commands[0]?.options.handler("", {
      mode: "print",
      ui: { notify: (message) => harness.notifications.push(message) },
    });

    expect(harness).toMatchObject({
      footers: [],
      headers: [],
      titles: [],
      notifications: [],
    });
  });

  test("lists discovered Profile agents only in TUI mode", async () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", [
      {
        id: "research-helper",
        version: 1,
        description: "Researches carefully",
        body: "Research instructions",
      },
    ]);
    const harness = createHarness();

    extension.factory({
      on: () => undefined,
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });

    await harness.commands[0]?.options.handler("", {
      mode: "tui",
      ui: { notify: (message) => harness.notifications.push(message) },
    });

    expect(harness.notifications).toEqual([
      "Profile agents:\n- research-helper — Researches carefully",
    ]);
  });

  test("does not register Profile specialist commands when specialist admission is disabled", () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", [], false);
    const harness = createHarness();

    extension.factory({
      on: () => undefined,
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });

    expect(harness.commands).toEqual([]);
  });
});
