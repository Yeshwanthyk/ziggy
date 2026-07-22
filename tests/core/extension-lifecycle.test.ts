import { afterAll, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  ExtensionLifecycle,
  type ExtensionApprovalRequirement,
  type ExtensionInstallResult,
  type ExtensionLifecycleOptions,
  type ExtensionLifecycleService,
} from "../../packages/core/src/index.ts";
import { runEffect } from "../testkit/effect.ts";

const roots: string[] = [];

test("installs a Skill-only Extension disabled and owns every lifecycle mutation", async () => {
  const fixture = await createFixture("skill-only");
  const installed = await lifecycle(fixture.profile, (service) =>
    service.install({ sourcePath: fixture.source, approvals: [] }),
  );
  expect(installed.status).toBe("installed");
  if (installed.status !== "installed") return;
  expect(installed.extension.enabled).toBeFalse();
  expect(installed.extension.trustTier).toBe("community");

  const listed = await lifecycle(fixture.profile, (service) => service.list());
  expect(listed).toEqual([installed.extension]);

  const enabled = await lifecycle(fixture.profile, (service) =>
    service.enable({ extensionId: "fixture", approvals: [] }),
  );
  expect(enabled.status).toBe("enabled");
  if (enabled.status !== "enabled") return;
  expect(enabled.extension.enabled).toBeTrue();

  const disabled = await lifecycle(fixture.profile, (service) =>
    service.disable({ extensionId: "fixture" }),
  );
  expect(disabled.enabled).toBeFalse();
  expect(
    JSON.parse(
      await readFile(
        join(fixture.profile, ".runtime", "extensions", "fixture", "state.json"),
        "utf8",
      ),
    ),
  ).toEqual({ schemaVersion: 1, extensionId: "fixture", enabled: false });
});

test("returns exact Tool approval requirements and wrong approval writes nothing", async () => {
  const fixture = await createFixture("tool", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    skills: [],
    files: { "tools/fixture/tool.ts": "export const inert = true;\n" },
  });
  const first = await install(fixture.profile, fixture.source, []);
  const requirements = approvalRequirements(first);
  expect(requirements).toHaveLength(1);
  expect(requirements[0]?.entryKind).toBe("tool");
  expect(await exists(join(fixture.profile, "extensions", "fixture"))).toBeFalse();

  const wrong = await install(fixture.profile, fixture.source, ["0".repeat(64)]);
  expect(wrong.status).toBe("approval-required");
  expect(await exists(join(fixture.profile, "extensions", "fixture"))).toBeFalse();

  const accepted = await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
  );
  expect(accepted.status).toBe("installed");
  expect(
    await exists(join(fixture.profile, "extensions", "fixture", "tools", "fixture", "tool.ts")),
  ).toBeTrue();
});

test("runs approved setup and doctor without a shell and bounds output", async () => {
  const fixture = await createFixture("process", {
    setup: {
      steps: [{ argv: ["setup/verify", "setup-arg"] }],
      doctor: { argv: ["setup/doctor", "doctor-arg"] },
    },
    files: {
      "setup/verify": "#!/bin/sh\nprintf 'setup:%s' \"$1\"\n",
      "setup/doctor": "#!/bin/sh\nprintf 'doctor:%s:abcdefghijklmnopqrstuvwxyz' \"$1\"\n",
    },
  });
  const first = await install(fixture.profile, fixture.source, []);
  const requirements = approvalRequirements(first);
  expect(requirements.map((entry) => entry.entryKind).sort()).toEqual(["doctor", "setup"]);
  const installed = await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
    { processOutputLimitBytes: 16 },
  );
  expect(installed.status).toBe("installed");
  const doctor = requirements.find((entry) => entry.entryKind === "doctor");
  expect(doctor).toBeDefined();
  if (doctor === undefined) return;
  const result = await lifecycle(
    fixture.profile,
    (service) => service.doctor({ extensionId: "fixture", approval: doctor.fingerprint }),
    { processOutputLimitBytes: 16 },
  );
  expect(result.status).toBe("ok");
  expect(result.stdout).toBe("doctor:doctor-ar");
  expect(result.truncated).toBeTrue();
});

test("setup and doctor receive only exact manifest-declared environment values", async () => {
  const fixture = await createFixture("process-environment", {
    setup: {
      steps: [{ argv: ["setup/verify"] }],
      doctor: { argv: ["setup/doctor"] },
    },
    requiresEnv: ["DECLARED", "SECRET"],
    secrets: ["SECRET"],
    files: {
      "setup/verify":
        '#!/bin/sh\nif [ "$DECLARED" != plain-value ] || [ "$SECRET" != secret-value ]; then exit 41; fi\n/usr/bin/env | /usr/bin/grep -q "^UNDECLARED=" && exit 42\n/usr/bin/env | /usr/bin/grep -q "^PATH=" && exit 43\n/usr/bin/env | /usr/bin/grep -q "^HOME=" && exit 44\nexit 0\n',
      "setup/doctor":
        '#!/bin/sh\nundeclared=unset; path_value=unset; home_value=unset\n/usr/bin/env | /usr/bin/grep -q "^UNDECLARED=" && undeclared=present\n/usr/bin/env | /usr/bin/grep -q "^PATH=" && path_value=present\n/usr/bin/env | /usr/bin/grep -q "^HOME=" && home_value=present\nprintf "%s|%s|%s|%s|%s" "$DECLARED" "$SECRET" "$undeclared" "$path_value" "$home_value"\n',
    },
  });
  const hostEnvironment = {
    DECLARED: "plain-value",
    SECRET: "secret-value",
    UNDECLARED: "synthetic-parent-secret",
    PATH: "/synthetic/path",
    HOME: "/synthetic/home",
  };
  const requirements = approvalRequirements(await install(fixture.profile, fixture.source, []));
  const installed = await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
    { environment: hostEnvironment },
  );
  expect(installed.status).toBe("installed");
  const doctor = requirements.find((entry) => entry.entryKind === "doctor");
  expect(doctor).toBeDefined();
  if (doctor === undefined) return;
  const result = await lifecycle(
    fixture.profile,
    (service) => service.doctor({ extensionId: "fixture", approval: doctor.fingerprint }),
    { environment: hostEnvironment },
  );
  expect(result.status).toBe("ok");
  expect(result.stdout).toBe("plain-value|secret-value|unset|unset|unset");
});

test("missing required environment fails setup and doctor before spawn", async () => {
  let spawnCount = 0;
  const nodeHooks = {
    checkpoint(point: string) {
      if (point === "process-after-spawn") spawnCount += 1;
      return Promise.resolve();
    },
  };
  const setupFixture = await createFixture("missing-setup-environment", {
    setup: { steps: [{ argv: ["setup/verify"] }] },
    requiresEnv: ["MISSING"],
    files: { "setup/verify": "#!/bin/sh\nexit 0\n" },
  });
  const setupRequirements = approvalRequirements(
    await install(setupFixture.profile, setupFixture.source, []),
  );
  await expect(
    install(
      setupFixture.profile,
      setupFixture.source,
      setupRequirements.map((entry) => entry.fingerprint),
      { environment: {}, nodeHooks },
    ),
  ).rejects.toThrow("MISSING");
  expect(spawnCount).toBe(0);

  const doctorFixture = await createFixture("missing-doctor-environment", {
    setup: { steps: [], doctor: { argv: ["setup/doctor"] } },
    requiresEnv: ["MISSING"],
    files: { "setup/doctor": "#!/bin/sh\nexit 0\n" },
  });
  const doctorRequirements = approvalRequirements(
    await install(doctorFixture.profile, doctorFixture.source, []),
  );
  await install(
    doctorFixture.profile,
    doctorFixture.source,
    doctorRequirements.map((entry) => entry.fingerprint),
    { environment: {}, nodeHooks },
  );
  const doctor = doctorRequirements.find((entry) => entry.entryKind === "doctor");
  expect(doctor).toBeDefined();
  if (doctor === undefined) return;
  await expect(
    lifecycle(
      doctorFixture.profile,
      (service) => service.doctor({ extensionId: "fixture", approval: doctor.fingerprint }),
      { environment: {}, nodeHooks },
    ),
  ).rejects.toThrow("MISSING");
  expect(spawnCount).toBe(0);
});

test("an empty declared environment replaces process inheritance exactly", async () => {
  const fixture = await createFixture("empty-process-environment", {
    setup: { steps: [], doctor: { argv: ["env"] } },
    requiresCommands: ["env"],
  });
  const overrides = { commandSearchPath: "/usr/bin", environment: {} };
  const requirements = approvalRequirements(
    await install(fixture.profile, fixture.source, [], overrides),
  );
  await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
    overrides,
  );
  const doctor = requirements.find((entry) => entry.entryKind === "doctor");
  expect(doctor).toBeDefined();
  if (doctor === undefined) return;
  const result = await lifecycle(
    fixture.profile,
    (service) => service.doctor({ extensionId: "fixture", approval: doctor.fingerprint }),
    overrides,
  );
  expect(result.status).toBe("ok");
  expect(result.stdout).toBe("");
});

test("identical reinstall preserves enabled state, approvals, and mutable state", async () => {
  const fixture = await createFixture("reinstall", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    skills: [],
    files: { "tools/fixture/tool.ts": "export const inert = true;\n" },
  });
  const first = await install(fixture.profile, fixture.source, []);
  const requirements = approvalRequirements(first);
  await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
  );
  await lifecycle(fixture.profile, (service) =>
    service.enable({
      extensionId: "fixture",
      approvals: requirements.map((entry) => entry.fingerprint),
    }),
  );
  const stateRoot = join(fixture.profile, ".runtime", "extensions", "fixture", "state");
  await mkdir(stateRoot);
  await writeFile(join(stateRoot, "owner.json"), '{"schemaVersion":1}\n');

  const reinstalled = await install(fixture.profile, fixture.source, []);
  expect(reinstalled.status).toBe("installed");
  if (reinstalled.status !== "installed") return;
  expect(reinstalled.extension.enabled).toBeTrue();
  expect(reinstalled.extension.approvalEpoch).toBe(0);
  expect(await readFile(join(stateRoot, "owner.json"), "utf8")).toBe('{"schemaVersion":1}\n');
});

test("bound package change advances approval epoch and requires new approval", async () => {
  const fixture = await createFixture("changed", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    skills: [],
    files: { "tools/fixture/tool.ts": "export const value = 1;\n" },
  });
  const first = await install(fixture.profile, fixture.source, []);
  const oldRequirements = approvalRequirements(first);
  await install(
    fixture.profile,
    fixture.source,
    oldRequirements.map((entry) => entry.fingerprint),
  );
  await writeFile(join(fixture.source, "tools", "fixture", "tool.ts"), "export const value = 2;\n");

  const changed = await install(
    fixture.profile,
    fixture.source,
    oldRequirements.map((entry) => entry.fingerprint),
  );
  const changedRequirements = approvalRequirements(changed);
  expect(changedRequirements[0]?.epoch).toBe(1);
  expect(changedRequirements[0]?.fingerprint).not.toBe(oldRequirements[0]?.fingerprint);
});

test("detected immutable mutation invalidates approvals even after bytes are restored", async () => {
  const fixture = await createFixture("mutation", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    skills: [],
    files: { "tools/fixture/tool.ts": "export const value = 1;\n" },
  });
  const first = await install(fixture.profile, fixture.source, []);
  const requirements = approvalRequirements(first);
  await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
  );
  const toolPath = join(fixture.profile, "extensions", "fixture", "tools", "fixture", "tool.ts");
  const original = await readFile(toolPath);
  await writeFile(toolPath, "export const value = 9;\n");
  await expect(
    lifecycle(fixture.profile, (service) =>
      service.enable({
        extensionId: "fixture",
        approvals: requirements.map((entry) => entry.fingerprint),
      }),
    ),
  ).rejects.toThrow("reinstall");
  await writeFile(toolPath, original);
  const restored = await lifecycle(fixture.profile, (service) => service.list());
  expect(restored[0]?.approvalEpoch).toBe(1);
  await expect(
    lifecycle(fixture.profile, (service) =>
      service.enable({
        extensionId: "fixture",
        approvals: requirements.map((entry) => entry.fingerprint),
      }),
    ),
  ).rejects.toThrow("reinstall");
  const reapproval = approvalRequirements(await install(fixture.profile, fixture.source, []));
  expect(reapproval[0]?.epoch).toBe(1);
  expect(reapproval[0]?.fingerprint).not.toBe(requirements[0]?.fingerprint);
  const reinstalled = await install(
    fixture.profile,
    fixture.source,
    reapproval.map((entry) => entry.fingerprint),
  );
  expect(reinstalled.status).toBe("installed");
  if (reinstalled.status !== "installed") return;
  expect(reinstalled.extension.approvalEpoch).toBe(1);
});

test("list durably invalidates a mutated Tool exactly once before bytes are restored", async () => {
  const fixture = await createFixture("list-mutation", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    skills: [],
    files: { "tools/fixture/tool.ts": "export const value = 1;\n" },
  });
  const requirements = approvalRequirements(await install(fixture.profile, fixture.source, []));
  await install(
    fixture.profile,
    fixture.source,
    requirements.map((entry) => entry.fingerprint),
  );
  const toolPath = join(fixture.profile, "extensions", "fixture", "tools", "fixture", "tool.ts");
  const original = await readFile(toolPath);
  await writeFile(toolPath, "export const value = 2;\n");

  const first = await lifecycle(fixture.profile, (service) => service.list());
  expect(first[0]?.health).toBe("mutated");
  expect(first[0]?.approvalEpoch).toBe(1);
  const repeated = await lifecycle(fixture.profile, (service) => service.list());
  expect(repeated[0]?.approvalEpoch).toBe(1);

  await writeFile(toolPath, original);
  const restored = await lifecycle(fixture.profile, (service) => service.list());
  expect(restored[0]?.health).toBe("mutated");
  expect(restored[0]?.approvalEpoch).toBe(1);
  await expect(
    lifecycle(fixture.profile, (service) =>
      service.enable({
        extensionId: "fixture",
        approvals: requirements.map((entry) => entry.fingerprint),
      }),
    ),
  ).rejects.toThrow("reinstall");
});

test("mutated reinstall starts disabled and preserves mutable state in place", async () => {
  const fixture = await createFixture("mutated-reinstall", {
    tools: [{ id: "fixture", path: "tools/fixture" }],
    skills: [],
    files: { "tools/fixture/tool.ts": "export const value = 1;\n" },
  });
  const initial = approvalRequirements(await install(fixture.profile, fixture.source, []));
  await install(
    fixture.profile,
    fixture.source,
    initial.map((entry) => entry.fingerprint),
  );
  await lifecycle(fixture.profile, (service) =>
    service.enable({
      extensionId: "fixture",
      approvals: initial.map((entry) => entry.fingerprint),
    }),
  );
  const mutableRoot = join(fixture.profile, ".runtime", "extensions", "fixture", "state");
  const mutableFile = join(mutableRoot, "owner.json");
  await mkdir(mutableRoot);
  await writeFile(mutableFile, '{"schemaVersion":1}\n');
  const before = await stat(mutableFile);
  await writeFile(
    join(fixture.profile, "extensions", "fixture", "tools", "fixture", "tool.ts"),
    "export const value = 9;\n",
  );
  await lifecycle(fixture.profile, (service) => service.list());

  const fresh = approvalRequirements(await install(fixture.profile, fixture.source, []));
  expect(fresh[0]?.epoch).toBe(1);
  const installed = await install(
    fixture.profile,
    fixture.source,
    fresh.map((entry) => entry.fingerprint),
  );
  expect(installed.status).toBe("installed");
  if (installed.status !== "installed") return;
  expect(installed.extension.enabled).toBeFalse();
  expect(await readFile(mutableFile, "utf8")).toBe('{"schemaVersion":1}\n');
  expect((await stat(mutableFile)).ino).toBe(before.ino);
});

test("rejects invalid signatures instead of downgrading and rejects source links", async () => {
  const signed = await createFixture("signed");
  await expect(
    lifecycle(
      signed.profile,
      (service) =>
        service.install({
          sourcePath: signed.source,
          approvals: [],
          verification: { keyId: "fixture-key", signature: "invalid" },
        }),
      { verifySignature: () => Effect.succeed(false) },
    ),
  ).rejects.toThrow("signature is invalid");
  expect(await exists(join(signed.profile, "extensions", "fixture"))).toBeFalse();

  const linked = await createFixture("linked");
  await symlink("SKILL.md", join(linked.source, "skills", "fixture", "alias.md"));
  await expect(install(linked.profile, linked.source, [])).rejects.toThrow(
    "inspect Extension source",
  );

  const hardlinked = await createFixture("hardlinked");
  await link(
    join(hardlinked.source, "skills", "fixture", "SKILL.md"),
    join(hardlinked.source, "skills", "fixture", "alias.md"),
  );
  await expect(install(hardlinked.profile, hardlinked.source, [])).rejects.toThrow(
    "inspect Extension source",
  );
});

test("setup failure and timeout preserve the absent install and clean quarantine", async () => {
  const failed = await createFixture("setup-failed", {
    setup: { steps: [{ argv: ["setup/verify"] }] },
    files: { "setup/verify": "#!/bin/sh\nprintf failure >&2\nexit 3\n" },
  });
  const failedRequirements = approvalRequirements(await install(failed.profile, failed.source, []));
  await expect(
    install(
      failed.profile,
      failed.source,
      failedRequirements.map((entry) => entry.fingerprint),
    ),
  ).rejects.toThrow("setup 0 failed");
  expect(await exists(join(failed.profile, "extensions", "fixture"))).toBeFalse();
  expect(await quarantineEntries(failed.profile)).toEqual([]);

  const timedOut = await createFixture("setup-timeout", {
    setup: { steps: [{ argv: ["setup/verify"] }] },
    files: { "setup/verify": "#!/bin/sh\nsleep 2\n" },
  });
  const timeoutRequirements = approvalRequirements(
    await install(timedOut.profile, timedOut.source, []),
  );
  await expect(
    install(
      timedOut.profile,
      timedOut.source,
      timeoutRequirements.map((entry) => entry.fingerprint),
      { processTimeoutMs: 20 },
    ),
  ).rejects.toThrow("setup 0 timeout");
  expect(await exists(join(timedOut.profile, "extensions", "fixture"))).toBeFalse();
  expect(await quarantineEntries(timedOut.profile)).toEqual([]);
});

test("failed reinstall preserves the previous package and authority byte-for-byte", async () => {
  const original = await createFixture("previous");
  await install(original.profile, original.source, []);
  const statePath = join(original.profile, ".runtime", "extensions", "fixture", "state.json");
  const provenancePath = join(
    original.profile,
    ".runtime",
    "extensions",
    "fixture",
    "provenance.json",
  );
  const beforeState = await readFile(statePath);
  const beforeProvenance = await readFile(provenancePath);
  const replacement = await createFixture("replacement-fails", {
    version: "2.0.0",
    setup: { steps: [{ argv: ["setup/verify"] }] },
    files: { "setup/verify": "#!/bin/sh\nexit 7\n" },
  });
  const requirements = approvalRequirements(
    await install(original.profile, replacement.source, []),
  );
  await expect(
    install(
      original.profile,
      replacement.source,
      requirements.map((entry) => entry.fingerprint),
    ),
  ).rejects.toThrow("setup 0 failed");
  expect(await readFile(statePath)).toEqual(beforeState);
  expect(await readFile(provenancePath)).toEqual(beforeProvenance);
  const listed = await lifecycle(original.profile, (service) => service.list());
  expect(listed[0]?.version).toBe("1.0.0");
});

test("fails loud on authority schema mismatch and incompatibility before setup", async () => {
  const authority = await createFixture("authority-schema");
  await install(authority.profile, authority.source, []);
  await writeFile(
    join(authority.profile, ".runtime", "extensions", "fixture", "state.json"),
    '{"schemaVersion":2,"extensionId":"fixture","enabled":false}\n',
  );
  await expect(
    lifecycle(authority.profile, (service) =>
      service.enable({ extensionId: "fixture", approvals: [] }),
    ),
  ).rejects.toThrow("Invalid Extension state");

  const incompatible = await createFixture("incompatible", {
    ziggyRequires: ">9.0.0",
    setup: { steps: [{ argv: ["setup/verify"] }] },
    files: { "setup/verify": "#!/bin/sh\nexit 0\n" },
  });
  await expect(install(incompatible.profile, incompatible.source, [])).rejects.toThrow(
    "requires Ziggy >9.0.0",
  );
  expect(await exists(join(incompatible.profile, "extensions", "fixture"))).toBeFalse();
});

test("same-ID concurrent installs serialize to one complete observation", async () => {
  const fixture = await createFixture("concurrent");
  const observations = await lifecycle(fixture.profile, (service) =>
    Effect.all(
      [
        service.install({ sourcePath: fixture.source, approvals: [] }),
        service.install({ sourcePath: fixture.source, approvals: [] }),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(observations.map((result) => result.status)).toEqual(["installed", "installed"]);
  const listed = await lifecycle(fixture.profile, (service) => service.list());
  expect(listed).toHaveLength(1);
  expect(listed[0]?.health).toBe("ready");
});

test("list never observes the package publication gap during reinstall", async () => {
  const fixture = await createFixture("list-publication");
  await install(fixture.profile, fixture.source, []);
  const manifestPath = join(fixture.source, "extension.json");
  const changed = (await readFile(manifestPath, "utf8")).replace(
    '"version": "1.0.0"',
    '"version": "1.0.1"',
  );
  await writeFile(manifestPath, changed);

  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reinstalling = install(fixture.profile, fixture.source, [], {
    nodeHooks: {
      checkpoint(point) {
        if (point !== "activation-after-package-backup") return Promise.resolve();
        reached.resolve();
        return release.promise;
      },
    },
  });
  await reached.promise;
  let listSettled = false;
  const listing = lifecycle(fixture.profile, (service) => service.list()).then((result) => {
    listSettled = true;
    return result;
  });
  await Bun.sleep(10);
  expect(listSettled).toBeFalse();
  release.resolve();
  await reinstalling;
  const listed = await listing;
  expect(listed).toHaveLength(1);
  expect(listed[0]?.version).toBe("1.0.1");
  expect(listed[0]?.health).toBe("ready");
});

interface FixtureOptions {
  readonly skills?: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  readonly tools?: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  readonly setup?: {
    readonly steps: ReadonlyArray<{ readonly argv: ReadonlyArray<string> }>;
    readonly doctor?: { readonly argv: ReadonlyArray<string> };
  };
  readonly files?: Readonly<Record<string, string>>;
  readonly ziggyRequires?: string;
  readonly version?: string;
  readonly requiresEnv?: ReadonlyArray<string>;
  readonly requiresCommands?: ReadonlyArray<string>;
  readonly secrets?: ReadonlyArray<string>;
}

async function createFixture(name: string, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), `ziggy-s4-lifecycle-${name}-`));
  roots.push(root);
  const profile = join(root, "profile");
  const source = join(root, "source");
  await mkdir(profile);
  await mkdir(source);
  const skills = options.skills ?? [{ id: "fixture", path: "skills/fixture" }];
  const manifest = {
    schemaVersion: 1,
    id: "fixture",
    version: options.version ?? "1.0.0",
    name: "Fixture",
    description: "Lifecycle fixture.",
    ziggy: { requires: options.ziggyRequires ?? ">=0.0.0 <=9.0.0" },
    skills,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    adapters: [],
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    requires: {
      env: options.requiresEnv ?? [],
      commands: options.requiresCommands ?? [],
      os: [],
    },
    permissions: { network: false, filesystem: "none", secrets: options.secrets ?? [] },
    distribution: { source: "fixture", license: "MIT" },
  };
  await writeSource(source, "extension.json", `${JSON.stringify(manifest, undefined, 2)}\n`);
  if (skills.length > 0) {
    await writeSource(
      source,
      "skills/fixture/SKILL.md",
      "---\nname: fixture\ndescription: Fixture Skill\n---\n\nFixture.\n",
    );
  }
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    await writeSource(source, path, contents);
  }
  return { root, profile, source };
}

async function writeSource(root: string, path: string, contents: string): Promise<void> {
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory !== "") await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, path), contents, { mode: 0o700 });
}

function lifecycle<Value>(
  profilePath: string,
  use: (service: ExtensionLifecycleService) => Effect.Effect<Value, unknown>,
  overrides: Omit<ExtensionLifecycleOptions, "profilePath"> = {},
): Promise<Value> {
  return runEffect(
    Effect.gen(function* () {
      const service = yield* ExtensionLifecycle;
      return yield* use(service);
    }).pipe(Effect.provide(ExtensionLifecycle.layer({ profilePath, ...overrides }))),
  );
}

function install(
  profilePath: string,
  sourcePath: string,
  approvals: ReadonlyArray<string>,
  overrides: Omit<ExtensionLifecycleOptions, "profilePath"> = {},
): Promise<ExtensionInstallResult> {
  return lifecycle(profilePath, (service) => service.install({ sourcePath, approvals }), overrides);
}

function approvalRequirements(
  result: ExtensionInstallResult,
): ReadonlyArray<ExtensionApprovalRequirement> {
  expect(result.status).toBe("approval-required");
  return result.status === "approval-required" ? result.requirements : [];
}

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function quarantineEntries(profile: string): Promise<ReadonlyArray<string>> {
  const root = join(profile, ".runtime", "extensions");
  const glob = new Bun.Glob(".quarantine-*");
  return Array.fromAsync(glob.scan({ cwd: root, onlyFiles: false }));
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
