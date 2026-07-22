import { describe, expect, test } from "bun:test";
import {
  assertImplementedStageFindings,
  declaredGates,
  manifestStatusLines,
} from "../../tooling/verification/runner.ts";
import type { VerificationManifest } from "../../tooling/verification/manifests.ts";

const s0: VerificationManifest = {
  schemaVersion: 1,
  stage: "s0",
  status: "implemented",
  predecessors: [],
  scenarios: [],
  gates: ["typecheck", "test"],
  requirements: [],
};

const s1: VerificationManifest = {
  schemaVersion: 1,
  stage: "s1",
  status: "implemented",
  predecessors: ["s0"],
  scenarios: [],
  gates: ["lint", "typecheck"],
  requirements: [],
};

const emptyS2: VerificationManifest = {
  schemaVersion: 1,
  stage: "s2",
  status: "manifest-empty",
  predecessors: ["s0", "s1"],
  scenarios: [],
  gates: [],
  requirements: [],
};

const s3: VerificationManifest = {
  schemaVersion: 1,
  stage: "s3",
  status: "implemented",
  predecessors: ["s0", "s1", "s2"],
  scenarios: [],
  gates: ["test"],
  requirements: [],
};

const fixedFinding = {
  id: "finding-1",
  role: "review" as const,
  severity: "error" as const,
  summary: "Reviewed S3 closure",
  review: {
    workspaceDigest: "a".repeat(64),
    gitRevision: null,
    reviewedAt: "2026-07-21T00:00:00.000Z",
  },
  disposition: {
    status: "fixed" as const,
    rationale: "Regression proof is attached",
    regressionScenarioId: "s3.fixture",
  },
};

describe("verification runner manifest planning", () => {
  test("dispatches only manifest-selected gates in declaration order", () => {
    expect(declaredGates([s0, s1])).toEqual(["typecheck", "test", "lint"]);
  });

  test("requires unique independent findings with fixed or accepted dispositions", () => {
    expect(() => assertImplementedStageFindings([s3], undefined)).toThrow("requires attached");
    for (const status of ["open", "not-applicable"] as const) {
      expect(() =>
        assertImplementedStageFindings(
          [s3],
          [{ ...fixedFinding, disposition: { ...fixedFinding.disposition, status } }],
        ),
      ).toThrow("fixed or accepted");
    }
    expect(() =>
      assertImplementedStageFindings([s3], [{ ...fixedFinding, role: "scout" }]),
    ).toThrow("review findings only");
    expect(() => assertImplementedStageFindings([s3], [fixedFinding, fixedFinding])).toThrow(
      "unique finding IDs",
    );
    expect(() => assertImplementedStageFindings([s3], [fixedFinding])).not.toThrow();
    expect(() =>
      assertImplementedStageFindings(
        [s3],
        [
          {
            ...fixedFinding,
            disposition: { ...fixedFinding.disposition, status: "accepted" },
          },
        ],
      ),
    ).not.toThrow();
    expect(() =>
      assertImplementedStageFindings([{ ...s3, status: "pending" }], undefined),
    ).not.toThrow();
  });

  test("reports selected pending and manifest-empty stages explicitly", () => {
    expect(manifestStatusLines([s0, emptyS2, { ...s3, status: "pending" }])).toEqual([
      "s2: manifest-empty (not implemented; no behavior claimed)",
      "s3: pending (stage closure is not claimed)",
    ]);
    expect(manifestStatusLines([s0])).toEqual([]);
  });
});
