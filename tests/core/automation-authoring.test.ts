import { describe, expect, it } from "bun:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { readdirSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("rejects YAML warnings, nested duplicate keys, and nested excess fields", async () => {
    const invalidDefinitions = [
      PROMPT.replace('schedule: "0 9 * * 1-5"', "schedule: !owner 0 9 * * 1-5"),
      PROMPT.replace(
        'schedule: "0 9 * * 1-5"',
        'schedule: "0 9 * * 1-5"\n  schedule: "30 9 * * 1-5"',
      ),
      PROMPT.replace('schedule: "0 9 * * 1-5"', 'schedule: "0 9 * * 1-5"\n  extra: true'),
    ];

    for (const content of invalidDefinitions) {
      await expect(
        runEffect(parseAutomationDefinition("daily-inbox", content)),
      ).rejects.toMatchObject({
        _tag: "AutomationDefinitionError",
        code: "invalid-frontmatter",
      });
    }
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
      expect(await readdir(join(profile, "automations"))).toEqual([]);

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

  it("rolls back atomic create when temporary-link cleanup fails", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile, (point) => {
        if (point === "before-create-temporary-remove") {
          throw new Error("injected temporary unlink failure");
        }
      });

      await expect(
        runEffect(service.create({ id: "daily-inbox", content: PROMPT })),
      ).rejects.toMatchObject({ code: "operation-failed" });
      expect(await readdir(join(profile, "automations"))).toEqual([]);
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
      expect(await readdir(join(profile, "automations"))).toEqual([]);

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

  it("uses one strict action-aware decoder behind a portable root object Tool schema", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const tool = createAutomationAuthoringTool(service);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        required: ["action"],
        properties: {
          action: { enum: ["list", "inspect", "create", "update", "delete"] },
          id: { minLength: 1 },
          content: { minLength: 1 },
          expectedRevision: { pattern: "^[a-fA-F0-9]{64}$" },
        },
      });
      expect(tool.inputSchema).not.toHaveProperty("oneOf");

      const invalidInputs = [
        { action: "inspect" },
        { action: "list", id: "daily-inbox" },
        { action: "create", id: "", content: PROMPT },
        { action: "create", id: "daily-inbox", content: "" },
        { action: "update", id: "daily-inbox", content: PROMPT },
        {
          action: "delete",
          id: "daily-inbox",
          expectedRevision: "g".repeat(64),
        },
        {
          action: "delete",
          id: "daily-inbox",
          content: PROMPT,
          expectedRevision: "a".repeat(64),
        },
      ];
      for (const input of invalidInputs) {
        const result = await runEffect(tool.execute(toolInput(input)));
        expect(result).toMatchObject({ success: false });
      }
    }));

  it("preserves Automation fields through the pinned Anthropic schema conversion", () =>
    withProfile(async (profile) => {
      const service = await makeService(profile);
      const tool = createAutomationAuthoringTool(service);
      const model: Model<"anthropic-messages"> = {
        id: "claude-test",
        name: "Claude Test",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_024,
      };
      const context: Context = {
        messages: [{ role: "user", content: "Update the Automation.", timestamp: 0 }],
        tools: [{ name: tool.name, description: tool.description, parameters: tool.inputSchema }],
      };
      let payload: unknown;
      const result = await stream(model, context, {
        apiKey: "fixture-key",
        cacheRetention: "none",
        onPayload(value) {
          payload = value;
          throw new Error("payload captured");
        },
      }).result();

      expect(result).toMatchObject({ stopReason: "error", errorMessage: "payload captured" });
      expect(payload).toMatchObject({
        tools: [
          {
            name: "automations",
            input_schema: {
              type: "object",
              required: ["action"],
              properties: {
                action: {
                  type: "string",
                  enum: ["list", "inspect", "create", "update", "delete"],
                },
                id: { type: "string", minLength: 1 },
                content: { type: "string", minLength: 1 },
                expectedRevision: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
              },
            },
          },
        ],
      });
    }));

  it("recovers daemon temporary files left before and after atomic create publication", () =>
    withProfile(async (profile) => {
      const directory = join(profile, "automations");
      await mkdir(directory);
      const orphan = temporaryPath(directory, "orphan");
      await writeFile(orphan, PROMPT);
      await makeService(profile);
      expect(await readdir(directory)).toEqual([]);

      const publishedTemporary = temporaryPath(directory, "daily-inbox");
      await writeFile(publishedTemporary, PROMPT);
      await link(publishedTemporary, automationPath(profile));
      const service = await makeService(profile);
      expect(await readdir(directory)).toEqual(["daily-inbox.md"]);
      expect((await runEffect(service.inspect("daily-inbox"))).content).toBe(PROMPT);
    }));

  it("fails closed for hardlinked definitions and suspicious crash artifacts", () =>
    withProfile(async (profile) => {
      const directory = join(profile, "automations");
      await mkdir(directory);
      await writeFile(automationPath(profile), PROMPT);
      await link(automationPath(profile), join(directory, "alias.md"));
      const service = await makeService(profile);
      await expect(runEffect(service.inspect("daily-inbox"))).rejects.toMatchObject({
        code: "operation-failed",
      });
    }).then(() =>
      withProfile(async (profile) => {
        const directory = join(profile, "automations");
        await mkdir(directory);
        const suspicious = temporaryPath(directory, "daily-inbox");
        await writeFile(suspicious, PROMPT);
        await link(suspicious, join(directory, "unrelated-link"));

        await expect(makeService(profile)).rejects.toMatchObject({ code: "operation-failed" });
        expect((await readdir(directory)).toSorted()).toEqual(
          ["unrelated-link", suspicious.slice(directory.length + 1)].toSorted(),
        );
      }),
    ));

  it("does not clean up symlinked or multiply-linked daemon temporary names", () =>
    withProfile(async (profile) => {
      const directory = join(profile, "automations");
      await mkdir(directory);
      const outside = join(profile, "outside.md");
      const suspicious = temporaryPath(directory, "daily-inbox");
      await writeFile(outside, PROMPT);
      await symlink(outside, suspicious);

      await expect(makeService(profile)).rejects.toMatchObject({ code: "operation-failed" });
      expect(await readFile(outside, "utf8")).toBe(PROMPT);
    }).then(() =>
      withProfile(async (profile) => {
        const directory = join(profile, "automations");
        await mkdir(directory);
        const suspicious = temporaryPath(directory, "daily-inbox");
        await writeFile(suspicious, PROMPT);
        await link(suspicious, join(directory, "alias-one"));
        await link(suspicious, join(directory, "alias-two"));

        await expect(makeService(profile)).rejects.toMatchObject({ code: "operation-failed" });
        expect(await readdir(directory)).toHaveLength(3);
      }),
    ));

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

function temporaryPath(directory: string, id: string): string {
  return join(directory, `.${id}.md.123.${crypto.randomUUID()}.tmp`);
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
