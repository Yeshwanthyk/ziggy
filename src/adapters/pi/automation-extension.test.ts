import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAutomationExtension,
  manageAutomations,
  type AutomationCli,
} from "./automation-extension";

const temporaryPaths: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("automation tools are active without Profile-installed extensions", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-automation-extension-"));
  temporaryPaths.push(profilePath);
  await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
  const cli: AutomationCli = {
    run: async () => ({
      automations: [],
      latestRuns: [],
      nextRuns: [],
      scheduler: { online: false },
      diagnostics: [],
    }),
  };
  const services = await createAgentSessionServices({
    cwd: profilePath,
    agentDir: profilePath,
    resourceLoaderOptions: {
      systemPrompt: join(profilePath, "SOUL.md"),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createAutomationExtension(profilePath, profilePath, cli)],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
  });

  expect(session.getActiveToolNames()).toEqual([
    "read",
    "bash",
    "edit",
    "write",
    "automation_list",
    "automation_create",
    "automation_update",
    "automation_remove",
    "automation_run",
  ]);
  expect(
    services.resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.commands.keys()]),
  ).toEqual(["automations"]);
  session.dispose();
});

test("/automations creates through the same Profile-bound CLI", async () => {
  const calls: Array<{ readonly action: string; readonly payload?: unknown }> = [];
  let listCount = 0;
  const cli: AutomationCli = {
    run: async (action, payload) => {
      calls.push({ action, ...(payload === undefined ? {} : { payload }) });
      if (action === "list") {
        listCount += 1;
        return {
          automations: [],
          latestRuns: [],
          nextRuns: [],
          scheduler: { online: false },
          diagnostics: [],
        };
      }
      return payload;
    },
  };
  const selections = ["＋ Create automation", undefined];
  const inputs = ["kai-weather", "Kai weather", "", "", "", ""];
  await manageAutomations(cli, {
    ui: {
      select: async () => selections.shift(),
      input: async () => inputs.shift(),
      editor: async () => "# Weather\n\nDress Kai.",
      confirm: async () => false,
      notify: () => {},
    },
  });

  expect(listCount).toBe(2);
  expect(calls[1]).toEqual({
    action: "create",
    payload: {
      id: "kai-weather",
      name: "Kai weather",
      enabled: true,
      prompt: "# Weather\n\nDress Kai.",
    },
  });
});

test("/automations runs now through the Profile-bound CLI", async () => {
  const calls: Array<{ readonly action: string; readonly payload?: unknown }> = [];
  const inventory = {
    automations: [
      {
        id: "daily-note",
        name: "Daily note",
        enabled: true,
        prompt: "Write it.",
        version: 1,
      },
    ],
    latestRuns: [],
    nextRuns: [],
    scheduler: { online: false },
    diagnostics: [],
  };
  const receipt = {
    version: 1,
    runId: "run-one",
    automationId: "daily-note",
    trigger: "manual",
    status: "succeeded",
    claimedAt: "2026-07-30T12:00:00.000Z",
    finishedAt: "2026-07-30T12:00:01.000Z",
    localOutput: "done",
    deliveries: [],
  };
  const cli: AutomationCli = {
    run: async (action, payload) => {
      calls.push({ action, ...(payload === undefined ? {} : { payload }) });
      return action === "run" ? receipt : inventory;
    },
  };
  const selections = ["● Daily note  (daily-note)", "Run now", undefined];
  const notifications: Array<string> = [];

  await manageAutomations(cli, {
    ui: {
      select: async () => selections.shift(),
      input: async () => undefined,
      editor: async () => undefined,
      confirm: async () => false,
      notify: (message) => notifications.push(message),
    },
  });

  expect(calls).toContainEqual({ action: "run", payload: "daily-note" });
  expect(notifications).toEqual(["daily-note succeeded"]);
});

test("/automations exposes scheduler start, stop, restart, and status", async () => {
  const calls: Array<{ readonly action: string; readonly payload?: unknown }> = [];
  const inventory = {
    automations: [],
    latestRuns: [],
    nextRuns: [],
    scheduler: { online: false },
    diagnostics: [],
  };
  const cli: AutomationCli = {
    run: async (action, payload) => {
      calls.push({ action, ...(payload === undefined ? {} : { payload }) });
      if (action === "scheduler-status") {
        return {
          backend: "launchd",
          id: "works.earendil.ziggy.scheduler.test",
          artifactPath: "/Users/test/Library/LaunchAgents/test.plist",
          installed: false,
          hostActive: false,
          healthFresh: false,
          diagnostics: [],
        };
      }
      if (action === "scheduler-start") {
        return {
          backend: "launchd",
          id: "works.earendil.ziggy.scheduler.test",
          artifactPath: "/Users/test/Library/LaunchAgents/test.plist",
          changed: true,
        };
      }
      return inventory;
    },
  };
  const selections = [
    "⚙ Scheduler · offline",
    "Start scheduler",
    undefined,
  ];
  const notifications: Array<string> = [];
  const schedulerOptions: Array<string> = [];

  await manageAutomations(cli, {
    ui: {
      select: async (title, options) => {
        if (title.startsWith("Scheduler ·")) schedulerOptions.push(...options);
        return selections.shift();
      },
      input: async () => undefined,
      editor: async () => undefined,
      confirm: async () => false,
      notify: (message) => notifications.push(message),
    },
  });

  expect(calls).toEqual([
    { action: "list" },
    { action: "scheduler-status" },
    { action: "scheduler-start" },
    { action: "list" },
  ]);
  expect(schedulerOptions).toEqual([
    "Start scheduler",
    "Stop scheduler",
    "Restart scheduler",
    "View scheduler status",
  ]);
  expect(notifications).toEqual(["Scheduler started"]);
});
