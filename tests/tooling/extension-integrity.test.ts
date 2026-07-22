import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("validates the checked-in 47-row ledger and empty derived landed-review set", async () => {
    const result = await verifyExtensionIntegrity(repositoryRoot);
    expect(result.candidateCount).toBe(47);
    expect(result.landedReviewCount).toBe(0);
    expect(result.ledgerDigest).toMatch(/^[a-f0-9]{64}$/);
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
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ziggy-s4-integrity-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "verification"), { recursive: true });
  await cp(join(repositoryRoot, "verification/schemas"), join(root, "verification/schemas"), {
    recursive: true,
  });
  await mkdir(join(root, "docs/plans/s4-extension-reviews"), { recursive: true });
  await cp(
    join(repositoryRoot, "docs/plans/s4-merlin-migration.json"),
    join(root, "docs/plans/s4-merlin-migration.json"),
  );
  return root;
}

async function ledgerFixture(): Promise<unknown> {
  return JSON.parse(
    await Bun.file(join(repositoryRoot, "docs/plans/s4-merlin-migration.json")).text(),
  );
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
