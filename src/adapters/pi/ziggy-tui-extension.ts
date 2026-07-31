import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  InlineExtension,
  SessionInfoChangedEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  SkillMultiSelectComponent,
  type SkillSelectionItem,
} from "./skill-multi-select";

interface TextComponent {
  invalidate(): void;
  render(width: number): Array<string>;
}

type TextComponentFactory = () => TextComponent;

interface ZiggyTuiContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    setTitle(title: string): void;
    setHeader(factory: TextComponentFactory): void;
    setFooter(factory: TextComponentFactory): void;
  };
}

export interface ZiggyCommandContext {
  readonly ui: {
    readonly notify: (message: string, level?: "info" | "warning" | "error") => void;
    readonly selectSkills: (
      items: ReadonlyArray<SkillSelectionItem>,
    ) => Promise<ReadonlyArray<string> | undefined>;
  };
  readonly reload: () => Promise<void>;
}

export interface ZiggyCommand {
  readonly description: string;
  readonly getArgumentCompletions: (
    argumentPrefix: string,
  ) => Array<{ readonly value: string; readonly label: string }> | null;
  readonly handler: (args: string, context: ZiggyCommandContext) => Promise<void>;
}

type ZiggyTuiEvent = SessionStartEvent | SessionInfoChangedEvent;
export type ZiggyTuiHandler = (event: ZiggyTuiEvent, context: ZiggyTuiContext) => void;

interface ResourcesDiscoverEvent {
  readonly reason: "startup" | "reload";
}

interface ResourcesDiscoverResult {
  readonly skillPaths: Array<string>;
}

export type ResourcesDiscoverHandler = (
  event: ResourcesDiscoverEvent,
) => ResourcesDiscoverResult | undefined;

export interface ZiggyTuiPort {
  onSessionStart(handler: ZiggyTuiHandler): void;
  onSessionInfoChanged(handler: ZiggyTuiHandler): void;
  onResourcesDiscover(handler: ResourcesDiscoverHandler): void;
  registerCommand(name: string, command: ZiggyCommand): void;
}

export interface SkillInstallResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface ZiggyTuiExtensionOptions {
  readonly profilePath: string;
  readonly catalogSkillIds: ReadonlyArray<string>;
  readonly profileSkillsConfiguredAtStartup: boolean;
  readonly installSkill: (id: string) => Promise<SkillInstallResult>;
}

const textComponent = (text: string) => ({
  invalidate: () => {},
  render: (_width: number): Array<string> => [text],
});

export const registerZiggyTui = (
  pi: ZiggyTuiPort,
  {
    profilePath,
    catalogSkillIds,
    profileSkillsConfiguredAtStartup,
    installSkill,
  }: ZiggyTuiExtensionOptions,
): void => {
  const profileName = basename(profilePath);
  const profileSkillsPath = join(profilePath, "skills");
  const isInstalled = (id: string) => existsSync(join(profileSkillsPath, id, "SKILL.md"));
  const availableSkills = () => catalogSkillIds.filter((id) => !isInstalled(id));
  const setTitle = (context: ZiggyTuiContext) => {
    // Pi restores its built-in title after session lifecycle handlers return.
    setTimeout(() => context.ui.setTitle(`Ziggy — ${profileName}`), 0);
  };

  pi.onResourcesDiscover((event) =>
    event.reason === "reload" &&
    !profileSkillsConfiguredAtStartup &&
    existsSync(profileSkillsPath)
      ? { skillPaths: [profileSkillsPath] }
      : undefined,
  );

  pi.onSessionStart((_event, context) => {
    if (context.mode !== "tui") {
      return;
    }

    context.ui.setHeader(() => textComponent(`Ziggy · ${profileName}`));
    context.ui.setFooter(() => textComponent(`Profile · ${profilePath}`));
    setTitle(context);
  });

  pi.onSessionInfoChanged((_event, context) => {
    if (context.mode === "tui") {
      setTitle(context);
    }
  });

  pi.registerCommand("skills", {
    description: "Install skills into this Profile",
    getArgumentCompletions: (argumentPrefix) => {
      const matches = availableSkills()
        .filter((id) => id.startsWith(argumentPrefix))
        .map((id) => ({ value: id, label: id }));
      return matches.length === 0 ? null : matches;
    },
    handler: async (args, context) => {
      const requested = [
        ...new Set(
          args
            .trim()
            .split(/[\s,]+/)
            .filter((id) => id.length > 0),
        ),
      ];
      const selected =
        requested.length > 0
          ? requested
          : await context.ui.selectSkills(
              catalogSkillIds.map((id) => ({ id, installed: isInstalled(id) })),
            );
      if (selected === undefined) {
        return;
      }
      if (selected.length === 0) {
        context.ui.notify("No skills selected", "info");
        return;
      }

      const unknown = selected.filter((id) => !catalogSkillIds.includes(id));
      if (unknown.length > 0) {
        context.ui.notify(`Unknown skills: ${unknown.join(", ")}`, "error");
        return;
      }

      const pending = selected.filter((id) => !isInstalled(id));
      if (pending.length === 0) {
        context.ui.notify("Selected skills are already installed", "info");
        return;
      }

      const installed: Array<string> = [];
      const failures: Array<string> = [];
      for (const id of pending) {
        const result = await installSkill(id);
        if (result.ok) {
          installed.push(id);
        } else {
          failures.push(result.message);
        }
      }

      if (failures.length > 0) {
        context.ui.notify(failures.join("\n"), "error");
      }
      if (installed.length === 0) {
        return;
      }

      context.ui.notify(
        `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"}: ${installed.join(", ")}; reloading Profile skills`,
        "info",
      );
      await context.reload();
    },
  });
};

export const createZiggyTuiExtension = (options: ZiggyTuiExtensionOptions) =>
  ({
    name: "ziggy-tui",
    hidden: true,
    factory: (pi) => {
      registerZiggyTui(
        {
          onSessionStart: (handler) => pi.on("session_start", handler),
          onSessionInfoChanged: (handler) => pi.on("session_info_changed", handler),
          onResourcesDiscover: (handler) =>
            pi.on("resources_discover", (event) => handler(event)),
          registerCommand: (name, command) =>
            pi.registerCommand(name, {
              ...command,
              handler: (args, context) =>
                command.handler(args, {
                  reload: () => context.reload(),
                  ui: {
                    notify: (message, level) => context.ui.notify(message, level),
                    selectSkills: (items) =>
                      context.ui.custom((tui, theme, _keybindings, done) => {
                        return new SkillMultiSelectComponent(
                          items,
                          () => tui.requestRender(),
                          done,
                          {
                            accent: (text) => theme.fg("accent", text),
                            bold: (text) => theme.bold(text),
                            dim: (text) => theme.fg("dim", text),
                            success: (text) => theme.fg("success", text),
                          },
                        );
                      }),
                  },
                }),
            }),
        },
        options,
      );
    },
  }) satisfies InlineExtension;
