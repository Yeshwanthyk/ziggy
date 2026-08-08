// oxlint-disable ziggy/no-unsafe-typescript-syntax
import { describe, expect, test } from "bun:test";
import type {
  BeforeAgentStartEvent,
  InputEvent,
  SessionInfoChangedEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createProfileAgentGuidanceExtension,
  createZiggyTuiExtension,
} from "./ziggy-tui-extension";

type Extension = ReturnType<typeof createZiggyTuiExtension>;
type ExtensionApi = Parameters<Extension["factory"]>[0];
type TestProvider = {
  getSuggestions(...args: ReadonlyArray<unknown>): Promise<unknown>;
  applyCompletion(...args: ReadonlyArray<unknown>): unknown;
};
type Ui = {
  setTitle(title: string): void;
  setHeader(factory: () => { invalidate(): void; render(width: number): string[] }): void;
  setFooter(factory: () => { invalidate(): void; render(width: number): string[] }): void;
  addAutocompleteProvider(factory: (current: TestProvider) => TestProvider): void;
};

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
  const autocompleteFactories: Array<Parameters<Ui["addAutocompleteProvider"]>[0]> = [];
  const commands: Array<{ readonly name: string; readonly options: CommandOptions }> = [];

  const ui: Ui = {
    setTitle: (title) => titles.push(title),
    setHeader: (factory) => headers.push(factory),
    setFooter: (factory) => footers.push(factory),
    addAutocompleteProvider: (factory) => autocompleteFactories.push(factory),
  };

  return { autocompleteFactories, commands, footers, headers, notifications, titles, ui };
};

describe("Ziggy TUI extension", () => {
  test("applies the profile title, header, and footer in TUI mode", async () => {
    const profilePath = "/profiles/ziggy-dev";
    const extension = createZiggyTuiExtension(profilePath);
    const harness = createHarness();
    let sessionStart!: (event: SessionStartEvent, context: { mode: "tui"; ui: Ui }) => void;
    let sessionInfoChanged!: (
      event: SessionInfoChangedEvent,
      context: { mode: "tui"; ui: Ui },
    ) => void;

    extension.factory({
      on: (event, registeredHandler) => {
        if (event === "session_start") {
          sessionStart = registeredHandler as typeof sessionStart;
        } else if (event === "session_info_changed") {
          sessionInfoChanged = registeredHandler as typeof sessionInfoChanged;
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
    const handlers: Array<
      (
        event: SessionStartEvent | SessionInfoChangedEvent,
        context: { mode: "print"; ui: Ui },
      ) => void
    > = [];

    extension.factory({
      on: (event, registeredHandler) => {
        if (event === "session_start" || event === "session_info_changed") {
          handlers.push(
            registeredHandler as unknown as (
              event: SessionStartEvent | SessionInfoChangedEvent,
              context: { mode: "print"; ui: Ui },
            ) => void,
          );
        }
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

  test("autocompletes only leading Profile agent ids with descriptions", async () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", [
      { id: "research-helper", version: 1, description: "Researches carefully", body: "" },
      { id: "code-helper", version: 1, description: "Writes code", body: "" },
    ]);
    const harness = createHarness();
    // The provider is installed by the TUI session lifecycle, not at extension load time.
    const sessionHandlers: Array<
      (
        event: SessionStartEvent,
        context: Parameters<Ui["setHeader"]>[0] extends never ? never : { mode: "tui"; ui: Ui },
      ) => void
    > = [];
    extension.factory({
      on: (event, handler) => {
        if (event === "session_start")
          sessionHandlers.push(handler as (typeof sessionHandlers)[number]);
      },
      registerCommand: () => undefined,
    });
    sessionHandlers[0]?.(sessionStartEvent, { mode: "tui", ui: harness.ui });
    const provider = harness.autocompleteFactories[0]?.({
      getSuggestions: async () => ({ items: [], prefix: "" }),
      applyCompletion: (...args: ReadonlyArray<unknown>) => args,
    });
    if (provider === undefined) throw new Error("autocomplete provider was not registered");
    const suggestions = await provider.getSuggestions(["@research"], 0, 9, {
      signal: new AbortController().signal,
    });
    expect(suggestions).toEqual({
      prefix: "@research",
      items: [
        {
          value: "@research-helper",
          label: "@research-helper",
          description: "Researches carefully",
        },
      ],
    });
    expect(
      await provider.getSuggestions(["help @research"], 0, 14, {
        signal: new AbortController().signal,
      }),
    ).toEqual({ items: [], prefix: "" });
  });

  test("rejects unknown leading agents and adds valid selection guidance", () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", [
      { id: "research-helper", version: 1, description: "Researches carefully", body: "" },
    ]);
    const notifications: string[] = [];
    let inputHandler:
      | ((
          event: InputEvent,
          context: {
            mode: "tui";
            ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
          },
        ) => { action: string; text?: string })
      | undefined;
    let beforeStart:
      | ((event: BeforeAgentStartEvent, context: { mode: "tui" }) => { systemPrompt: string })
      | undefined;
    extension.factory({
      on: (event, handler) => {
        if (event === "input") inputHandler = handler as typeof inputHandler;
      },
      registerCommand: () => undefined,
    });
    createProfileAgentGuidanceExtension([
      { id: "research-helper", version: 1, description: "Researches carefully", body: "" },
    ]).factory({
      on: (event, handler) => {
        if (event === "before_agent_start") beforeStart = handler as typeof beforeStart;
      },
      registerCommand: () => undefined,
    });
    if (inputHandler === undefined || beforeStart === undefined)
      throw new Error("handlers missing");
    const context = {
      mode: "tui" as const,
      ui: { notify: (message: string) => notifications.push(message) },
    };
    expect(
      inputHandler({ type: "input", text: "@missing do this", source: "interactive" }, context),
    ).toEqual({ action: "handled" });
    expect(notifications[0]).toContain("Use /agents");
    expect(
      inputHandler({ type: "input", text: "@Missing do this", source: "interactive" }, context),
    ).toEqual({ action: "handled" });
    const transformed = inputHandler(
      { type: "input", text: "@research-helper do this", source: "interactive" },
      context,
    );
    expect(transformed.action).toBe("transform");
    expect(transformed.text).toContain("@research-helper do this");
    expect(transformed.text).toContain("call agent_run");
    const guidance = beforeStart(
      {
        type: "before_agent_start",
        prompt: "task",
        systemPrompt: "base",
        systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
      },
      context,
    );
    expect(JSON.stringify(guidance)).toMatch(/Researches carefully/);
    expect(JSON.stringify(guidance)).toMatch(/one specialist clearly matches/);
    expect(JSON.stringify(guidance)).toMatch(/agent_discuss/);
  });

  test("adds the same specialist guidance outside TUI", () => {
    const extension = createProfileAgentGuidanceExtension([
      { id: "research-helper", version: 1, description: "Researches carefully", body: "" },
    ]);
    let beforeStart:
      | ((event: BeforeAgentStartEvent, context: { mode: "print" }) => { systemPrompt: string })
      | undefined;
    extension.factory({
      on: (event, handler) => {
        if (event === "before_agent_start") beforeStart = handler as typeof beforeStart;
      },
      registerCommand: () => undefined,
    });
    if (beforeStart === undefined) throw new Error("before_agent_start handler missing");
    expect(
      beforeStart(
        {
          type: "before_agent_start",
          prompt: "task",
          systemPrompt: "base",
          systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
        },
        { mode: "print" },
      ).systemPrompt,
    ).toContain("Researches carefully");
    expect(
      beforeStart(
        {
          type: "before_agent_start",
          prompt: "task",
          systemPrompt: "base",
          systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
        },
        { mode: "print" },
      ).systemPrompt,
    ).toContain("agent_discuss");
  });

  test("keeps the TUI-only agents command when a Profile has no agents", () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", []);
    const harness = createHarness();

    extension.factory({
      on: () => undefined,
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });

    expect(harness.commands.map((command) => command.name)).toEqual(["agents"]);
  });
});
