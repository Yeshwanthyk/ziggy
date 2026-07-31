import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfoChangedEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  registerZiggyTui,
  type ResourcesDiscoverHandler,
  type ZiggyCommand,
  type ZiggyTuiExtensionOptions,
  type ZiggyTuiHandler,
  type ZiggyTuiPort,
} from "./ziggy-tui-extension";

const temporaryPaths: Array<string> = [];

type CommandContext = Parameters<ZiggyCommand["handler"]>[1];

interface TextComponent {
  render(width: number): Array<string>;
}

interface LifecycleUi {
  setTitle(title: string): void;
  setHeader(factory: () => TextComponent): void;
  setFooter(factory: () => TextComponent): void;
}

const sessionStartEvent: SessionStartEvent = {
  type: "session_start",
  reason: "startup",
};
const sessionInfoChangedEvent: SessionInfoChangedEvent = {
  type: "session_info_changed",
  name: "renamed",
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

const createExtension = (
  profilePath: string,
  options?: {
    readonly catalogSkillIds?: ReadonlyArray<string>;
    readonly profileSkillsConfiguredAtStartup?: boolean;
    readonly installSkill?: (id: string) => Promise<{ readonly ok: boolean; readonly message: string }>;
  },
) =>
  ({
    profilePath,
    catalogSkillIds: options?.catalogSkillIds ?? [],
    profileSkillsConfiguredAtStartup: options?.profileSkillsConfiguredAtStartup ?? false,
    installSkill:
      options?.installSkill ??
      (() => Promise.resolve({ ok: true, message: "installed" })),
  }) satisfies ZiggyTuiExtensionOptions;

const createHarness = () => {
  const titles: Array<string> = [];
  const headers: Array<() => TextComponent> = [];
  const footers: Array<() => TextComponent> = [];
  const commands = new Map<string, ZiggyCommand>();
  let sessionStart: ZiggyTuiHandler | undefined;
  let sessionInfoChanged: ZiggyTuiHandler | undefined;
  let resourcesDiscover: ResourcesDiscoverHandler | undefined;

  const ui: LifecycleUi = {
    setTitle: (title) => titles.push(title),
    setHeader: (factory) => headers.push(factory),
    setFooter: (factory) => footers.push(factory),
  };
  const port: ZiggyTuiPort = {
    onSessionStart: (handler) => {
      sessionStart = handler;
    },
    onSessionInfoChanged: (handler) => {
      sessionInfoChanged = handler;
    },
    onResourcesDiscover: (handler) => {
      resourcesDiscover = handler;
    },
    registerCommand: (name, command) => {
      commands.set(name, command);
    },
  };

  return {
    commands,
    footers,
    headers,
    port,
    resourcesDiscover: () => resourcesDiscover,
    sessionInfoChanged: () => sessionInfoChanged,
    sessionStart: () => sessionStart,
    titles,
    ui,
  };
};

describe("Ziggy TUI extension", () => {
  test("applies the profile title, header, and footer in TUI mode", async () => {
    const profilePath = "/profiles/ziggy-dev";
    const options = createExtension(profilePath);
    const harness = createHarness();
    registerZiggyTui(harness.port, options);

    const sessionStart = harness.sessionStart();
    const sessionInfoChanged = harness.sessionInfoChanged();
    if (sessionStart === undefined || sessionInfoChanged === undefined) {
      throw new Error("TUI lifecycle handlers were not registered");
    }

    sessionStart(sessionStartEvent, { mode: "tui", ui: harness.ui });
    await Bun.sleep(1);

    expect(harness.titles).toEqual(["Ziggy — ziggy-dev"]);
    expect(harness.headers).toHaveLength(1);
    expect(harness.footers).toHaveLength(1);
    expect(harness.headers[0]?.().render(80)).toEqual(["Ziggy · ziggy-dev"]);
    expect(harness.footers[0]?.().render(80)).toEqual([`Profile · ${profilePath}`]);

    sessionInfoChanged(sessionInfoChangedEvent, { mode: "tui", ui: harness.ui });
    await Bun.sleep(1);
    expect(harness.titles).toEqual(["Ziggy — ziggy-dev", "Ziggy — ziggy-dev"]);
  });

  test("does nothing outside TUI mode", async () => {
    const options = createExtension("/profiles/ziggy-dev");
    const harness = createHarness();
    registerZiggyTui(harness.port, options);

    const sessionStart = harness.sessionStart();
    const sessionInfoChanged = harness.sessionInfoChanged();
    if (sessionStart === undefined || sessionInfoChanged === undefined) {
      throw new Error("TUI lifecycle handlers were not registered");
    }

    sessionStart(sessionStartEvent, { mode: "print", ui: harness.ui });
    sessionInfoChanged(sessionInfoChangedEvent, { mode: "print", ui: harness.ui });
    await Bun.sleep(1);

    expect(harness).toMatchObject({
      footers: [],
      headers: [],
      titles: [],
    });
  });

  test("/skills installs multiple catalog skills and exposes them on one reload", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-tui-skills-"));
    temporaryPaths.push(profilePath);
    const installed: Array<string> = [];
    const options = createExtension(profilePath, {
      catalogSkillIds: ["alpha", "beta"],
      installSkill: async (id) => {
        installed.push(id);
        const destination = join(profilePath, "skills", id);
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "SKILL.md"), `# ${id}\n`, "utf8");
        return { ok: true, message: `installed ${id}` };
      },
    });
    const harness = createHarness();
    registerZiggyTui(harness.port, options);
    const command = harness.commands.get("skills");
    const resourcesDiscover = harness.resourcesDiscover();
    if (command === undefined || resourcesDiscover === undefined) {
      throw new Error("skills command or resources handler was not registered");
    }

    const selections: Array<ReadonlyArray<{ readonly id: string; readonly installed: boolean }>> = [];
    const notifications: Array<string> = [];
    let reloads = 0;
    const context: CommandContext = {
      ui: {
        notify: (message) => notifications.push(message),
        selectSkills: (items) => {
          selections.push(items);
          return Promise.resolve(["alpha", "beta"]);
        },
      },
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    };

    expect(resourcesDiscover({ reason: "startup" })).toBeUndefined();
    await command.handler("", context);

    expect(installed).toEqual(["alpha", "beta"]);
    expect(selections).toEqual([
      [
        { id: "alpha", installed: false },
        { id: "beta", installed: false },
      ],
    ]);
    expect(notifications).toEqual([
      "Installed 2 skills: alpha, beta; reloading Profile skills",
    ]);
    expect(reloads).toBe(1);
    expect(resourcesDiscover({ reason: "reload" })).toEqual({
      skillPaths: [join(profilePath, "skills")],
    });
    expect(command.getArgumentCompletions?.("")).toBeNull();
  });
});
