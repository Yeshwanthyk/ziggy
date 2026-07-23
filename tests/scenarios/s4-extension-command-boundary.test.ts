import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { loadInstalledExtensionCommands, type SessionTool } from "../../packages/core/src/index.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  createS4ExtensionFixture,
  installS4Fixture,
  requireApprovalRequirements,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

let root: string | undefined;

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("S4 supervised Command crosses approval, lifecycle, and Session Tool boundaries", async () => {
  const fixture = await createS4ExtensionFixture("command-boundary", {
    skills: [],
    commands: [
      {
        id: "executor",
        description: "Executes exact argv under daemon supervision.",
        argv: ["bin/executor", "--fixed"],
        argumentMode: "append",
        cwd: "profile",
        timeoutMs: 1_000,
      },
    ],
    filesystemPermission: "profile",
    files: {
      "bin/executor": '#!/bin/sh\nprintf "%s|%s|%s" "$1" "$2" "$PWD"\n',
    },
  });
  root = fixture.root;

  const requirement = requireApprovalRequirements(
    await installS4Fixture(fixture.profile, fixture.source, []),
  );
  expect(requirement).toHaveLength(1);
  const approvals = requirement.map((entry) => entry.fingerprint);
  expect(await installS4Fixture(fixture.profile, fixture.source, approvals)).toMatchObject({
    status: "installed",
  });
  expect(
    await useS4Lifecycle(fixture.profile, (service) =>
      service.enable({ extensionId: "fixture", approvals }),
    ),
  ).toMatchObject({ status: "enabled" });

  const tools = await runEffect(loadInstalledExtensionCommands(fixture.profile, "0.0.0"));
  const command = requireOnly(tools);
  const output = await runEffect(
    command.execute({
      sessionId: "session",
      turnId: "turn",
      stepId: "step",
      toolCallId: "call",
      toolName: "executor",
      input: { args: ["literal;not-shell"] },
      signal: new AbortController().signal,
    }),
  );
  expect(output).toMatchObject({
    status: "ok",
    exitCode: 0,
    stderr: "",
    truncated: false,
  });
  expect(JSON.stringify(output)).toContain("--fixed|literal;not-shell|");
  emitVerificationObservation("s4.extension-command-boundary", {
    ...emptyRuntimeObservations(),
    faultSchedule: [
      {
        boundary: "extension-command",
        point: "approval-before-execution",
        occurrence: 1,
        outcome: "continued",
      },
    ],
    metrics: [
      { name: "approval-requirements", value: requirement.length },
      { name: "session-command-tools", value: tools.length },
    ],
  });
});

function requireOnly(tools: ReadonlyArray<SessionTool>): SessionTool {
  expect(tools).toHaveLength(1);
  const command = tools[0];
  if (command === undefined) throw new Error("Expected one supervised Command");
  return command;
}
