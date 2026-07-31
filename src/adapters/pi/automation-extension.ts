import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const AutomationId = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});
const AutomationSchedule = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("cron"),
      expression: Type.String({ minLength: 1 }),
      timezone: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("at"), instant: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("every"), seconds: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
]);
const AutomationInputFields = {
  id: AutomationId,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  enabled: Type.Boolean(),
  gate: Type.Optional(Type.String({ minLength: 1 })),
  telegramChat: Type.Optional(Type.Integer()),
  discordChannel: Type.Optional(Type.String({ minLength: 1 })),
  slackChannel: Type.Optional(Type.String({ minLength: 1 })),
  schedule: Type.Optional(AutomationSchedule),
  prompt: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
};
const AutomationInput = Type.Object(AutomationInputFields, {
  additionalProperties: false,
});
const RemoveInput = Type.Object({ id: AutomationId }, { additionalProperties: false });
const AutomationRecord = Type.Object(
  { ...AutomationInputFields, version: Type.Literal(1) },
  { additionalProperties: false },
);
const DeliveryOutcome = Type.Object({
  target: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("unknown"),
    Type.Literal("skipped"),
  ]),
  finishedAt: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
const RunReceipt = Type.Object({
  version: Type.Literal(1),
  runId: Type.String(),
  automationId: Type.String(),
  trigger: Type.Union([Type.Literal("manual"), Type.Literal("scheduled")]),
  scheduledInstant: Type.Optional(Type.String()),
  firingId: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("interrupted"),
    Type.Literal("unknown"),
    Type.Literal("skipped"),
  ]),
  claimedAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.String()),
  sessionPath: Type.Optional(Type.String()),
  localOutput: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  deliveries: Type.Array(DeliveryOutcome),
});
const RunHistory = Type.Array(RunReceipt);
const Inventory = Type.Object({
  automations: Type.Array(AutomationRecord),
  latestRuns: Type.Array(RunReceipt),
  nextRuns: Type.Array(
    Type.Object({ automationId: Type.String(), instant: Type.String() }),
  ),
  scheduler: Type.Object({
    online: Type.Boolean(),
    heartbeatAt: Type.Optional(Type.String()),
  }),
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
type AutomationRunReceipt = Static<typeof RunReceipt>;
type AutomationAction = "list" | "create" | "update" | "remove" | "run" | "history";

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
        : [
            action === "remove" || action === "run" || action === "history"
              ? String(payload)
              : JSON.stringify(payload),
          ]),
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

const requireRunReceipt = (value: unknown): AutomationRunReceipt => {
  if (!Check(RunReceipt, value)) {
    throw new Error("Ziggy returned an invalid automation run receipt");
  }
  return value;
};

const requireRunHistory = (value: unknown): ReadonlyArray<AutomationRunReceipt> => {
  if (!Check(RunHistory, value)) {
    throw new Error("Ziggy returned invalid automation run history");
  }
  return value;
};

const receiptMarkdown = (receipt: AutomationRunReceipt): string =>
  [
    "---",
    "version: 1",
    `run-id: ${receipt.runId}`,
    `automation-id: ${receipt.automationId}`,
    `trigger: ${receipt.trigger}`,
    `status: ${receipt.status}`,
    `claimed-at: ${receipt.claimedAt}`,
    ...(receipt.startedAt === undefined ? [] : [`started-at: ${receipt.startedAt}`]),
    ...(receipt.finishedAt === undefined ? [] : [`finished-at: ${receipt.finishedAt}`]),
    ...(receipt.error === undefined ? [] : [`error: ${JSON.stringify(receipt.error)}`]),
    `deliveries: ${JSON.stringify(receipt.deliveries)}`,
    "---",
    "",
    receipt.localOutput ?? "",
  ].join("\n");

const scheduleText = (schedule: Automation["schedule"]): string => {
  if (schedule === undefined) return "";
  switch (schedule.kind) {
    case "cron":
      return `cron:${schedule.expression}`;
    case "at":
      return `at:${schedule.instant}`;
    case "every":
      return `every:${schedule.seconds}`;
  }
};

const promptForAutomation = async (
  context: {
    readonly ui: {
      input(title: string, placeholder?: string): Promise<string | undefined>;
      editor(title: string, prefill?: string): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
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
  const scheduleSource = await context.ui.input(
    "Schedule (blank, cron:, at:, or every:seconds)",
    scheduleText(current?.schedule),
  );
  if (scheduleSource === undefined) return undefined;
  const trimmedSchedule = scheduleSource.trim();
  let schedule: Automation["schedule"];
  if (trimmedSchedule.startsWith("cron:")) {
    const expression = trimmedSchedule.slice("cron:".length).trim();
    const timezone = await context.ui.input(
      "Cron timezone",
      current?.schedule?.kind === "cron"
        ? current.schedule.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (timezone === undefined) return undefined;
    schedule = { kind: "cron", expression, timezone: timezone.trim() };
  } else if (trimmedSchedule.startsWith("at:")) {
    schedule = { kind: "at", instant: trimmedSchedule.slice("at:".length).trim() };
  } else if (trimmedSchedule.startsWith("every:")) {
    schedule = {
      kind: "every",
      seconds: Number(trimmedSchedule.slice("every:".length).trim()),
    };
  } else if (trimmedSchedule.length > 0) {
    context.ui.notify("Schedule must be blank, cron:, at:, or every:seconds", "error");
    return undefined;
  }
  const telegramSource = await context.ui.input(
    "Telegram chat ID (blank for none)",
    current?.telegramChat?.toString() ?? "",
  );
  if (telegramSource === undefined) return undefined;
  const discordChannel = await context.ui.input(
    "Discord channel ID (blank for none)",
    current?.discordChannel ?? "",
  );
  if (discordChannel === undefined) return undefined;
  const slackChannel = await context.ui.input(
    "Slack channel ID (blank for none)",
    current?.slackChannel ?? "",
  );
  if (slackChannel === undefined) return undefined;
  return {
    id: id.trim(),
    name,
    enabled: current?.enabled ?? true,
    prompt: prompt.trim(),
    ...(schedule === undefined ? {} : { schedule }),
    ...(current?.gate === undefined ? {} : { gate: current.gate }),
    ...(telegramSource.trim().length === 0
      ? {}
      : { telegramChat: Number(telegramSource.trim()) }),
    ...(discordChannel.trim().length === 0
      ? {}
      : { discordChannel: discordChannel.trim() }),
    ...(slackChannel.trim().length === 0 ? {} : { slackChannel: slackChannel.trim() }),
  };
};

const automationLabel = (
  automation: Automation,
  inventory: AutomationInventory,
): string => {
  const last = inventory.latestRuns.find((run) => run.automationId === automation.id);
  const next = inventory.nextRuns.find((run) => run.automationId === automation.id);
  return [
    `${automation.enabled ? "●" : "○"} ${automation.name}  (${automation.id})`,
    ...(last === undefined ? [] : [`last ${last.status} ${last.finishedAt ?? last.claimedAt}`]),
    ...(next === undefined ? [] : [`next ${next.instant}`]),
  ].join(" · ");
};

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
    const selected = await context.ui.select(
      `Automations · scheduler ${inventory.scheduler.online ? "online" : "offline"}`,
      [
        createLabel,
        ...inventory.automations.map((automation) => automationLabel(automation, inventory)),
      ],
    );
    if (selected === undefined) return;

    if (selected === createLabel) {
      const created = await promptForAutomation(context);
      if (created !== undefined) {
        await cli.run("create", created);
        context.ui.notify(`Created ${created.id}`, "info");
      }
      continue;
    }

    const automation = inventory.automations.find(
      (item) => automationLabel(item, inventory) === selected,
    );
    if (automation === undefined) continue;
    const action = await context.ui.select(automation.name, [
      "View Markdown",
      "Run now",
      "Run history",
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
        ...(automation.discordChannel === undefined
          ? []
          : [`discord-channel: ${automation.discordChannel}`]),
        ...(automation.slackChannel === undefined
          ? []
          : [`slack-channel: ${automation.slackChannel}`]),
        ...(automation.schedule === undefined
          ? []
          : automation.schedule.kind === "cron"
            ? [
                `schedule: cron:${automation.schedule.expression}`,
                `timezone: ${automation.schedule.timezone}`,
              ]
            : automation.schedule.kind === "at"
              ? [`schedule: at:${automation.schedule.instant}`]
              : [`schedule: every:${automation.schedule.seconds}`]),
        "---",
        "",
        automation.prompt,
      ];
      await context.ui.editor(`${automation.id}.md (read-only; changes ignored)`, lines.join("\n"));
    } else if (action === "Run now") {
      const receipt = requireRunReceipt(await cli.run("run", automation.id));
      context.ui.notify(
        `${automation.id} ${receipt.status}${receipt.deliveries.some((item) => item.status === "failed") ? " with delivery failures" : ""}`,
        receipt.status === "succeeded" ? "info" : "warning",
      );
    } else if (action === "Run history") {
      const receipts = requireRunHistory(await cli.run("history", automation.id));
      if (receipts.length === 0) {
        context.ui.notify(`No runs yet for ${automation.id}`, "info");
        continue;
      }
      const labels = receipts.map(
        (receipt) =>
          `${receipt.status} · ${receipt.finishedAt ?? receipt.claimedAt} · ${receipt.trigger}`,
      );
      const selectedReceipt = await context.ui.select("Run history", labels);
      const selectedIndex =
        selectedReceipt === undefined ? -1 : labels.indexOf(selectedReceipt);
      const receipt = receipts[selectedIndex];
      if (receipt !== undefined) {
        await context.ui.editor(
          `${receipt.runId}.md (read-only; changes ignored)`,
          receiptMarkdown(receipt),
        );
      }
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
        ...(automation.discordChannel === undefined
          ? {}
          : { discordChannel: automation.discordChannel }),
        ...(automation.slackChannel === undefined
          ? {}
          : { slackChannel: automation.slackChannel }),
        ...(automation.schedule === undefined ? {} : { schedule: automation.schedule }),
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
      pi.registerTool({
        name: "automation_run",
        label: "automation_run",
        description:
          "Run one Profile-owned automation now and return its durable local receipt.",
        parameters: RemoveInput,
        executionMode: "sequential",
        async execute(_id, { id }) {
          return jsonResult(await cli.run("run", id));
        },
      });
      pi.registerCommand("automations", {
        description: "View and manage this Profile's automations",
        handler: async (_args, context) => manageAutomations(cli, context),
      });
    },
  }) satisfies InlineExtension;
