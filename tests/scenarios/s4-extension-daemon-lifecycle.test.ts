import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileLockCoordinator } from "../../packages/core/src/index.ts";
import type {
  ExtensionApprovalRequirement,
  ExtensionInstallResponse,
  ExtensionObservation,
} from "../../packages/protocol/src/index.ts";
import { Effect, Layer } from "effect";
import {
  runProductionExtension,
  type ExtensionClientResult,
} from "../../packages/ziggy/src/cli-client.ts";
import {
  DaemonControlError,
  DaemonReadiness,
  probeDaemon,
  serveDaemon,
  type DaemonProbeResult,
} from "../../packages/ziggy/src/daemon.ts";
import { runEffect } from "../testkit/effect.ts";
import { createS4ExtensionFixture } from "../testkit/s4-extension-fixture.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
  fixtureDigest,
} from "../testkit/verification-observations.ts";

test("S4 production daemon owns the complete Extension CLI lifecycle across restart", async () => {
  const fixture = await createS4ExtensionFixture("daemon-lifecycle", {
    skills: [],
    tools: [{ id: "fixture", path: "tools/fixture" }],
    setup: {
      steps: [{ argv: ["setup/install"] }],
      doctor: { argv: ["setup/doctor"] },
    },
    files: {
      "tools/fixture/tool.ts": "export const inert = true;\n",
      "setup/install": "#!/bin/sh\nexit 0\n",
      "setup/doctor": "#!/bin/sh\nprintf 'doctor:healthy\\n'\n",
    },
    filesystemPermission: "profile",
  });
  const canaryPath = join(fixture.profile, "owner-canary.txt");
  const canary = "daemon owner bytes\n";
  await writeFile(canaryPath, canary);
  await writeFile(
    join(fixture.profile, "ziggy.jsonc"),
    '{"schemaVersion":1,"defaultProvider":"anthropic","defaultModel":"claude-fable-5","thinkingLevel":"medium","cacheRetention":"long"}\n',
  );
  await writeFile(join(fixture.profile, "SOUL.md"), "fixture soul\n");
  await mkdir(join(fixture.profile, "credentials"), { mode: 0o700 });
  await chmod(join(fixture.profile, "credentials"), 0o700);
  const sourceManifestBefore = await readFile(join(fixture.source, "extension.json"));
  const sourceDoctorBefore = await readFile(join(fixture.source, "setup", "doctor"));
  const setupMarker = join(fixture.source, "setup-ran.txt");
  await writeFile(
    join(fixture.source, "setup", "install"),
    `#!/bin/sh\nprintf 'setup complete\\n' > ${JSON.stringify(setupMarker)}\n`,
    { mode: 0o700 },
  );
  const setup = {
    probe: (path: string) => probeDaemon({ profilePath: path }),
    startAbsent: () =>
      Effect.fail(
        new DaemonControlError({
          operation: "unexpected-start",
          message: "Scenario daemon must already be ready",
        }),
      ),
  };

  const firstAbort = new AbortController();
  const firstDaemon = runProductionEffect(
    serveDaemon({ profilePath: fixture.profile, signal: firstAbort.signal }),
  );
  await waitUntilReady(fixture.profile);
  let approvalCount = 0;
  try {
    const approval = requireApproval(
      await runEffect(
        runProductionExtension(
          fixture.profile,
          { action: "install", sourcePath: fixture.source, approvals: [] },
          setup,
        ),
      ),
    );
    approvalCount += approval.requirements.length;
    expect(approval.requirements.map((entry) => entry.entryKind).sort()).toEqual([
      "doctor",
      "setup",
      "tool",
    ]);
    expect(await Bun.file(setupMarker).exists()).toBeFalse();

    const installed = requireInstalled(
      await runEffect(
        runProductionExtension(
          fixture.profile,
          {
            action: "install",
            sourcePath: fixture.source,
            approvals: approval.requirements.map((entry) => entry.fingerprint),
          },
          setup,
        ),
      ),
    );
    expect(installed.extension).toMatchObject({
      id: "fixture",
      enabled: false,
      health: "ready",
    });
    expect(await readFile(setupMarker, "utf8")).toBe("setup complete\n");
    expect(
      requireExtensionList(
        await runEffect(runProductionExtension(fixture.profile, { action: "list" }, setup)),
      ),
    ).toEqual([installed.extension]);

    const enableApproval = requireApproval(
      await runEffect(
        runProductionExtension(
          fixture.profile,
          { action: "enable", extensionId: "fixture", approvals: [] },
          setup,
        ),
      ),
    );
    approvalCount += enableApproval.requirements.length;
    const enabled = requireEnabled(
      await runEffect(
        runProductionExtension(
          fixture.profile,
          {
            action: "enable",
            extensionId: "fixture",
            approvals: enableApproval.requirements.map((entry) => entry.fingerprint),
          },
          setup,
        ),
      ),
    );
    expect(enabled).toMatchObject({ id: "fixture", enabled: true, health: "ready" });
    const doctorApproval = requireEntry(enableApproval.requirements, "doctor");
    const doctor = await runEffect(
      runProductionExtension(
        fixture.profile,
        { action: "doctor", extensionId: "fixture", approval: doctorApproval.fingerprint },
        setup,
      ),
    );
    expect(doctor).toMatchObject({
      status: "ok",
      extension: { id: "fixture", enabled: true },
      exitCode: 0,
      stdout: "doctor:healthy\n",
      stderr: "",
      truncated: false,
    });
    expect(
      await runEffect(
        runProductionExtension(
          fixture.profile,
          { action: "disable", extensionId: "fixture" },
          setup,
        ),
      ),
    ).toMatchObject({ id: "fixture", enabled: false, health: "ready" });
    expect(await readFile(canaryPath, "utf8")).toBe(canary);
    expect(await readFile(join(fixture.source, "extension.json"))).toEqual(sourceManifestBefore);
    expect(await readFile(join(fixture.source, "setup", "doctor"))).toEqual(sourceDoctorBefore);
  } finally {
    firstAbort.abort();
    await firstDaemon;
  }

  const secondAbort = new AbortController();
  const secondDaemon = runProductionEffect(
    serveDaemon({ profilePath: fixture.profile, signal: secondAbort.signal }),
  );
  await waitUntilReady(fixture.profile);
  try {
    expect(
      requireExtensionList(
        await runEffect(runProductionExtension(fixture.profile, { action: "list" }, setup)),
      ),
    ).toEqual([expect.objectContaining({ id: "fixture", enabled: false, health: "ready" })]);
    expect(await readFile(canaryPath, "utf8")).toBe(canary);
  } finally {
    secondAbort.abort();
    await secondDaemon;
  }

  emitVerificationObservation("s4.extension-daemon-lifecycle", {
    ...emptyRuntimeObservations(),
    faultSchedule: [
      {
        boundary: "extension-install",
        point: "exact-approval-resubmit",
        occurrence: 1,
        outcome: "continued",
      },
      {
        boundary: "extension-enable",
        point: "exact-approval-resubmit",
        occurrence: 1,
        outcome: "continued",
      },
      { boundary: "daemon-lifecycle", point: "restart", occurrence: 1, outcome: "recovered" },
    ],
    filesystemDiffs: [
      {
        path: "owner-canary.txt",
        change: "unchanged",
        beforeDigest: fixtureDigest(canary),
        afterDigest: fixtureDigest(await readFile(canaryPath, "utf8")),
      },
    ],
    metrics: [
      { name: "approval-requirements", value: approvalCount },
      { name: "daemon-restarts", value: 1 },
      { name: "lifecycle-verbs", value: 6 },
    ],
  });
  await rm(fixture.root, { recursive: true, force: true });
});

type ApprovalResponse = Extract<ExtensionInstallResponse, { readonly status: "approval-required" }>;

function requireApproval(value: ExtensionClientResult): ApprovalResponse {
  if (!Array.isArray(value) && "status" in value && value.status === "approval-required") {
    return value;
  }
  throw new Error("Expected approval-required Extension response");
}

function requireInstalled(
  value: ExtensionClientResult,
): Extract<ExtensionInstallResponse, { readonly status: "installed" }> {
  if (!Array.isArray(value) && "status" in value && value.status === "installed") return value;
  throw new Error("Expected installed Extension response");
}

function requireEnabled(value: ExtensionClientResult): ExtensionObservation {
  if (!Array.isArray(value) && "status" in value && value.status === "enabled") {
    return value.extension;
  }
  throw new Error("Expected enabled Extension response");
}

function requireExtensionList(value: ExtensionClientResult): ReadonlyArray<ExtensionObservation> {
  if (Array.isArray(value)) return value;
  throw new Error("Expected Extension list response");
}

function requireEntry(
  requirements: ReadonlyArray<ExtensionApprovalRequirement>,
  kind: ExtensionApprovalRequirement["entryKind"],
): ExtensionApprovalRequirement {
  const requirement = requirements.find((entry) => entry.entryKind === kind);
  if (requirement !== undefined) return requirement;
  throw new Error(`Missing ${kind} approval requirement`);
}

async function waitUntilReady(profilePath: string): Promise<DaemonProbeResult> {
  let latest = await runEffect(probeDaemon({ profilePath }));
  for (let attempt = 0; attempt < 100 && latest.status !== "ready"; attempt += 1) {
    await Bun.sleep(5);
    latest = await runEffect(probeDaemon({ profilePath }));
  }
  if (latest.status === "ready") return latest;
  throw new Error("Scenario daemon did not become ready");
}

const ProductionDaemonLayer = Layer.merge(DaemonReadiness.layer, ProfileLockCoordinator.layer);

function runProductionEffect<A, E>(
  program: Effect.Effect<A, E, DaemonReadiness | ProfileLockCoordinator>,
): Promise<A> {
  return runEffect(program.pipe(Effect.provide(ProductionDaemonLayer)));
}
