import { describe, expect, it } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutomationAuthoringTool,
  makeAutomationAuthoring,
  parseAutomationDefinition,
  type AutomationAuthoringService,
  type AutomationPublicationPoint,
} from "../../packages/core/src/index.ts";
import { runEffect } from "../testkit/effect.ts";

const PROMPT = `---
version: 1
type: prompt
trigger:
  schedule: "0 9 * * 1-5"
---
Summarize today's inbox.
`;

const UPDATED_PROMPT = `---
version: 1
type: prompt
trigger:
  schedule: "30 9 * * 1-5"
---
Summarize today's priority inbox.
`;

const DIRECT_EDIT = `---
version: 1
type: no_agent
trigger:
  webhook:
    name: owner-hook
    token: owner-secret
---
./scripts/owner-edit.sh
`;

describe("Automation definition boundary", () => {
  it("parses strict prompt and no_agent definitions", async () => {
    await expect(runEffect(parseAutomationDefinition("daily-inbox", PROMPT))).resolves.toEqual({
      id: "daily-inbox",
      version: 1,
      type: "prompt",
      trigger: { schedule: "0 9 * * 1-5" },
      body: "Summarize today's inbox.\n",
    });
    await expect(
      runEffect(parseAutomationDefinition("owner-hook", DIRECT_EDIT)),
    ).resolves.toMatchObject({
      id: "owner-hook",
      type: "no_agent",
      trigger: { webhook: { name: "owner-hook", token: "owner-secret" } },
      body: "./scripts/owner-edit.sh\n",
    });
  });

  it("fails loud for invalid ids, unknown fields, invalid triggers, and unsupported versions", async () => {
    await expect(runEffect(parseAutomationDefinition("../escape", PROMPT))).rejects.toMatchObject({
      _tag: "AutomationDefinitionError",
      code: "invalid-id",
    });
    await expect(
      runEffect(
        parseAutomationDefinition(
          "daily-inbox",
          PROMPT.replace("type: prompt", "type: prompt\nextra: true"),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AutomationDefinitionError",
      code: "invalid-frontmatter",
    });
    await expect(
      runEffect(
        parseAutomationDefinition("daily-inbox", PROMPT.replace("0 9 * * 1-5", "99 9 * * 1-5")),
      ),
    ).rejects.toMatchObject({
      _tag: "AutomationDefinitionError",
      code: "invalid-frontmatter",
    });
    await expect(
      runEffect(
        parseAutomationDefinition("daily-inbox", PROMPT.replace("version: 1", "version: 2")),
      ),
    ).rejects.toMatchObject({
      _tag: "AutomationDefinitionError",
      code: "unsupported-version",
    });
    await expect(
      runEffect(
        parseAutomationDefinition(
          "daily-inbox",
          PROMPT.replace("version: 1", "version: 1\nversion: 1"),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AutomationDefinitionError",
      code: "invalid-frontmatter",
    });
  });
});

describe("Automation authoring service", () => {
  it("atomically creates, lists, inspects, updates, and deletes the sole markdown authority", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      expect(created.content).toBe(PROMPT);
      expect(await readFile(automationPath(profile), "utf8")).toBe(PROMPT);
      expect(await runEffect(service.list())).toEqual([created]);
      expect(await runEffect(service.inspect("daily-inbox"))).toEqual(created);

      const updated = await runEffect(
        service.update({
          id: "daily-inbox",
          content: UPDATED_PROMPT,
          expectedRevision: created.revision,
        }),
      );
      expect(updated.revision).not.toBe(created.revision);
      expect(await readFile(automationPath(profile), "utf8")).toBe(UPDATED_PROMPT);

      await runEffect(service.delete({ id: "daily-inbox", expectedRevision: updated.revision }));
      expect(await readdir(join(profile, "automations"))).toEqual([]);
    }));

  it("rejects stale expected-current revisions", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      await writeFile(automationPath(profile), DIRECT_EDIT);

      await expect(
        runEffect(
          service.update({
            id: "daily-inbox",
            content: UPDATED_PROMPT,
            expectedRevision: created.revision,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "AutomationAuthoringError", code: "conflict" });
      await expect(
        runEffect(service.delete({ id: "daily-inbox", expectedRevision: created.revision })),
      ).rejects.toMatchObject({ _tag: "AutomationAuthoringError", code: "conflict" });
      expect(await readFile(automationPath(profile), "utf8")).toBe(DIRECT_EDIT);
    }));

  it("validates complete proposals before changing any file", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const invalid = PROMPT.replace("type: prompt", "type: unknown");
      await expect(
        runEffect(service.create({ id: "invalid", content: invalid })),
      ).rejects.toMatchObject({ code: "invalid-definition" });
      await expect(readdir(join(profile, "automations"))).rejects.toMatchObject({ code: "ENOENT" });

      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      await expect(
        runEffect(
          service.update({
            id: "daily-inbox",
            content: invalid,
            expectedRevision: created.revision,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid-definition" });
      expect(await readFile(automationPath(profile), "utf8")).toBe(PROMPT);
    }));

  it("preserves a concurrent direct owner edit instead of overwriting it", () =>
    withProfile(async (profile) => {
      let armed = false;
      const service = await makeService(profile, (point) => {
        if (armed && point === "after-expected-read") {
          armed = false;
          writeFileSync(automationPath(profile), DIRECT_EDIT);
        }
      });
      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      armed = true;

      await expect(
        runEffect(
          service.update({
            id: "daily-inbox",
            content: UPDATED_PROMPT,
            expectedRevision: created.revision,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "AutomationAuthoringError", code: "conflict" });
      expect(await readFile(automationPath(profile), "utf8")).toBe(DIRECT_EDIT);
    }));

  it("never publishes partial content when publication fails after the temporary write", () =>
    withProfile(async (profile) => {
      let failPublication = false;
      const service = await makeService(profile, (point) => {
        if (failPublication && point === "after-temporary-write") {
          throw new Error("injected publication failure");
        }
      });
      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      failPublication = true;

      await expect(
        runEffect(
          service.update({
            id: "daily-inbox",
            content: UPDATED_PROMPT,
            expectedRevision: created.revision,
          }),
        ),
      ).rejects.toMatchObject({ code: "operation-failed" });
      expect(await readFile(automationPath(profile), "utf8")).toBe(PROMPT);
      expect(await readdir(join(profile, "automations"))).toEqual(["daily-inbox.md"]);
    }));

  it("never publishes temporary bytes changed after validation", () =>
    withProfile(async (profile) => {
      let mutatePublication = false;
      const service = await makeService(profile, (point) => {
        if (mutatePublication && point === "after-temporary-write") {
          mutatePublication = false;
          writeFileSync(temporaryAutomationPath(profile), "unvalidated temporary bytes");
        }
      });
      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      mutatePublication = true;

      await expect(
        runEffect(
          service.update({
            id: "daily-inbox",
            content: UPDATED_PROMPT,
            expectedRevision: created.revision,
          }),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await readFile(automationPath(profile), "utf8")).toBe(PROMPT);
      expect(await readdir(join(profile, "automations"))).toEqual(["daily-inbox.md"]);
    }));

  it("rejects lossy UTF-16 proposals before create or update publication", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const lossy = PROMPT.replace("today's", "today\ud800s");
      await expect(
        runEffect(service.create({ id: "lossy", content: lossy })),
      ).rejects.toMatchObject({ code: "invalid-definition" });
      await expect(readdir(join(profile, "automations"))).rejects.toMatchObject({ code: "ENOENT" });

      const created = await runEffect(service.create({ id: "daily-inbox", content: PROMPT }));
      await expect(
        runEffect(
          service.update({
            id: "daily-inbox",
            content: lossy,
            expectedRevision: created.revision,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid-definition" });
      expect(await readFile(automationPath(profile), "utf8")).toBe(PROMPT);
    }));

  it("exposes validated authoring through a Session Tool without filesystem parameters", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const tool = createAutomationAuthoringTool(service);
      const created = await runEffect(
        tool.execute(toolInput({ action: "create", id: "daily-inbox", content: PROMPT })),
      );
      expect(created).toMatchObject({ success: true });

      const rejected = await runEffect(
        tool.execute(toolInput({ action: "list", path: "/tmp/not-allowed" })),
      );
      expect(rejected).toMatchObject({ success: false });
      expect(tool.inputSchema).not.toHaveProperty("properties.path");
    }));

  it("refuses Automation symlinks instead of exposing arbitrary files through inspect", () =>
    withProfile(async (profile) => {
      const outside = join(profile, "outside.md");
      await writeFile(outside, PROMPT);
      await mkdir(join(profile, "automations"));
      await symlink(outside, automationPath(profile));
      const service = await makeService(profile);

      await expect(runEffect(service.inspect("daily-inbox"))).rejects.toMatchObject({
        _tag: "AutomationAuthoringError",
        code: "operation-failed",
      });
    }));

  it("fails loud on malformed UTF-8 direct edits instead of hashing lossy text", () =>
    withProfile(async (profile) => {
      await mkdir(join(profile, "automations"));
      await writeFile(automationPath(profile), new Uint8Array([0xff, 0xfe, 0xfd]));
      const service = await makeService(profile);

      await expect(runEffect(service.inspect("daily-inbox"))).rejects.toMatchObject({
        _tag: "AutomationAuthoringError",
        code: "invalid-definition",
      });
      await expect(runEffect(service.list())).rejects.toMatchObject({
        _tag: "AutomationAuthoringError",
        code: "invalid-definition",
      });
    }));
});

function automationPath(profile: string): string {
  return join(profile, "automations", "daily-inbox.md");
}

function temporaryAutomationPath(profile: string): string {
  const directory = join(profile, "automations");
  const temporary = readdirSync(directory).find((name) => name.startsWith(".daily-inbox.md."));
  if (temporary === undefined) throw new Error("Expected Automation temporary file");
  return join(directory, temporary);
}

function makeService(
  profilePath: string,
  onPublicationPoint?: (point: AutomationPublicationPoint) => void,
): Promise<AutomationAuthoringService> {
  return runEffect(
    makeAutomationAuthoring({
      profilePath,
      ...(onPublicationPoint === undefined ? {} : { nodeHooks: { onPublicationPoint } }),
    }),
  );
}

function toolInput(input: Record<string, string>) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    stepId: "step-1",
    toolCallId: "tool-call-1",
    toolName: "automations",
    input,
    signal: new AbortController().signal,
  };
}

async function withProfile(run: (profile: string) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "ziggy-automation-"));
  try {
    await run(profile);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
