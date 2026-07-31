import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const AutomationId = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});
const AutomationInput = Type.Object(
  {
    id: AutomationId,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    enabled: Type.Boolean(),
    gate: Type.Optional(Type.String({ minLength: 1 })),
    telegramChat: Type.Optional(Type.Integer()),
    prompt: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  },
  { additionalProperties: false },
);
const RemoveInput = Type.Object({ id: AutomationId }, { additionalProperties: false });
const AutomationRecord = Type.Intersect([
  AutomationInput,
  Type.Object({ version: Type.Literal(1) }),
]);
const Inventory = Type.Object({
  automations: Type.Array(AutomationRecord),
  diagnostics: Type.Array(
    Type.Object({
      id: Type.String(),
      path: Type.String(),
      message: Type.String(),
    }),
  ),
});

type Automation = Static<typeof AutomationRecord>;
type AutomationWriteInput = Static<typeof AutomationInput>;
type AutomationInventory = Static<typeof Inventory>;
type AutomationAction = "list" | "create" | "update" | "remove";

const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export interface AutomationCli {
  readonly run: (action: AutomationAction, payload?: unknown) => Promise<unknown>;
}

const makeAutomationCli = (repositoryRoot: string, profilePath: string): AutomationCli => ({
  run: async (action, payload) => {
    const command = [
      process.execPath,
      join(repositoryRoot, "src", "main.ts"),
      "automations",
      action,
      profilePath,
      ...(payload === undefined
        ? []
        : [action === "remove" ? String(payload) : JSON.stringify(payload)]),
    ];
    const child = Bun.spawn({
      cmd: command,
      cwd: profilePath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error((stderr || stdout || `automation command exited ${exitCode}`).trim());
    }
    const output = stdout.trim();
    return output.length === 0 ? {} : JSON.parse(output);
  },
});

const requireInventory = (value: unknown): AutomationInventory => {
  if (!Check(Inventory, value)) {
    throw new Error("Ziggy returned an invalid automation inventory");
  }
  return value;
};

const promptForAutomation = async (
  context: {
    readonly ui: {
      input(title: string, placeholder?: string): Promise<string | undefined>;
      editor(title: string, prefill?: string): Promise<string | undefined>;
    };
  },
  current?: Automation,
): Promise<AutomationWriteInput | undefined> => {
  const id =
    current?.id ??
    (await context.ui.input("Automation ID", "lowercase-kebab-case"));
  if (id === undefined) return undefined;
  const nameSource = await context.ui.input("Automation name", current?.name ?? "Daily digest");
  if (nameSource === undefined) return undefined;
  const name = nameSource.trim() || current?.name || "Daily digest";
  const prompt = await context.ui.editor("Automation prompt (Markdown)", current?.prompt ?? "");
  if (prompt === undefined) return undefined;
  return {
    id: id.trim(),
    name,
    enabled: current?.enabled ?? true,
    prompt: prompt.trim(),
    ...(current?.gate === undefined ? {} : { gate: current.gate }),
    ...(current?.telegramChat === undefined ? {} : { telegramChat: current.telegramChat }),
  };
};

const automationLabel = (automation: Automation): string =>
  `${automation.enabled ? "●" : "○"} ${automation.name}  (${automation.id})`;

export const manageAutomations = async (
  cli: AutomationCli,
  context: {
    readonly ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
      input(title: string, placeholder?: string): Promise<string | undefined>;
      editor(title: string, prefill?: string): Promise<string | undefined>;
      confirm(title: string, message: string): Promise<boolean>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  },
): Promise<void> => {
  for (;;) {
    const inventory = requireInventory(await cli.run("list"));
    const createLabel = "＋ Create automation";
    const selected = await context.ui.select("Automations", [
      createLabel,
      ...inventory.automations.map(automationLabel),
    ]);
    if (selected === undefined) return;

    if (selected === createLabel) {
      const created = await promptForAutomation(context);
      if (created !== undefined) {
        await cli.run("create", created);
        context.ui.notify(`Created ${created.id}`, "info");
      }
      continue;
    }

    const automation = inventory.automations.find((item) => automationLabel(item) === selected);
    if (automation === undefined) continue;
    const action = await context.ui.select(automation.name, [
      "View Markdown",
      "Edit",
      automation.enabled ? "Pause" : "Resume",
      "Remove",
    ]);
    if (action === undefined) continue;
    if (action === "View Markdown") {
      const lines = [
        "---",
        `version: 1`,
        `name: ${automation.name}`,
        `enabled: ${automation.enabled}`,
        ...(automation.gate === undefined ? [] : [`gate: ${automation.gate}`]),
        ...(automation.telegramChat === undefined
          ? []
          : [`telegram-chat: ${automation.telegramChat}`]),
        "---",
        "",
        automation.prompt,
      ];
      await context.ui.editor(`${automation.id}.md (read-only; changes ignored)`, lines.join("\n"));
    } else if (action === "Edit") {
      const edited = await promptForAutomation(context, automation);
      if (edited !== undefined) {
        await cli.run("update", edited);
        context.ui.notify(`Updated ${edited.id}`, "info");
      }
    } else if (action === "Pause" || action === "Resume") {
      await cli.run("update", {
        id: automation.id,
        name: automation.name,
        enabled: !automation.enabled,
        prompt: automation.prompt,
        ...(automation.gate === undefined ? {} : { gate: automation.gate }),
        ...(automation.telegramChat === undefined
          ? {}
          : { telegramChat: automation.telegramChat }),
      });
      context.ui.notify(`${automation.id} ${automation.enabled ? "paused" : "resumed"}`, "info");
    } else if (
      action === "Remove" &&
      (await context.ui.confirm("Remove automation?", `Delete automations/${automation.id}.md?`))
    ) {
      await cli.run("remove", automation.id);
      context.ui.notify(`Removed ${automation.id}`, "info");
    }
  }
};

export const createAutomationExtension = (
  profilePath: string,
  repositoryRoot: string,
  cli: AutomationCli = makeAutomationCli(repositoryRoot, profilePath),
) =>
  ({
    name: "ziggy-automations",
    hidden: true,
    factory: (pi) => {
      pi.registerTool({
        name: "automation_list",
        label: "automation_list",
        description:
          "List the Profile's Ziggy automation definitions. Use this immediately for automation questions.",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute() {
          return jsonResult(await cli.run("list"));
        },
      });
      for (const [name, action] of [
        ["automation_create", "create"],
        ["automation_update", "update"],
      ] as const) {
        pi.registerTool({
          name,
          label: name,
          description: `${action === "create" ? "Create" : "Replace"} one Profile-owned Markdown automation definition.`,
          parameters: AutomationInput,
          executionMode: "sequential",
          async execute(_id, parameters) {
            return jsonResult(await cli.run(action, parameters));
          },
        });
      }
      pi.registerTool({
        name: "automation_remove",
        label: "automation_remove",
        description: "Remove one Profile-owned automation definition.",
        parameters: RemoveInput,
        executionMode: "sequential",
        async execute(_id, { id }) {
          return jsonResult(await cli.run("remove", id));
        },
      });
      pi.registerCommand("automations", {
        description: "View and manage this Profile's automations",
        handler: async (_args, context) => manageAutomations(cli, context),
      });
    },
  }) satisfies InlineExtension;
