import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFauxCore, createModels, createProvider } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import {
  canonicalApprovals,
  createFilesystemWorld,
  createProviderRuntimeComposition,
  decodeExtensionApprovalsJson,
  loadInstalledExtensionCommands,
  loadInstalledExtensionTools,
  makeExtensionApprovalRequirement,
  SessionRuntimeError,
  type ExtensionCommandLoaderOptions,
  type SessionTool,
} from "../../packages/core/src/index.ts";
import type { JsonObject } from "../../packages/protocol/src/index.ts";
import { runEffect, runScopedEffect } from "../testkit/effect.ts";
import { waitForFile } from "../testkit/compiled-process.ts";
import {
  createS4ExtensionFixture,
  installS4Fixture,
  requireApprovalRequirements,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Command execution requires exact install approval and preserves argv without a shell", async () => {
  const fixture = await commandFixture("approval", {
    script:
      '#!/bin/sh\nprintf \'{"cwd":"%s","declared":"%s","undeclared":"%s","args":["%s","%s"]}\' "$PWD" "$DECLARED" "$UNDECLARED" "$1" "$2"\n',
    argumentMode: "append",
  });
  const first = await installS4Fixture(fixture.profile, fixture.source, []);
  const requirements = requireApprovalRequirements(first);
  expect(requirements).toHaveLength(1);
  expect(requirements[0]).toMatchObject({
    entryKind: "command",
    entryId: "executor",
    argv: ["bin/executor", "--fixed"],
    argumentMode: "append",
    cwd: "extension",
    timeoutMs: 1_000,
  });
  expect(await load(fixture.profile)).toEqual([]);

  await installS4Fixture(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
    { environment: { DECLARED: "visible", PATH: "/must-not-leak" } },
  );
  await useS4Lifecycle(fixture.profile, (service) =>
    service.enable({
      extensionId: "fixture",
      approvals: requirements.map((entry) => entry.fingerprint),
    }),
  );
  const tool = only(
    await load(fixture.profile, {
      DECLARED: "visible",
      UNDECLARED: "must-not-leak",
      PATH: "/must-not-leak",
    }),
  );
  const output = await execute(tool, ["; touch /tmp/ziggy-must-not-exist"]);
  expect(output).toEqual({
    status: "ok",
    exitCode: 0,
    stdout: JSON.stringify({
      cwd: join(await realpath(fixture.profile), "extensions", "fixture"),
      declared: "visible",
      undeclared: "",
      args: ["--fixed", "; touch /tmp/ziggy-must-not-exist"],
    }),
    stderr: "",
    truncated: false,
  });
});

test("Command results report nonzero, bounded output, timeout, and cancellation", async () => {
  const failed = await enabledCommand("failed", "#!/bin/sh\nprintf out; printf err >&2; exit 7\n");
  expect(await execute(failed.tool, [])).toMatchObject({
    status: "failed",
    exitCode: 7,
    stdout: "out",
    stderr: "err",
  });

  const bounded = await enabledCommand(
    "bounded",
    "#!/bin/sh\nprintf 123456789; printf abcdefghi >&2\n",
    5,
  );
  expect(await execute(bounded.tool, [])).toEqual({
    status: "ok",
    exitCode: 0,
    stdout: "12345",
    stderr: "abcde",
    truncated: true,
  });

  const timeout = await enabledCommand("timeout", "#!/bin/sh\nsleep 5\n", undefined, 50);
  expect(await execute(timeout.tool, [])).toMatchObject({ status: "timeout", exitCode: null });

  const cancelled = await enabledCommand("cancelled", "#!/bin/sh\nsleep 5\n");
  const controller = new AbortController();
  controller.abort();
  await expect(execute(cancelled.tool, [], controller.signal)).rejects.toThrow("execution failed");

  const liveCancelled = await enabledCommand(
    "live-cancelled",
    "#!/bin/sh\ntrap 'exit 0' TERM\nsh -c 'trap \"\" TERM; exec </dev/null >/dev/null 2>&1; while :; do sleep 1; done' &\nprintf '%s' \"$!\" > cancel-child.pid\nprintf ready > cancel-ready\nwhile :; do sleep 1; done\n",
    undefined,
    5_000,
  );
  const liveController = new AbortController();
  const execution = execute(liveCancelled.tool, [], liveController.signal);
  const extensionRoot = join(liveCancelled.fixture.profile, "extensions", "fixture");
  await waitForFile(join(extensionRoot, "cancel-ready"), (contents) => contents === "ready");
  const childPid = Number(await readFile(join(extensionRoot, "cancel-child.pid"), "utf8"));
  liveController.abort();
  await expect(execution).rejects.toThrow("execution failed");
  expect(() => process.kill(childPid, 0)).toThrow();
});

test("Command input mode, NUL, count, and aggregate UTF-8 byte limits fail before spawn", async () => {
  const append = await commandFixture("input-bounds", {
    script: "#!/bin/sh\nprintf spawned > should-not-exist\n",
    argumentMode: "append",
  });
  const requirements = requireApprovalRequirements(
    await installS4Fixture(append.profile, append.source, []),
  );
  const approvals = requirements.map((entry) => entry.fingerprint);
  await installS4Fixture(append.profile, append.source, approvals);
  await useS4Lifecycle(append.profile, (service) =>
    service.enable({ extensionId: "fixture", approvals }),
  );
  const appendTool = only(await load(append.profile));
  await expect(executeInput(appendTool, {})).rejects.toThrow("Invalid Extension Command input");
  await expect(executeInput(appendTool, { args: ["contains\0nul"] })).rejects.toThrow(
    "Invalid Extension Command input",
  );
  await expect(
    executeInput(appendTool, { args: Array.from({ length: 63 }, () => "x") }),
  ).rejects.toThrow("exceed 64 total entries");
  await expect(executeInput(appendTool, { args: ["x".repeat(16 * 1024 + 1)] })).rejects.toThrow(
    "exceed 16384 aggregate UTF-8 bytes",
  );
  await expect(
    readFile(join(append.profile, "extensions", "fixture", "should-not-exist")),
  ).rejects.toThrow();

  const none = await enabledCommand("input-none", "#!/bin/sh\nprintf ok\n");
  await expect(executeInput(none.tool, { args: [] })).rejects.toThrow(
    "Invalid Extension Command input",
  );
});

test("Command invocation fails closed after disable, approval removal, or immutable mutation", async () => {
  const fixture = await enabledCommand("stale", "#!/bin/sh\nprintf ok\n");
  await useS4Lifecycle(fixture.fixture.profile, (service) =>
    service.disable({ extensionId: "fixture" }),
  );
  await expect(execute(fixture.tool, [])).rejects.toThrow("disabled");

  await useS4Lifecycle(fixture.fixture.profile, (service) =>
    service.enable({ extensionId: "fixture", approvals: fixture.approvals }),
  );
  const executable = join(fixture.fixture.profile, "extensions", "fixture", "bin", "executor");
  const original = await readFile(executable, "utf8");
  await writeFile(executable, "#!/bin/sh\nprintf changed\n", { mode: 0o700 });
  await expect(execute(fixture.tool, [])).rejects.toThrow("reinstall is required");
  await writeFile(executable, original, { mode: 0o700 });
  await expect(execute(fixture.tool, [])).rejects.toThrow("authority identity mismatch");
});

test("Command invocation uses the approved absolute executable without runtime PATH resolution", async () => {
  const fixture = await createS4ExtensionFixture("path-pinning", {
    skills: [],
    commands: [
      {
        id: "executor",
        description: "Runs the PATH-resolved install-time executable.",
        argv: ["fixture-command"],
        argumentMode: "none",
        cwd: "extension",
        timeoutMs: 1_000,
      },
    ],
    requiresCommands: ["fixture-command"],
  });
  roots.push(fixture.root);
  const approvedBin = join(fixture.root, "approved-bin");
  const replacementBin = join(fixture.root, "replacement-bin");
  await Promise.all([mkdir(approvedBin), mkdir(replacementBin)]);
  await Promise.all([
    writeFile(join(approvedBin, "fixture-command"), "#!/bin/sh\nprintf approved\n", {
      mode: 0o700,
    }),
    writeFile(join(replacementBin, "fixture-command"), "#!/bin/sh\nprintf replacement\n", {
      mode: 0o700,
    }),
  ]);
  const requirements = requireApprovalRequirements(
    await installS4Fixture(fixture.profile, fixture.source, [], {
      commandSearchPath: approvedBin,
    }),
  );
  const approvals = requirements.map((entry) => entry.fingerprint);
  await installS4Fixture(fixture.profile, fixture.source, approvals, {
    commandSearchPath: approvedBin,
  });
  await useS4Lifecycle(
    fixture.profile,
    (service) => service.enable({ extensionId: "fixture", approvals }),
    { commandSearchPath: replacementBin },
  );
  expect(await execute(only(await load(fixture.profile)), [])).toMatchObject({
    status: "ok",
    stdout: "approved",
  });
});

test("Command invocation executes a private approved-byte snapshot across final path mutation", async () => {
  const fixture = await enabledCommand("snapshot-toctou", "#!/bin/sh\nprintf approved\n");
  const executable = join(fixture.fixture.profile, "extensions", "fixture", "bin", "executor");
  const attackerMarker = join(fixture.fixture.profile, "attacker-ran");
  const tool = only(
    await load(fixture.fixture.profile, {}, undefined, () =>
      Effect.tryPromise({
        try: () =>
          writeFile(
            executable,
            `#!/bin/sh\nprintf attacker\nprintf ran > ${JSON.stringify(attackerMarker)}\n`,
            { mode: 0o700 },
          ),
        catch: (cause) =>
          new SessionRuntimeError({ message: "Failed final path mutation fixture", cause }),
      }),
    ),
  );
  expect(await execute(tool, [])).toMatchObject({ status: "ok", stdout: "approved" });
  await expect(readFile(attackerMarker)).rejects.toThrow();
  await expect(execute(tool, [])).rejects.toThrow("reinstall is required");
});

test("production Provider composition freezes supervised Commands into the Session Tool snapshot", async () => {
  const enabled = await enabledCommand("provider", "#!/bin/sh\nprintf ok\n");
  await Promise.all([
    writeFile(join(enabled.fixture.profile, "SOUL.md"), "fixture soul\n"),
    ...["credentials", "sessions", "memory"].map((directory) =>
      mkdir(
        join(enabled.fixture.profile, directory),
        directory === "credentials" ? { mode: 0o700 } : {},
      ),
    ),
  ]);
  const faux = createFauxCore({
    provider: "fixture-provider",
    models: [{ id: "fixture-model", name: "Fixture Model" }],
  });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "fixture-provider",
      auth: {},
      models: faux.models,
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  const names = await runScopedEffect(
    Effect.gen(function* () {
      const composition = yield* createProviderRuntimeComposition({
        profilePath: enabled.fixture.profile,
        config: {
          defaultProvider: "fixture-provider",
          defaultModel: "fixture-model",
          thinkingLevel: "medium",
          cacheRetention: "short",
        },
        models,
      });
      const world = createFilesystemWorld({ profilePath: enabled.fixture.profile });
      const runtime = yield* composition.createRuntime("command-session", world);
      const envelopes = yield* world.readSession("command-session", 0);
      yield* runtime.close;
      const started = envelopes[0]?.event;
      return started?.type === "session-started"
        ? started.snapshot.tools.map((tool) => tool.name)
        : [];
    }),
  );
  expect(names).toEqual(["memory", "executor"]);
});

test("Provider composition rejects Command and in-process Tool name collisions globally", async () => {
  const command = await enabledCommand("provider-collision", "#!/bin/sh\nprintf ok\n");
  const toolFixture = await createS4ExtensionFixture("provider-tool-collision", {
    skills: [],
    tools: [{ id: "executor", path: "tools/executor" }],
    files: {
      "tools/executor/tool.ts":
        'export default { name: "executor", description: "collision", inputSchema: { type: "object" }, execute() { return {}; } };\n',
    },
  });
  roots.push(toolFixture.root);
  await writeFile(
    join(toolFixture.source, "extension.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "other",
        version: "1.0.0",
        name: "Other",
        description: "Collision fixture.",
        ziggy: { requires: ">=0.0.0 <=9.0.0" },
        skills: [],
        tools: [{ id: "executor", path: "tools/executor" }],
        adapters: [],
        requires: { env: [], commands: [], os: [] },
        permissions: { network: false, filesystem: "none", secrets: [] },
        distribution: { source: "fixture", license: "MIT" },
      },
      undefined,
      2,
    )}\n`,
  );
  const toolRequirements = requireApprovalRequirements(
    await installS4Fixture(command.fixture.profile, toolFixture.source, []),
  );
  const toolApprovals = toolRequirements.map((entry) => entry.fingerprint);
  await installS4Fixture(command.fixture.profile, toolFixture.source, toolApprovals);
  await useS4Lifecycle(command.fixture.profile, (service) =>
    service.enable({ extensionId: "other", approvals: toolApprovals }),
  );
  await expect(
    runScopedEffect(loadInstalledExtensionTools(command.fixture.profile, "0.0.0")),
  ).rejects.toThrow("globally unique");
  await expect(
    runScopedEffect(
      createProviderRuntimeComposition({
        profilePath: command.fixture.profile,
        config: {
          defaultProvider: "unused",
          defaultModel: "unused",
          thinkingLevel: "low",
          cacheRetention: "none",
        },
      }),
    ),
  ).rejects.toThrow("Failed to load installed Extension Tools");
});

test("Command loading rejects mismatched identities and extra approval authority", async () => {
  const identity = await enabledCommand("identity", "#!/bin/sh\nprintf ok\n");
  const authorityPath = join(
    identity.fixture.profile,
    ".runtime",
    "extensions",
    "fixture",
    "approvals.json",
  );
  const original = await readFile(authorityPath, "utf8");
  const approvals = await runEffect(decodeExtensionApprovalsJson(original));
  await writeFile(authorityPath, `${JSON.stringify({ ...approvals, extensionId: "other" })}\n`);
  await expect(load(identity.fixture.profile)).rejects.toThrow("Failed to load Extension Commands");
  await writeFile(authorityPath, original);

  const commandApproval = approvals.approvals.find((entry) => entry.entryKind === "command");
  expect(commandApproval).toBeDefined();
  if (commandApproval === undefined) return;
  const extra = makeExtensionApprovalRequirement({
    extensionId: "fixture",
    extensionVersion: "1.0.0",
    entryKind: "tool",
    entryId: "extra",
    argv: [],
    permissions: commandApproval.permissions,
    executablePath: join(identity.fixture.profile, "extensions", "fixture", "tools/extra/tool.ts"),
    executableSha256: "0".repeat(64),
    trustTier: commandApproval.trustTier,
    treeDigest: commandApproval.treeDigest,
    epoch: approvals.epoch,
  });
  await writeFile(
    authorityPath,
    `${JSON.stringify({
      ...approvals,
      approvals: canonicalApprovals([...approvals.approvals, extra]),
    })}\n`,
  );
  await expect(load(identity.fixture.profile)).rejects.toThrow(
    "Invalid Extension Command authority",
  );
});

async function commandFixture(
  name: string,
  input: {
    readonly script: string;
    readonly argumentMode?: "none" | "append";
    readonly timeoutMs?: number;
  },
) {
  const fixture = await createS4ExtensionFixture(name, {
    skills: [],
    commands: [
      {
        id: "executor",
        description: "Runs a deterministic supervised command.",
        argv: ["bin/executor", "--fixed"],
        argumentMode: input.argumentMode ?? "none",
        cwd: "extension",
        timeoutMs: input.timeoutMs ?? 1_000,
      },
    ],
    files: { "bin/executor": input.script },
    requiresEnv: name === "approval" ? ["DECLARED"] : [],
  });
  roots.push(fixture.root);
  return fixture;
}

async function enabledCommand(
  name: string,
  script: string,
  outputLimitBytes?: number,
  timeoutMs?: number,
) {
  const fixture = await commandFixture(name, {
    script,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const requirements = requireApprovalRequirements(
    await installS4Fixture(fixture.profile, fixture.source, []),
  );
  const approvals = requirements.map((entry) => entry.fingerprint);
  await installS4Fixture(fixture.profile, fixture.source, approvals);
  await useS4Lifecycle(fixture.profile, (service) =>
    service.enable({ extensionId: "fixture", approvals }),
  );
  return {
    fixture,
    approvals,
    tool: only(await load(fixture.profile, {}, outputLimitBytes)),
  };
}

function load(
  profilePath: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  outputLimitBytes?: number,
  beforeSpawn?: ExtensionCommandLoaderOptions["beforeSpawn"],
): Promise<ReadonlyArray<SessionTool>> {
  return runEffect(
    loadInstalledExtensionCommands(profilePath, "0.0.0", {
      environment,
      ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
      ...(beforeSpawn === undefined ? {} : { beforeSpawn }),
    }),
  );
}

function only(tools: ReadonlyArray<SessionTool>): SessionTool {
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  if (tool === undefined) throw new Error("Expected one Command Tool");
  return tool;
}

function execute(
  tool: SessionTool,
  args: ReadonlyArray<string>,
  signal: AbortSignal = new AbortController().signal,
) {
  return executeInput(tool, args.length === 0 ? {} : { args }, signal);
}

function executeInput(
  tool: SessionTool,
  input: JsonObject,
  signal: AbortSignal = new AbortController().signal,
) {
  return runEffect(
    tool.execute({
      sessionId: "session",
      turnId: "turn",
      stepId: "step",
      toolCallId: "call",
      toolName: tool.name,
      input,
      signal,
    }),
  );
}
