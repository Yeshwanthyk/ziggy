import { expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeExtensionApprovalsJson,
  loadInstalledExtensionSkills,
  type ExtensionInstallResult,
} from "../../packages/core/src/index.ts";
import {
  createS4ExtensionFixture,
  installS4Fixture,
  requireApprovalRequirements,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
} from "../testkit/verification-observations.ts";

test("S4 mutation invalidation is durable and reinstall recovers disabled with exact environment", async () => {
  const fixture = await createS4ExtensionFixture("mutation-recovery", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    setup: {
      steps: [{ argv: ["setup/verify"] }],
      doctor: { argv: ["setup/doctor"] },
    },
    requiresEnv: ["DECLARED", "SECRET"],
    secrets: ["SECRET"],
    files: {
      "tools/fixture/tool.ts": "export const value = 1;\n",
      "setup/verify":
        '#!/bin/sh\nif [ "$DECLARED" != plain-value ] || [ "$SECRET" != secret-value ]; then exit 41; fi\n/usr/bin/env | /usr/bin/grep -q "^UNDECLARED=" && exit 42\n/usr/bin/env | /usr/bin/grep -q "^PATH=" && exit 43\n/usr/bin/env | /usr/bin/grep -q "^HOME=" && exit 44\nexit 0\n',
      "setup/doctor":
        '#!/bin/sh\nundeclared=unset; path_value=unset; home_value=unset\n/usr/bin/env | /usr/bin/grep -q "^UNDECLARED=" && undeclared=present\n/usr/bin/env | /usr/bin/grep -q "^PATH=" && path_value=present\n/usr/bin/env | /usr/bin/grep -q "^HOME=" && home_value=present\nprintf "%s|%s|%s|%s|%s" "$DECLARED" "$SECRET" "$undeclared" "$path_value" "$home_value"\n',
    },
  });
  const environment = {
    DECLARED: "plain-value",
    SECRET: "secret-value",
    UNDECLARED: "synthetic-parent-secret",
    PATH: "/synthetic/path",
    HOME: "/synthetic/home",
  };
  const initial = requireApprovalRequirements(
    await installS4Fixture(fixture.profile, fixture.source, []),
  );
  const installed = requireInstalled(
    await installS4Fixture(
      fixture.profile,
      fixture.source,
      initial.map((entry) => entry.fingerprint),
      { environment },
    ),
  );
  expect(installed.extension).toMatchObject({ enabled: false, approvalEpoch: 0, health: "ready" });
  const enabled = await useS4Lifecycle(
    fixture.profile,
    (service) =>
      service.enable({
        extensionId: "fixture",
        approvals: initial.map((entry) => entry.fingerprint),
      }),
    { environment },
  );
  expect(enabled).toMatchObject({ status: "enabled", extension: { enabled: true } });
  const doctorApproval = initial.find((entry) => entry.entryKind === "doctor");
  if (doctorApproval === undefined) throw new Error("Missing doctor approval requirement");
  const doctor = await useS4Lifecycle(
    fixture.profile,
    (service) => service.doctor({ extensionId: "fixture", approval: doctorApproval.fingerprint }),
    { environment },
  );
  expect(doctor).toMatchObject({
    status: "ok",
    stdout: "plain-value|secret-value|unset|unset|unset",
  });

  const mutableRoot = join(fixture.profile, ".runtime", "extensions", "fixture", "state");
  const mutableFile = join(mutableRoot, "owner.json");
  const mutableContents = '{"schemaVersion":1,"owner":"extension"}\n';
  await mkdir(mutableRoot);
  await writeFile(mutableFile, mutableContents);
  const mutableInode = (await stat(mutableFile)).ino;
  const installedTool = join(
    fixture.profile,
    "extensions",
    "fixture",
    "tools",
    "fixture",
    "tool.ts",
  );
  const originalTool = await readFile(installedTool);
  await writeFile(installedTool, "export const value = 9;\n");
  const invalidated = await useS4Lifecycle(fixture.profile, (service) => service.list());
  expect(invalidated).toEqual([
    expect.objectContaining({ id: "fixture", enabled: false, health: "mutated", approvalEpoch: 1 }),
  ]);
  await writeFile(installedTool, originalTool);
  await expect(
    useS4Lifecycle(fixture.profile, (service) =>
      service.enable({
        extensionId: "fixture",
        approvals: initial.map((entry) => entry.fingerprint),
      }),
    ),
  ).rejects.toThrow("reinstall");

  const fresh = requireApprovalRequirements(
    await installS4Fixture(fixture.profile, fixture.source, [], { environment }),
  );
  expect(fresh.map((entry) => entry.epoch)).toEqual(fresh.map(() => 1));
  expect(fresh.map((entry) => entry.fingerprint)).not.toEqual(
    initial.map((entry) => entry.fingerprint),
  );
  const recovered = requireInstalled(
    await installS4Fixture(
      fixture.profile,
      fixture.source,
      fresh.map((entry) => entry.fingerprint),
      { environment },
    ),
  );
  expect(recovered.extension).toMatchObject({
    enabled: false,
    health: "ready",
    approvalEpoch: 1,
  });
  expect(await readFile(mutableFile, "utf8")).toBe(mutableContents);
  expect((await stat(mutableFile)).ino).toBe(mutableInode);

  const skillFixture = await createS4ExtensionFixture("skill-mutation");
  expect(
    requireInstalled(await installS4Fixture(skillFixture.profile, skillFixture.source, [])),
  ).toBeDefined();
  expect(
    await useS4Lifecycle(skillFixture.profile, (service) =>
      service.enable({ extensionId: "fixture", approvals: [] }),
    ),
  ).toMatchObject({ status: "enabled", extension: { enabled: true } });
  const skillPath = join(
    skillFixture.profile,
    "extensions",
    "fixture",
    "skills",
    "fixture",
    "SKILL.md",
  );
  const originalSkill = await readFile(skillPath);
  await writeFile(
    skillPath,
    "---\nname: fixture\ndescription: S4 scenario Skill\n---\n\nMutated.\n",
  );
  await expect(
    runEffect(loadInstalledExtensionSkills(skillFixture.profile, "0.0.0")),
  ).rejects.toThrow("mutated");
  await writeFile(skillPath, originalSkill);
  await expect(
    runEffect(loadInstalledExtensionSkills(skillFixture.profile, "0.0.0")),
  ).rejects.toThrow("reinstall");
  const skillApprovals = await runEffect(
    decodeExtensionApprovalsJson(
      await readFile(
        join(skillFixture.profile, ".runtime", "extensions", "fixture", "approvals.json"),
        "utf8",
      ),
    ),
  );
  expect(skillApprovals).toMatchObject({ epoch: 1, invalidated: true, approvals: [] });

  emitVerificationObservation("s4.extension-mutation-recovery", {
    ...emptyRuntimeObservations(),
    faultSchedule: [
      {
        boundary: "extension-list",
        point: "immutable-tool-mutation",
        occurrence: 1,
        outcome: "failed",
      },
      {
        boundary: "extension-skill-load",
        point: "immutable-skill-mutation",
        occurrence: 1,
        outcome: "failed",
      },
      {
        boundary: "extension-reinstall",
        point: "fresh-approval",
        occurrence: 1,
        outcome: "recovered",
      },
    ],
    filesystemDiffs: [
      {
        path: ".runtime/extensions/fixture/state/owner.json",
        change: "unchanged",
        beforeDigest: fixtureDigest(mutableContents),
        afterDigest: fixtureDigest(await readFile(mutableFile, "utf8")),
      },
    ],
    metrics: [
      { name: "approval-epoch", value: recovered.extension.approvalEpoch },
      { name: "filtered-host-variables", value: 3 },
      { name: "mutation-detectors", value: 2 },
    ],
  });
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(skillFixture.root, { recursive: true, force: true }),
  ]);
});

function requireInstalled(
  result: ExtensionInstallResult,
): Extract<ExtensionInstallResult, { readonly status: "installed" }> {
  if (result.status === "installed") return result;
  throw new Error("Expected installed Extension response");
}
