// oxlint-disable ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion, ziggy/no-chained-type-assertions -- Pi extension factory handlers are registered through untyped test doubles; assertions bridge Pi's event-specific handler overloads.
import { describe, expect, test } from "bun:test";
import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  InputEvent,
  KeybindingsManager,
  SessionInfoChangedEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type {
  AutomationTuiDispatch,
  AutomationTuiRequest,
  AutomationTuiResponse,
} from "./automation-tui";
import type { ProfileExtensionSelectionRunner } from "./profile-extension-selection";
import {
  createProfileAgentGuidanceExtension,
  createZiggyTuiExtension,
} from "./ziggy-tui-extension";

type Extension = ReturnType<typeof createZiggyTuiExtension>;
type ExtensionApi = Parameters<Extension["factory"]>[0];
type TestProvider = AutocompleteProvider;
type Ui = {
  setTitle(title: string): void;
  setHeader(factory: () => { invalidate(): void; render(width: number): string[] }): void;
  setFooter(factory: () => { invalidate(): void; render(width: number): string[] }): void;
  addAutocompleteProvider(factory: (current: TestProvider) => TestProvider): void;
};

const emptySystemPromptOptions = { cwd: "/profiles/ziggy-dev" } satisfies BuildSystemPromptOptions;

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

const commandUi = (harness: ReturnType<typeof createHarness>) => ({
  notify: (message: string) => harness.notifications.push(message),
  select: async (_title: string, _options: string[]) => undefined,
  confirm: async (_title: string, _message: string) => false,
  editor: async (_title: string, _prefilled: string) => undefined,
});

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
      ui: commandUi(harness),
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
      ui: commandUi(harness),
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
      ui: commandUi(harness),
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
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
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
        systemPromptOptions: emptySystemPromptOptions,
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
          systemPromptOptions: emptySystemPromptOptions,
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
          systemPromptOptions: emptySystemPromptOptions,
        },
        { mode: "print" },
      ).systemPrompt,
    ).toContain("agent_discuss");
  });

  test("saves one complete extension checklist from the TUI", async () => {
    const setCalls: Array<ReadonlyArray<string>> = [];
    const runner: ProfileExtensionSelectionRunner = {
      list: () =>
        Promise.resolve({
          available: [
            {
              id: "alpha",
              description: "Alpha extension",
              kind: "skill",
              source: "bundled",
            },
            {
              id: "beta",
              description: "Beta extension",
              kind: "skill+code",
              source: "remote-approved",
            },
          ],
          selected: ["alpha"],
        }),
      setSelected: (ids) => {
        setCalls.push(ids);
        return Promise.resolve({ changed: true, selected: [...ids] });
      },
    };
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", [], runner);
    const harness = createHarness();
    extension.factory({
      on: () => undefined,
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });
    const command = harness.commands.find(({ name }) => name === "extensions");
    if (command === undefined) throw new Error("extensions command missing");

    await command.options.handler("", {
      mode: "tui",
      ui: {
        ...commandUi(harness),
        custom: async <Result>(
          _factory: (
            _tui: { requestRender(): void },
            _theme: {
              fg(_color: "accent" | "muted" | "text" | "dim", text: string): string;
              bold(text: string): string;
            },
            _keybindings: KeybindingsManager,
            _done: (result: Result) => void,
          ) => { invalidate(): void; render(_width: number): string[] },
        ): Promise<Result> => ["alpha", "beta"] as Result,
      },
    });

    expect(setCalls).toEqual([["alpha", "beta"]]);
    expect(harness.notifications).toEqual([
      "Saved 2 optional extensions. Reopen this Profile to apply the change.",
    ]);
  });

  test("manages definitions, validated edits, scheduler status, and run history", async () => {
    const requests: Array<AutomationTuiRequest> = [];
    const source =
      "---\nversion: 1\ncron: 0 9 * * *\ntimezone: UTC\nbroadcast: none\n---\n\nOld task.\n";
    const edited = source.replace("Old task.", "New task.");
    let overviewCount = 0;
    const dispatch: AutomationTuiDispatch = (request) => {
      requests.push(request);
      let response: AutomationTuiResponse;
      switch (request.kind) {
        case "overview":
          overviewCount += 1;
          response = {
            kind: "overview",
            definitions: [
              {
                id: "daily",
                path: "automations/daily.md",
                valid: true,
                lifecycle: "active",
                schedule: "0 9 * * *",
                timezone: "UTC",
                gateState: "manual-only",
              },
            ],
            statusText: "scheduler: active\nnext due: tomorrow (daily)",
          };
          break;
        case "document":
          response = {
            kind: "document",
            id: "daily",
            path: "automations/daily.md",
            lifecycle: "active",
            source,
          };
          break;
        case "save":
          response = {
            kind: "saved",
            id: "daily",
            path: "automations/daily.md",
            lifecycle: "active",
            source: request.source,
          };
          break;
        case "runs":
          response =
            request.id === undefined
              ? { kind: "runs", text: "daily completed scheduled" }
              : { kind: "runs", automationId: request.id, text: "daily completed scheduled" };
          break;
        case "pause":
        case "resume":
          response = {
            kind: "transitioned",
            id: request.id,
            path: `automations/daily${request.kind === "pause" ? ".paused" : ""}.md`,
            lifecycle: request.kind === "pause" ? "paused" : "active",
          };
          break;
      }
      return Promise.resolve(response);
    };
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", [], undefined, dispatch);
    const harness = createHarness();
    extension.factory({
      on: () => undefined,
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });
    const command = harness.commands.find(({ name }) => name === "automations");
    if (command === undefined) throw new Error("automations command missing");
    const selections = ["View details", "Run history", "Edit Markdown", "Scheduler overview"];

    await command.options.handler("daily", {
      mode: "tui",
      ui: {
        notify: (message) => harness.notifications.push(message),
        select: async () => selections.shift(),
        confirm: async () => true,
        editor: async () => edited,
      },
    });

    expect(overviewCount).toBe(3);
    expect(requests).toEqual([
      { kind: "overview" },
      { kind: "runs", id: "daily" },
      { kind: "document", id: "daily" },
      { kind: "save", id: "daily", expectedSource: source, source: edited },
      { kind: "overview" },
      { kind: "overview" },
    ]);
    expect(harness.notifications).toEqual([
      "Automation: daily\nLifecycle: active\nDefinition: valid\nSchedule: 0 9 * * *\nTimezone: UTC\nGate: manual-only\nFile: automations/daily.md",
      "daily completed scheduled",
      "Saved daily at automations/daily.md.",
      "scheduler: active\nnext due: tomorrow (daily)",
    ]);
  });

  test("keeps the TUI-only agents command when a Profile has no selection runner", () => {
    const extension = createZiggyTuiExtension("/profiles/ziggy-dev", []);
    const harness = createHarness();

    extension.factory({
      on: () => undefined,
      registerCommand: (name, options) => harness.commands.push({ name, options }),
    });

    expect(harness.commands.map((command) => command.name)).toEqual(["agents"]);
  });
});
