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
    run: async () => ({ automations: [], diagnostics: [] }),
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
        return { automations: [], diagnostics: [] };
      }
      return payload;
    },
  };
  const selections = ["＋ Create automation", undefined];
  const inputs = ["kai-weather", "Kai weather"];
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
