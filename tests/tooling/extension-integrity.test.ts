import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  validateImplementationFileSet,
  validateReviewBudgetContract,
  validateS4Ledger,
  verifyExtensionIntegrity,
} from "../../tooling/verification/extension-integrity.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S4 Extension integrity", () => {
  test("validates the checked-in 47-row ledger and exact Task 9 landed set", async () => {
    const candidates = validateS4Ledger(await checkedInLedgerFixture());
    expect(candidates).toHaveLength(47);
    expect(
      candidates
        .filter((candidate) => candidate.deliveryStatus === "landed")
        .map((candidate) => candidate.id),
    ).toEqual(["hyperframes", "skill-creator"]);
  });

  test("replays from an isolated Ziggy root without a sibling Merlin checkout", async () => {
    const root = await fixtureRoot();
    const result = await verifyExtensionIntegrity(root);
    expect(result.candidateCount).toBe(47);
    expect(result.landedReviewCount).toBe(0);
    expect(
      await Bun.file(join(root, "../merlin/extensions/executor/extension.json")).exists(),
    ).toBeFalse();
  });

  test("rejects missing, substituted, duplicated, and non-canonical candidate IDs", async () => {
    const ledger = await ledgerFixture();
    const candidates = array(record(ledger).candidates);
    const first = candidates[0];
    if (first === undefined) throw new Error("missing first candidate fixture");
    expect(() => validateS4Ledger({ ...record(ledger), candidates: candidates.slice(1) })).toThrow(
      "candidate IDs",
    );
    expect(() =>
      validateS4Ledger({
        ...record(ledger),
        candidates: candidates.map((candidate, index) =>
          index === 0 ? { ...record(candidate), id: "substituted" } : candidate,
        ),
      }),
    ).toThrow("candidate IDs");
    expect(() =>
      validateS4Ledger({
        ...record(ledger),
        candidates: [...candidates.slice(0, 1), first, ...candidates.slice(2)],
      }),
    ).toThrow("candidate IDs");
    expect(() =>
      validateS4Ledger({ ...record(ledger), candidates: [...candidates].reverse() }),
    ).toThrow("candidate IDs");
  });

  test("requires a review for every landed S4 row, including executor without special treatment", async () => {
    for (const id of ["agent-browser", "executor"]) {
      const root = await fixtureRoot();
      const ledger = await ledgerFixture();
      const ledgerRecord = record(ledger);
      const candidates = array(ledgerRecord.candidates).map((candidate) => {
        const row = record(candidate);
        return row.id === id ? { ...row, deliveryStatus: "landed" } : row;
      });
      await Bun.write(
        join(root, "docs/plans/s4-merlin-migration.json"),
        `${JSON.stringify({ ...ledgerRecord, candidates }, null, 2)}\n`,
      );
      await expect(verifyExtensionIntegrity(root)).rejects.toThrow(
        `S4 landed review file set: expected exactly ${id}.json`,
      );
    }
  });

  test("rejects extra reviews and duplicate JSON keys before schema decoding", async () => {
    const extraRoot = await fixtureRoot();
    await Bun.write(join(extraRoot, "docs/plans/s4-extension-reviews/executor.json"), "{}\n");
    await expect(verifyExtensionIntegrity(extraRoot)).rejects.toThrow(
      "S4 landed review file set: expected exactly",
    );

    const duplicateRoot = await fixtureRoot();
    const ledgerText = await Bun.file(
      join(duplicateRoot, "docs/plans/s4-merlin-migration.json"),
    ).text();
    await Bun.write(
      join(duplicateRoot, "docs/plans/s4-merlin-migration.json"),
      ledgerText.replace(
        '{\n  "schemaVersion": 1,',
        '{\n  "schemaVersion": 1,\n  "schemaVersion": 1,',
      ),
    );
    await expect(verifyExtensionIntegrity(duplicateRoot)).rejects.toThrow("duplicate object key");
  });

  test("locks drop-only not-applicable and the Extension execution-mode vocabulary", async () => {
    const ledger = await ledgerFixture();
    const ledgerRecord = record(ledger);
    const candidates = array(ledgerRecord.candidates);
    const clawhub = requireCandidate(candidates, "clawhub");
    expect(() =>
      validateS4Ledger({
        ...ledgerRecord,
        candidates: replaceCandidate(candidates, { ...clawhub, deliveryStatus: "planned" }),
      }),
    ).toThrow("drop alone is not-applicable");

    const executor = requireCandidate(candidates, "executor");
    const target = record(executor.target);
    expect(() =>
      validateS4Ledger({
        ...ledgerRecord,
        candidates: replaceCandidate(candidates, {
          ...executor,
          target: { ...target, executionMode: "skill-with-approved-executables" },
        }),
      }),
    ).toThrow("invalid Extension execution mode");
  });

  test("rejects unreviewed dependency, argv, persisted-state, and implementation-file growth", async () => {
    const ledger = record(await ledgerFixture());
    const executor = requireCandidate(array(ledger.candidates), "executor");
    const permissions = record(executor.permissions);
    const dependency = record(array(executor.dependencies)[0]);
    const dependencyName = dependency.name;
    if (typeof dependencyName !== "string") throw new Error("missing dependency name fixture");
    const budgets: Record<string, unknown> = {
      runtimeDependencies: [dependencyName],
      subprocesses: [{ argv: ["executor"] }],
      persistedStatePaths: [],
      permissions: {
        network: permissions.network,
        filesystem: permissions.filesystem,
        secrets: permissions.secrets,
        externalAuthorities: permissions.externalAuthorities,
      },
    };
    expect(() =>
      validateReviewBudgetContract({ ...budgets, runtimeDependencies: [] }, executor),
    ).toThrow("runtime dependencies");
    expect(() =>
      validateReviewBudgetContract(
        { ...budgets, subprocesses: [{ argv: ["executor"] }, { argv: ["node", "hidden.js"] }] },
        executor,
      ),
    ).toThrow("subprocess executables");
    expect(() =>
      validateReviewBudgetContract(
        { ...budgets, persistedStatePaths: [".runtime/extensions/executor/hidden.json"] },
        executor,
      ),
    ).toThrow("persisted state paths");
    expect(() =>
      validateImplementationFileSet(
        ["extensions/executor/extension.json"],
        ["extensions/executor/extension.json", "extensions/executor/tools/hidden/tool.ts"],
        "executor",
      ),
    ).toThrow("outside reviewed production/support allowlist");
  });

  test("rejects a landed Extension whose reviewed implementation has an invalid manifest", async () => {
    const root = await landedArchitectureDiagramFixture({ manifestText: "{}\n" });

    await expect(verifyExtensionIntegrity(root)).rejects.toThrow("Extension manifest");
  });

  test("rejects landed Extensions with missing entrypoints and unreachable Skill support", async () => {
    const missing = await landedArchitectureDiagramFixture({
      manifestText: architectureDiagramManifest(),
    });
    await expect(verifyExtensionIntegrity(missing)).rejects.toThrow("Missing immediate");

    const cases = [
      {
        name: "orphan",
        skillBody: "Body.",
        files: { "skills/architecture-diagram/references/orphan.md": "# Orphan\n" },
        message: "Orphan Skill support file",
      },
      {
        name: "dangling",
        skillBody: "Read [missing](references/missing.md).",
        files: {},
        message: "Dangling Skill link",
      },
    ];
    for (const fixture of cases) {
      const root = await landedArchitectureDiagramFixture({
        manifestText: architectureDiagramManifest(),
        files: {
          "skills/architecture-diagram/SKILL.md": architectureDiagramSkill(fixture.skillBody),
          ...fixture.files,
        },
      });
      await expect(verifyExtensionIntegrity(root)).rejects.toThrow(fixture.message);
    }
  });

  test("keeps a candidate review fresh across unrelated later repository commits", async () => {
    const root = await landedArchitectureDiagramFixture({
      manifestText: architectureDiagramManifest(),
      files: {
        "skills/architecture-diagram/SKILL.md": architectureDiagramSkill("Body."),
      },
    });
    await expect(verifyExtensionIntegrity(root)).resolves.toMatchObject({ landedReviewCount: 1 });

    await mkdir(join(root, "docs"), { recursive: true });
    await Bun.write(join(root, "docs/unrelated.md"), "# Unrelated later work\n");
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.name=Ziggy Test",
      "-c",
      "user.email=ziggy@example.invalid",
      "commit",
      "-m",
      "unrelated",
    );

    await expect(verifyExtensionIntegrity(root)).resolves.toMatchObject({ landedReviewCount: 1 });
  });

  test("binds a core-Skill review to production composition but not unrelated later work", async () => {
    const root = await landedSkillCreatorFixture();
    await expect(verifyExtensionIntegrity(root)).resolves.toMatchObject({ landedReviewCount: 1 });

    await mkdir(join(root, "docs"), { recursive: true });
    await Bun.write(join(root, "docs/unrelated.md"), "# Unrelated later work\n");
    await commitAll(root, "unrelated");

    await expect(verifyExtensionIntegrity(root)).resolves.toMatchObject({ landedReviewCount: 1 });
  });

  test("invalidates a core-Skill review when production composition changes", async () => {
    for (const change of ["mutation", "removal", "reordering"] as const) {
      const root = await landedSkillCreatorFixture();
      const path = join(root, "packages/core/src/provider-runtime.ts");
      if (change === "removal") {
        await rm(path);
      } else {
        const source = await Bun.file(path).text();
        await Bun.write(
          path,
          change === "mutation"
            ? `${source}\n// changed production composition\n`
            : source.replace(
                "const skillPrompt = [coreSkill, ...extensionSkills]",
                "const skillPrompt = [...extensionSkills, coreSkill]",
              ),
        );
      }
      await commitAll(root, `provider-runtime-${change}`);

      await expect(verifyExtensionIntegrity(root)).rejects.toThrow(
        change === "removal" ? "repository input is missing" : "stale reviewedInputDigest",
      );
    }
  });

  test("invalidates a review when a reviewed candidate input changes", async () => {
    const root = await landedArchitectureDiagramFixture({
      manifestText: architectureDiagramManifest(),
      files: {
        "skills/architecture-diagram/SKILL.md": architectureDiagramSkill("Body."),
      },
    });
    await Bun.write(
      join(root, "extensions/architecture-diagram/skills/architecture-diagram/SKILL.md"),
      architectureDiagramSkill("Changed body."),
    );
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.name=Ziggy Test",
      "-c",
      "user.email=ziggy@example.invalid",
      "commit",
      "-m",
      "candidate-input-change",
    );

    await expect(verifyExtensionIntegrity(root)).rejects.toThrow("stale reviewedInputDigest");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ziggy-s4-integrity-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "verification"), { recursive: true });
  await cp(join(repositoryRoot, "verification/schemas"), join(root, "verification/schemas"), {
    recursive: true,
  });
  await mkdir(join(root, "docs/plans/s4-extension-reviews"), { recursive: true });
  await Bun.write(
    join(root, "docs/plans/s4-merlin-migration.json"),
    `${JSON.stringify(await ledgerFixture(), null, 2)}\n`,
  );
  return root;
}

async function ledgerFixture(): Promise<unknown> {
  const ledger = record(await checkedInLedgerFixture());
  return {
    ...ledger,
    candidates: array(ledger.candidates).map((candidate) => {
      const row = record(candidate);
      return row.id === "hyperframes" || row.id === "skill-creator"
        ? { ...row, deliveryStatus: "planned" }
        : row;
    }),
  };
}

async function checkedInLedgerFixture(): Promise<unknown> {
  return JSON.parse(
    await Bun.file(join(repositoryRoot, "docs/plans/s4-merlin-migration.json")).text(),
  );
}

interface LandedArchitectureDiagramFixtureOptions {
  readonly manifestText: string;
  readonly files?: Readonly<Record<string, string>>;
}

async function landedArchitectureDiagramFixture(
  options: LandedArchitectureDiagramFixtureOptions,
): Promise<string> {
  const root = await fixtureRoot();
  await cp(join(repositoryRoot, "package.json"), join(root, "package.json"));
  await cp(join(repositoryRoot, "bun.lock"), join(root, "bun.lock"));
  const ledger = record(await ledgerFixture());
  const candidates = array(ledger.candidates);
  const candidate: Record<string, unknown> = {
    ...requireCandidate(candidates, "architecture-diagram"),
    deliveryStatus: "landed",
  };
  await Bun.write(
    join(root, "docs/plans/s4-merlin-migration.json"),
    `${JSON.stringify({ ...ledger, candidates: replaceCandidate(candidates, candidate) }, null, 2)}\n`,
  );
  await mkdir(join(root, "extensions/architecture-diagram"), { recursive: true });
  const manifestPath = "extensions/architecture-diagram/extension.json";
  await Bun.write(join(root, manifestPath), options.manifestText);
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    const repositoryPath = `extensions/architecture-diagram/${path}`;
    await mkdir(dirname(join(root, repositoryPath)), { recursive: true });
    await Bun.write(join(root, repositoryPath), contents);
  }
  await git(root, "init");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Ziggy Test",
    "-c",
    "user.email=ziggy@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const revision = (await Bun.$`git rev-parse HEAD`.cwd(root).quiet()).text().trim();
  const candidatePermissions = record(candidate.permissions);
  const allowedFiles = [
    manifestPath,
    ...Object.keys(options.files ?? {}).map((path) => `extensions/architecture-diagram/${path}`),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const budgets = {
    production: {
      allowedFiles,
      maximumLines: 100,
      lineMetric: "physical-non-generated-text-lines-final-partial-counted",
    },
    runtimeDependencies: ["none"],
    permissions: {
      network: candidatePermissions.network,
      filesystem: candidatePermissions.filesystem,
      secrets: candidatePermissions.secrets,
      externalAuthorities: candidatePermissions.externalAuthorities,
    },
    subprocesses: [],
    persistedStatePaths: [],
    supportMaterial: { files: [], maximumFiles: 0, maximumBytes: 0 },
  };
  const reviewedInputDigest = await fixtureReviewedInputDigest(root, candidate, allowedFiles);
  const review = {
    schemaVersion: 1,
    id: "architecture-diagram",
    review: {
      role: "independent",
      reviewedAt: "2026-07-22T12:03:00.000Z",
      gitRevision: revision,
      reviewedInputDigest,
      contexts: {
        scout: { id: "scout", completedAt: "2026-07-22T12:00:00.000Z" },
        implementer: { id: "implementer", completedAt: "2026-07-22T12:01:00.000Z" },
        verifier: { id: "verifier", startedAt: "2026-07-22T12:02:00.000Z" },
      },
    },
    userOutcome: record(candidate.capability).userOutcome,
    target: { mechanism: "extension", id: "architecture-diagram", trustTier: "builtin" },
    overlap: [],
    capabilityContract: { scenarioIds: ["s4.manifest-version-compatibility"] },
    budgets,
    removableMaterial: [],
    assertions: {
      lowestTrustTier: true,
      noDuplicateAuthority: true,
      noCompatibilityShim: true,
      noInactiveVendoredMaterial: true,
    },
    findings: [],
    disposition: "accepted",
  };
  await Bun.write(
    join(root, "docs/plans/s4-extension-reviews/architecture-diagram.json"),
    `${JSON.stringify(review, null, 2)}\n`,
  );
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Ziggy Test",
    "-c",
    "user.email=ziggy@example.invalid",
    "commit",
    "-m",
    "review",
  );
  return root;
}

async function landedSkillCreatorFixture(): Promise<string> {
  const root = await fixtureRoot();
  await cp(join(repositoryRoot, "package.json"), join(root, "package.json"));
  await cp(join(repositoryRoot, "bun.lock"), join(root, "bun.lock"));
  await mkdir(join(root, "packages/core"), { recursive: true });
  await cp(
    join(repositoryRoot, "packages/core/package.json"),
    join(root, "packages/core/package.json"),
  );
  const ledger = record(await ledgerFixture());
  const candidates = array(ledger.candidates);
  const candidate: Record<string, unknown> = {
    ...requireCandidate(candidates, "skill-creator"),
    deliveryStatus: "landed",
  };
  await Bun.write(
    join(root, "docs/plans/s4-merlin-migration.json"),
    `${JSON.stringify({ ...ledger, candidates: replaceCandidate(candidates, candidate) }, null, 2)}\n`,
  );
  const allowedFiles = [
    "packages/core/src/provider-runtime.ts",
    "packages/core/src/skills/skill-writing/SKILL.md",
    "packages/core/src/skills/skill-writing/index.ts",
  ];
  for (const path of allowedFiles) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repositoryRoot, path), join(root, path));
  }
  await git(root, "init");
  await commitAll(root, "fixture");
  const revision = (await Bun.$`git rev-parse HEAD`.cwd(root).quiet()).text().trim();
  const candidatePermissions = record(candidate.permissions);
  const budgets = {
    production: {
      allowedFiles,
      maximumLines: 500,
      lineMetric: "physical-non-generated-text-lines-final-partial-counted",
    },
    runtimeDependencies: ["Ziggy Skill/manifest schemas"],
    permissions: {
      network: candidatePermissions.network,
      filesystem: candidatePermissions.filesystem,
      secrets: candidatePermissions.secrets,
      externalAuthorities: candidatePermissions.externalAuthorities,
    },
    subprocesses: [],
    persistedStatePaths: [],
    supportMaterial: { files: [], maximumFiles: 0, maximumBytes: 0 },
  };
  const reviewedInputDigest = await fixtureReviewedInputDigest(root, candidate, allowedFiles);
  const review = {
    schemaVersion: 1,
    id: "skill-creator",
    review: {
      role: "independent",
      reviewedAt: "2026-07-22T12:03:00.000Z",
      gitRevision: revision,
      reviewedInputDigest,
      contexts: {
        scout: { id: "scout", completedAt: "2026-07-22T12:00:00.000Z" },
        implementer: { id: "implementer", completedAt: "2026-07-22T12:01:00.000Z" },
        verifier: { id: "verifier", startedAt: "2026-07-22T12:02:00.000Z" },
      },
    },
    userOutcome: record(candidate.capability).userOutcome,
    target: { mechanism: "core-skill", id: "skill-writing" },
    overlap: [],
    capabilityContract: { scenarioIds: ["s4.skill-writing"] },
    budgets,
    removableMaterial: [],
    assertions: {
      lowestTrustTier: true,
      noDuplicateAuthority: true,
      noCompatibilityShim: true,
      noInactiveVendoredMaterial: true,
    },
    findings: [],
    disposition: "accepted",
  };
  await Bun.write(
    join(root, "docs/plans/s4-extension-reviews/skill-creator.json"),
    `${JSON.stringify(review, null, 2)}\n`,
  );
  await commitAll(root, "review");
  return root;
}

async function fixtureReviewedInputDigest(
  root: string,
  candidate: Record<string, unknown>,
  allowedFiles: ReadonlyArray<string>,
): Promise<string> {
  const candidateId = candidate.id;
  if (typeof candidateId !== "string") throw new Error("missing candidate id fixture");
  const pathSet = new Set(["bun.lock", "package.json", ...allowedFiles]);
  for (const path of allowedFiles) {
    const components = path.split("/");
    if (components[0] === "packages" && components[1] !== undefined) {
      pathSet.add(`packages/${components[1]}/package.json`);
    }
  }
  const paths = [...pathSet].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const candidateText = canonicalJson(candidate);
  const inputs = [
    {
      path: `docs/plans/s4-merlin-migration.json#candidate/${candidateId}`,
      bytes: new TextEncoder().encode(candidateText).byteLength,
      sha256: sha256(candidateText),
    },
  ];
  for (const path of paths) {
    const bytes = await Bun.file(join(root, path)).arrayBuffer();
    inputs.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  inputs.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      candidateId,
      deliveryStatus: candidate.deliveryStatus,
      ledgerRowDigest: sha256(candidateText),
      inputs,
    }),
  );
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=Ziggy Test",
    "-c",
    "user.email=ziggy@example.invalid",
    "commit",
    "-m",
    message,
  );
}

function architectureDiagramManifest(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id: "architecture-diagram",
      version: "1.0.0",
      name: "Architecture Diagram",
      description: "Create a standalone architecture diagram.",
      ziggy: { requires: ">=0.0.0 <=9.0.0" },
      skills: [{ id: "architecture-diagram", path: "skills/architecture-diagram" }],
      adapters: [],
      requires: { env: [], commands: [], os: [] },
      permissions: { network: false, filesystem: "profile", secrets: [] },
      distribution: { source: "fixture", license: "MIT" },
    },
    null,
    2,
  )}\n`;
}

function architectureDiagramSkill(body: string): string {
  return `---\nname: architecture-diagram\ndescription: Create a standalone architecture diagram\n---\n\n${body}\n`;
}

async function git(root: string, ...arguments_: ReadonlyArray<string>): Promise<void> {
  const result = await Bun.$`git ${arguments_}`.cwd(root).quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test fixture must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error("test fixture must be an array");
  return value;
}

function requireCandidate(candidates: ReadonlyArray<unknown>, id: string): Record<string, unknown> {
  const candidate = candidates.map(record).find((item) => item.id === id);
  if (candidate === undefined) throw new Error(`missing candidate fixture ${id}`);
  return candidate;
}

function replaceCandidate(
  candidates: ReadonlyArray<unknown>,
  replacement: Record<string, unknown>,
): ReadonlyArray<unknown> {
  return candidates.map((candidate) =>
    record(candidate).id === replacement.id ? replacement : candidate,
  );
}
